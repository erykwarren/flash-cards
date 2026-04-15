# Public CSV Data Source — Design

**Date:** 2026-04-14
**Status:** Drafted, awaiting implementation plan

## Problem

The app currently reads decks from Google Sheets via the authenticated Sheets API v4. This works but is awkward for the single-user (personal) workflow:

1. **Edits don't reflect automatically.** Adding a row to the source sheet only becomes visible after a manual "Sync" click or the 24 h auto-sync threshold passes.
2. **OAuth is heavy.** Google Identity Services, silent refresh, and the Drive-picker UI exist only to read three columns of public-ish data.
3. **Authoring / sharing friction.** Linking a deck means signing in, picking from Drive, and managing tokens that expire hourly.

## Goals

- Replace OAuth-authenticated reads with zero-auth public CSV fetches.
- Let the user add/remove decks from the app UI by pasting a sheet URL.
- Fetch every configured deck's CSV on every app load so new rows appear on refresh, not after a manual sync.
- Preserve all existing review scores across the migration.

## Non-goals

- Writing back to sheets (read-only, same as today).
- Supporting non-Google data sources (CSV files in the repo, markdown decks, etc.).
- A wizard that automates the "share this sheet" setup in Google Drive.
- Multi-user auth — this is a personal app on GitHub Pages.

## Approach

**Replace OAuth + Sheets API with an unauthenticated CSV fetch** against Google Sheets' public export URL:
`https://docs.google.com/spreadsheets/d/{spreadsheetId}/export?format=csv&gid={gid}`

The user must share each sheet as "Anyone with the link → Viewer." Decks are configured per-user in the app Settings (not checked into the repo).

### Why CSV and not "Sheets API with an API key"

Swapping OAuth for an API key (keeping the JSON endpoint) was considered — it reuses the existing `readSpreadsheet` code with ~5 lines changed and no new parser. It was rejected in favor of public CSV for two reasons: (a) CSV requires **zero credentials** in the client, so nothing needs to be committed or rotated, and (b) no GCP project state needs to be maintained going forward. Trade-off accepted: ~40 lines of hand-rolled CSV parser.

## What changes

### Removed
- `js/google.js` (Google Identity Services wrapper, token refresh, sign-in callbacks).
- `AuthStorage` in `js/storage.js`.
- The `auth` view in `index.html` (sign-in screen).
- The Drive-picker UI for linking decks.
- `SheetsService.readSpreadsheet`'s authenticated JSON path.
- `SyncService.autoSync` (replaced by on-load fetch-all).
- The Google Identity Services `<script>` tag in `index.html`.

### Added
- `js/sheets.js` — `fetchCsv(csvUrl)` and `parseCsv(text)`. Roughly 80 lines total.
- Settings-view markup and handlers for the add-deck form and the deck list.
- One-time migration logic in `app.js` init: for any deck with `spreadsheetId` but no `csvUrl`, build `csvUrl = https://docs.google.com/spreadsheets/d/{spreadsheetId}/export?format=csv&gid=0`.
- Extended `verify.html` tests for the CSV parser, URL parser, and `syncCards` round-trips.

### Modified
- `js/storage.js` — `DeckStorage` gains a `csvUrl` field (and keeps `spreadsheetId` / `gid` for reference). The "is this deck linked" check becomes `!!deck.csvUrl`. `AuthStorage` removed.
- `js/sync.js` — `syncDeck` keeps its shape but drops the auth check and now calls `SheetsService.fetchCsv` instead of the authenticated JSON endpoint. `autoSync` deleted. `getSyncStatus` kept and used by the deck list UI.
- `js/app.js` — removes `views: 'auth'`, sign-in / sign-out handlers, and Drive-picker logic. Adds on-load `Promise.all(decks.map(fetchAndSync))`. Adds add-deck form handler (URL parse → test fetch → create).
- `index.html` — script-order becomes: `version.js` → `storage.js` → `scheduler.js` → `sheets.js` → `sync.js` → `app.js`. Auth view removed; Settings view gains deck-list + add-deck form.
- `css/*` — remove unused auth-screen styles.

### Unchanged
- `ReviewStorage` and the append-only review-event log.
- `Scheduler` (stability, retrievability, `buildQueue`, `priorityShuffle`).
- `CardStorage.syncCards` diff/unarchive/archive logic.
- Deterministic `cardId` = first 16 hex chars of SHA-256(deckId + question + answer).
- The `/verify.html` harness shape (`VERIFY.assert`, `window.TESTS.push(...)`).

## Data flow

### On app load
```
DeckStorage.getAll()
  → for each deck in parallel:
      SheetsService.fetchCsv(deck.csvUrl)
        → GET deck.csvUrl (no auth)
        → parseCsv(text) → [{ question, answer, example }]
      CardStorage.syncCards(deck.id, rows)   // unchanged
      DeckStorage.update(deck.id, { lastSyncedAt: now })
```
Failed fetches (network error, 4xx, parse error) log a console warning and leave the cached `localStorage` copy in place. The user keeps studying from cached cards.

### Offline
If `navigator.onLine === false`, `fetchCsv` short-circuits with `{ success: false, error: 'offline' }`. Sync is skipped; cached cards remain usable.

### Manual refresh
Each deck row in the Settings deck list has a **Refresh** button that calls the same `fetchCsv → syncCards` pair and shows a toast with the sync stats (unchanged message format: "Synced successfully! X new, Y updated, Z archived.").

## Scores across the migration

Card IDs are SHA-256 of `(deckId, question, answer)`, and review events are an append-only log keyed by `cardId`. `Scheduler.calculateStability` recomputes from the log on every call. As long as a row's question+answer text is unchanged, its `cardId` is unchanged, and its review history carries over.

**Intentional edit behavior preserved:** editing a question's or answer's text changes the hash → new card + old card archived. The old card's review events remain in the log but are attached to the archived card. Per CLAUDE.md: "preserves review history on unchanged cards and drops it on edits."

## Settings UI

A **Decks** section inside the existing Settings view (not a separate tab).

### Sharing hint
Plain text block above the add form:
> Your sheet must be shared as "Anyone with the link → Viewer". In Google Sheets: File → Share → General access → Anyone with the link.

### Add-deck form
Two fields: *Deck name*, *Google Sheets URL*. On submit:
1. Parse URL → `{ spreadsheetId, gid }`. If parse fails, show: "That doesn't look like a Google Sheets URL."
2. Build `csvUrl` from `spreadsheetId` + `gid`.
3. Test-fetch the CSV. On 403/404: "Can't read this sheet. Make sure sharing is set to 'Anyone with the link → Viewer'." On other network error: "Couldn't reach Google. Check your connection."
4. On success: `DeckStorage.create({ name, spreadsheetId, gid, csvUrl })` then immediately call `syncDeck(deckId)`.

### Deck list
Each row shows:
- Deck name
- Card count (active, not archived)
- Last fetched time (e.g. "Synced 2 hours ago", via existing `getSyncStatus`)
- **Refresh** button (manual re-fetch)
- **Remove** button (archives all cards — same semantics as today's delete-deck)

## URL parsing

Input formats accepted:
- `https://docs.google.com/spreadsheets/d/{ID}/edit#gid={N}` (most common)
- `https://docs.google.com/spreadsheets/d/{ID}/edit?usp=sharing#gid={N}`
- `https://docs.google.com/spreadsheets/d/{ID}/edit` → `gid` defaults to `0`
- `https://docs.google.com/spreadsheets/d/{ID}/` → `gid` defaults to `0`

Rejected:
- Any URL that doesn't match `/spreadsheets/d/{ID}/`
- A bare spreadsheet ID without the URL wrapper (keeps validation strict; avoids silently accepting bogus input).

Return shape: `{ spreadsheetId, gid }` on success, `null` on failure.

## CSV parser

Hand-rolled, ~40 lines. Requirements:
- Three columns: question, answer, example (example optional).
- Handles double-quoted fields with embedded commas, embedded `\n` or `\r\n`, and escaped `""` for a literal quote.
- Accepts `\r\n` or `\n` line terminators.
- Skips empty rows (all three columns blank or whitespace).
- First row is checked with the existing `isHeaderRow` helper; if it matches, it's skipped.
- Missing third column returns `example: ''`, not `undefined`.

Output: `[{ question, answer, example }]`.

## Error handling

Keep it narrow:

| Failure | User-visible message |
|---|---|
| 4xx from Google | "Sheet not found or not public. Check sharing." |
| Network error | "Couldn't refresh. Using cached cards." |
| Parse error | "Couldn't read sheet format." |
| Offline (on-load sync) | Silent skip; cached cards load. |

Everything else is a `console.warn`. No retries, no exponential backoff, no structured recovery beyond "fall back to the cached `localStorage` copy."

## Migration path

Existing decks linked via OAuth have `spreadsheetId` populated but no `csvUrl`. On first load after this change, `app.js` init walks `DeckStorage.getAll()` and for any deck missing `csvUrl`, it writes `csvUrl = https://docs.google.com/spreadsheets/d/{spreadsheetId}/export?format=csv&gid=0` in place. If the subsequent fetch fails (sheet isn't public), the deck row shows a "needs re-sharing" banner with the sharing hint inline.

Since there is only one user of this app, accepting minor friction (re-sharing an existing sheet as public) is the chosen trade-off — no automated detection or re-auth prompt is built.

## Verification

Extend `verify.html` to load `js/sheets.js` and add three new test groups.

### CSV parser (~8 assertions)
- Three-column row with plain text
- Header row auto-skipped (reuses existing `isHeaderRow`)
- Quoted field containing a comma
- Quoted field containing an escaped `""`
- Quoted field containing an embedded newline
- `\r\n` line terminator handled
- Trailing blank rows stripped
- Missing third column → `example` is `''`, not `undefined`

### URL parser (~5 assertions)
- `https://docs.google.com/spreadsheets/d/ABC/edit#gid=123` → `{ spreadsheetId: 'ABC', gid: '123' }`
- URL with no `#gid` → `gid: '0'`
- URL with query params before the hash → still parses
- Non-Sheets URL → returns `null`
- Bare spreadsheet ID (no URL wrapper) → returns `null`

### `syncCards` round-trips (~5 assertions, uses real `localStorage`)
- Initial sync of 3 rows creates 3 cards
- Re-sync with an added row: creates 1, updates 3, archives 0
- Re-sync with a removed row: archives 1, others unchanged
- Review events survive archive: `ReviewStorage.getByCardId` for an archived card's id still returns prior events
- Edit question text: old card archived, new card created with different id; scores for unchanged cards preserved

### Not unit-tested
`fetchCsv` itself — it's a five-line wrapper around `fetch`; mocking `window.fetch` in the harness would add more code than it tests. Covered by the manual checklist below.

### Manual checklist
1. Add a public sheet via Settings → deck appears, cards load.
2. Add a row to the sheet → reload app → new card appears with score = new.
3. Grade a few cards, edit the sheet to archive/add others, reload → graded cards keep their scores.
4. Edit a question's text in the sheet → old card archived, new card appears with score reset (confirms intentional behavior).
5. Unshare the sheet → reload → cached cards still usable, error toast shown.
6. Add a malformed URL → test fetch fails with the sharing-hint error.
7. Go offline → reload → cached cards load, fetch is skipped cleanly.

### Running
`python -m http.server 8000`, open `http://localhost:8000/verify.html`. New assertions (~18) run alongside the existing 21 scheduler assertions.

## Risks

- **Google changes the public CSV export URL format.** Low likelihood (this endpoint has been stable for 10+ years), but if it happens the app breaks until the URL template is updated. Acceptable for a personal app.
- **CORS.** Google's `/export?format=csv` endpoint already sends permissive CORS headers for GET, confirmed by existing community use. No proxy needed.
- **Rate limits.** Fetching every deck on every app load × many opens/day. The public export endpoint is edge-cached and generous; a single user at normal usage is well under any practical threshold.
- **Sheet visibility mistake.** User pastes a URL for a private sheet → test-fetch fails with a clear error, no silent breakage.
