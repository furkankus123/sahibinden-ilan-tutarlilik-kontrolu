/* =============================================================================
 * lexicon.js — Turkish car-listing vocabulary for slot extraction
 *
 * detector.js answers "is there damage evidence here, and is it negated?".
 * This file supplies the vocabulary needed to answer the next question:
 * WHAT was damaged, and HOW MUCH. That turns a bare keyword hit ("boyalı")
 * into a reason a human can read ("ön kapı boyalı", "2 parça boya").
 *
 * All entries are written ASCII-folded, matching LIDDetector.normalize():
 * ç->c, ğ->g, ı->i, ö->o, ş->s, ü->u.
 * ========================================================================== */

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.LIDLexicon = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /**
     * Body panels and components a seller names when disclosing damage.
     * `label` is the display spelling; `stem` is what we match, deliberately
     * cut before the Turkish suffix so "kapida", "kapisi", "kapinin" all hit
     * the same entry. Longer stems are tried first so "on kapi" wins over "kapi".
     */
    const PARTS = [
        { stem: 'marspiyel',  label: 'marşpiyel' },
        { stem: 'camurluk',   label: 'çamurluk' },
        { stem: 'davlumbaz',  label: 'davlumbaz' },
        { stem: 'tampon',     label: 'tampon' },
        { stem: 'kaput',      label: 'kaput' },
        { stem: 'bagaj',      label: 'bagaj' },
        { stem: 'tavan',      label: 'tavan' },
        { stem: 'kapi',       label: 'kapı' },
        { stem: 'ceyrek',     label: 'çeyrek panel' },
        { stem: 'panel',      label: 'panel' },
        { stem: 'direk',      label: 'direk' },
        { stem: 'far',        label: 'far' },
        { stem: 'ayna',       label: 'ayna' },
        { stem: 'kapak',      label: 'kapak' },
        { stem: 'sacak',      label: 'saçak' },
        { stem: 'motor',      label: 'motor' },
        { stem: 'sasi',       label: 'şasi' },
    ];

    /**
     * Position words that qualify a part: "ön kapı", "sağ arka çamurluk".
     * Kept separate from PARTS so they can combine freely.
     */
    const POSITIONS = [
        { stem: 'sag on',  label: 'sağ ön' },
        { stem: 'sag arka', label: 'sağ arka' },
        { stem: 'sol on',  label: 'sol ön' },
        { stem: 'sol arka', label: 'sol arka' },
        { stem: 'on',      label: 'ön' },
        { stem: 'arka',    label: 'arka' },
        { stem: 'sag',     label: 'sağ' },
        { stem: 'sol',     label: 'sol' },
    ];

    /** Turkish number words, so "iki parça boya" reads as well as "2 parça boya". */
    const NUMBER_WORDS = {
        bir: 1, iki: 2, uc: 3, dort: 4, bes: 5,
        alti: 6, yedi: 7, sekiz: 8, dokuz: 9, on: 10,
    };

    /** Counting units that follow a number: "2 parça", "3 adet", "bir bölge". */
    const COUNT_UNITS = ['parca', 'adet', 'bolge', 'nokta', 'yer'];

    /**
     * How each damage keyword should be phrased in a reason line.
     * Without this "boya" would render as "ön kapı boya" instead of
     * "ön kapı boyalı".
     */
    const KEYWORD_PHRASING = {
        'boya':        'boyalı',
        'boyalı':      'boyalı',
        'lokal boya':  'lokal boyalı',
        'değişen':     'değişen',
        'tramer':      'tramer kaydı',
        'hasar kaydı': 'hasar kaydı',
        'çarpma':      'çarpma',
        'sürtme':      'sürtme',
    };

    /**
     * Whole-phrase readings that beat the generic "part + keyword" assembly.
     * These are the cases where a literal assembly would read badly.
     */
    const STANDALONE = ['tramer', 'hasar kaydı'];

    return { PARTS, POSITIONS, NUMBER_WORDS, COUNT_UNITS, KEYWORD_PHRASING, STANDALONE };
});
