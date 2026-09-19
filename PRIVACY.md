# Privacy Policy — Sahibinden Tutarsızlık Dedektörü

_Last updated: 19 September 2026_

## Short version

This extension collects nothing, sends nothing anywhere, and has no server.
Everything it does happens inside your own browser.

## What the extension does

When you open a search results page on sahibinden.com, the extension reads the
listing titles already on that page. For any title claiming the car is
`hatasız`, `boyasız`, `değişensiz` or `tramersiz`, it requests that listing's
own detail page — the same page you would get by clicking the link — and reads
the description text to check whether it contradicts the title.

Those requests go to **sahibinden.com only**, using your existing browser
session, exactly as if you had opened the listing yourself. No third party is
contacted. There is no analytics, no telemetry, no error reporting, and no
remote server operated by the developer.

## What is stored, and where

| Data | Where | Why | Leaves your device? |
|---|---|---|---|
| Verdicts per listing URL (`inconsistent` / `consistent` / no description, plus matched keywords) | `chrome.storage.local` | Avoids re-requesting a listing you already checked. Expires after 24 hours; capped at 600 entries. | **No** |
| Two preferences (extension on/off, show "consistent" badges) | `chrome.storage.sync` | Keeps your settings consistent across your Chrome profiles. | Only through **your own** Chrome Sync, to your Google account. Two booleans; no browsing data. |

Clearing the cache at any time: open the extension's popup and press
**"Önbelleği temizle"**. Removing the extension deletes both stores.

## What is NOT collected

- No browsing history
- No search queries, filters, or which listings you viewed
- No account details, cookies, credentials, or personal information
- No identifiers of any kind — there is no user ID, because there are no users
  to identify
- Nothing is ever sold, shared, or transferred to anyone

## Permissions and why each is needed

- **`storage`** — to keep the verdict cache and your two preferences, as above.
- **Host access to `sahibinden.com`** — to read the results page you are on and
  to request listing detail pages from that same site. The extension has access
  to no other website.

## Accuracy

Verdicts are produced by keyword matching on Turkish text. They are a hint, not
a finding of fact, and will sometimes be wrong in both directions. Nothing shown
by this extension is an accusation against any seller. Read the listing yourself
before drawing conclusions.

## Contact

Open an issue at <https://github.com/Furkankus123/sahibinden-ilan-tutarlilik-kontrolu/issues>.

## Changes

Any change to this policy will be published in this file and reflected in the
extension's Chrome Web Store listing before a new version is submitted.
