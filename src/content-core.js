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
            // Supplied by the glue: the extension writes to chrome.storage via
            // its service worker, the userscript to GM storage. Defaults to a
            // no-op so the tests can run content-core without any storage.
            recordFeedback = () => {},
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

            // A finding replaces any progress badge wholesale, because it is a
            // different element (a button plus its details panel).
            job.row.querySelector('.lid-finding')?.remove();

            let badge = job.row.querySelector('.lid-badge');
            if (!badge) {
                badge = document.createElement('span');
                job.titleLink.insertAdjacentElement('afterend', badge);
            }
            badge.className = `lid-badge lid-badge--${variant}`;
            badge.textContent = label;
            badge.title = tooltip;
        }

        /**
         * Renders a finding as a collapsed chip that expands on click.
         *
         * The reasons used to live in a `title` tooltip, which meant they were
         * invisible until hovered, could not be read on a touch screen, and
         * vanished the moment the pointer moved. A chip that stays put and
         * opens in place is readable, scannable down a column of results, and
         * lets a buyer compare two listings without chasing tooltips.
         */
        /**
         * "Bu karar doğru / yanlış" buttons.
         *
         * A verdict the tool cannot be corrected on is a verdict nobody can
         * improve. Each click stores one labelled example locally — the raw
         * material for fixing the vocabulary, and the only way to ever train
         * something better than hand-written rules.
         */
        function buildFeedbackRow(job, result) {
            const row = document.createElement('div');
            row.className = 'lid-feedback';

            const label = document.createElement('span');
            label.textContent = 'Bu karar doğru mu?';
            row.appendChild(label);

            const done = (verdictText) => {
                row.textContent = verdictText;
                row.classList.add('lid-feedback--done');
            };

            for (const [key, text] of [['correct', '✓ Doğru'], ['wrong', '✗ Yanlış']]) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = `lid-fb lid-fb--${key}`;
                b.textContent = text;
                b.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    try {
                        recordFeedback({
                            label: key,
                            url: job.key,
                            title: job.title,
                            status: result.status,
                            severity: result.severity || null,
                            reasons: result.reasons || [],
                            // The sentences behind the verdict. Kept locally for
                            // the user's own export, and the only part that is
                            // ever eligible for upload (see src/upload.js).
                            snippets: (result.evidence || []).map((e) => e.snippet),
                            at: new Date().toISOString(),
                        });
                        done('Teşekkürler, kaydedildi.');
                    } catch (err) {
                        warn('feedback failed:', err && err.message);
                        done('Kaydedilemedi.');
                    }
                });
                row.appendChild(b);
            }
            return row;
        }

        function renderFinding(job, result, paintOnly) {
            job.row.querySelector('.lid-badge')?.remove();
            job.row.querySelector('.lid-finding')?.remove();

            const reasons = (result.reasons && result.reasons.length)
                ? result.reasons
                : Detector.evidenceWords(result.evidence);

            const wrap = document.createElement('span');
            wrap.className = 'lid-finding';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `lid-badge lid-badge--${paintOnly ? 'paint' : 'danger'}`;
            btn.setAttribute('aria-expanded', 'false');

            const head = document.createElement('span');
            head.textContent = `${paintOnly ? LABELS.paint : LABELS.major} · ${reasons[0]}`
                + (reasons.length > 1 ? ` +${reasons.length - 1}` : '');

            const caret = document.createElement('span');
            caret.className = 'lid-caret';
            caret.textContent = '⊕';

            btn.append(head, caret);

            const panel = document.createElement('div');
            panel.className = 'lid-details';
            panel.hidden = true;

            const claim = document.createElement('div');
            claim.className = 'lid-details__claim';
            claim.textContent = `Başlıkta: ${result.cleanHits.join(', ')}`;
            panel.appendChild(claim);

            const list = document.createElement('ul');
            list.className = 'lid-details__list';
            for (const e of result.evidence) {
                const li = document.createElement('li');
                const what = document.createElement('b');
                what.textContent = e.reason || e.keyword;
                const quote = document.createElement('span');
                quote.className = 'lid-details__quote';
                quote.textContent = e.snippet;
                li.append(what, quote);
                list.appendChild(li);
            }
            panel.appendChild(list);
            panel.appendChild(buildFeedbackRow(job, result));

            // The row is a link; without this the click navigates away.
            btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const open = panel.hidden;
                panel.hidden = !open;
                btn.setAttribute('aria-expanded', String(open));
                caret.textContent = open ? '⊖' : '⊕';
                // Collapsed it sits inline after the title; open it needs the
                // full row width, otherwise the panel is pushed to the right
                // of the title and wraps awkwardly.
                wrap.classList.toggle('lid-finding--open', open);
            });

            wrap.append(btn, panel);
            job.titleLink.insertAdjacentElement('afterend', wrap);
        }

        /** The "✓ tutarlı" chip: no reasons to list, but still correctable. */
        function renderConsistent(job, result) {
            if (!showProgressBadges) return;

            job.row.querySelector('.lid-badge')?.remove();
            job.row.querySelector('.lid-finding')?.remove();

            const wrap = document.createElement('span');
            wrap.className = 'lid-finding';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'lid-badge lid-badge--ok';
            btn.setAttribute('aria-expanded', 'false');
            btn.textContent = LABELS.ok + ' ⊕';

            const panel = document.createElement('div');
            panel.className = 'lid-details lid-details--ok';
            panel.hidden = true;

            const note = document.createElement('div');
            note.className = 'lid-details__claim';
            note.textContent = 'Açıklamada çelişkili ifade bulunamadı.';
            panel.append(note, buildFeedbackRow(job, result));

            btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const open = panel.hidden;
                panel.hidden = !open;
                btn.setAttribute('aria-expanded', String(open));
                btn.textContent = LABELS.ok + (open ? ' ⊖' : ' ⊕');
                wrap.classList.toggle('lid-finding--open', open);
            });

            wrap.append(btn, panel);
            job.titleLink.insertAdjacentElement('afterend', wrap);
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

                    job.row.classList.add(paintOnly ? 'lid-paint' : 'lid-inconsistent');
                    applyRowBackground(job.row, ROW_BACKGROUNDS[paintOnly ? 'paint' : 'major']);
                    job.titleLink.classList.add('lid-strike', paintOnly ? 'lid-strike--paint' : 'lid-strike--major');

                    renderFinding(job, result, paintOnly);
                    break;
                }
                case 'consistent':
                    // Also expandable, because a MISSED deceitful listing is the
                    // costlier error and the only way to hear about one is to
                    // let the user say so here.
                    renderConsistent(job, result);
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
