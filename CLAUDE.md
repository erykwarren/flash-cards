# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A static, no-build browser flashcard app backed by public Google Sheets (CSV export), using spaced repetition. Deployed to GitHub Pages from `main` via `.github/workflows/deploy.yml`. Runtime stack: Alpine.js + Tailwind (both via CDN), `localStorage`. No OAuth, no credentials.

## Commands

There is no package manager, build step, linter, or test suite. Development is: edit → refresh browser.

- Local dev: `./update-version.sh && python -m http.server 8000` then open http://localhost:8000. `update-version.sh` generates `version.js` (git-ignored; also generated in CI). Without it `window.APP_VERSION` is just `undefined` — not fatal, but version stamps in logs will read `dev`.
- Deploy: push to `main`. The Actions workflow regenerates `version.js` with the short SHA and uploads the whole repo as the Pages artifact.

## Architecture

Single-page app. `index.html` loads scripts in this fixed order: `version.js` → `storage.js` → `scheduler.js` → `sheets.js` → `sync.js` → `app.js`. Each module attaches globals to `window`; there are no ES modules or imports. Alpine stores (`app`, `session`, `stats`, `settings`) are defined in `app.js` on the `alpine:init` event.

### Data model (all in localStorage)

Keys live under `flashcards_*` (see `STORAGE_KEYS` in `storage.js`). Four collections: `DeckStorage`, `CardStorage`, `ReviewStorage`, `SettingsStorage`.

- **Card IDs are deterministic**: `generateCardId(deckId, question, answer)` is a SHA-256 hash of the normalized triple (first 16 hex chars). This is load-bearing for sync: editing a question or answer in the source spreadsheet creates a *new* card and archives the old one, which preserves review history on unchanged cards and drops it on edits. `CardStorage.syncCards` walks existing cards, unarchives/updates those still present, and archives any missing from the sheet.
- Deleting a deck archives its cards rather than deleting them.
- `ReviewEvent`s are append-only; card/deck stats are computed on demand from the full event log.

### Sheets import

Decks are user-configured in the Settings view by pasting a Google Sheets URL. The sheet must be shared as "Anyone with the link → Viewer." `SheetsService.fetchCsv` fetches `https://docs.google.com/spreadsheets/d/{spreadsheetId}/export?format=csv&gid={gid}` with no auth headers, then `SheetsService.parseCsv` parses the text. Columns: A = question, B = answer, C = example (optional). A header row is auto-detected via `isHeaderRow` (keyword match on the first row). Empty rows are skipped. On every app load, `app.js` init runs `fetchCsv → syncCards` for every configured deck in parallel; failed fetches leave the cached `localStorage` copy in place.

`SheetsService.parseSheetUrl(url)` extracts `{ spreadsheetId, gid }` from pasted URLs; `gid` defaults to `'0'` when absent. Non-Sheets URLs or bare IDs return `null`.

### Scheduler

`Scheduler.calculateStability` folds a card's review events into a stability value `S` (days), multiplying by `successMultiplier` on correct and `failureMultiplier` on incorrect, clamped to `minStability`. `Scheduler.calculateRetrievability(S, lastReviewedAt, now)` returns `R = exp(−t/S)` — the predicted recall probability. `Scheduler.pickNextCard(deckId, opts)` picks the next card via weighted-random sampling over all eligible cards, with weight `(1 − R)^α`; this keeps the top-priority position stochastic (random session start) while still heavily favoring low-R cards. Card state is not persisted — stability is recomputed from the append-only `ReviewEvent` log on each `getCardStats` call, keeping the log as the single source of truth.

Algorithm parameters (`successMultiplier`, `failureMultiplier`, `initialStability`, `pickerAlpha`) are user-tunable in the Settings view. A browser-based verification harness lives at `/verify.html` (loads `js/verify.js`); it runs assertions covering stability folding, retrievability, `getCardStats` integration, weighted sampling, `pickNextCard`, CSV parsing, URL parsing, and `syncCards` round-trips.

### Session state machine

`Alpine.store('session')` has three states: `question` → (tap) → `answer` → (grade button) → `flipping` → (600 ms timeout) → `question` with the next card. The 600 ms matches the CSS flip animation duration; changing one requires changing the other. Answers are only accepted in the `answer` state.

Sessions are unbounded: there is no pre-built queue. After each answer, `session._pickNext` consults a session-local `retryQueue` (cards answered incorrectly, scheduled to reappear after 5–15 answers) before falling back to `Scheduler.pickNextCard`. The session ends only when the user clicks "End Session" or presses ESC — or when the deck is effectively empty (e.g., a one-card deck with the just-answered card excluded). The `newCardsPerSession` cap is enforced by excluding never-reviewed cards from the picker once the cap is reached, and relaxed as a fallback if that would leave no candidate.
