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
| Feedback you give by pressing "✓ Doğru" / "✗ Yanlış": the listing URL and title, the verdict shown, and when | `chrome.storage.local` | Lets you correct a wrong verdict so the rules can be improved. Recorded **only** when you press one of those buttons. | **No**, unless you press "JSON olarak dışa aktar" and send the file somewhere yourself. |
| Words from listing descriptions that the extension does not recognise, with a short example sentence and a count | `chrome.storage.local` | Shows which Turkish vocabulary is missing, so the matcher can be extended from real listings instead of guesswork. Taken from descriptions already fetched for analysis; no extra requests. | **No**, same as above. |

Clearing at any time: the extension's popup has **"Önbelleği temizle"** for the
verdict cache and **"Öğrenme verisini sil"** for the feedback and vocabulary.
Removing the extension deletes all of it.

Nothing in the table above is uploaded anywhere by default. The export button
writes a file to your own computer; what happens to that file afterwards is
entirely your choice.

## Optional: contributing anonymously

There is one setting — **"Anonim katkı"**, off unless you switch it on — that
sends corrections to a shared collection so the Turkish matching rules can be
improved for everyone.

It cannot send anything until two separate things happen: you turn the switch
on, **and** you accept the additional site permission Chrome then asks for. A
default installation holds no permission for any host except sahibinden.com.

When it is on, a contribution contains only:

- the sentence that produced the verdict, with phone numbers, plates, e-mail
  addresses and long digit runs replaced by placeholders
- the verdict that was shown and whether you marked it correct or wrong
- words the extension did not recognise, with one example sentence
- the extension's version number

It never contains the listing URL, the listing title, an account name, a device
or user identifier, a cookie, or anything about which listings you looked at.
The code that builds a contribution copies fields one by one from a fixed list,
so a field added to the local store later cannot leak by being overlooked, and
every contribution is checked for identifying content immediately before it is
sent — a failed check cancels the upload. Both the list and the check are
covered by the test suite in `tests/detector-tests.html`.

The receiving server stores no IP address. For its daily request limit it keeps
a salted hash of the address for the current day only.

Press **"Ne gönderileceğini göster"** in the popup to read the exact contents of
the next contribution before it leaves. Turning the switch back off stops all
sending immediately.

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
