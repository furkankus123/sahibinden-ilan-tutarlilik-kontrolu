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
