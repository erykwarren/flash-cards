# Retrievability-based scheduler (Ebbinghaus)

Status: approved for implementation planning
Date: 2026-04-14

## Summary

Replace the current priority-score scheduler in `js/scheduler.js` with an Ebbinghaus retrievability model. Each card is scored by predicted recall probability `R(t) = exp(−t/S)`, where `S` is a per-card stability (in days) updated multiplicatively on each review. The session queue is built by ranking cards by `1 − R(now)` and taking the top N, unchanged in shape from today.

This swaps five hand-tuned weights for three interpretable parameters, preserves the existing two-button UI and session-of-N UX, and requires no migration of stored data — stability is derived on demand from the append-only `ReviewEvent` log, matching the current architecture.

## Motivation

The current scheduler in `js/scheduler.js` is a weighted sum of heuristics: failure rate, days-since-last-seen, exposure gap, a recent-review penalty, and a streak penalty. It works, but the five weights are arbitrary and the formula encodes no explicit model of memory. Several of its terms (recent penalty, streak penalty, recency weight) are approximations of a single underlying quantity — the probability the user still remembers the card right now.

Ebbinghaus' forgetting curve gives that quantity directly. Using it:

- Collapses 5 tunable weights to 3 meaningful parameters (`a`, `b`, `S₀`).
- Removes the need for separate recent/streak penalties — they fall out of `R(t)`.
- Opens a clean upgrade path to FSRS later (same skeleton; add difficulty and fitted weights) without another data migration.

SM-2 and FSRS were considered and rejected for this step: SM-2 is dominated by Ebbinghaus unless the UI moves to 4-button grading; FSRS is overkill for 50–500 card personal decks and requires 3-button grading to pay off. Both can be adopted later without reworking the storage layer this design preserves.

## The algorithm

### Per-card state

Two values, both derived from the event log (not stored):

- `stability: number` — days. Intuition: the time for recall probability to decay from 1.0 to `1/e ≈ 0.37`.
- `lastReviewedAt: number` — epoch ms. Already available as `stats.lastSeenAt`.

### Recall probability

```
R(t) = exp(−t / S)
```

where `t` is days since `lastReviewedAt` (use `(Date.now() − lastReviewedAt) / 86400000`). `R` is in (0, 1].

A card with no reviews has no `S`; see "New cards" below.

### Update rule

On each review event, applied in chronological order:

```
if outcome === 'correct':  S := max(S_min, S * a)
if outcome === 'incorrect': S := max(S_min, S * b)
```

with defaults `a = 2.0`, `b = 0.5`, `S_min = 0.5` day, initial `S = S₀ = 1.0` day.

No ceiling on `S`. Long correct streaks compound into multi-month intervals, which is the desired behavior.

### Why no time-elapsed term in the update

Pure Ebbinghaus does not factor elapsed time into the multiplier. `S *= a` on correct regardless of whether the review happened at `t = 0.1·S` or `t = 2·S`. This is deliberately simpler than FSRS, which modulates `S'` by retrievability at review time. Simpler update, more predictable behavior, acceptable for this deck size. A later FSRS upgrade can add the retrievability modulation without reshaping storage.

## Queue construction

Rewrite of `Scheduler.buildQueue(deckId, maxCards)`. Shape is unchanged from the caller's view: returns an ordered array of cards.

1. Compute stats for every active card in the deck. For each card, note whether it is `new` (zero reviews) or `reviewed`.
2. Rank `reviewed` cards by `R(now)` ascending. Lowest predicted recall first.
3. Take up to `settings.newCardsPerSession` from `new` cards. Order among new cards is insertion order (existing behavior).
4. Fill the remaining slots up to `maxCards` from the ranked `reviewed` list.
5. Apply `priorityShuffle` to the combined queue for minor adjacency variety. Keep this function unchanged.

Removed: the weighted-random `weightedSelect`. `R(t)` is a real probability — ranking is sufficient, and the stochastic draw was compensating for heuristic noise that no longer exists.

### Edge cases

- **Empty deck**: return `[]`. Existing behavior.
- **All new**: take up to `newCardsPerSession`, then up to `maxCards`, whichever is smaller.
- **No new**: fill entirely from ranked `reviewed`.
- **Fewer cards than `maxCards`**: return all of them.
- **Card reviewed seconds ago**: `t ≈ 0`, `R ≈ 1`, ranks last. Natural recent-review suppression.

## Data model

No schema migration, no card state stored in localStorage, no version flag.

### Change to `ReviewStorage.getCardStats` (js/storage.js)

Extend the returned object with two fields:

```
stability: number   // days; S₀ if no reviews
lastReviewedAt: number | null  // already exists as lastSeenAt; rename or alias
```

Computed by folding over the card's review events sorted ascending by `answeredAt`, applying the update rule above. The fold is O(reviews-for-this-card) per call; for realistic deck sizes (≤500 cards, ≤tens of reviews per card) this is trivially fast at session start. Events are appended in order today but the fold should sort defensively in case that ever changes.

### Change to `ReviewEvent`

None. Existing `outcome: 'correct' | 'incorrect'` is sufficient.

### Legacy settings

The six retired settings (`failureWeight`, `recencyWeight`, `exposureWeight`, `targetExposures`, `maxRecencyDays`, `recentPenaltyMinutes`) remain readable in any user's localStorage but are ignored by the new scheduler. Do not purge them; no harm in leaving them. `SettingsStorage.get()` should merge stored values over the new defaults, so users with old settings simply get the new defaults for new keys.

## Settings page

Replace the six retired sliders with three:

| Setting | Default | Range | Meaning |
|---|---|---|---|
| `successMultiplier` (`a`) | 2.0 | 1.1 – 3.0 | Stability growth on correct |
| `failureMultiplier` (`b`) | 0.5 | 0.1 – 0.9 | Stability reset on incorrect |
| `initialStability` (`S₀`) | 1.0 | 0.25 – 5.0 | Days, first-ever review |

Keep `newCardsPerSession` unchanged.

Also keep `SettingsStorage.reset()` — rewrite its defaults to the new three.

## Changes by file

### `js/storage.js`

- Update `DEFAULT_SETTINGS` to the new three parameters plus `newCardsPerSession`. Drop the six retired keys.
- Extend `ReviewStorage.getCardStats(cardId)` return value with `stability` and `lastReviewedAt`. Keep `lastSeenAt` for backward compatibility with any existing callers; set both to the same value.
- No changes to `DeckStorage`, `CardStorage`, or event writing.

### `js/scheduler.js`

- Remove `calculatePriority`, `calculateAllPriorities`, `weightedSelect`.
- Add `calculateStability(reviews, settings)` — pure function, folds the update rule. Used internally by stats.
- Add `calculateRetrievability(stability, lastReviewedAt, now)` — pure function returning `R(t)`.
- Rewrite `buildQueue` per "Queue construction" above.
- Update `getNextCard` to use `1 − R` ranking.
- Update `getUrgentCards` threshold semantics: "urgent" means `R(now) < 0.5`.
- Update `getMasteredCards` criterion: `stability ≥ 60` days AND `totalReviews ≥ 3` (drop the 0.8-success-rate and streak conditions — they're correlated with stability anyway).
- Update `getProgress` category logic using the new mastered criterion.
- Keep `priorityShuffle` unchanged.

### `js/app.js`

- `Alpine.store('settings')` needs no structural change; it reads from `SettingsStorage` which handles the new keys.
- `Alpine.store('stats')` — verify the per-card sort in `loadCardStats` still makes sense. Current sort is by success rate ascending; it still works, but consider sorting by `R(now)` ascending (cards that most need review first) as a quality-of-life improvement. Flag for implementation discussion, not blocking.

### `index.html`

- Settings view: swap the six sliders for three. Field IDs change to match the new setting keys.
- No other UI changes. Session view untouched.

## Verification

No automated test suite exists in this repo; adding one for a single algorithm change is out of scope. Verification plan for implementation:

1. **Unit-style manual check** (can be a throwaway HTML page or console paste): construct synthetic event sequences and assert stability matches hand-calculation.
   - Five consecutive corrects starting from `S₀=1`, `a=2`: `S = 1, 2, 4, 8, 16, 32`.
   - Two corrects then one incorrect with `a=2, b=0.5`: `S = 1, 2, 4, 2`.
   - Incorrect below `S_min` floor: confirm clamping.
2. **Retrievability sanity**: just-answered card has `R > 0.99`; card with `t = S` has `R ≈ 0.37`; card with `t = 3·S` has `R ≈ 0.05`.
3. **Queue sanity** on a real deck: open the app, start a session, confirm the first card is the one with lowest `R`, confirm new cards respect the `newCardsPerSession` cap.
4. **Smoke**: settings page shows three fields; changing `a` from 2.0 to 1.5 visibly changes ranking on next session.

## Out of scope

- Moving to 3- or 4-button grading (Anki style).
- FSRS adoption. Deliberately left as a future upgrade; this design is the stepping stone.
- Decks > 5000 cards. The fold-over-events computation is fine at expected scale; a much larger deck would want caching, which can be added later without changing the model.
- Test framework introduction.

## Open questions resolved during design

- **Defaults `a=2, b=0.5, S₀=1`** — accepted by user.
- **"Mastered" threshold at `S ≥ 60` days** — accepted.
- **Removing the weighted-random picker** — accepted.
