/* =============================================================================
 * diagnose.js — paste into the DevTools console ON sahibinden.com
 *
 * Reports whether the selectors in src/site-adapters.js match the live markup,
 * and if they do not, discovers what the real markup looks like. Works on both
 * a search results page and a listing detail page.
 *
 * Usage:  F12 -> Console -> paste -> Enter -> copy the output.
 * Reads the DOM only. Makes no network requests and changes nothing.
 * ========================================================================== */

(function diagnose() {
    const L = [];
    const say = (s) => L.push(s);
    const cls = (el) => (el && el.className && typeof el.className === 'string')
        ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.')
        : '(no class)';

    say('=== LID DIAGNOSTIC ===');
    say('url    : ' + location.href.slice(0, 120));
    say('title  : ' + document.title);

    const isDetail = /\/ilan\//.test(location.pathname);
    say('page   : ' + (isDetail ? 'DETAIL' : 'RESULTS'));
    say('');

    if (!isDetail) {
        /* ---------------- RESULTS PAGE ---------------- */
        say('-- row selectors (need > 0) --');
        const rowSels = ['tr.searchResultsItem', 'li.searchResultsItem', '.searchResultsGalleryItem'];
        let rows = [];
        for (const s of rowSels) {
            const n = document.querySelectorAll(s);
            say('  ' + String(n.length).padStart(4) + '  ' + s);
            if (n.length > rows.length) rows = [...n];
        }

        say('');
        say('-- title link selectors --');
        const linkSels = ['a.classifiedTitle', '.searchResultsTitleValue a', 'a[href*="/ilan/"]'];
        for (const s of linkSels) {
            say('  ' + String(document.querySelectorAll(s).length).padStart(4) + '  ' + s);
        }

        say('');
        if (rows.length) {
            say('-- sample titles from matched rows --');
            let withLink = 0;
            rows.slice(0, 5).forEach((r, i) => {
                let link = null;
                for (const s of linkSels) { link = r.querySelector(s); if (link && link.href) break; }
                if (link) {
                    withLink++;
                    const t = (link.getAttribute('title') || link.textContent || '').trim();
                    say('  [' + i + '] ' + t.slice(0, 70));
                    say('       href=' + (link.getAttribute('href') || '').slice(0, 70));
                } else {
                    say('  [' + i + '] NO TITLE LINK FOUND  row=' + cls(r));
                }
            });
            say('  rows with a usable link: ' + withLink + '/' + Math.min(5, rows.length));
        } else {
            say('!! NO ROWS MATCHED — discovering actual markup...');
            const anchors = [...document.querySelectorAll('a[href*="/ilan/"]')].slice(0, 6);
            say('  anchors to /ilan/: ' + document.querySelectorAll('a[href*="/ilan/"]').length);
            anchors.forEach((a, i) => {
                const box = a.closest('tr, li, article, div[class]');
                say('  [' + i + '] a' + cls(a));
                say('       container: <' + (box ? box.tagName.toLowerCase() : '?') + '> ' + cls(box));
                say('       text: ' + (a.textContent || '').trim().slice(0, 55));
            });
        }

        say('');
        say('-- clean-claim titles (what the script would fetch) --');
        const KW = ['hatasiz', 'boyasiz', 'degisensiz', 'tramersiz'];
        const norm = (t) => String(t || '').toLocaleLowerCase('tr-TR')
            .replace(/[çğıöşüâîû]/g, (c) => ({ 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u' }[c]));
        const all = [...document.querySelectorAll('a[href*="/ilan/"]')];
        const hits = all.filter((a) => {
            const t = norm(a.getAttribute('title') || a.textContent);
            return KW.some((k) => t.includes(k));
        });
        say('  ' + hits.length + ' of ' + all.length + ' listing links claim clean');
        hits.slice(0, 3).forEach((a) => say('    • ' + (a.textContent || '').trim().slice(0, 65)));

    } else {
        /* ---------------- DETAIL PAGE ---------------- */
        say('-- description selectors (need a match) --');
        const descSels = ['#classifiedDescription', '.classifiedDescription', '[itemprop="description"]'];
        let found = null;
        for (const s of descSels) {
            const el = document.querySelector(s);
            say('  ' + (el ? 'FOUND' : '  -  ') + '  ' + s + (el ? '  (' + el.textContent.trim().length + ' chars)' : ''));
            if (el && !found) found = el;
        }

        if (found) {
            say('');
            say('-- extracted text (first 300 chars) --');
            say('  ' + found.textContent.replace(/\s+/g, ' ').trim().slice(0, 300));
        } else {
            say('');
            say('!! NO DESCRIPTION CONTAINER — discovering candidates...');
            const cands = [...document.querySelectorAll('[id], [class]')].filter((el) => {
                const key = ((el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '')).toLowerCase();
                return /descr|aciklama|açıklama/.test(key);
            }).slice(0, 8);
            cands.forEach((el) => say('  <' + el.tagName.toLowerCase() + '> #' + (el.id || '-') + ' ' + cls(el)
                + '  (' + el.textContent.trim().length + ' chars)'));
        }
    }

    say('');
    say('=== END ===');

    const report = L.join('\n');
    console.log(report);
    try { copy(report); console.log('%c(copied to clipboard)', 'color:green'); } catch (e) {}
    return report;
})();
