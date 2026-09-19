/* =============================================================================
 * userscript-glue.js — Tampermonkey-specific wiring
 *
 * Supplies the three things content-core.js does not know how to do by itself:
 *   1. HTTP   — GM_xmlhttpRequest (sends cookies, bypasses CORS)
 *   2. Cache  — GM_setValue / GM_getValue
 *   3. Queue  — one ThrottledQueue per page
 *
 * The extension replaces this file with content-glue.js + background.js.
 * `LID_INLINE_CSS` is injected above this block by build.ps1.
 * ========================================================================== */

(function () {
    'use strict';

    const { ThrottledQueue, RateLimitError, HttpError, NetworkError } = LIDQueue;

    const SETTINGS = {
        REQUEST_TIMEOUT_MS: 20000,
        CACHE_KEY: 'lid_cache_v2',
        CACHE_TTL_MS: 24 * 60 * 60 * 1000,
        CACHE_MAX_ENTRIES: 600,
        SHOW_PROGRESS_BADGES: true,
        DEBUG: false,
    };

    /* -------------------------------------------------------------------------
     * Cache — GM storage, degrading to memory-only if the GM API is absent
     * (e.g. Greasemonkey 4, where the sync GM_* functions do not exist).
     * ---------------------------------------------------------------------- */
    const Cache = {
        _mem: null,

        _load() {
            if (this._mem) return this._mem;
            try {
                const raw = typeof GM_getValue === 'function' ? GM_getValue(SETTINGS.CACHE_KEY, '{}') : '{}';
                this._mem = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
            } catch {
                this._mem = {};
            }
            return this._mem;
        },

        get(key) {
            const entry = this._load()[key];
            if (!entry || Date.now() - entry.ts > SETTINGS.CACHE_TTL_MS) return null;
            // Verdicts cached by an older build have an older shape; see
            // RESULT_SCHEMA in detector.js. Treat them as a miss.
            if (!LIDDetector.isCurrentSchema(entry.result)) return null;
            return entry.result;
        },

        set(key, result) {
            const data = this._load();
            data[key] = { ts: Date.now(), result };

            // Prune expired entries, then keep only the newest N.
            const now = Date.now();
            this._mem = Object.fromEntries(
                Object.entries(data)
                    .filter(([, v]) => v && now - v.ts < SETTINGS.CACHE_TTL_MS
                        && LIDDetector.isCurrentSchema(v.result))
                    .sort((a, b) => b[1].ts - a[1].ts)
                    .slice(0, SETTINGS.CACHE_MAX_ENTRIES)
            );

            try {
                if (typeof GM_setValue === 'function') GM_setValue(SETTINGS.CACHE_KEY, JSON.stringify(this._mem));
            } catch (e) {
                console.warn('[LID] Cache save failed:', e);
            }
        },
    };

    /* -------------------------------------------------------------------------
     * HTTP
     * ---------------------------------------------------------------------- */
    function httpGet(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    timeout: SETTINGS.REQUEST_TIMEOUT_MS,
                    headers: { Accept: 'text/html,application/xhtml+xml' },
                    onload: (r) => resolve({ status: r.status, text: r.responseText || '', finalUrl: r.finalUrl || url }),
                    onerror: () => reject(new NetworkError('Network error')),
                    ontimeout: () => reject(new NetworkError('Request timed out')),
                });
                return;
            }

            // Fallback: same-origin fetch (works because we only ever request
            // listing pages on the site we are already browsing).
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), SETTINGS.REQUEST_TIMEOUT_MS);
            fetch(url, { credentials: 'include', signal: ctrl.signal })
                .then(async (r) => resolve({ status: r.status, text: await r.text(), finalUrl: r.url }))
                .catch((e) => reject(new NetworkError(e.name === 'AbortError' ? 'Request timed out' : e.message)))
                .finally(() => clearTimeout(timer));
        });
    }

    /* -------------------------------------------------------------------------
     * Worker: fetch -> parse -> analyse
     * ---------------------------------------------------------------------- */
    async function analyseListing(job) {
        const res = await httpGet(job.url);

        if ([403, 429, 503].includes(res.status)) throw new RateLimitError(`HTTP ${res.status}`, res.status);
        if (res.status < 200 || res.status >= 300) throw new HttpError(`HTTP ${res.status}`, res.status);

        const doc = new DOMParser().parseFromString(res.text, 'text/html');
        const adapter = LIDSiteAdapters.forHost(location.hostname);

        if (LIDSiteAdapters.looksBlocked(doc, res.finalUrl, LIDDetector.normalize)) {
            throw new RateLimitError('Bot challenge or login page detected', res.status);
        }

        const description = LIDSiteAdapters.extractDescription(doc, adapter);
        const result = LIDDetector.analyze(job.title, description);

        Cache.set(job.key, result);
        return result;
    }

    /* -------------------------------------------------------------------------
     * Wire-up
     * ---------------------------------------------------------------------- */
    let core = null;
    const queue = new ThrottledQueue(analyseListing, {
        onStateChange: (state) => core && core.setQueueState(state),
    });

    core = LIDContentCore.start({
        css: typeof LID_INLINE_CSS === 'string' ? LID_INLINE_CSS : '',
        showProgressBadges: SETTINGS.SHOW_PROGRESS_BADGES,
        debug: SETTINGS.DEBUG,
        requestAnalysis(job) {
            const cached = Cache.get(job.key);
            if (cached) return Promise.resolve(cached);
            return queue.submit(job);
        },
    });
})();
