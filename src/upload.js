/* =============================================================================
 * upload.js — decides exactly what may leave the user's machine
 *
 * This file is the privacy boundary. Everything the extension would ever send
 * to the shared corpus passes through buildPayload(), and buildPayload() is a
 * pure function so it can be tested exhaustively without a network.
 *
 * Two rules it exists to enforce:
 *
 *   1. ALLOW-LIST, never deny-list. Fields are copied out one by one. A field
 *      added to the local store later — a URL, a title, a user id — cannot leak
 *      by being forgotten, because nothing is copied unless it is named here.
 *
 *   2. SCRUB the free text. Seller descriptions routinely contain phone
 *      numbers, plates and e-mail addresses. "Anonymous" is not a property of
 *      the transport; it has to be done to the text itself.
 * ========================================================================== */

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.LIDUpload = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const LIMITS = {
        PAYLOAD_VERSION: 1,
        MAX_ITEMS: 200,
        MAX_SENTENCE: 300,
        MAX_REASONS: 6,
        MAX_REASON: 80,
        MAX_TERM: 40,
        MAX_EXAMPLE: 200,
        MAX_VERSION: 16,
    };

    const STATUSES = ['inconsistent', 'consistent', 'no-description'];
    const SEVERITIES = ['paint', 'major'];
    const LABELS = ['correct', 'wrong'];

    /**
     * Removes anything that could identify a person from free text.
     * Order matters: e-mail before digit runs, so the local part of an address
     * is not half-masked first.
     */
    function scrub(text) {
        return String(text || '')
            // e-mail
            .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[eposta]')
            // urls
            .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[link]')
            // Turkish plates: 34 ABC 123 / 06-AB-1234
            .replace(/\b\d{2}\s*[-\s]?\s*[a-zA-ZçğıöşüÇĞİÖŞÜ]{1,3}\s*[-\s]?\s*\d{2,4}\b/g, '[plaka]')
            // phone numbers and any long digit run (IMEI, account numbers, ...).
            // Anchored on a final digit so the separator after the number is
            // not swallowed, which would glue the mask to the next word.
            .replace(/(?:\+?\d[\s()\-.]?){6,}\d/g, '[numara]')
            // leftover 5+ digit runs
            .replace(/\b\d{5,}\b/g, '[numara]')
            .replace(/\s+/g, ' ')
            .trim();
    }

    const clip = (text, max) => {
        const s = scrub(text);
        return s.length > max ? s.slice(0, max) : s;
    };

    const oneOf = (value, allowed) => (allowed.includes(value) ? value : null);

    /**
     * One feedback record, reduced to its linguistic content.
     * The local store also holds `url` and `title`; neither is read here.
     */
    function feedbackItem(entry) {
        const label = oneOf(entry && entry.label, LABELS);
        const status = oneOf(entry && entry.status, STATUSES);
        if (!label || !status) return null;

        return {
            kind: 'feedback',
            label,
            status,
            severity: oneOf(entry.severity, SEVERITIES),
            reasons: (Array.isArray(entry.reasons) ? entry.reasons : [])
                .slice(0, LIMITS.MAX_REASONS)
                .map((r) => clip(r, LIMITS.MAX_REASON))
                .filter(Boolean),
            // The sentence that produced the verdict — the whole point of
            // collecting anything at all.
            sentences: (Array.isArray(entry.snippets) ? entry.snippets : [])
                .slice(0, LIMITS.MAX_REASONS)
                .map((s) => clip(s, LIMITS.MAX_SENTENCE))
                .filter(Boolean),
        };
    }

    /** One unknown-vocabulary record. */
    function termItem(term) {
        const word = clip(term && term.term, LIMITS.MAX_TERM);
        if (!word || !/[a-zçğıöşü]/i.test(word)) return null;

        return {
            kind: 'term',
            term: word,
            count: Math.min(Number(term.count) || 1, 9999),
            example: clip(term.example, LIMITS.MAX_EXAMPLE),
        };
    }

    /**
     * Builds the complete request body.
     * @param {object} input { feedback[], terms[], version, includeTerms }
     * @returns {{v:number, ext:string, items:object[]}}
     */
    function buildPayload({ feedback = [], terms = [], version = '0', includeTerms = true } = {}) {
        const items = [];

        for (const entry of feedback) {
            const item = feedbackItem(entry);
            if (item) items.push(item);
            if (items.length >= LIMITS.MAX_ITEMS) break;
        }

        if (includeTerms) {
            for (const term of terms) {
                if (items.length >= LIMITS.MAX_ITEMS) break;
                const item = termItem(term);
                if (item) items.push(item);
            }
        }

        return {
            v: LIMITS.PAYLOAD_VERSION,
            ext: clip(version, LIMITS.MAX_VERSION),
            items,
        };
    }

    /**
     * Last line of defence, used by the tests and by the sender before it
     * transmits: walks the finished payload looking for anything that smells
     * identifying. Returns a list of problems; empty means safe to send.
     */
    function auditPayload(payload) {
        const problems = [];
        const banned = [
            [/https?:\/\//i, 'url'],
            [/\bwww\./i, 'url'],
            [/[\w.+-]+@[\w-]+\.[\w]+/, 'email'],
            [/\d{5,}/, 'long digit run'],
            [/sahibinden\.com/i, 'site reference'],
            [/\/ilan\//i, 'listing path'],
        ];

        const walk = (value, path) => {
            if (typeof value === 'string') {
                for (const [re, name] of banned) {
                    if (re.test(value)) problems.push(`${path}: ${name}`);
                }
            } else if (Array.isArray(value)) {
                value.forEach((v, i) => walk(v, `${path}[${i}]`));
            } else if (value && typeof value === 'object') {
                for (const [k, v] of Object.entries(value)) {
                    if (k === 'url' || k === 'title') problems.push(`${path}.${k}: forbidden field`);
                    walk(v, `${path}.${k}`);
                }
            }
        };

        walk(payload, 'payload');
        return problems;
    }

    return { LIMITS, scrub, buildPayload, auditPayload };
});
