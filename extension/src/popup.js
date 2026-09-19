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

bindToggle('enabled', 'enabled');
bindToggle('badges', 'showProgressBadges');

loadSettings();
loadStats();
