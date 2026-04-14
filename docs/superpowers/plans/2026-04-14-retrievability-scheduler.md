# Retrievability Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the weighted priority-score scheduler in `js/scheduler.js` with an Ebbinghaus retrievability model that computes `R(t) = exp(−t/S)` per card, with per-card stability `S` updated multiplicatively from the existing binary review log.

**Architecture:** Pure functions `calculateStability` and `calculateRetrievability` live in `js/scheduler.js`. No new card state is persisted — stability is folded on demand from `ReviewStorage` events. `Scheduler.buildQueue` becomes a rank-by-`R` + new-card-cap selector. Settings UI swaps four legacy weight sliders for three Ebbinghaus parameters.

**Tech Stack:** Plain ES5-ish JS attached to `window.*`, Alpine.js for reactive UI, Tailwind via CDN, localStorage for persistence. No build step, no bundler, no test framework. We introduce a minimal in-browser verification page (`verify.html`) to assert pure-function behavior before wiring up UI.

**Spec:** `docs/superpowers/specs/2026-04-14-retrievability-scheduler-design.md`

---

## File Structure

**Modify:**
- `js/scheduler.js` — full rewrite of the module. Remove `calculatePriority`, `calculateAllPriorities`, `weightedSelect`. Add `calculateStability`, `calculateRetrievability`. Rewrite `buildQueue`, `getNextCard`, `getUrgentCards`, `getMasteredCards`, `getProgress`. Keep `priorityShuffle`.
- `js/storage.js` — update `DEFAULT_SETTINGS`; extend `ReviewStorage.getCardStats` return value with `stability` and `lastReviewedAt`.
- `index.html:524-615` — replace four retired Algorithm Parameters sliders with three new ones. Keep New Cards Per Session. Update descriptive text.

**Create:**
- `verify.html` — in-browser test harness. Loads storage/scheduler and runs assertions, rendering pass/fail to the page and console.
- `js/verify.js` — assertion framework (~30 LOC) and test cases.

**Do not modify:** `js/google.js`, `js/sync.js`, `js/app.js` (verify once that `Alpine.store('stats').loadCardStats` still works; no code change expected).

---

## Task 1: Create verification harness

**Files:**
- Create: `/Users/erykwarren/perso/dev/flash-cards/verify.html`
- Create: `/Users/erykwarren/perso/dev/flash-cards/js/verify.js`

- [ ] **Step 1: Create `verify.html`**

Create file `/Users/erykwarren/perso/dev/flash-cards/verify.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Flashcards · Verify</title>
  <style>
    body { font-family: monospace; padding: 1rem; background: #1a1a2e; color: #e8e8e8; }
    .pass { color: #00ff9d; }
    .fail { color: #ff6b6b; }
    .group { margin-top: 1rem; font-weight: bold; color: #00d4ff; }
    pre { margin: 0.1rem 0 0.1rem 1rem; }
  </style>
</head>
<body>
  <h1>Scheduler Verification</h1>
  <div id="results"></div>
  <script>
    window.APP_VERSION = 'verify';
    window.APP_BUILD_TIME = 'verify';
  </script>
  <script src="js/storage.js"></script>
  <script src="js/scheduler.js"></script>
  <script src="js/verify.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `js/verify.js` with the assertion framework**

Create file `/Users/erykwarren/perso/dev/flash-cards/js/verify.js`:

```javascript
// Minimal in-browser assertion runner. No framework — intentional.
(function () {
  const out = document.getElementById('results');
  let passed = 0, failed = 0;

  function render(kind, text) {
    const pre = document.createElement('pre');
    pre.className = kind;
    pre.textContent = text;
    out.appendChild(pre);
    (kind === 'fail' ? console.error : console.log)(text);
  }

  function group(name) {
    const div = document.createElement('div');
    div.className = 'group';
    div.textContent = name;
    out.appendChild(div);
    console.log(`\n=== ${name} ===`);
  }

  function approx(actual, expected, epsilon = 1e-6) {
    return Math.abs(actual - expected) <= epsilon;
  }

  function assert(label, condition, detail) {
    if (condition) {
      passed++;
      render('pass', `  PASS  ${label}`);
    } else {
      failed++;
      render('fail', `  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    }
  }

  function assertEqual(label, actual, expected) {
    assert(label, actual === expected, `expected ${expected}, got ${actual}`);
  }

  function assertApprox(label, actual, expected, epsilon) {
    assert(label, approx(actual, expected, epsilon), `expected ~${expected}, got ${actual}`);
  }

  window.VERIFY = { group, assert, assertEqual, assertApprox };

  // Test cases get appended below by later tasks.
  window.addEventListener('load', () => {
    (window.TESTS || []).forEach(fn => fn());
    const summary = document.createElement('h2');
    summary.textContent = `${passed} passed, ${failed} failed`;
    summary.className = failed === 0 ? 'pass' : 'fail';
    out.appendChild(summary);
  });

  window.TESTS = [];
})();
```

- [ ] **Step 3: Open `verify.html` to confirm harness loads**

Serve the app locally (`python -m http.server 8000` from repo root) and open `http://localhost:8000/verify.html`. The page should show "Scheduler Verification" and "0 passed, 0 failed". The console should have no errors.

- [ ] **Step 4: Commit**

```bash
git add verify.html js/verify.js
git commit -m "Add in-browser scheduler verification harness"
```

---

## Task 2: Write failing tests for `calculateStability`

**Files:**
- Modify: `js/verify.js` (append test cases)

- [ ] **Step 1: Append stability tests to `js/verify.js`**

Append to the bottom of `/Users/erykwarren/perso/dev/flash-cards/js/verify.js`, **after** the closing `})();` of the IIFE. `window.TESTS` and `window.VERIFY` are already exposed as globals from the harness, so test cases just push to them:

```javascript
// ---- calculateStability ----
window.TESTS.push(function () {
  VERIFY.group('calculateStability');
  const settings = { successMultiplier: 2.0, failureMultiplier: 0.5, initialStability: 1.0, minStability: 0.5 };

  const mkReview = (outcome, t) => ({ outcome, answeredAt: new Date(t).toISOString() });

  // Five consecutive corrects: 1 -> 2 -> 4 -> 8 -> 16 -> 32
  const fiveCorrects = [1, 2, 3, 4, 5].map(day => mkReview('correct', day * 86400000));
  VERIFY.assertApprox('five corrects → S = 32', Scheduler.calculateStability(fiveCorrects, settings), 32);

  // Two corrects then one incorrect: 1 -> 2 -> 4 -> 2
  const twoCorrectsOneFail = [
    mkReview('correct', 86400000),
    mkReview('correct', 2 * 86400000),
    mkReview('incorrect', 3 * 86400000)
  ];
  VERIFY.assertApprox('correct, correct, incorrect → S = 2', Scheduler.calculateStability(twoCorrectsOneFail, settings), 2);

  // Empty history → S₀
  VERIFY.assertApprox('no reviews → S = S₀ (1.0)', Scheduler.calculateStability([], settings), 1.0);

  // Floor clamp: three incorrects starting from 1.0 would be 0.5, 0.25, 0.125 — clamps to 0.5
  const threeFails = [1, 2, 3].map(day => mkReview('incorrect', day * 86400000));
  VERIFY.assertApprox('three incorrects clamp at S_min = 0.5', Scheduler.calculateStability(threeFails, settings), 0.5);

  // Unsorted input must be sorted by answeredAt before folding
  const unsorted = [
    mkReview('incorrect', 3 * 86400000), // applied last: 4 * 0.5 = 2
    mkReview('correct', 86400000),       // applied first: 1 * 2 = 2
    mkReview('correct', 2 * 86400000),   // applied second: 2 * 2 = 4
  ];
  VERIFY.assertApprox('unsorted events sort by answeredAt', Scheduler.calculateStability(unsorted, settings), 2);
});
```

- [ ] **Step 2: Reload `verify.html` to confirm all five assertions FAIL**

Expected: five `FAIL` lines under "calculateStability". Error reason in the console should be that `Scheduler.calculateStability is not a function` (the FAIL message shows `got undefined` because the function doesn't exist yet — that's fine, it still counts as failing).

- [ ] **Step 3: Commit**

```bash
git add js/verify.js
git commit -m "Add failing tests for calculateStability"
```

---

## Task 3: Implement `calculateStability`

**Files:**
- Modify: `js/scheduler.js` (add method to `Scheduler` object)

- [ ] **Step 1: Add `calculateStability` to `Scheduler` in `js/scheduler.js`**

Open `/Users/erykwarren/perso/dev/flash-cards/js/scheduler.js`. Near the top of the `Scheduler = { ... }` object (before `calculatePriority`, which will be removed in a later task), add:

```javascript
  /**
   * Fold a card's review events into a final stability value.
   * Sorts defensively by answeredAt, then applies S *= a on correct,
   * S *= b on incorrect, clamping to minStability.
   *
   * @param {Array<{outcome: string, answeredAt: string}>} reviews
   * @param {Object} settings - Must include successMultiplier, failureMultiplier, initialStability, minStability
   * @returns {number} final stability in days
   */
  calculateStability(reviews, settings) {
    const a = settings.successMultiplier;
    const b = settings.failureMultiplier;
    const floor = settings.minStability;
    let S = settings.initialStability;

    const sorted = [...reviews].sort(
      (x, y) => new Date(x.answeredAt) - new Date(y.answeredAt)
    );

    for (const r of sorted) {
      S = Math.max(floor, S * (r.outcome === 'correct' ? a : b));
    }
    return S;
  },
```

- [ ] **Step 2: Reload `verify.html` to confirm all five stability assertions PASS**

Expected: five `PASS` lines under "calculateStability".

- [ ] **Step 3: Commit**

```bash
git add js/scheduler.js
git commit -m "Implement calculateStability"
```

---

## Task 4: Write failing tests for `calculateRetrievability`

**Files:**
- Modify: `js/verify.js`

- [ ] **Step 1: Append retrievability tests to `js/verify.js`**

Append to `/Users/erykwarren/perso/dev/flash-cards/js/verify.js`:

```javascript
// ---- calculateRetrievability ----
window.TESTS.push(function () {
  VERIFY.group('calculateRetrievability');
  const now = Date.now();
  const day = 86400000;

  // Just reviewed: t=0 → R=1
  VERIFY.assertApprox('t=0 → R=1',
    Scheduler.calculateRetrievability(5, now, now), 1.0);

  // t = S → R = 1/e ≈ 0.3679
  VERIFY.assertApprox('t=S → R≈0.368',
    Scheduler.calculateRetrievability(5, now - 5 * day, now), Math.exp(-1), 1e-6);

  // t = 3S → R = e^-3 ≈ 0.0498
  VERIFY.assertApprox('t=3S → R≈0.050',
    Scheduler.calculateRetrievability(5, now - 15 * day, now), Math.exp(-3), 1e-6);

  // Never-reviewed (lastReviewedAt null) → 0 (treat as maximally forgotten for ranking)
  VERIFY.assertApprox('null lastReviewedAt → R=0',
    Scheduler.calculateRetrievability(1, null, now), 0);
});
```

- [ ] **Step 2: Reload `verify.html` — four new FAIL lines under "calculateRetrievability"**

Expected: function doesn't exist yet.

- [ ] **Step 3: Commit**

```bash
git add js/verify.js
git commit -m "Add failing tests for calculateRetrievability"
```

---

## Task 5: Implement `calculateRetrievability`

**Files:**
- Modify: `js/scheduler.js`

- [ ] **Step 1: Add `calculateRetrievability` to `Scheduler`**

In `/Users/erykwarren/perso/dev/flash-cards/js/scheduler.js`, immediately after `calculateStability`, add:

```javascript
  /**
   * Predicted recall probability using R(t) = exp(-t/S).
   * Returns 0 for never-reviewed cards (so they rank as maximally due).
   *
   * @param {number} stability - days
   * @param {number|null} lastReviewedAt - epoch ms, or null for never-reviewed
   * @param {number} now - epoch ms
   * @returns {number} R in [0, 1]
   */
  calculateRetrievability(stability, lastReviewedAt, now) {
    if (lastReviewedAt === null || lastReviewedAt === undefined) return 0;
    const days = (now - lastReviewedAt) / 86400000;
    return Math.exp(-days / stability);
  },
```

- [ ] **Step 2: Reload `verify.html` — four new PASS lines**

Expected: all four retrievability assertions pass. Total so far: 9 passed, 0 failed.

- [ ] **Step 3: Commit**

```bash
git add js/scheduler.js
git commit -m "Implement calculateRetrievability"
```

---

## Task 6: Update `DEFAULT_SETTINGS` and `getCardStats`

**Files:**
- Modify: `js/storage.js:14-22` (DEFAULT_SETTINGS)
- Modify: `js/storage.js:313-352` (getCardStats)
- Modify: `js/verify.js` (add integration test)

- [ ] **Step 1: Replace `DEFAULT_SETTINGS` in `js/storage.js`**

Replace lines 14–22 of `/Users/erykwarren/perso/dev/flash-cards/js/storage.js`:

```javascript
const DEFAULT_SETTINGS = {
  successMultiplier: 2.0,     // S grows by this factor on correct
  failureMultiplier: 0.5,     // S shrinks by this factor on incorrect
  initialStability: 1.0,      // days; S for first review
  minStability: 0.5,          // days; floor so S never collapses
  newCardsPerSession: 5       // cap on brand-new cards per session
};
```

- [ ] **Step 2: Extend `ReviewStorage.getCardStats` to include `stability` and `lastReviewedAt`**

In `/Users/erykwarren/perso/dev/flash-cards/js/storage.js`, replace the entire `getCardStats(cardId)` method (currently lines 313–352) with:

```javascript
  getCardStats(cardId) {
    const reviews = this.getByCard(cardId);
    const settings = SettingsStorage.get();

    if (reviews.length === 0) {
      return {
        totalReviews: 0,
        correct: 0,
        incorrect: 0,
        lastSeenAt: null,
        lastReviewedAt: null,
        avgDurationMs: 0,
        streak: 0,
        stability: settings.initialStability
      };
    }

    const correct = reviews.filter(r => r.outcome === 'correct').length;
    const incorrect = reviews.length - correct;
    const sorted = [...reviews].sort(
      (a, b) => new Date(b.answeredAt) - new Date(a.answeredAt)
    );
    const lastSeenAt = new Date(sorted[0].answeredAt).getTime();
    const avgDurationMs = reviews.reduce((sum, r) => sum + r.durationMs, 0) / reviews.length;

    let streak = 0;
    for (const review of sorted) {
      if (review.outcome === 'correct') streak++;
      else break;
    }

    const stability = Scheduler.calculateStability(reviews, settings);

    return {
      totalReviews: reviews.length,
      correct,
      incorrect,
      lastSeenAt,
      lastReviewedAt: lastSeenAt,
      avgDurationMs: Math.round(avgDurationMs),
      streak,
      stability
    };
  },
```

Note: `lastSeenAt` is kept for backward compatibility with `Alpine.store('stats')`. `lastReviewedAt` is the canonical name going forward; both point at the same value.

- [ ] **Step 3: Append integration test to `js/verify.js`**

Append to `/Users/erykwarren/perso/dev/flash-cards/js/verify.js`:

```javascript
// ---- getCardStats integration ----
window.TESTS.push(function () {
  VERIFY.group('getCardStats integration');

  // Seed localStorage with settings + a fake review sequence for a synthetic card.
  // We don't touch the real DECKS/CARDS collections; we write REVIEWS directly
  // and read them back through ReviewStorage.getCardStats.
  const originalSettings = localStorage.getItem('flashcards_settings');
  const originalReviews = localStorage.getItem('flashcards_reviews');

  try {
    SettingsStorage.reset();

    const cardId = '__verify_card__';
    const deckId = '__verify_deck__';
    const day = 86400000;
    const t0 = Date.now() - 10 * day;

    const synthetic = [
      { id: 'r1', cardId, deckId, startedAt: new Date(t0).toISOString(),
        answeredAt: new Date(t0).toISOString(), durationMs: 1000, outcome: 'correct' },
      { id: 'r2', cardId, deckId, startedAt: new Date(t0 + day).toISOString(),
        answeredAt: new Date(t0 + day).toISOString(), durationMs: 1000, outcome: 'correct' },
      { id: 'r3', cardId, deckId, startedAt: new Date(t0 + 2 * day).toISOString(),
        answeredAt: new Date(t0 + 2 * day).toISOString(), durationMs: 1000, outcome: 'incorrect' }
    ];
    localStorage.setItem('flashcards_reviews', JSON.stringify(synthetic));

    const stats = ReviewStorage.getCardStats(cardId);
    VERIFY.assertEqual('totalReviews = 3', stats.totalReviews, 3);
    VERIFY.assertApprox('stability = 2 (1→2→4→2)', stats.stability, 2);
    VERIFY.assertEqual('lastReviewedAt matches last event', stats.lastReviewedAt, t0 + 2 * day);
    VERIFY.assertEqual('streak = 0 (last was incorrect)', stats.streak, 0);

    // Empty history yields initialStability
    const emptyStats = ReviewStorage.getCardStats('__nonexistent__');
    VERIFY.assertApprox('empty history → stability = S₀', emptyStats.stability, 1.0);
    VERIFY.assertEqual('empty history → lastReviewedAt null', emptyStats.lastReviewedAt, null);
  } finally {
    if (originalSettings === null) localStorage.removeItem('flashcards_settings');
    else localStorage.setItem('flashcards_settings', originalSettings);
    if (originalReviews === null) localStorage.removeItem('flashcards_reviews');
    else localStorage.setItem('flashcards_reviews', originalReviews);
  }
});
```

- [ ] **Step 4: Reload `verify.html` — six new PASS lines**

Expected: 15 passed, 0 failed total. If a stability assertion fails, check that `Scheduler.calculateStability` is reading `settings.successMultiplier` (new key) and not `settings.a` or similar.

- [ ] **Step 5: Commit**

```bash
git add js/storage.js js/verify.js
git commit -m "Wire retrievability settings and stability into getCardStats"
```

---

## Task 7: Write failing tests for `buildQueue` behavior

**Files:**
- Modify: `js/verify.js`

- [ ] **Step 1: Append buildQueue tests**

Append to `/Users/erykwarren/perso/dev/flash-cards/js/verify.js`:

```javascript
// ---- buildQueue ----
window.TESTS.push(function () {
  VERIFY.group('buildQueue');

  const originalSettings = localStorage.getItem('flashcards_settings');
  const originalReviews = localStorage.getItem('flashcards_reviews');
  const originalCards = localStorage.getItem('flashcards_cards');
  const originalDecks = localStorage.getItem('flashcards_decks');

  try {
    SettingsStorage.update({ newCardsPerSession: 2 });
    const deckId = '__verify_deck_q__';
    const day = 86400000;
    const now = Date.now();

    // Three reviewed cards with different last-seen times and stabilities,
    // two new cards. Expected session-of-5 order:
    //   lowest R first among reviewed, then new cards (capped at 2), then any leftover.
    const cards = [
      { id: 'c_low_R', deckId, question: 'low', answer: 'low', isArchived: false, createdAt: new Date().toISOString() },
      { id: 'c_mid_R', deckId, question: 'mid', answer: 'mid', isArchived: false, createdAt: new Date().toISOString() },
      { id: 'c_high_R', deckId, question: 'high', answer: 'high', isArchived: false, createdAt: new Date().toISOString() },
      { id: 'c_new_1', deckId, question: 'new1', answer: 'new1', isArchived: false, createdAt: new Date().toISOString() },
      { id: 'c_new_2', deckId, question: 'new2', answer: 'new2', isArchived: false, createdAt: new Date().toISOString() }
    ];
    localStorage.setItem('flashcards_cards', JSON.stringify(cards));

    // Reviews: c_low_R reviewed 20 days ago, one correct (S=2, t=20 → R = e^-10 tiny)
    //          c_mid_R reviewed 2 days ago, one correct (S=2, t=2 → R = e^-1 ≈ 0.37)
    //          c_high_R reviewed 1 hour ago, one correct (S=2, t≈0 → R ≈ 1)
    const reviews = [
      { id: 'rv1', cardId: 'c_low_R', deckId, startedAt: new Date(now - 20 * day).toISOString(),
        answeredAt: new Date(now - 20 * day).toISOString(), durationMs: 1000, outcome: 'correct' },
      { id: 'rv2', cardId: 'c_mid_R', deckId, startedAt: new Date(now - 2 * day).toISOString(),
        answeredAt: new Date(now - 2 * day).toISOString(), durationMs: 1000, outcome: 'correct' },
      { id: 'rv3', cardId: 'c_high_R', deckId, startedAt: new Date(now - 3600000).toISOString(),
        answeredAt: new Date(now - 3600000).toISOString(), durationMs: 1000, outcome: 'correct' }
    ];
    localStorage.setItem('flashcards_reviews', JSON.stringify(reviews));

    const queue = Scheduler.buildQueue(deckId, 10);
    VERIFY.assertEqual('queue length = 5 (3 reviewed + 2 new, cap 2 new)', queue.length, 5);

    // First reviewed card in the queue must be c_low_R (priorityShuffle may nudge it by one,
    // so check it's in the first 2 positions)
    const firstTwoIds = queue.slice(0, 2).map(c => c.id);
    VERIFY.assert('c_low_R appears in first 2 positions',
      firstTwoIds.includes('c_low_R'),
      `got ${firstTwoIds.join(', ')}`);

    // c_high_R (just-reviewed) should NOT be in first 2
    VERIFY.assert('c_high_R not in first 2 positions',
      !firstTwoIds.includes('c_high_R'),
      `got ${firstTwoIds.join(', ')}`);

    // All 5 distinct cards present
    const idSet = new Set(queue.map(c => c.id));
    VERIFY.assertEqual('queue has 5 distinct cards', idSet.size, 5);

    // newCardsPerSession cap: add a 3rd new card, queue should only include 2 of them
    const moreCards = [...cards,
      { id: 'c_new_3', deckId, question: 'new3', answer: 'new3', isArchived: false, createdAt: new Date().toISOString() }
    ];
    localStorage.setItem('flashcards_cards', JSON.stringify(moreCards));
    const queue2 = Scheduler.buildQueue(deckId, 10);
    const newInQueue = queue2.filter(c => c.id.startsWith('c_new_')).length;
    VERIFY.assertEqual('new-card cap respected', newInQueue, 2);

    // maxCards trims the result
    const queue3 = Scheduler.buildQueue(deckId, 3);
    VERIFY.assertEqual('maxCards=3 returns 3', queue3.length, 3);
  } finally {
    if (originalSettings === null) localStorage.removeItem('flashcards_settings');
    else localStorage.setItem('flashcards_settings', originalSettings);
    if (originalReviews === null) localStorage.removeItem('flashcards_reviews');
    else localStorage.setItem('flashcards_reviews', originalReviews);
    if (originalCards === null) localStorage.removeItem('flashcards_cards');
    else localStorage.setItem('flashcards_cards', originalCards);
    if (originalDecks === null) localStorage.removeItem('flashcards_decks');
    else localStorage.setItem('flashcards_decks', originalDecks);
  }
});
```

- [ ] **Step 2: Reload `verify.html`**

Expected: tests fail. The current `buildQueue` still works but its ranking is by legacy priority, so the "c_low_R in first 2" assertion is probabilistic — it may pass or fail. The "new-card cap respected" should pass (existing behavior). Don't rely on all failing; the point is the tests exist and the next task swaps the implementation.

- [ ] **Step 3: Commit**

```bash
git add js/verify.js
git commit -m "Add buildQueue behavior tests for retrievability ranking"
```

---

## Task 8: Rewrite `buildQueue` and remove legacy scheduler code

**Files:**
- Modify: `js/scheduler.js`

- [ ] **Step 1: Remove `calculatePriority`, `calculateAllPriorities`, `weightedSelect`**

In `/Users/erykwarren/perso/dev/flash-cards/js/scheduler.js`, delete:
- `calculatePriority(card, stats, settings)` (currently ~lines 17–75)
- `calculateAllPriorities(deckId)` (currently ~lines 83–92)
- `weightedSelect(prioritized, count)` (currently ~lines 137–168)

Keep `priorityShuffle` (still used).

- [ ] **Step 2: Rewrite `buildQueue`**

Replace the existing `buildQueue` method with:

```javascript
  /**
   * Build a review queue ranked by predicted recall (lowest R first).
   * New cards (zero reviews) are capped at settings.newCardsPerSession.
   *
   * @param {string} deckId
   * @param {number} maxCards - upper bound on queue length
   * @returns {Array<Object>} cards to review, in order
   */
  buildQueue(deckId, maxCards = Infinity) {
    const settings = SettingsStorage.get();
    const cards = CardStorage.getByDeck(deckId);
    if (cards.length === 0) return [];

    const now = Date.now();
    const scored = cards.map(card => {
      const stats = ReviewStorage.getCardStats(card.id);
      const isNew = stats.totalReviews === 0;
      // New cards: R = 0 (maximally due). Reviewed cards: compute R(t).
      const R = isNew ? 0 : this.calculateRetrievability(stats.stability, stats.lastReviewedAt, now);
      return { card, stats, R, isNew };
    });

    const newCards = scored.filter(s => s.isNew);
    const reviewedCards = scored.filter(s => !s.isNew)
      .sort((a, b) => a.R - b.R); // lowest R first

    const newCap = Math.min(settings.newCardsPerSession || 0, newCards.length, maxCards);
    const selectedNew = newCards.slice(0, newCap);

    const remaining = Math.max(0, maxCards - selectedNew.length);
    const selectedReviewed = reviewedCards.slice(0, remaining);

    // priorityShuffle expects objects with a numeric `priority` field; priority = 1 - R.
    // New cards get R=0 → priority=1, tying with the most-stale reviewed cards, which is
    // semantically right: both are maximally due.
    const shufflable = [...selectedReviewed, ...selectedNew].map(s => ({
      card: s.card,
      priority: 1 - s.R
    }));

    return this.priorityShuffle(shufflable);
  },
```

Note: `priorityShuffle` currently takes `{card, priority, stats}` objects and returns `cards`. The shape above (`{card, priority}`) is compatible — `priorityShuffle` only reads `priority` and `card`.

- [ ] **Step 3: Reload `verify.html`**

Expected: all buildQueue assertions PASS. Total so far: ~20 passed, 0 failed. If "c_low_R in first 2" still fails, `priorityShuffle`'s adjacent-swap probability may be nudging it past position 2 — inspect by logging `queue.map(c => c.id)` and loosen the test to "first 3" if the ranking is correct but shuffled.

- [ ] **Step 4: Commit**

```bash
git add js/scheduler.js
git commit -m "Rewrite buildQueue to rank by retrievability"
```

---

## Task 9: Update peripheral scheduler methods

**Files:**
- Modify: `js/scheduler.js`

- [ ] **Step 1: Rewrite `getNextCard`**

Replace the existing `getNextCard` method with:

```javascript
  /**
   * Pick the single next card to review, ranked by retrievability.
   * Picks randomly from the top 5 lowest-R cards for variety.
   */
  getNextCard(deckId, excludeCardId = null) {
    const cards = CardStorage.getByDeck(deckId).filter(c => c.id !== excludeCardId);
    if (cards.length === 0) return null;

    const now = Date.now();
    const scored = cards.map(card => {
      const stats = ReviewStorage.getCardStats(card.id);
      const R = stats.totalReviews === 0 ? 0
        : this.calculateRetrievability(stats.stability, stats.lastReviewedAt, now);
      return { card, R };
    });

    scored.sort((a, b) => a.R - b.R);
    const topN = scored.slice(0, Math.min(5, scored.length));
    const pick = topN[Math.floor(Math.random() * topN.length)];
    return pick.card;
  },
```

- [ ] **Step 2: Rewrite `getUrgentCards`**

Replace the existing `getUrgentCards` method with:

```javascript
  /**
   * Cards whose predicted recall is below the given threshold.
   * Default 0.5 means "50% or worse chance of recall right now."
   */
  getUrgentCards(deckId, maxRetrievability = 0.5) {
    const cards = CardStorage.getByDeck(deckId);
    const now = Date.now();
    return cards
      .map(card => {
        const stats = ReviewStorage.getCardStats(card.id);
        const R = stats.totalReviews === 0 ? 0
          : this.calculateRetrievability(stats.stability, stats.lastReviewedAt, now);
        return { card, stats, R };
      })
      .filter(x => x.R < maxRetrievability)
      .sort((a, b) => a.R - b.R);
  },
```

- [ ] **Step 3: Rewrite `getMasteredCards`**

Replace with:

```javascript
  /**
   * "Mastered" = stability has grown to at least 60 days with ≥ 3 reviews.
   */
  getMasteredCards(deckId) {
    const cards = CardStorage.getByDeck(deckId);
    return cards
      .map(card => ({ card, stats: ReviewStorage.getCardStats(card.id) }))
      .filter(x => x.stats.totalReviews >= 3 && x.stats.stability >= 60);
  },
```

- [ ] **Step 4: Rewrite `getProgress`**

Replace with:

```javascript
  /**
   * Summarize learning state: new / learning / mastered counts.
   */
  getProgress(deckId) {
    const cards = CardStorage.getByDeck(deckId);
    let newCount = 0, learningCount = 0, masteredCount = 0;

    for (const card of cards) {
      const stats = ReviewStorage.getCardStats(card.id);
      if (stats.totalReviews === 0) newCount++;
      else if (stats.totalReviews >= 3 && stats.stability >= 60) masteredCount++;
      else learningCount++;
    }

    return {
      total: cards.length,
      new: newCount,
      learning: learningCount,
      mastered: masteredCount,
      percentMastered: cards.length > 0 ? Math.round((masteredCount / cards.length) * 100) : 0
    };
  },
```

- [ ] **Step 5: Reload `verify.html` to confirm nothing regressed**

Expected: all existing tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add js/scheduler.js
git commit -m "Port getNextCard, getUrgentCards, getMasteredCards, getProgress to retrievability"
```

---

## Task 10: Replace Settings UI sliders

**Files:**
- Modify: `index.html:524-615`

- [ ] **Step 1: Replace the four retired sliders**

In `/Users/erykwarren/perso/dev/flash-cards/index.html`, replace the block from line 528 through line 590 (four `<div>` blocks: Failure Weight, Recency Weight, Exposure Weight, Target Exposures) with three new blocks:

```html
            <!-- Success Multiplier (a) -->
            <div>
              <div class="flex justify-between mb-2">
                <label class="text-text-muted">Success Multiplier</label>
                <span class="font-mono text-accent" x-text="$store.settings.values.successMultiplier"></span>
              </div>
              <input 
                type="range" 
                min="1.1" max="3.0" step="0.1"
                class="w-full"
                x-model="$store.settings.values.successMultiplier"
                @change="$store.settings.update('successMultiplier', $event.target.value)"
              >
              <p class="text-xs text-text-muted mt-1">Higher = correct answers grow intervals faster</p>
            </div>
            
            <!-- Failure Multiplier (b) -->
            <div>
              <div class="flex justify-between mb-2">
                <label class="text-text-muted">Failure Multiplier</label>
                <span class="font-mono text-accent" x-text="$store.settings.values.failureMultiplier"></span>
              </div>
              <input 
                type="range" 
                min="0.1" max="0.9" step="0.05"
                class="w-full"
                x-model="$store.settings.values.failureMultiplier"
                @change="$store.settings.update('failureMultiplier', $event.target.value)"
              >
              <p class="text-xs text-text-muted mt-1">Lower = missed cards reset harder</p>
            </div>
            
            <!-- Initial Stability (S₀) -->
            <div>
              <div class="flex justify-between mb-2">
                <label class="text-text-muted">Initial Stability (days)</label>
                <span class="font-mono text-accent" x-text="$store.settings.values.initialStability"></span>
              </div>
              <input 
                type="range" 
                min="0.25" max="5.0" step="0.25"
                class="w-full"
                x-model="$store.settings.values.initialStability"
                @change="$store.settings.update('initialStability', $event.target.value)"
              >
              <p class="text-xs text-text-muted mt-1">Days before a new card becomes due</p>
            </div>
```

The "New Cards Per Session" block below stays untouched.

- [ ] **Step 2: Serve the app and open it**

Run `./update-version.sh && python -m http.server 8000` from the repo root. Open `http://localhost:8000/` and navigate to Settings.

Expected: three new sliders (Success Multiplier, Failure Multiplier, Initial Stability) plus New Cards Per Session. Move each slider and confirm its numeric readout updates.

- [ ] **Step 3: Verify "Reset to Defaults" still works**

Click Reset to Defaults. Confirm the three new sliders snap back to 2.0, 0.5, 1.0 respectively and New Cards Per Session returns to 5. Open devtools, check `localStorage.getItem('flashcards_settings')` — should contain only the five keys from the new `DEFAULT_SETTINGS`.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Swap legacy algorithm sliders for retrievability parameters"
```

---

## Task 11: End-to-end smoke test

**Files:** none (manual verification)

- [ ] **Step 1: Clean localStorage to simulate a fresh user with legacy data**

In browser devtools console, set up a realistic starting state:

```javascript
// Pretend the user had old settings from a previous version
localStorage.setItem('flashcards_settings', JSON.stringify({
  failureWeight: 3.0, recencyWeight: 2.0, exposureWeight: 1.5,
  targetExposures: 7, maxRecencyDays: 30, recentPenaltyMinutes: 10,
  newCardsPerSession: 5
}));
location.reload();
```

- [ ] **Step 2: Open Settings, confirm graceful upgrade**

Expected: three new sliders render with their DEFAULT values (2.0, 0.5, 1.0), not NaN. The old keys may still exist in localStorage — that's fine, they're inert. New Cards Per Session should read 5 (preserved from the user's old settings).

- [ ] **Step 3: Run a real session on a deck with existing reviews**

Sign in (if not already), pick a deck with at least 10 cards and some review history. Start a session. Confirm:
- Cards load without console errors.
- Tapping reveals the answer; Correct / Incorrect buttons work.
- Session ends with a success message. No errors in console.

- [ ] **Step 4: Inspect ranking sanity**

In devtools console after your deck is loaded (replace `DECK_ID` with the deck's id, visible via `DeckStorage.getAll()`):

```javascript
const deckId = DeckStorage.getAll()[0].id;
const now = Date.now();
CardStorage.getByDeck(deckId).map(c => {
  const s = ReviewStorage.getCardStats(c.id);
  return {
    q: c.question.slice(0, 30),
    reviews: s.totalReviews,
    S: s.stability.toFixed(2),
    lastSeenDaysAgo: s.lastReviewedAt ? ((now - s.lastReviewedAt) / 86400000).toFixed(1) : 'never',
    R: s.lastReviewedAt
      ? Scheduler.calculateRetrievability(s.stability, s.lastReviewedAt, now).toFixed(3)
      : 'n/a'
  };
}).sort((a, b) => (a.R === 'n/a' ? -1 : b.R === 'n/a' ? 1 : a.R - b.R));
```

Expected: just-reviewed cards have `R` close to 1.0; cards not seen in weeks have `R` near 0; cards with many consecutive corrects have large `S` (dozens of days).

- [ ] **Step 5: Confirm `verify.html` is all green**

Reload `http://localhost:8000/verify.html`. Expected: all assertions PASS, final summary header green.

- [ ] **Step 6: Final commit if anything was tweaked, otherwise skip**

If Steps 1–5 revealed any bug and you fixed it, commit the fix. Otherwise nothing to commit.

- [ ] **Step 7: Update CLAUDE.md**

The previously-written CLAUDE.md describes the old weighted-priority algorithm (lines 39, 41). Replace the Scheduler paragraph in `CLAUDE.md` with:

```markdown
`Scheduler.calculateStability` folds a card's review events into a stability value `S` (days), multiplying by `successMultiplier` on correct and `failureMultiplier` on incorrect, clamped to `minStability`. `Scheduler.calculateRetrievability(S, lastReviewedAt, now)` returns `R = exp(−t/S)` — the predicted recall probability. `buildQueue` ranks reviewed cards by `R` ascending, caps new cards at `newCardsPerSession`, and applies `priorityShuffle` for minor adjacency variety. Card state is not persisted — stability is recomputed from the append-only `ReviewEvent` log on each `getCardStats` call, keeping the log as the single source of truth.
```

Replace the settings-related mentions accordingly. Commit:

```bash
git add CLAUDE.md
git commit -m "Update CLAUDE.md scheduler description for retrievability model"
```

---

## Post-implementation checklist

- [ ] `verify.html` shows all assertions passing.
- [ ] Settings page renders three new sliders plus New Cards Per Session.
- [ ] Reset to Defaults restores the five new keys.
- [ ] Real deck session works end-to-end.
- [ ] No console errors during normal navigation.
- [ ] Legacy localStorage keys coexist peacefully with the new settings.
- [ ] All intermediate commits are small and reversible.
