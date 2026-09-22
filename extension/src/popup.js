/* =============================================================================
 * popup.js — toolbar popup: master switch, badge preference, cache stats
 * ========================================================================== */

'use strict';

const DEFAULTS = { enabled: true, showProgressBadges: true };

const $ = (id) => document.getElementById(id);

/* -----------------------------------------------------------------------------
 * Settings
 * -------------------------------------------------------------------------- */
async function loadSettings() {
    const s = await chrome.storage.sync.get(DEFAULTS);
    $('enabled').checked = s.enabled;
    $('badges').checked = s.showProgressBadges;
}

function bindToggle(id, key) {
    $(id).addEventListener('change', (e) => {
        chrome.storage.sync.set({ [key]: e.target.checked });
    });
}

/* -----------------------------------------------------------------------------
 * Stats
 * -------------------------------------------------------------------------- */
async function loadStats() {
    const { cached, flagged } = await chrome.runtime.sendMessage({ type: 'stats' });
    $('cached').textContent = cached;
    $('flagged').textContent = flagged;
    $('clear').disabled = cached === 0;
}

$('clear').addEventListener('click', async () => {
    $('clear').disabled = true;
    $('clear').textContent = 'Temizleniyor…';
    await chrome.runtime.sendMessage({ type: 'clear-cache' });
    $('clear').textContent = 'Önbelleği temizle';
    await loadStats();
});

/* -----------------------------------------------------------------------------
 * Learning data — feedback the user gave and vocabulary we did not recognise.
 * Local only; leaves the machine only through this explicit export.
 * -------------------------------------------------------------------------- */
async function loadCorpus() {
    const s = await chrome.runtime.sendMessage({ type: 'corpus-stats' });
    $('fb').textContent = s.feedback;
    $('wrong').textContent = s.wrong;
    $('terms').textContent = s.terms;
    const empty = s.feedback === 0 && s.terms === 0;
    $('export').disabled = empty;
    $('clearCorpus').disabled = empty;
}

$('export').addEventListener('click', async () => {
    const data = await chrome.runtime.sendMessage({ type: 'corpus-export' });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lid-corpus-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('clearCorpus').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'corpus-clear' });
    await loadCorpus();
});

/* -----------------------------------------------------------------------------
 * Anonymous contribution.
 *
 * Turning this on is the only way the extension ever talks to a server, so it
 * also has to obtain a host permission the default install does not hold. If
 * the user declines that prompt, the switch goes back off — the setting must
 * never claim to be on while nothing can actually be sent.
 * -------------------------------------------------------------------------- */
const SHARE_ORIGIN = 'https://*.workers.dev/*';

async function loadShare() {
    const { shareEnabled } = await chrome.storage.sync.get({ shareEnabled: false });
    const granted = await chrome.permissions.contains({ origins: [SHARE_ORIGIN] });
    $('share').checked = shareEnabled && granted;
}

$('share').addEventListener('change', async (e) => {
    if (!e.target.checked) {
        await chrome.storage.sync.set({ shareEnabled: false });
        return;
    }
    const granted = await chrome.permissions.request({ origins: [SHARE_ORIGIN] });
    if (!granted) {
        e.target.checked = false;
        return;
    }
    await chrome.storage.sync.set({ shareEnabled: true });
});

$('preview').addEventListener('click', async () => {
    const box = $('previewBox');
    if (!box.hidden) { box.hidden = true; return; }

    const info = await chrome.runtime.sendMessage({ type: 'share-preview' });
    box.textContent = info.pending === 0
        ? 'Gönderilecek yeni veri yok.'
        : `${info.pending} kayıt bekliyor. Örnek gövde:\n\n`
          + JSON.stringify(info.payload, null, 2);
    box.hidden = false;
});

bindToggle('enabled', 'enabled');
bindToggle('badges', 'showProgressBadges');

loadSettings();
loadStats();
loadCorpus();
loadShare();
