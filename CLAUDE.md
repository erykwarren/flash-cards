# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A static, no-build browser flashcard app backed by Google Sheets, using spaced repetition. Deployed to GitHub Pages from `main` via `.github/workflows/deploy.yml`. Runtime stack: Alpine.js + Tailwind (both via CDN), Google Identity Services, `localStorage`.

## Commands

There is no package manager, build step, linter, or test suite. Development is: edit → refresh browser.

- Local dev: `./update-version.sh && python -m http.server 8000` then open http://localhost:8000. `update-version.sh` generates `version.js` (git-ignored; also generated in CI). Without it `window.APP_VERSION` is just `undefined` — not fatal, but version stamps in logs will read `dev`.
- Google OAuth requires the current origin to be in the authorized JavaScript origins list for the Client ID in `js/google.js`. `localhost:8000` and the GitHub Pages URL are already configured.
- Deploy: push to `main`. The Actions workflow regenerates `version.js` with the short SHA and uploads the whole repo as the Pages artifact.

## Architecture

Single-page app. `index.html` loads scripts in this fixed order: `version.js` → `storage.js` → `scheduler.js` → `google.js` → `sync.js` → `app.js`. Each module attaches globals to `window`; there are no ES modules or imports. Alpine stores (`app`, `session`, `stats`, `settings`) are defined in `app.js` on the `alpine:init` event.

### Data model (all in localStorage)

Keys live under `flashcards_*` (see `STORAGE_KEYS` in `storage.js`). Four collections: `DeckStorage`, `CardStorage`, `ReviewStorage`, `SettingsStorage`, plus `AuthStorage` for the OAuth token.

- **Card IDs are deterministic**: `generateCardId(deckId, question, answer)` is a SHA-256 hash of the normalized triple (first 16 hex chars). This is load-bearing for sync: editing a question or answer in the source spreadsheet creates a *new* card and archives the old one, which preserves review history on unchanged cards and drops it on edits. `CardStorage.syncCards` walks existing cards, unarchives/updates those still present, and archives any missing from the sheet.
- Deleting a deck archives its cards rather than deleting them.
- `ReviewEvent`s are append-only; card/deck stats are computed on demand from the full event log.

### Sheets import

`SheetsService.readSpreadsheet` reads range `A:C` from the first sheet: Column A = question, B = answer, C = example (optional). A header row is auto-detected via `isHeaderRow` (keyword match on the first row). Empty rows are skipped.

### Auth flow

`GoogleAuth` (in `js/google.js`) wraps Google Identity Services. Tokens are stored in localStorage with an `expires_at` timestamp. On init, if the token is expired or expiring within 5 minutes, it attempts a silent refresh (`requestAccessToken({ prompt: '' })`). Any code needing a token should `await GoogleAuth.ensureAccessToken()` — do not read `AuthStorage` directly for API calls, since `ensureAccessToken` handles silent refresh and returns `null` cleanly when re-auth is needed. Callbacks during an in-flight refresh are queued in `pendingRefreshCallbacks` to avoid concurrent refresh attempts.

### Scheduler

`Scheduler.calculateStability` folds a card's review events into a stability value `S` (days), multiplying by `successMultiplier` on correct and `failureMultiplier` on incorrect, clamped to `minStability`. `Scheduler.calculateRetrievability(S, lastReviewedAt, now)` returns `R = exp(−t/S)` — the predicted recall probability. `buildQueue` ranks reviewed cards by `R` ascending, caps new cards at `newCardsPerSession`, and applies `priorityShuffle` for minor adjacency variety. Card state is not persisted — stability is recomputed from the append-only `ReviewEvent` log on each `getCardStats` call, keeping the log as the single source of truth.

Algorithm parameters (`successMultiplier`, `failureMultiplier`, `initialStability`) are user-tunable in the Settings view. A browser-based verification harness lives at `/verify.html` (loads `js/verify.js`); it runs 21 assertions covering stability folding, retrievability, `getCardStats` integration, and queue ranking.

### Session state machine

`Alpine.store('session')` has three states: `question` → (tap) → `answer` → (grade button) → `flipping` → (600 ms timeout) → `question` with the next card. The 600 ms matches the CSS flip animation duration; changing one requires changing the other. Answers are only accepted in the `answer` state.
