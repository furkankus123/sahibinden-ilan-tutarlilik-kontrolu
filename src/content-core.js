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
