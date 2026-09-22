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
     *   4 — adds evidence[].reason and reasons[] from slot extraction
     *   5 — snippets keep the seller's own spelling and quote a whole sentence
     */
    const RESULT_SCHEMA = 5;

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
        // Longest quoted sentence shown in the expanded reason panel. Long
        // enough to read a full disclosure, short enough not to paste the
        // whole advert into a results row.
        SNIPPET_MAX: 240,
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

    /** Whitespace tidied, but case and Turkish letters untouched. */
    function collapseWhitespace(text) {
        return String(text || '')
            .replace(/[ \t\r\f\v ]+/g, ' ')
            .replace(/\n\s*/g, '\n')
            .trim();
    }

    /**
     * Case-folds and strips Turkish diacritics WITHOUT changing the length,
     * one UTF-16 unit in, one out.
     *
     * That guarantee is the whole point: it lets an index found in the folded
     * text address the exact same character in the original. Without it we can
     * only ever show the folded text back to the user, which is how snippets
     * ended up reading "parca ince cizik boyasi vardir" instead of
     * "parça ince çizik boyası vardır".
     */
    function toMatchable(display) {
        let out = '';
        for (let i = 0; i < display.length; i++) {
            const ch = display[i];
            const lower = ch.toLocaleLowerCase('tr-TR');
            const folded = FOLD_MAP[lower] !== undefined ? FOLD_MAP[lower] : lower;
            out += folded.length === 1 ? folded : ch;
        }
        return out;
    }

    /**
     * The two aligned views of a description: what we search, and what we show.
     * `match[i]` and `display[i]` are always the same character position.
     */
    function prepareText(raw) {
        const display = collapseWhitespace(raw);
        return { display, match: toMatchable(display) };
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

    /* -------------------------------------------------------------------------
     * SLOT EXTRACTION
     *
     * A keyword hit alone ("boyalı") is a poor explanation. These functions read
     * the clause around the hit for the two things a buyer actually wants —
     * WHICH panel and HOW MANY — and assemble a readable reason from them.
     * The vocabulary lives in lexicon.js.
     * ---------------------------------------------------------------------- */

    const Lex = () => (typeof globalThis !== 'undefined' ? globalThis.LIDLexicon : null);

    /** The sentence containing `pos`, as [start, end). Commas do not split it. */
    function sentenceBounds(text, pos) {
        const before = text.slice(0, pos);
        let start = 0;
        for (const ch of ['.', '!', '?', ';', '\n']) {
            start = Math.max(start, before.lastIndexOf(ch) + 1);
        }
        const rel = text.slice(pos).search(/[.!?;\n]/);
        return [start, rel === -1 ? text.length : pos + rel];
    }

    /** The clause containing `pos`, as [start, end). Commas DO split it. */
    function clauseBounds(text, pos) {
        const before = text.slice(0, pos);
        let start = 0;
        for (const ch of ['.', '!', '?', ';', '\n', ',']) {
            start = Math.max(start, before.lastIndexOf(ch) + 1);
        }
        const rel = text.slice(pos).search(/[.!?;\n,]/);
        return [start, rel === -1 ? text.length : pos + rel];
    }

    /** Nearest part name to the match, plus any position word qualifying it. */
    function findPart(clause, matchAt) {
        const lex = Lex();
        if (!lex) return null;

        let best = null;
        for (const part of lex.PARTS) {
            const re = new RegExp(WORD_START + escapeRegExp(part.stem), 'g');
            let m;
            while ((m = re.exec(clause)) !== null) {
                const distance = Math.abs(m.index - matchAt);
                if (!best || distance < best.distance) {
                    best = { part, at: m.index, distance };
                }
            }
        }
        if (!best) return null;

        // A position word immediately before the part: "sağ ön çamurluk".
        const lead = clause.slice(Math.max(0, best.at - 12), best.at);
        for (const pos of lex.POSITIONS) {
            if (new RegExp(`${WORD_START}${escapeRegExp(pos.stem)}\\s*$`).test(lead)) {
                return `${pos.label} ${best.part.label}`;
            }
        }
        return best.part.label;
    }

    /** A count expressed as digits or a Turkish number word: "2 parça", "iki bölge". */
    function findCount(clause) {
        const lex = Lex();
        if (!lex) return null;

        const units = lex.COUNT_UNITS.map(escapeRegExp).join('|');
        const words = Object.keys(lex.NUMBER_WORDS).map(escapeRegExp).join('|');
        const re = new RegExp(`${WORD_START}(\\d{1,2}|${words})\\s*(${units})`, 'i');

        const m = re.exec(clause);
        if (!m) return null;

        const n = /^\d+$/.test(m[1]) ? Number(m[1]) : lex.NUMBER_WORDS[m[1]];
        if (!n) return null;

        // Display the unit the seller used, in its original spelling.
        const unit = { parca: 'parça', adet: 'adet', bolge: 'bölge', nokta: 'nokta', yer: 'yer' }[m[2]] || m[2];
        return `${n} ${unit}`;
    }

    /**
     * Assembles the human-readable reason for one finding, e.g.
     *   "ön kapı boyalı", "2 parça boyalı", "tramer kaydı"
     */
    function buildReason(text, m) {
        const lex = Lex();
        const phrase = (lex && lex.KEYWORD_PHRASING[m.keyword]) || m.keyword;

        // "tramer kaydı" reads badly with a panel glued in front of it.
        if (lex && lex.STANDALONE.includes(m.keyword)) return phrase;

        const [cs, ce] = clauseBounds(text, m.start);
        const clause = text.slice(cs, ce);

        const part = findPart(clause, m.start - cs);
        if (part) return `${part} ${phrase}`;

        const count = findCount(clause);
        if (count) return `${count} ${phrase}`;

        return phrase;
    }

    /**
     * Finds non-negated damage evidence in a description.
     * @param {string} rawText raw description text
     * @returns {Array<{keyword: string, severity: string, reason: string, snippet: string}>}
     */
    /**
     * Trims a sentence down to `max` characters while keeping the matched
     * phrase inside it, and never cuts through the middle of a word.
     */
    function clipAround(text, from, to, max) {
        if (text.length <= max) return { text, cutStart: false, cutEnd: false };

        const slack = max - (to - from);
        let start = Math.max(0, from - Math.floor(slack * 0.4));
        let end = Math.min(text.length, start + max);
        start = Math.max(0, Math.min(start, end - max));

        // Snap outwards to whitespace so no word is sliced in half.
        if (start > 0) {
            const space = text.indexOf(' ', start);
            if (space !== -1 && space < from) start = space + 1;
        }
        if (end < text.length) {
            const space = text.lastIndexOf(' ', end);
            if (space !== -1 && space > to) end = space;
        }

        return {
            text: text.slice(start, end).trim(),
            cutStart: start > 0,
            cutEnd: end < text.length,
        };
    }

    /**
     * The sentence a finding came from, in the seller's own spelling.
     * A whole sentence reads far better than a fixed character window, which
     * used to start and end mid-word ("…tur.sadece 1 parca ince cizik boyasi").
     */
    function buildSnippet(display, match, m) {
        const [s, e] = sentenceBounds(match, m.start);

        // Replacing newlines is 1:1, so offsets survive it; trimming is not,
        // so the leading whitespace is measured and subtracted explicitly.
        const raw = display.slice(s, e).replace(/\n/g, ' ');
        const lead = raw.length - raw.replace(/^\s+/, '').length;
        const sentence = raw.trim();
        if (!sentence) return display.slice(m.start, m.end);

        const from = Math.max(0, m.start - s - lead);
        const to = Math.min(sentence.length, m.end - s - lead);

        const clipped = clipAround(sentence, from, to, TUNING.SNIPPET_MAX);
        return (clipped.cutStart ? '…' : '') + clipped.text + (clipped.cutEnd ? '…' : '');
    }

    function findDamageEvidence(rawText) {
        const { display, match } = prepareText(rawText);
        const matches = resolveNegation(match, collectMatches(match));

        return matches
            .filter((m) => !m.negated)
            .map((m) => ({
                keyword: m.keyword,
                severity: m.severity,
                reason: buildReason(match, m),
                snippet: buildSnippet(display, match, m),
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
        const empty = { schema: RESULT_SCHEMA, severity: null, cleanHits, evidence: [], words: [], reasons: [] };

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
            // Distinct, display-ready reason lines, in the order they appear in
            // the description. This is what the expandable badge renders.
            reasons: [...new Set(evidence.map((e) => e.reason))],
        };
    }

    /** True when a cached verdict was produced by this version of the shape. */
    function isCurrentSchema(result) {
        return !!result && result.schema === RESULT_SCHEMA;
    }

    /* -------------------------------------------------------------------------
     * CORPUS HARVESTING
     *
     * Every listing the user browses is free evidence about how Turkish sellers
     * actually phrase damage. This collects the words we do NOT yet understand
     * that sit in the same clause as a damage keyword — the exact place a
     * missing vocabulary entry would hide.
     *
     * It reads text already fetched for analysis. It never issues a request,
     * and it is the reason this works from ordinary browsing instead of a crawl.
     * ---------------------------------------------------------------------- */

    // Function words that carry no vocabulary signal.
    const STOPWORDS = new Set([
        've', 'ile', 'veya', 'ya', 'da', 'de', 'ki', 'ise', 'ama', 'fakat', 'ancak',
        'bir', 'bu', 'su', 'o', 'her', 'hic', 'tum', 'tumu', 'hepsi', 'diger', 'digeri',
        'icin', 'gibi', 'kadar', 'sonra', 'once', 'uzeri', 'uzerine', 'ayrica',
        'olarak', 'olan', 'olup', 'oldugu', 'edilmis', 'edilmistir', 'yapilan',
        'arac', 'aracin', 'aracimiz', 'araba', 'oto', 'otomobil', 'model', 'km',
        'sahibinden', 'satilik', 'fiyat', 'tl', 'not', 'bilgi', 'lutfen', 'ilgilenen',
        'tertemiz', 'temiz', 'bakimli', 'garanti', 'servis', 'ekspertiz', 'rapor',
        'degisim', 'takas', 'kredi', 'senet', 'pesin', 'anahtar', 'ruhsat',
    ]);

    /** Known stems, so "tamponda" and "kaputu" count as understood. */
    function knownStems() {
        const lex = Lex();
        const stems = [
            ...CLEAN_NORM,
            ...DAMAGE_NORM,
            ...NEGATION_WORDS, ...AFFIRMATION_WORDS,
            ...NEUTRAL_BEFORE, ...NEUTRAL_AFTER,
            ...QUANTIFIER_WORDS,
        ].map((w) => normalize(w));

        if (lex) {
            stems.push(
                ...lex.PARTS.map((p) => p.stem),
                ...lex.POSITIONS.map((p) => p.stem),
                ...lex.COUNT_UNITS,
                ...Object.keys(lex.NUMBER_WORDS)
            );
        }
        // Split multi-word stems into their parts. Keeping only the first word
        // left "kaydı" (from "tramer kaydı") looking unknown, which polluted
        // every harvest with a word we already understand.
        return stems
            .flatMap((s) => s.split(' '))
            .filter((s) => s.length >= 2);
    }

    let STEM_CACHE = null;

    function isKnownToken(token) {
        if (STOPWORDS.has(token)) return true;
        if (!STEM_CACHE) STEM_CACHE = knownStems();
        return STEM_CACHE.some((stem) => token.startsWith(stem));
    }

    /**
     * Unknown words sharing a clause with a damage keyword.
     * @returns {Array<{term: string, count: number, example: string}>}
     */
    function harvestTerms(rawText) {
        const text = normalize(rawText);
        const found = new Map();

        for (const m of collectMatches(text)) {
            // Sentence scope, NOT clauseBounds: that one also splits on commas,
            // which would drop "göçük var" from "göçük var, boyalı" — precisely
            // the neighbouring word we are trying to discover.
            const [cs, ce] = sentenceBounds(text, m.start);
            const clause = text.slice(cs, ce).trim();

            for (const token of clause.split(/[^a-z0-9]+/)) {
                if (token.length < 3 || /^\d/.test(token)) continue;
                if (isKnownToken(token)) continue;

                const entry = found.get(token)
                    || { term: token, count: 0, example: clause.slice(0, 140) };
                entry.count++;
                found.set(token, entry);
            }
        }
        return [...found.values()];
    }

    return {
        SEVERITY,
        RESULT_SCHEMA,
        isCurrentSchema,
        KEYWORDS,
        TUNING,
        normalize,
        harvestTerms,
        findCleanKeywords,
        findDamageEvidence,
        worstSeverity,
        evidenceWords,
        analyze,
        // exposed for tests
        _internal: { collectMatches, resolveNegation, isQuantified },
    };
});
