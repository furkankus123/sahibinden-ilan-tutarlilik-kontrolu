/* =============================================================================
 * content-glue.js — extension-specific wiring (the userscript's counterpart
 * is src/userscript-glue.js)
 *
 * Talks to the service worker over a long-lived port:
 *   -> analyze  : "what is the verdict for this listing?"
 *   <- grant    : "your turn — fetch it now"
 *   -> outcome  : "here is what I found / I got rate-limited"
 *   <- verdict  : final answer (from cache, or from the outcome above)
 *
 * The fetch and the HTML parsing happen HERE, not in the worker, because
 * DOMParser does not exist in a service worker.
 *
 * SERVICE WORKER LIFETIME
 * Chrome evicts an MV3 service worker after ~30 s idle, and on a long queue it
 * WILL be evicted mid-run no matter how often we ping it. When that happens the
 * port dies, every later postMessage throws synchronously, and the whole
 * remaining queue fails instantly — which looks like "31 listings could not be
 * checked" with an empty queue. So this file does not rely on the worker
 * staying alive: it detects the disconnect, reconnects (which wakes the worker
 * back up), and resubmits whatever was still outstanding. The worker lost its
 * in-memory queue along with everything else, so resubmitting is required, not
 * merely an optimisation. The cache lives in chrome.storage.local and survives,
 * so resubmitted listings that were already answered come straight back.
 * ========================================================================== */

(function () {
    'use strict';

    const SETTINGS = {
        REQUEST_TIMEOUT_MS: 20000,
        KEEPALIVE_MS: 15000,        // comfortably inside Chrome's ~30 s idle timeout
        MAX_RECONNECTS: 50,         // guards against a reconnect loop if the worker is broken
        DEBUG: false,
    };

    const PREFS = { enabled: true, showProgressBadges: true };

    const log = (...a) => SETTINGS.DEBUG && console.log('%c[LID]', 'color:#c00;font-weight:bold', ...a);
    const warn = (...a) => console.warn('[LID]', ...a);

    let nextId = 1;
    const pendingVerdicts = new Map(); // id -> { resolve, reject }
    const activeJobs = new Map();      // id -> job (needed to re-fetch on a repeat grant)
    let core = null;

    /* -------------------------------------------------------------------------
     * Port management
     * ---------------------------------------------------------------------- */
    let port = null;
    let reconnects = 0;
    let shuttingDown = false;

    function connect() {
        port = chrome.runtime.connect({ name: 'lid' });
        port.onMessage.addListener(handleMessage);
        port.onDisconnect.addListener(handleDisconnect);
        return port;
    }

    function handleDisconnect() {
        // Reading lastError marks it handled and tells us why we were dropped.
        const why = chrome.runtime.lastError && chrome.runtime.lastError.message;
        port = null;
        if (shuttingDown) return;

        if (pendingVerdicts.size === 0) return;   // nothing in flight; reconnect lazily

        if (++reconnects > SETTINGS.MAX_RECONNECTS) {
            warn('Too many reconnects; giving up.', why || '');
            failAllPending('Arka plan servisi yeniden başlatılamadı');
            return;
        }

        log('Service worker went away' + (why ? ' (' + why + ')' : '') + '; reconnecting.');
        connect();
        resubmitPending();
    }

    /** Re-asks for every verdict still outstanding; the worker lost its queue. */
    function resubmitPending() {
        for (const id of pendingVerdicts.keys()) {
            const job = activeJobs.get(id);
            if (!job) continue;
            post({ type: 'analyze', id, key: job.key, url: job.url });
        }
    }

    function failAllPending(message) {
        for (const [id, pending] of [...pendingVerdicts]) {
            pendingVerdicts.delete(id);
            activeJobs.delete(id);
            pending.reject(new Error(message));
        }
    }

    /**
     * Sends a message, reconnecting once if the port has gone stale.
     * Returns false only when the runtime itself is unavailable (extension
     * reloaded or updated), which no amount of retrying will fix.
     */
    function post(message) {
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!port) {
                if (shuttingDown) return false;
                try { connect(); } catch (e) { warn('connect failed:', e.message); return false; }
            }
            try {
                port.postMessage(message);
                return true;
            } catch (e) {
                // "Attempting to use a disconnected port object" — the worker was
                // evicted between our check and this call. Drop it and retry once.
                port = null;
                if (attempt === 1) { warn('postMessage failed:', e.message); return false; }
            }
        }
        return false;
    }

    /* -------------------------------------------------------------------------
     * Fetch + parse + analyse — runs when the worker grants a permit
     * ---------------------------------------------------------------------- */
    async function performAnalysis(job) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), SETTINGS.REQUEST_TIMEOUT_MS);

        let res;
        try {
            // Same-origin request: cookies ride along and there is no CORS issue,
            // because we only ever fetch listing pages on the site we are on.
            res = await fetch(job.url, { credentials: 'include', signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }

        if ([403, 429, 503].includes(res.status)) {
            return { status: 'rate-limited', httpStatus: res.status, message: `HTTP ${res.status}` };
        }
        if (!res.ok) {
            return { status: 'error', message: `HTTP ${res.status}` };
        }

        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const adapter = LIDSiteAdapters.forHost(location.hostname);

        if (LIDSiteAdapters.looksBlocked(doc, res.url, LIDDetector.normalize)) {
            return { status: 'rate-limited', message: 'Bot challenge or login page detected' };
        }

        const description = LIDSiteAdapters.extractDescription(doc, adapter);

        // Free evidence: this text was fetched for analysis anyway, so mine it
        // for vocabulary we do not yet understand. No extra request is made.
        if (description) {
            const terms = LIDDetector.harvestTerms(description);
            if (terms.length) post({ type: 'terms', terms });
        }

        return { status: 'ok', result: LIDDetector.analyze(job.title, description) };
    }

    /* -------------------------------------------------------------------------
     * Port protocol
     * ---------------------------------------------------------------------- */
    async function handleMessage(msg) {
        switch (msg.type) {
            case 'grant': {
                const job = activeJobs.get(msg.id);
                if (!job) return;

                // The row may have been replaced by an AJAX update while queued.
                if (!job.row.isConnected) {
                    post({ type: 'outcome', id: msg.id, status: 'error', message: 'stale' });
                    return;
                }

                try {
                    const outcome = await performAnalysis(job);
                    post({ type: 'outcome', id: msg.id, ...outcome });
                } catch (err) {
                    post({
                        type: 'outcome',
                        id: msg.id,
                        status: 'error',
                        message: err.name === 'AbortError' ? 'Zaman aşımı' : err.message,
                    });
                }
                return;
            }

            case 'verdict': {
                const pending = pendingVerdicts.get(msg.id);
                if (!pending) return;
                pendingVerdicts.delete(msg.id);
                activeJobs.delete(msg.id);

                if (msg.error) {
                    const err = new Error(msg.error.message);
                    err.name = msg.error.name;
                    pending.reject(err);
                } else {
                    pending.resolve(msg.result);
                }
                return;
            }

            case 'queue-state':
                if (core) core.setQueueState(msg.state);
                return;
        }
    }

    // Best-effort: keeps the worker alive through short gaps so the common case
    // never needs a reconnect. The reconnect path above is what makes it correct.
    setInterval(() => {
        if (pendingVerdicts.size > 0) post({ type: 'ping' });
    }, SETTINGS.KEEPALIVE_MS);

    window.addEventListener('pagehide', () => {
        shuttingDown = true;
        if (port) { try { port.disconnect(); } catch (e) { /* already gone */ } }
    });

    /* -------------------------------------------------------------------------
     * Wire-up
     * ---------------------------------------------------------------------- */
    (async function init() {
        const prefs = await chrome.storage.sync.get(PREFS);

        // Master switch off: connect nothing, scan nothing, request nothing.
        if (!prefs.enabled) return;

        connect();

        core = LIDContentCore.start({
            css: null, // injected by the manifest instead
            showProgressBadges: prefs.showProgressBadges,
            debug: SETTINGS.DEBUG,
            recordFeedback: (entry) => post({ type: 'feedback', entry }),
            requestAnalysis(job) {
                const id = nextId++;
                activeJobs.set(id, job);
                return new Promise((resolve, reject) => {
                    pendingVerdicts.set(id, { resolve, reject });
                    if (!post({ type: 'analyze', id, key: job.key, url: job.url })) {
                        pendingVerdicts.delete(id);
                        activeJobs.delete(id);
                        reject(new Error('Eklenti arka planına ulaşılamadı (sayfayı yenileyin)'));
                    }
                });
            },
        });
    })();
})();
