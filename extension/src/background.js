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
importScripts('detector.js', 'queue.js');

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
    return false;
});
