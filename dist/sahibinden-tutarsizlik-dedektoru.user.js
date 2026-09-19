// ==UserScript==
// @name         Sahibinden Tutarsızlık Dedektörü
// @name:en      Sahibinden Listing Inconsistency Detector
// @namespace    https://github.com/Furkankus123/sahibinden-ilan-tutarlilik-kontrolu
// @version      2.0.0
// @description  Başlıkta "hatasız / boyasız / değişensiz / tramersiz" yazan, ancak ilan açıklamasında boya, değişen parça veya hasar kaydı geçen ilanları işaretler.
// @description:en  Flags car listings whose titles claim "hatasız / boyasız / değişensiz / tramersiz" while the detail description mentions paint, replaced parts or damage records.
// @author       Furkankus123
// @license      MIT
// @homepageURL  https://github.com/Furkankus123/sahibinden-ilan-tutarlilik-kontrolu
// @supportURL   https://github.com/Furkankus123/sahibinden-ilan-tutarlilik-kontrolu/issues
// @match        https://www.sahibinden.com/*
// @match        https://sahibinden.com/*
// @connect      sahibinden.com
// @connect      www.sahibinden.com
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

// -----------------------------------------------------------------------------
// GENERATED FILE — do not edit.
// Built from src/ by build.ps1. Edit the sources and rebuild instead.
// -----------------------------------------------------------------------------


/* ===== src/detector.js ==================================================== */

/* =============================================================================
 * detector.js — pure text-analysis logic (no DOM, no network)
 *
 * This is the ONLY place the Turkish keyword/negation rules live. The
 * userscript, the Chrome extension and the test runner all load this same
 * file, so there is exactly one implementation to reason about and test.
 *
 * Everything here is a pure function: same input -> same output. That is what
 * makes tests/detector-tests.html possible without a browser extension,
 * a network connection, or sahibinden.com.
 * ========================================================================== */

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api; // Node, if ever
    root.LIDDetector = api;                                                 // browser / userscript
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /* -------------------------------------------------------------------------
     * KEYWORDS
     * ---------------------------------------------------------------------- */
    /**
     * Severity tiers. A repainted panel and a registered damage record are both
     * contradictions of "hatasız", but they are not the same finding, and a
     * buyer scanning a results page needs to tell them apart without reading
     * a tooltip. PAINT is shown orange, MAJOR red.
     */
    const SEVERITY = {
        PAINT: 'paint',   // cosmetic: the car has been repainted somewhere
        MAJOR: 'major',   // structural or on record: replaced parts, damage entry
    };

    /**
     * Shape version for the object analyze() returns.
     *
     * Verdicts are cached for 24 hours, so after a release the caches still hold
     * objects built by the PREVIOUS version. When severity was introduced, those
     * older entries had no `severity` field, came back from cache unchanged, and
     * every finding rendered red — the orange tier looked broken when it was
     * simply never reached. Bump this whenever the result shape changes; both
     * caches drop anything that does not match, so the fix is automatic.
     *
     * Bump it for a change of SHAPE **or** of CLASSIFICATION: a cached verdict
     * produced by older rules is just as wrong as one with missing fields, and
     * would otherwise survive in the cache for a full day after an update.
     *
     *   1 — status, cleanHits, evidence[{keyword, snippet}]
     *   2 — adds severity, words[], evidence[].severity
     *   3 — adds bare "boya" keyword + NEUTRAL_BEFORE/AFTER rules
     */
    const RESULT_SCHEMA = 3;

    const KEYWORDS = {
        // Title claims that the car is clean.
        CLEAN: ['hatasız', 'boyasız', 'değişensiz', 'tramersiz'],

        // Description evidence, each tagged with how serious it is.
        // Move a word between tiers here and the whole UI follows.
        DAMAGE: [
            { word: 'lokal boya',  severity: SEVERITY.PAINT },
            { word: 'boyalı',      severity: SEVERITY.PAINT },
            // Bare "boya" catches the most common disclosure phrasings —
            // "2 parça boya", "boya var", "boya yapılmış" — which the two
            // entries above miss entirely. It is safe because "boyasız" is
            // killed by the -siz suffix rule and the NEUTRAL lists below
            // exclude "boya raporu / kalınlığı / orijinal boyası".
            { word: 'boya',        severity: SEVERITY.PAINT },
            { word: 'değişen',     severity: SEVERITY.MAJOR },
            { word: 'tramer',      severity: SEVERITY.MAJOR },
            { word: 'hasar kaydı', severity: SEVERITY.MAJOR },
            { word: 'çarpma',      severity: SEVERITY.MAJOR },
            { word: 'sürtme',      severity: SEVERITY.MAJOR },
        ],
    };

    /* -------------------------------------------------------------------------
     * NEGATION / AFFIRMATION VOCABULARY
     *
     * All entries are written ASCII-folded (see normalize): ç->c, ğ->g, ı->i,
     * ö->o, ş->s, ü->u. Matching is done with an explicit word-start guard.
     * ---------------------------------------------------------------------- */

    // Words that NEGATE a preceding damage keyword: "tramer kaydı yoktur".
    //
    // These must be full negative forms, never prefixes. An earlier version used
    // the stem 'bulunma', which also matches the AFFIRMATIVE "bulunmaktadır"
    // ("there IS one") — the exact opposite meaning, and a silent false negative.
    const NEGATION_WORDS = [
        'yok', 'yoktur', 'yoktu', 'yoksa',
        'bulunmamaktadir', 'bulunmamakta', 'bulunmamis', 'bulunmamistir',
        'bulunmuyor', 'bulunmaz', 'bulunmadi',
        'degil', 'degildir',
        'olmayan', 'olmamis', 'olmamistir', 'olmadi',
        'icermez', 'icermiyor',
        'gormemis', 'gormemistir', 'gormedi',
        'sifir tl', '0 tl',
    ];

    // Words that AFFIRM a preceding damage keyword: "tramer kaydı vardır".
    // When one of these follows the keyword, the mention is a real disclosure —
    // it must never inherit a negation from a later list item.
    const AFFIRMATION_WORDS = [
        'var', 'vardir', 'mevcut', 'mevcuttur',
        'bulunmaktadir', 'bulunmakta', 'bulunuyor', 'bulunur',
        'yapilmis', 'yapildi', 'yapilmistir',
        'gormus', 'gormustur',
    ];

    // Suffixes that negate the keyword itself: "değişen" + "siz" -> "değişensiz".
    const NEGATION_SUFFIXES = ['siz', 'suz'];

    /**
     * Words that turn a keyword into something other than a damage disclosure.
     *
     * BEFORE the keyword: "orjinal boyalı" is factory paint — the opposite of
     * repainted — yet it reads as a paint hit without this list.
     * AFTER the keyword: "boya raporu", "boya kalınlığı ölçüldü" describe a
     * measurement or a document, not damage.
     */
    const NEUTRAL_BEFORE = ['orijinal', 'orjinal', 'fabrika', 'fabrikasyon'];
    const NEUTRAL_AFTER = [
        'kalite', 'kalinlik', 'kalinlig',
        'rapor', 'olcum', 'olcu', 'test',
        'renk', 'reng', 'kod',
        'orijinal', 'orjinal', 'fabrika',
    ];

    // Quantifiers/locators that mark a damage mention as a concrete DISCLOSURE
    // rather than a list item: "2 parça boyalı", "ön tampon boyalı".
    // A quantified mention is an assertion and cannot inherit negation.
    const QUANTIFIER_WORDS = [
        'parca', 'adet', 'bolge', 'nokta', 'lokal', 'kismi', 'hafif', 'az',
        'sadece', 'yalniz', 'sacak',
        'kapi', 'camurluk', 'tampon', 'kaput', 'bagaj', 'tavan', 'kapak',
        'ceyrek', 'marspiyel', 'davlumbaz', 'panel', 'far', 'ayna',
        'on', 'arka', 'sag', 'sol',
    ];

    const TUNING = {
        // How far after a damage keyword we look for a negation/affirmation word.
        NEGATION_WINDOW: 35,
        // How far before a damage keyword we look for a quantifier.
        QUANTIFIER_WINDOW: 25,
        // Max leftover letters allowed in a "connector only" gap (see below).
        MAX_CONNECTOR_REMNANT: 4,
    };

    /* -------------------------------------------------------------------------
     * NORMALIZATION
     * ---------------------------------------------------------------------- */

    const FOLD_MAP = {
        'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u',
        'â': 'a', 'î': 'i', 'û': 'u',
    };

    /**
     * Normalizes Turkish text for robust matching:
     *  - Turkish-aware lowercasing ("İ" -> "i", "I" -> "ı")
     *  - ASCII folding, so sellers who type "hatasiz" / "boyali" without
     *    Turkish characters are still matched
     *  - horizontal whitespace collapsed; newlines kept as sentence boundaries
     */
    function normalize(text) {
        return String(text || '')
            .toLocaleLowerCase('tr-TR')
            .replace(/[çğıöşüâîû]/g, (ch) => FOLD_MAP[ch])
            .replace(/[ \t\r\f\v ]+/g, ' ')
            .replace(/\n\s*/g, '\n')
            .trim();
    }

    const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Unicode-safe stand-in for \b at the start of a match: the character before
    // the match must not be a letter or digit.
    const WORD_START = '(?<![a-z0-9])';

    const alternation = (words) => words.map((w) => escapeRegExp(normalize(w))).join('|');

    const CLEAN_NORM = KEYWORDS.CLEAN.map(normalize);
    const DAMAGE_NORM = KEYWORDS.DAMAGE.map((d) => normalize(d.word));

    const NEG_SUFFIX_RE = new RegExp(`^(${alternation(NEGATION_SUFFIXES)})`);
    // The leading [a-z]{0,4} absorbs a Turkish possessive tail: in "boyası
    // orjinaldir" the gap after the keyword "boya" is "si orjinaldir".
    const NEUTRAL_AFTER_RE = new RegExp(`^[a-z]{0,4}\\s*(${alternation(NEUTRAL_AFTER)})[a-z]*`);
    const NEUTRAL_BEFORE_RE = new RegExp(`(${alternation(NEUTRAL_BEFORE)})[a-z]*\\s+$`);
    const NEG_WORD_RE = new RegExp(`${WORD_START}(${alternation(NEGATION_WORDS)})(?![a-z])`);
    const AFFIRM_WORD_RE = new RegExp(`${WORD_START}(${alternation(AFFIRMATION_WORDS)})(?![a-z])`);
    const QUANTIFIER_RE = new RegExp(`(\\d|${WORD_START}(${alternation(QUANTIFIER_WORDS)})(?![a-z]))`);

    /**
     * A gap between two damage keywords that is *only* a list connector,
     * e.g. "boyalı ve değişen yoktur" -> gap between them is " ve ".
     *
     * The leading [a-z]{0,N} absorbs the tail of an overlapping match: when
     * "lokal boya" matches inside "lokal boyalı", two letters ("li") are left
     * over. It is length-bounded on purpose — an unbounded [a-z]* would let a
     * whole unrelated word pass as a "connector".
     */
    const CONNECTOR_ONLY_RE = new RegExp(
        `^[a-z]{0,${TUNING.MAX_CONNECTOR_REMNANT}}[\\s,/&+-]*(ve|veya|ya da|ile|ayrica)?[\\s,/&+-]*$`
    );

    /* -------------------------------------------------------------------------
     * TITLE ANALYSIS
     * ---------------------------------------------------------------------- */

    /** Returns the clean-claim keywords present in a title (original spelling). */
    function findCleanKeywords(title) {
        const t = normalize(title);
        return KEYWORDS.CLEAN.filter((_, i) =>
            new RegExp(WORD_START + escapeRegExp(CLEAN_NORM[i])).test(t)
        );
    }

    /* -------------------------------------------------------------------------
     * DESCRIPTION ANALYSIS
     * ---------------------------------------------------------------------- */

    /** Collects every damage-keyword occurrence, longest-match-wins on overlap. */
    function collectMatches(text) {
        const hits = [];
        DAMAGE_NORM.forEach((kw, i) => {
            const re = new RegExp(WORD_START + escapeRegExp(kw), 'g');
            let m;
            while ((m = re.exec(text)) !== null) {
                hits.push({
                    keyword: KEYWORDS.DAMAGE[i].word,
                    severity: KEYWORDS.DAMAGE[i].severity,
                    start: m.index,
                    end: m.index + kw.length,
                });
            }
        });

        // Sort by position, preferring the longer match at the same position,
        // then drop anything that overlaps a match we already kept.
        hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

        const kept = [];
        let lastEnd = -1;
        for (const h of hits) {
            if (h.start >= lastEnd) { kept.push(h); lastEnd = h.end; }
        }
        return kept;
    }

    /** True when a concrete quantifier/part name precedes the match in the same clause. */
    function isQuantified(text, match) {
        const from = Math.max(0, match.start - TUNING.QUANTIFIER_WINDOW);
        let before = text.slice(from, match.start);

        // Never look past a clause boundary.
        const boundary = before.search(/[.!?;\n][^.!?;\n]*$/);
        if (boundary !== -1) before = before.slice(boundary + 1);

        return QUANTIFIER_RE.test(before);
    }

    /**
     * Decides, for each damage keyword occurrence, whether it is negated.
     *
     * Rules, in priority order:
     *   1. Suffix         "değişensiz"                  -> negated
     *   2. Negation word  "tramer kaydı yoktur"         -> negated
     *   3. Affirmation    "tramer kaydı vardır"         -> asserted (never inherits)
     *   4. Quantified     "2 parça boyalı, ..."         -> asserted (never inherits)
     *   5. List inherit   "boyalı ve değişen yoktur"    -> inherits from the next item
     *   6. Otherwise                                    -> not negated
     *
     * Resolved right-to-left so rule 5 can read the already-resolved next item.
     */
    function resolveNegation(text, matches) {
        for (let i = matches.length - 1; i >= 0; i--) {
            const m = matches[i];
            const next = matches[i + 1];

            // Window: NEGATION_WINDOW chars, cut short at a sentence boundary.
            let limit = Math.min(text.length, m.end + TUNING.NEGATION_WINDOW);
            const sentenceEnd = text.slice(m.end).search(/[.!?;\n]/);
            if (sentenceEnd !== -1) limit = Math.min(limit, m.end + sentenceEnd);

            // ...and cut short again at the next keyword in the same clause.
            const nextInClause = !!next && next.start <= limit;
            if (nextInClause) limit = Math.min(limit, next.start);

            const tail = text.slice(m.end, limit);

            const before = text.slice(Math.max(0, m.start - 20), m.start);

            if (NEG_SUFFIX_RE.test(tail)) {
                m.negated = true;
            } else if (NEG_WORD_RE.test(tail)) {
                m.negated = true;
            } else if (NEUTRAL_AFTER_RE.test(tail) || NEUTRAL_BEFORE_RE.test(before)) {
                // Not a denial, but not a disclosure either: a paint report,
                // a thickness measurement, or original factory paint.
                m.negated = true;
            } else if (AFFIRM_WORD_RE.test(tail)) {
                m.negated = false;
            } else if (isQuantified(text, m)) {
                m.negated = false;
            } else if (nextInClause && CONNECTOR_ONLY_RE.test(tail)) {
                m.negated = !!next.negated;
            } else {
                m.negated = false;
            }
        }
        return matches;
    }

    /**
     * Finds non-negated damage evidence in a description.
     * @param {string} rawText raw description text
     * @returns {Array<{keyword: string, snippet: string}>}
     */
    function findDamageEvidence(rawText) {
        const text = normalize(rawText);
        const matches = resolveNegation(text, collectMatches(text));

        return matches
            .filter((m) => !m.negated)
            .map((m) => ({
                keyword: m.keyword,
                severity: m.severity,
                snippet: '…' + text
                    .slice(Math.max(0, m.start - 30), Math.min(text.length, m.end + 40))
                    .replace(/\n/g, ' ') + '…',
            }));
    }

    /** MAJOR wins: one damage record outranks any amount of paint. */
    function worstSeverity(evidence) {
        return evidence.some((e) => e.severity === SEVERITY.MAJOR) ? SEVERITY.MAJOR : SEVERITY.PAINT;
    }

    /**
     * The distinct keywords behind a verdict, for the badge.
     * De-duplicated and capped, because the badge sits inline in a results row.
     */
    function evidenceWords(evidence, limit = 3) {
        const seen = [];
        for (const e of evidence) {
            if (!seen.includes(e.keyword)) seen.push(e.keyword);
            if (seen.length >= limit) break;
        }
        return seen;
    }

    /**
     * Full verdict for one listing.
     * @param {string} title       listing title from the search results page
     * @param {string|null} description  description text from the detail page
     * @returns {{status: string, severity: string|null, cleanHits: string[],
     *            evidence: object[], words: string[]}}
     *          status: 'not-a-claim' | 'no-description' | 'inconsistent' | 'consistent'
     *          severity: 'paint' | 'major' (only when inconsistent)
     */
    function analyze(title, description) {
        const cleanHits = findCleanKeywords(title);
        const empty = { schema: RESULT_SCHEMA, severity: null, cleanHits, evidence: [], words: [] };

        if (cleanHits.length === 0) return { status: 'not-a-claim', ...empty };
        if (!description) return { status: 'no-description', ...empty };

        const evidence = findDamageEvidence(description);
        if (evidence.length === 0) return { status: 'consistent', ...empty };

        return {
            schema: RESULT_SCHEMA,
            status: 'inconsistent',
            severity: worstSeverity(evidence),
            cleanHits,
            evidence,
            words: evidenceWords(evidence),
        };
    }

    /** True when a cached verdict was produced by this version of the shape. */
    function isCurrentSchema(result) {
        return !!result && result.schema === RESULT_SCHEMA;
    }

    return {
        SEVERITY,
        RESULT_SCHEMA,
        isCurrentSchema,
        KEYWORDS,
        TUNING,
        normalize,
        findCleanKeywords,
        findDamageEvidence,
        worstSeverity,
        evidenceWords,
        analyze,
        // exposed for tests
        _internal: { collectMatches, resolveNegation, isQuantified },
    };
});


/* ===== src/site-adapters.js =============================================== */

/* =============================================================================
 * site-adapters.js — per-site DOM knowledge
 *
 * Everything that depends on a specific site's HTML lives here, so that adding
 * a new classified site means adding one object (plus a @match / host_permission
 * entry) and touching nothing else.
 * ========================================================================== */

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.LIDSiteAdapters = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const ADAPTERS = [
        {
            name: 'sahibinden',
            hostPattern: /(^|\.)sahibinden\.com$/i,

            // Listing cards across list view, gallery view and fallbacks.
            rowSelector: 'tr.searchResultsItem, li.searchResultsItem, .searchResultsGalleryItem',

            // Title link inside a row — first match wins.
            titleLinkSelectors: [
                'a.classifiedTitle',
                '.searchResultsTitleValue a',
                'a[href*="/ilan/"]',
            ],

            // Rows that are ads/promos rather than real listings.
            isIgnoredRow: (row) =>
                row.classList.contains('nativeAd') ||
                (row.classList.contains('searchResultsPromoSuper') && !row.querySelector('a[href*="/ilan/"]')),

            // Description container on the detail page — first match wins.
            // Ordered most-specific first so a generic `.description` elsewhere
            // on the page can never win over the real one.
            descriptionSelectors: [
                '#classifiedDescription',
                '.classifiedDescription',
                '[itemprop="description"]',
            ],
        },

        /* ---------------------------------------------------------------------
         * TEST ADAPTER — only ever matches localhost, so it is inert in
         * production. Used by tests/e2e.html to exercise the full
         * scan -> fetch -> parse -> highlight pipeline offline.
         * ------------------------------------------------------------------ */
        {
            name: 'localhost-fixture',
            hostPattern: /^(localhost|127\.0\.0\.1)$/i,
            rowSelector: 'tr.searchResultsItem',
            titleLinkSelectors: ['a.classifiedTitle'],
            isIgnoredRow: () => false,
            descriptionSelectors: ['#classifiedDescription'],
        },
    ];

    /** Returns the adapter for a hostname, or null if the site is unsupported. */
    function forHost(hostname) {
        return ADAPTERS.find((a) => a.hostPattern.test(hostname)) || null;
    }

    /** Finds the title link inside a listing row using the adapter's selectors. */
    function findTitleLink(row, adapter) {
        for (const sel of adapter.titleLinkSelectors) {
            const link = row.querySelector(sel);
            if (link && link.href) return link;
        }
        return null;
    }

    /**
     * Extracts readable description text from a parsed detail-page document.
     * Block elements get a trailing newline so text from adjacent paragraphs
     * cannot glue together ("...boyalı</p><p>tramer..." -> "boyalıtramer").
     */
    function extractDescription(doc, adapter) {
        let container = null;
        for (const sel of adapter.descriptionSelectors) {
            container = doc.querySelector(sel);
            if (container) break;
        }
        if (!container) return null;

        container.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
        container.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
        container.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6')
            .forEach((el) => el.append('\n'));

        const text = container.textContent.trim();
        return text.length ? text : null;
    }

    /**
     * Detects anti-bot / captcha / login pages that come back with HTTP 200.
     * Without this the script would read a challenge page as "no damage found"
     * and mark deceitful listings as clean.
     */
    function looksBlocked(doc, finalUrl, normalize) {
        const url = String(finalUrl || '');
        const title = normalize(doc.title || '');
        // Challenge pages are tiny; a real listing page has far more text than this.
        const lead = normalize((doc.body && doc.body.textContent || '').slice(0, 400));

        return (
            // --- sahibinden's own interstitial, observed live on 2026-09-19 ----
            // Path /cs/tloading, title "sahibinden.com Yükleniyor", body
            // "Tarayıcınızı kontrol ediyoruz...". NONE of the generic patterns
            // below match it, so without these three rules the queue would read
            // a challenge page as a valid empty listing and never back off.
            /\/cs\/(tloading|captcha)/i.test(url) ||
            /tarayicinizi kontrol|guvenlik dogrulamasi|devam et butonuna/.test(lead) ||
            /yukleniyor/.test(title) ||

            // --- generic challenge / login signatures -------------------------
            /captcha|challenge|dogrulama|olagandisi|just a moment|access denied|erisim engellendi/.test(title) ||
            /\/(giris|login|secure|captcha)/i.test(url) ||
            !!doc.querySelector('form[action*="captcha"], #captcha, .g-recaptcha, [data-sitekey]')
        );
    }

    /** Canonical cache key for a listing URL (origin + path, no query/hash). */
    function canonicalKey(href, base) {
        try {
            const u = new URL(href, base);
            return u.origin + u.pathname.replace(/\/+$/, '');
        } catch {
            return String(href);
        }
    }

    return { ADAPTERS, forHost, findTitleLink, extractDescription, looksBlocked, canonicalKey };
});


/* ===== src/queue.js ======================================================= */

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


/* ===== src/content-core.js ================================================ */

/* =============================================================================
 * content-core.js — everything that touches the results page DOM
 *
 * Deliberately knows nothing about HOW a listing gets analysed. The caller
 * supplies `requestAnalysis(job) -> Promise<result>`; the userscript fulfils it
 * with GM_xmlhttpRequest in-page, the extension by messaging its service
 * worker. That keeps this file identical in both builds.
 * ========================================================================== */

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.LIDContentCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const LABELS = {
        major: '⚠️ TUTARSIZ',
        paint: '🎨 BOYALI',
        queued: '⏳ sırada…',
        checking: '⏳ kontrol ediliyor…',
        waiting: '⏸ bekleniyor…',
        ok: '✓ tutarlı',
        noDescription: '? açıklama yok',
        error: '⚠ kontrol edilemedi',
        blocked: '⚠ engellendi',
    };

    function start(options) {
        const {
            requestAnalysis,
            showProgressBadges = true,
            css = null,
            debug = false,
        } = options;

        const Detector = globalThis.LIDDetector;
        const Sites = globalThis.LIDSiteAdapters;

        const log = (...a) => debug && console.log('%c[LID]', 'color:#c00;font-weight:bold', ...a);
        const warn = (...a) => console.warn('[LID]', ...a);

        const adapter = Sites.forHost(location.hostname);
        if (!adapter) return null;

        /* ---------------------------------------------------------------------
         * Styles
         * ------------------------------------------------------------------ */
        if (css && !document.getElementById('lid-styles')) {
            const style = document.createElement('style');
            style.id = 'lid-styles';
            style.textContent = css;
            (document.head || document.documentElement).appendChild(style);
        }

        /* ---------------------------------------------------------------------
         * Status panel
         * ------------------------------------------------------------------ */
        const stats = { checked: 0, flagged: 0, painted: 0, errors: 0 };
        const errorReasons = new Map();   // reason -> count, for the panel summary
        let queueState = { queued: 0, pausedSeconds: 0 };
        let panelEl = null;

        /**
         * Condenses an error into a few words fit for a badge.
         * Without this every failure looks identical ("kontrol edilemedi"),
         * which hides whether 30 listings hit a 404, a timeout, or a dead
         * background worker — three problems with three different fixes.
         */
        function shortReason(err) {
            if (err && err.name === 'RateLimitError') return LABELS.blocked;
            const msg = (err && err.message) || 'bilinmiyor';
            const http = /^HTTP (\d{3})$/.exec(msg);
            if (http) return 'HTTP ' + http[1];
            if (/zaman aşımı|timed out|AbortError/i.test(msg)) return 'zaman aşımı';
            if (/ulaşılamadı|disconnected|başlatılamadı|port/i.test(msg)) return 'bağlantı koptu';
            if (/failed to fetch|network/i.test(msg)) return 'ağ hatası';
            return msg.slice(0, 24);
        }

        /** The most common failure, so the panel can name it. */
        function topErrorReason() {
            let best = null;
            for (const [reason, count] of errorReasons) {
                if (!best || count > best[1]) best = [reason, count];
            }
            return best;
        }

        function renderPanel() {
            if (!panelEl) {
                panelEl = document.createElement('div');
                panelEl.id = 'lid-panel';
                document.body.appendChild(panelEl);
            }
            if (queueState.queued === 0 && stats.checked === 0 && stats.errors === 0) {
                panelEl.style.display = 'none';
                return;
            }
            panelEl.style.display = 'block';

            const top = topErrorReason();
            panelEl.innerHTML =
                `🔍 Kuyruk: ${queueState.queued} &nbsp;|&nbsp; Kontrol: ${stats.checked}<br>` +
                `⚠️ Tutarsız: <b>${stats.flagged}</b> &nbsp;|&nbsp; ` +
                `🎨 Boyalı: <i>${stats.painted}</i> &nbsp;|&nbsp; Hata: ${stats.errors}` +
                (queueState.pausedSeconds > 0
                    ? `<br>⏸️ Hız sınırı: ${queueState.pausedSeconds} sn bekleniyor`
                    : '') +
                // Naming the dominant failure turns "31 errors" into something
                // actionable without opening DevTools.
                (top ? `<br>↳ ${top[0]} (${top[1]})` : '');
        }

        /* ---------------------------------------------------------------------
         * Badges
         * ------------------------------------------------------------------ */
        // Findings, as opposed to progress/error chatter. These are the point of
        // the script and are shown even when progress badges are switched off.
        const FINDING_VARIANTS = ['danger', 'paint'];

        /**
         * Row background per severity. Deliberately here rather than in
         * styles.css: the host page's own row rules can out-specify anything we
         * write as a class, so these are applied as inline !important styles,
         * which no stylesheet can override.
         */
        const ROW_BACKGROUNDS = {
            major: '#ffe6e6',   // red
            paint: '#fff1e6',   // orange
        };

        /** Paints the row and its direct cells, beating the host page's CSS. */
        function applyRowBackground(row, color) {
            row.style.setProperty('background-color', color, 'important');
            row.querySelectorAll(':scope > td').forEach((cell) =>
                cell.style.setProperty('background-color', color, 'important'));
        }

        function setBadge(job, variant, label, tooltip = '') {
            if (!FINDING_VARIANTS.includes(variant) && !showProgressBadges) return;

            let badge = job.row.querySelector('.lid-badge');
            if (!badge) {
                badge = document.createElement('span');
                job.titleLink.insertAdjacentElement('afterend', badge);
            }
            badge.className = `lid-badge lid-badge--${variant}`;
            badge.textContent = label;
            badge.title = tooltip;
        }

        function renderResult(job, result) {
            switch (result.status) {
                case 'inconsistent': {
                    // Paint alone is a milder finding than a replaced part or a
                    // damage record, so it gets its own orange treatment rather
                    // than being lumped in with the red one.
                    // A verdict with no severity can only come from a cache
                    // written by an older build. The schema check should have
                    // rejected it; if one slips through, treat it as MAJOR —
                    // never downgrade a warning we cannot re-derive.
                    const paintOnly = result.severity === 'paint';

                    // The words that produced the verdict, shown inline: a buyer
                    // should know WHY a row is flagged without hovering it.
                    const words = (result.words && result.words.length
                        ? result.words
                        : Detector.evidenceWords(result.evidence)).join(', ');

                    job.row.classList.add(paintOnly ? 'lid-paint' : 'lid-inconsistent');
                    applyRowBackground(job.row, ROW_BACKGROUNDS[paintOnly ? 'paint' : 'major']);
                    job.titleLink.classList.add('lid-strike', paintOnly ? 'lid-strike--paint' : 'lid-strike--major');

                    const details = result.evidence.map((e) => `• ${e.keyword}: ${e.snippet}`).join('\n');
                    setBadge(
                        job,
                        paintOnly ? 'paint' : 'danger',
                        `${paintOnly ? LABELS.paint : LABELS.major} · ${words}`,
                        `Başlıkta: ${result.cleanHits.join(', ')}\n\n`
                        + `Açıklamada bulunanlar:\n${details}`
                    );
                    break;
                }
                case 'consistent':
                    setBadge(job, 'ok', LABELS.ok, 'Açıklamada çelişkili ifade bulunamadı.');
                    break;
                case 'no-description':
                    setBadge(job, 'error', LABELS.noDescription, 'İlan sayfasında açıklama bulunamadı.');
                    break;
                default:
                    job.row.querySelector('.lid-badge')?.remove();
            }
        }

        /* ---------------------------------------------------------------------
         * Scanning
         * ------------------------------------------------------------------ */
        async function handleRow(row) {
            if (adapter.isIgnoredRow(row)) return;

            const titleLink = Sites.findTitleLink(row, adapter);
            if (!titleLink) return;

            const title = (titleLink.getAttribute('title') || titleLink.textContent || '').trim();

            // The whole point of the title filter: listings that make no "clean"
            // claim are never fetched, which keeps request volume low.
            const cleanHits = Detector.findCleanKeywords(title);
            if (cleanHits.length === 0) return;

            const job = {
                row,
                titleLink,
                title,
                cleanHits,
                url: titleLink.href,
                key: Sites.canonicalKey(titleLink.href, location.href),
                adapterName: adapter.name,
                isStale: () => !row.isConnected,
                onRetry: () => setBadge(job, 'pending', LABELS.waiting, 'Hız sınırı nedeniyle beklemede.'),
            };

            setBadge(job, 'pending', LABELS.queued);

            try {
                const result = await requestAnalysis(job);
                if (!row.isConnected) return; // page changed while we waited

                stats.checked++;
                if (result.status === 'inconsistent') {
                    if (result.severity === 'paint') stats.painted++; else stats.flagged++;
                }
                log(result.status.toUpperCase(), job.title, result.evidence);
                renderResult(job, { ...result, cleanHits });
            } catch (err) {
                if (err && err.message === 'stale') return;
                stats.errors++;

                const reason = shortReason(err);
                errorReasons.set(reason, (errorReasons.get(reason) || 0) + 1);
                warn(`Failed [${reason}]: ${job.url} ->`, err && err.message);

                const blocked = err && err.name === 'RateLimitError';
                setBadge(job, 'error',
                    blocked ? LABELS.blocked : `⚠ ${reason}`,
                    blocked
                        ? 'Site istekleri engelledi; bir süre sonra tekrar deneyin.'
                        : `Hata: ${err && err.message}\n${job.url}`);
            }
            renderPanel();
        }

        function scanPage() {
            document.querySelectorAll(adapter.rowSelector).forEach((row) => {
                if (row.dataset.lidProcessed) return;
                row.dataset.lidProcessed = '1';
                handleRow(row);
            });
            renderPanel();
        }

        /* ---------------------------------------------------------------------
         * Bootstrap
         * ------------------------------------------------------------------ */
        scanPage();

        // The site replaces result rows via AJAX (filters, sorting, paging).
        // scanPage() is idempotent, so the badges we add ourselves are harmless
        // re-triggers of this observer.
        let debounce = null;
        new MutationObserver(() => {
            clearTimeout(debounce);
            debounce = setTimeout(scanPage, 600);
        }).observe(document.body, { childList: true, subtree: true });

        // Keeps the rate-limit countdown ticking even when nothing else happens.
        setInterval(renderPanel, 1000);

        log(`Initialized for ${adapter.name}.`);

        return {
            adapter,
            rescan: scanPage,
            setQueueState(state) { queueState = state; renderPanel(); },
        };
    }

    return { start, LABELS };
});


/* ===== src/styles.css ===================================================== */

const LID_INLINE_CSS = "/* =============================================================================\n * styles.css — visual treatment for flagged listings\n * Loaded by the extension via the manifest, and inlined into the userscript\n * by build.ps1. Keep selectors prefixed with `lid-` to avoid colliding with\n * the host site\u0027s own CSS.\n * ========================================================================== */\n\n/* ROW BACKGROUNDS ARE NOT SET HERE.\n *\n * The host page styles its own result rows, and a rule selected by class loses\n * to any id-based rule the site has, even with !important — specificity is\n * compared before !important among important declarations. Rather than fight\n * that with ever-longer selectors, content-core.js writes the row background as\n * an inline `!important` style, which nothing in a stylesheet can outrank.\n *\n * The colours therefore live in ROW_BACKGROUNDS in src/content-core.js.\n * The .lid-inconsistent / .lid-paint classes are still applied, so the rows\n * stay selectable for tests and for anyone restyling them. */\n\n.lid-strike {\n    text-decoration: line-through !important;\n    text-decoration-thickness: 2px !important;\n}\n\n.lid-strike--major { text-decoration-color: #cc0000 !important; }\n.lid-strike--paint { text-decoration-color: #c2410c !important; }\n\n.lid-badge {\n    display: inline-block;\n    margin: 4px 0 0 6px;\n    padding: 2px 8px;\n    border-radius: 4px;\n    font: bold 11px/1.5 Arial, sans-serif;\n    vertical-align: middle;\n    white-space: nowrap;\n    cursor: help;\n}\n\n/* #c2410c keeps white text at ~4.8:1 contrast, which a lighter orange would not. */\n.lid-badge--danger  { background: #d40000; color: #fff; box-shadow: 0 0 0 2px #ffb3b3; font-size: 12px; }\n.lid-badge--paint   { background: #c2410c; color: #fff; box-shadow: 0 0 0 2px #fdba74; font-size: 12px; }\n.lid-badge--pending { background: #eeeeee; color: #666; font-weight: normal; }\n.lid-badge--ok      { background: #e3f6e3; color: #1d7a1d; font-weight: normal; }\n.lid-badge--error   { background: #fff1d6; color: #9a6400; font-weight: normal; }\n\n#lid-panel {\n    position: fixed;\n    right: 12px;\n    bottom: 12px;\n    z-index: 2147483647;\n    background: rgba(30, 30, 30, .92);\n    color: #fff;\n    font: 12px/1.4 Arial, sans-serif;\n    padding: 8px 12px;\n    border-radius: 6px;\n    box-shadow: 0 2px 8px rgba(0, 0, 0, .3);\n    max-width: 280px;\n    pointer-events: none;\n}\n\n#lid-panel b { color: #ff6b6b; }\n";


/* ===== src/userscript-glue.js ============================================= */

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
