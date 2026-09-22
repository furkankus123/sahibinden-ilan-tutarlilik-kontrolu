/* =============================================================================
 * background.js — MV3 service worker: global scheduler + shared cache
 *
 * Why the queue lives here instead of in the content script:
 *   Open five results tabs and five in-page queues would hammer the site with
 *   five parallel request streams. One queue in the service worker means one
 *   polite stream no matter how many tabs are open — which is the single
 *   biggest difference between the extension and the userscript.
 *
 * Why this worker does NOT parse HTML:
 *   DOMParser does not exist in a service worker. So the worker hands out
 *   *permits* ("your turn to fetch") and the content script does the actual
 *   fetch + parse, where DOMParser is available. Only small JSON messages
 *   cross the boundary, never 500 KB of listing HTML.
 * ========================================================================== */

// detector.js is pure string/regex work with no DOM dependency, so it loads
// fine in a service worker. The worker does not analyse anything — it needs
// LIDDetector only to know which cached verdict shapes are still valid.
importScripts('detector.js', 'queue.js', 'upload.js');

/**
 * Where anonymous contributions go. Replace the host after deploying
 * server/ (see server/README.md), and keep it under *.workers.dev so it
 * matches the optional_host_permissions entry in manifest.json.
 */
const SHARE_ENDPOINT = 'https://lid-corpus.furkankus123.workers.dev/v1/submit';
const SHARE_ORIGIN = 'https://*.workers.dev/*';
const SHARE_MIN_INTERVAL_MS = 5 * 60 * 1000;

const { ThrottledQueue, RateLimitError } = LIDQueue;

const SETTINGS = {
    CACHE_KEY: 'lid_cache_v2',
    CACHE_TTL_MS: 24 * 60 * 60 * 1000,
    CACHE_MAX_ENTRIES: 600,
};

/* -----------------------------------------------------------------------------
 * Shared cache (chrome.storage.local, visible to every tab)
 * -------------------------------------------------------------------------- */
const Cache = {
    _mem: null,

    async _load() {
        if (this._mem) return this._mem;
        const stored = await chrome.storage.local.get(SETTINGS.CACHE_KEY);
        this._mem = stored[SETTINGS.CACHE_KEY] || {};
        return this._mem;
    },

    async get(key) {
        const data = await this._load();
        const entry = data[key];
        if (!entry || Date.now() - entry.ts > SETTINGS.CACHE_TTL_MS) return null;

        // A verdict cached by an older build has an older shape. Serving it
        // would render with fields that no longer exist — which is exactly how
        // the orange paint tier silently never appeared. Treat it as a miss and
        // re-fetch; it costs one request and then self-corrects.
        if (!LIDDetector.isCurrentSchema(entry.result)) return null;

        return entry.result;
    },

    async set(key, result) {
        const data = await this._load();
        data[key] = { ts: Date.now(), result };

        const now = Date.now();
        this._mem = Object.fromEntries(
            Object.entries(data)
                // Drop expired AND outdated-shape entries, so stale verdicts do
                // not squat on the 600-entry budget until their TTL runs out.
                .filter(([, v]) => v && now - v.ts < SETTINGS.CACHE_TTL_MS
                    && LIDDetector.isCurrentSchema(v.result))
                .sort((a, b) => b[1].ts - a[1].ts)
                .slice(0, SETTINGS.CACHE_MAX_ENTRIES)
        );
        await chrome.storage.local.set({ [SETTINGS.CACHE_KEY]: this._mem });
    },

    async clear() {
        this._mem = {};
        await chrome.storage.local.remove(SETTINGS.CACHE_KEY);
    },

    async stats() {
        const entries = Object.values(await this._load());
        return {
            cached: entries.length,
            flagged: entries.filter((e) => e.result && e.result.status === 'inconsistent').length,
        };
    },
};

/* -----------------------------------------------------------------------------
 * Corpus — labelled feedback and unknown vocabulary, gathered from ordinary
 * browsing. Nothing here is ever transmitted; it exists so the user can export
 * it and so the rules can be improved from real listings instead of guesses.
 * -------------------------------------------------------------------------- */
const CORPUS = {
    FEEDBACK_KEY: 'lid_feedback_v1',
    TERMS_KEY: 'lid_terms_v1',
    PENDING_TERMS_KEY: 'lid_terms_pending_v1',
    MAX_FEEDBACK: 1000,
    MAX_TERMS: 3000,
};

const Corpus = {
    async addFeedback(entry) {
        const store = await chrome.storage.local.get(CORPUS.FEEDBACK_KEY);
        const list = store[CORPUS.FEEDBACK_KEY] || [];

        // One verdict per listing: a correction replaces an earlier opinion.
        const next = list.filter((e) => e.url !== entry.url);
        next.push(entry);

        await chrome.storage.local.set({
            [CORPUS.FEEDBACK_KEY]: next.slice(-CORPUS.MAX_FEEDBACK),
        });
    },

    async addTerms(terms) {
        if (!terms || !terms.length) return;
        const store = await chrome.storage.local.get(CORPUS.TERMS_KEY);
        const map = store[CORPUS.TERMS_KEY] || {};

        for (const t of terms) {
            const existing = map[t.term];
            if (existing) {
                existing.count += t.count;
            } else {
                map[t.term] = { count: t.count, example: t.example };
            }
        }

        // Keep the most frequent; a long tail of typos is not worth storing.
        const trimmed = Object.fromEntries(
            Object.entries(map)
                .sort((a, b) => b[1].count - a[1].count)
                .slice(0, CORPUS.MAX_TERMS)
        );
        await chrome.storage.local.set({ [CORPUS.TERMS_KEY]: trimmed });
    },

    async read() {
        const store = await chrome.storage.local.get([CORPUS.FEEDBACK_KEY, CORPUS.TERMS_KEY]);
        return {
            feedback: store[CORPUS.FEEDBACK_KEY] || [],
            terms: store[CORPUS.TERMS_KEY] || {},
        };
    },

    async clear() {
        await chrome.storage.local.remove([
            CORPUS.FEEDBACK_KEY, CORPUS.TERMS_KEY, CORPUS.PENDING_TERMS_KEY,
        ]);
    },

    /** Terms not yet contributed. Kept apart from the cumulative local store so
     *  a re-send cannot inflate the shared counts. */
    async addPendingTerms(terms) {
        const store = await chrome.storage.local.get(CORPUS.PENDING_TERMS_KEY);
        const map = store[CORPUS.PENDING_TERMS_KEY] || {};
        for (const t of terms) {
            if (map[t.term]) map[t.term].count += t.count;
            else map[t.term] = { count: t.count, example: t.example };
        }
        await chrome.storage.local.set({ [CORPUS.PENDING_TERMS_KEY]: map });
    },

    async pending() {
        const store = await chrome.storage.local.get([CORPUS.FEEDBACK_KEY, CORPUS.PENDING_TERMS_KEY]);
        const feedback = (store[CORPUS.FEEDBACK_KEY] || []).filter((e) => !e.shared);
        const terms = Object.entries(store[CORPUS.PENDING_TERMS_KEY] || {})
            .map(([term, v]) => ({ term, count: v.count, example: v.example }));
        return { feedback, terms };
    },

    /** Marks everything just contributed, so it is never sent twice. */
    async markShared(sharedFeedback) {
        const store = await chrome.storage.local.get(CORPUS.FEEDBACK_KEY);
        const seen = new Set(sharedFeedback.map((e) => e.at));
        const list = (store[CORPUS.FEEDBACK_KEY] || [])
            .map((e) => (seen.has(e.at) ? { ...e, shared: true } : e));
        await chrome.storage.local.set({
            [CORPUS.FEEDBACK_KEY]: list,
            [CORPUS.PENDING_TERMS_KEY]: {},
        });
    },
};

/* -----------------------------------------------------------------------------
 * Anonymous contribution — OFF unless the user turns it on.
 *
 * The extension's promise is that it sends nothing anywhere. This is the one
 * exception, and it only applies after an explicit opt-in that also has to
 * grant a host permission the default install does not hold. What leaves the
 * machine is built by LIDUpload.buildPayload and checked by auditPayload
 * immediately before the request; if the audit finds anything identifying, the
 * upload is abandoned rather than sent.
 * -------------------------------------------------------------------------- */
let lastShareAttempt = 0;

async function shareSettings() {
    return chrome.storage.sync.get({ shareEnabled: false, shareTerms: true });
}

async function mayShare() {
    const { shareEnabled } = await shareSettings();
    if (!shareEnabled) return false;
    if (SHARE_ENDPOINT.includes('CHANGE-ME')) return false;
    return chrome.permissions.contains({ origins: [SHARE_ORIGIN] });
}

async function maybeShare(force = false) {
    if (!force && Date.now() - lastShareAttempt < SHARE_MIN_INTERVAL_MS) return null;
    if (!(await mayShare())) return null;
    lastShareAttempt = Date.now();

    const { shareTerms } = await shareSettings();
    const { feedback, terms } = await Corpus.pending();
    if (feedback.length === 0 && (!shareTerms || terms.length === 0)) return null;

    const payload = LIDUpload.buildPayload({
        feedback,
        terms,
        includeTerms: shareTerms,
        version: chrome.runtime.getManifest().version,
    });

    const problems = LIDUpload.auditPayload(payload);
    if (problems.length) {
        console.error('[LID] upload aborted, payload failed audit:', problems);
        return { ok: false, error: 'audit failed' };
    }
    if (payload.items.length === 0) return null;

    try {
        const res = await fetch(SHARE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

        await Corpus.markShared(feedback);
        return { ok: true, sent: payload.items.length };
    } catch (err) {
        // Offline or blocked: keep the data and try again later.
        return { ok: false, error: err.message };
    }
}

/* -----------------------------------------------------------------------------
 * Ports — one per results tab
 * -------------------------------------------------------------------------- */
const ports = new Set();

/** Pending permits: jobId -> { resolve, reject, port } for the outcome the tab reports. */
const awaitingOutcome = new Map();

function broadcastQueueState(state) {
    for (const port of ports) {
        try { port.postMessage({ type: 'queue-state', state }); } catch { /* tab is gone */ }
    }
}

const queue = new ThrottledQueue(grantPermit, { onStateChange: broadcastQueueState });

/**
 * Queue worker. Tells the owning tab it may fetch now, then waits for it to
 * report what happened. Throwing RateLimitError makes ThrottledQueue pause
 * and re-queue the job, which results in a second permit later.
 */
function grantPermit(job) {
    return new Promise((resolve, reject) => {
        if (job.port.disconnected) { reject(new Error('stale')); return; }

        awaitingOutcome.set(job.id, { resolve, reject, port: job.port });
        try {
            job.port.postMessage({ type: 'grant', id: job.id });
        } catch {
            awaitingOutcome.delete(job.id);
            reject(new Error('stale'));
        }
    });
}

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'lid') return;
    ports.add(port);
    port.disconnected = false;

    port.onMessage.addListener(async (msg) => {
        switch (msg.type) {
            /* Tab asks for a verdict ------------------------------------- */
            case 'analyze': {
                const cached = await Cache.get(msg.key);
                if (cached) {
                    safePost(port, { type: 'verdict', id: msg.id, result: cached, cached: true });
                    return;
                }

                try {
                    const result = await queue.submit({
                        key: msg.key,
                        id: msg.id,
                        port,
                        isStale: () => port.disconnected,
                    });
                    await Cache.set(msg.key, result);
                    safePost(port, { type: 'verdict', id: msg.id, result });
                } catch (err) {
                    safePost(port, {
                        type: 'verdict',
                        id: msg.id,
                        error: { name: err.name, message: err.message },
                    });
                }
                return;
            }

            /* Tab reports what happened after a permit -------------------- */
            case 'outcome': {
                const pending = awaitingOutcome.get(msg.id);
                if (!pending) return;
                awaitingOutcome.delete(msg.id);

                if (msg.status === 'ok') {
                    pending.resolve(msg.result);
                } else if (msg.status === 'rate-limited') {
                    pending.reject(new RateLimitError(msg.message || 'rate limited', msg.httpStatus));
                } else {
                    pending.reject(new Error(msg.message || 'fetch failed'));
                }
                return;
            }

            /* Corpus from ordinary browsing ------------------------------- */
            case 'feedback':
                await Corpus.addFeedback(msg.entry);
                maybeShare();          // no await: the tab must not wait on a network call
                return;

            case 'terms':
                await Corpus.addTerms(msg.terms);
                await Corpus.addPendingTerms(msg.terms);
                return;

            /* Keepalive: stops Chrome idling the worker out mid-queue ----- */
            case 'ping':
                safePost(port, { type: 'pong' });
                return;
        }
    });

    port.onDisconnect.addListener(() => {
        port.disconnected = true;
        ports.delete(port);
        // Fail anything this tab still owed us an answer for.
        for (const [id, pending] of awaitingOutcome) {
            if (pending.port === port) {
                awaitingOutcome.delete(id);
                pending.reject(new Error('stale'));
            }
        }
    });
});

function safePost(port, message) {
    try { port.postMessage(message); } catch { /* tab closed mid-flight */ }
}

/* -----------------------------------------------------------------------------
 * One-off messages from the popup
 * -------------------------------------------------------------------------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'stats') {
        Cache.stats().then(sendResponse);
        return true;   // keep the channel open for the async reply
    }
    if (msg.type === 'clear-cache') {
        Cache.clear().then(() => sendResponse({ ok: true }));
        return true;
    }
    if (msg.type === 'corpus-stats') {
        Corpus.read().then(({ feedback, terms }) => sendResponse({
            feedback: feedback.length,
            wrong: feedback.filter((e) => e.label === 'wrong').length,
            terms: Object.keys(terms).length,
        }));
        return true;
    }
    if (msg.type === 'corpus-export') {
        Corpus.read().then(({ feedback, terms }) => sendResponse({
            exportedAt: new Date().toISOString(),
            extensionVersion: chrome.runtime.getManifest().version,
            feedback,
            // Most frequent first: that is the order worth reading.
            unknownTerms: Object.entries(terms)
                .map(([term, v]) => ({ term, count: v.count, example: v.example }))
                .sort((a, b) => b.count - a.count),
        }));
        return true;
    }
    if (msg.type === 'corpus-clear') {
        Corpus.clear().then(() => sendResponse({ ok: true }));
        return true;
    }
    if (msg.type === 'share-now') {
        maybeShare(true).then((r) => sendResponse(r || { ok: false, error: 'nothing to send' }));
        return true;
    }
    if (msg.type === 'share-preview') {
        // Shows the user the exact bytes that would leave their machine.
        Promise.all([shareSettings(), Corpus.pending()]).then(([s, p]) => sendResponse({
            enabled: s.shareEnabled,
            configured: !SHARE_ENDPOINT.includes('CHANGE-ME'),
            pending: p.feedback.length + (s.shareTerms ? p.terms.length : 0),
            payload: LIDUpload.buildPayload({
                feedback: p.feedback.slice(0, 3),
                terms: s.shareTerms ? p.terms.slice(0, 3) : [],
                includeTerms: s.shareTerms,
                version: chrome.runtime.getManifest().version,
            }),
        }));
        return true;
    }
    return false;
});
