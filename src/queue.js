/* =============================================================================
 * queue.js — throttled, self-backing-off request queue
 *
 * One queue instance = one request stream. The userscript runs an instance
 * per page; the extension runs a single instance in the service worker, so
 * opening five result tabs still produces one polite request stream instead
 * of five. That difference is the main reason the extension is safer to use.
 * ========================================================================== */

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.LIDQueue = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const DEFAULTS = {
        DELAY_MIN_MS: 1500,
        DELAY_MAX_MS: 4000,
        RATE_LIMIT_BASE_PAUSE_MS: 60 * 1000,
        RATE_LIMIT_MAX_PAUSE_MS: 10 * 60 * 1000,
        MAX_RETRIES: 3,
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

    /** Thrown for 403/429/503 and bot-challenge pages: the queue pauses on these. */
    class RateLimitError extends Error {
        constructor(message, status) { super(message); this.name = 'RateLimitError'; this.status = status; }
    }
    /** Thrown for other non-2xx responses: the job is dropped, the queue continues. */
    class HttpError extends Error {
        constructor(message, status) { super(message); this.name = 'HttpError'; this.status = status; }
    }
    /** Thrown for transport failures and timeouts. */
    class NetworkError extends Error {
        constructor(message) { super(message); this.name = 'NetworkError'; }
    }

    class ThrottledQueue {
        /**
         * @param {(job:object)=>Promise<any>} worker  performs one job; may throw
         * @param {object} options  overrides for DEFAULTS, plus:
         *        onStateChange(state)  called whenever queue stats change
         */
        constructor(worker, options = {}) {
            this.worker = worker;
            this.opts = { ...DEFAULTS, ...options };
            this.onStateChange = options.onStateChange || (() => {});

            this.jobs = [];
            this.inFlight = new Map();   // key -> Promise, so duplicate URLs share one request
            this.running = false;
            this.pausedUntil = 0;
            this.consecutiveRateLimits = 0;
        }

        get state() {
            return {
                queued: this.jobs.length,
                running: this.running,
                pausedUntil: this.pausedUntil,
                pausedSeconds: Math.max(0, Math.ceil((this.pausedUntil - Date.now()) / 1000)),
            };
        }

        /**
         * Schedules a job and resolves with the worker's return value.
         * Calling this twice with the same `key` returns the same promise
         * instead of issuing a second request.
         * @returns {Promise<any>}
         */
        submit(job) {
            if (this.inFlight.has(job.key)) return this.inFlight.get(job.key);

            const promise = new Promise((resolve, reject) => {
                this.jobs.push({ ...job, retries: 0, resolve, reject });
            }).finally(() => this.inFlight.delete(job.key));

            this.inFlight.set(job.key, promise);
            this.onStateChange(this.state);
            this._run();
            return promise;
        }

        async _run() {
            if (this.running) return;
            this.running = true;

            try {
                while (this.jobs.length > 0) {
                    // Honour an active rate-limit pause before touching the network.
                    const pauseLeft = this.pausedUntil - Date.now();
                    if (pauseLeft > 0) await sleep(pauseLeft);

                    // Randomized human-like gap before every request, including the first.
                    await sleep(randomBetween(this.opts.DELAY_MIN_MS, this.opts.DELAY_MAX_MS));

                    const job = this.jobs.shift();
                    this.onStateChange(this.state);

                    // The caller may have lost interest (tab closed, rows replaced).
                    if (job.isStale && job.isStale()) {
                        job.reject(new Error('stale'));
                        continue;
                    }

                    try {
                        const result = await this.worker(job);
                        this.consecutiveRateLimits = 0;
                        job.resolve(result);
                    } catch (err) {
                        if (err instanceof RateLimitError) {
                            this._handleRateLimit(job, err);
                        } else {
                            job.reject(err); // 404 / network / parse: drop this one, keep going
                        }
                    }
                    this.onStateChange(this.state);
                }
            } finally {
                this.running = false;
                this.onStateChange(this.state);
            }
        }

        /** Exponential back-off with jitter; the job goes back to the front of the line. */
        _handleRateLimit(job, err) {
            this.consecutiveRateLimits++;
            const pause = Math.min(
                this.opts.RATE_LIMIT_BASE_PAUSE_MS * 2 ** (this.consecutiveRateLimits - 1),
                this.opts.RATE_LIMIT_MAX_PAUSE_MS
            ) + randomBetween(0, 15000);

            this.pausedUntil = Date.now() + pause;
            job.retries++;

            if (job.retries <= this.opts.MAX_RETRIES) {
                this.jobs.unshift(job);
                if (job.onRetry) job.onRetry(job.retries, pause);
            } else {
                job.reject(err);
            }
            this.onStateChange(this.state);
        }
    }

    return { ThrottledQueue, RateLimitError, HttpError, NetworkError, DEFAULTS };
});
