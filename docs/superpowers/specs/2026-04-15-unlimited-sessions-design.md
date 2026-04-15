# Unlimited sessions with weighted Ebbinghaus picker

## Problem

Today's study sessions have three flaws:

1. **Fixed length.** `session.start()` pre-builds a queue via `Scheduler.buildQueue()` and ends the moment the queue empties. Users can't keep studying past that point.
2. **Missed cards don't come back.** An incorrect answer is recorded but the card is never re-queued in the same session — so users never get a second crack at a card they just got wrong.
3. **Sessions start the same way every time.** `buildQueue` ranks by retrievability and applies only minor adjacent-swap shuffling. The top-ranked card is almost always the same card for a given deck state, so the first several cards of every session repeat.

## Goals

- Sessions run until the user explicitly ends them (button or ESC).
- A just-failed card can reappear within the same session.
- The starting card and early-session variety feel random, while still respecting Ebbinghaus retrievability.
- Correct cards retain a non-zero but diminishing chance of reappearing, decreasing further with each additional correct review.

## Non-goals

- Changing the stability fold, the `R = exp(−t/S)` formula, or the append-only `ReviewEvent` log. These remain the source of truth.
- Changing how new cards are introduced per session (the `newCardsPerSession` cap still applies at session start).
- Any persistence of session-local state across reloads.

## Design

### 1. Continuous picker replaces the pre-built queue

`session.queue` is removed. `session.start()` no longer calls `Scheduler.buildQueue()`. Instead, after each answer, the session calls a new `Scheduler.pickNextCard(deckId, context)` which returns a single card based on the current `ReviewEvent` log plus session-local context.

Sessions end only when the user clicks "End Session" or presses ESC. The existing `session.end()` path is unchanged.

### 2. Weighted-random picker

Replace `getNextCard`'s "pick uniformly from top 5 lowest-R" with **weighted-random sampling over all eligible cards**, weighted by `(1 − R)^α`.

- `R` for a never-reviewed card is 0 → weight 1 (maximally due).
- A freshly-correct card has `R ≈ 1` → weight ≈ 0 (unlikely to reappear).
- Each additional correct review grows stability, keeping R near 1 for longer, which keeps `(1 − R)` smaller for longer → **diminishing reappearance probability with correct occurrences**, as requested.
- A long-untouched card has `R` near 0 → high weight.

`α` is a new tunable setting (default 1.0). Higher α sharpens bias toward truly-due cards; lower α flattens the distribution. Exposed in the Settings view alongside existing Ebbinghaus parameters.

The just-answered card is excluded from the candidate pool for the immediate next pick only (to avoid back-to-back repeats). No other exclusions.

### 3. New-card introduction

The `newCardsPerSession` cap is preserved but enforced differently: the session tracks how many never-reviewed cards it has surfaced so far. When picking, if the cap has been reached, never-reviewed cards are excluded from the weighted pool for the rest of the session. Under the cap, they participate normally (weight = 1).

### 4. Session-local retry queue for failed cards

When a user answers incorrectly, the card is added to a session-local `retryQueue` with a counter K drawn uniformly from `[5, 15]`. After each subsequent answer, all counters decrement.

Picking logic per turn:

1. If any retry-queue card has counter ≤ 0, surface that card directly (remove from retry queue). If multiple are due, pick the one with the smallest counter (ties broken by insertion order).
2. Otherwise, call the weighted-random picker in §2.

If a retry-queue card happens to be picked by the weighted picker before its counter elapses (possible only when its stability was already low), it's removed from the retry queue.

If the deck has fewer cards than the upper K bound, K is clamped to `max(1, deckCardCount − 1)` so small decks still work.

The retry queue lives on `Alpine.store('session')` and is wiped on `session.start()` and `session.end()`. It is never persisted.

### 5. UI changes

- Remove "N remaining" from the session header; the queue is unbounded.
- Replace the progress bar with a simple reviewed-count readout (e.g., "12 reviewed · 10 correct"). Keeping the session-ends-when-empty UX out of the UI.
- Add an α slider to the Settings view. Range 0.5–3.0, step 0.1, default 1.0, labeled "Due-card bias (α)" with a short description.

No changes to the flip animation, grading buttons, keyboard shortcuts, or end-session button.

## Data model

No storage-format changes. No new `localStorage` keys. `ReviewEvent` log is untouched. One new field in `SettingsStorage.defaults`: `pickerAlpha: 1.0`.

Session store gains two new in-memory fields:
- `retryQueue: Array<{cardId, counter}>`
- `newCardsSurfaced: number`

## Scheduler API changes

- **Remove**: `Scheduler.buildQueue`, `Scheduler.getNextCard`, `Scheduler.priorityShuffle` (all tied to the old queue/top-5 model).
- **Add**: `Scheduler.pickNextCard(deckId, { excludeCardId, excludeNew, alpha })` — returns a single card using weighted-random sampling by `(1 − R)^α` over all cards in the deck, honoring the exclusions. Returns `null` only if the deck has no eligible cards.
- **Keep unchanged**: `calculateStability`, `calculateRetrievability`, `getUrgentCards`, `getMasteredCards`, `getProgress`.

## Testing

Extend `js/verify.js` with new assertions:

- Weighted picker produces different orderings across runs for the same deck state (random start).
- Weighted picker's sampling distribution matches `(1 − R)^α` within a tolerance over many trials.
- A card answered incorrectly appears again within K+ε cards with probability 1.
- A card answered correctly N times has strictly lower reappearance frequency than a card answered correctly N−1 times over a large sample (diminishing).
- `newCardsPerSession` cap is respected across a long synthetic session.
- Ending a session wipes the retry queue.

No other test harness exists; browser-based `verify.html` remains the verification surface.

## Risks and trade-offs

- **Weighted sampling over all cards is O(N) per pick.** For a deck of 1000 cards and a 100-card session, that's 100k operations — negligible in a browser. If decks ever grow to 10⁴+ cards, revisit.
- **Users who liked the hard session cap lose it.** Mitigated by keeping the End Session button prominent and adding a reviewed-count readout so users have a natural stopping cue.
- **α as a user-facing knob is unusual.** Default of 1.0 is the intuitive "weight = probability of non-recall" setting; most users will never touch it.
