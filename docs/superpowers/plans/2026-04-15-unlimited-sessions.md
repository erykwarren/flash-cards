# Unlimited Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed-length pre-built session queue with a continuous weighted-random Ebbinghaus picker, add a session-local retry queue for missed cards, and expose an alpha knob so correct cards retain a diminishing reappearance probability.

**Architecture:** The core Ebbinghaus model (`S`, `R = exp(−t/S)`, append-only `ReviewEvent` log) is unchanged. We swap the picker from "top-5 lowest-R uniform pick" to "weighted sample over all eligible cards by `(1 − R)^α`", remove the pre-built queue from the session store, and maintain a session-local retry queue for cards answered incorrectly. UI drops the "N remaining" indicator and the finite progress bar.

**Tech Stack:** Vanilla JS, Alpine.js, Tailwind (all via CDN). Browser-based verification via `verify.html` + `js/verify.js`. No build, no package manager, no test framework.

---

## File Structure

- **Modify `js/storage.js`** — Add `pickerAlpha` to `DEFAULT_SETTINGS`.
- **Modify `js/scheduler.js`** — Add `pickNextCard()` and an internal `_weightedSample()` helper. Remove `buildQueue`, `getNextCard`, `priorityShuffle`.
- **Modify `js/app.js`** — Rework the `session` Alpine store: drop `queue` / `nextCardData` / `getProgress`; add `retryQueue` and `newCardsSurfaced`; call `Scheduler.pickNextCard` after each answer.
- **Modify `index.html`** — Replace the progress bar with a reviewed/correct readout. Add an α slider in the Settings view. Update the session header to not reference `queue.length`.
- **Modify `js/verify.js`** — Replace the `buildQueue` test group with `pickNextCard` + weighted sampling tests.

---

## Task 1: Add `pickerAlpha` setting

**Files:**
- Modify: `js/storage.js:13-19` (DEFAULT_SETTINGS)

- [ ] **Step 1: Add `pickerAlpha` to `DEFAULT_SETTINGS`**

Open `js/storage.js` and update the constant:

```javascript
const DEFAULT_SETTINGS = {
  successMultiplier: 2.0,     // S grows by this factor on correct
  failureMultiplier: 0.5,     // S shrinks by this factor on incorrect
  initialStability: 1.0,      // days; S for first review
  minStability: 0.5,          // days; floor so S never collapses
  newCardsPerSession: 5,      // cap on brand-new cards per session
  pickerAlpha: 1.0            // exponent on (1 − R) in the session picker; higher = sharper bias to due cards
};
```

- [ ] **Step 2: Commit**

```bash
git add js/storage.js
git commit -m "Add pickerAlpha to default settings"
```

---

## Task 2: Add `_weightedSample` helper with tests

**Files:**
- Modify: `js/scheduler.js` (append before the final `window.Scheduler =` line)
- Modify: `js/verify.js` (new test group)

- [ ] **Step 1: Write failing test for `_weightedSample`**

Add this test group to `js/verify.js`, immediately after the existing `calculateRetrievability` test group (search for `VERIFY.group('calculateRetrievability')` and add after its closing `});`):

```javascript
// ---- _weightedSample ----
window.TESTS.push(function () {
  VERIFY.group('_weightedSample');

  // Deterministic: one item with non-zero weight is always picked.
  const one = Scheduler._weightedSample(
    [{ v: 'a' }, { v: 'b' }, { v: 'c' }],
    [0, 1, 0]
  );
  VERIFY.assertEqual('single non-zero weight is picked', one.v, 'b');

  // All-zero weights returns null.
  const none = Scheduler._weightedSample([{ v: 'a' }], [0]);
  VERIFY.assertEqual('all-zero weights returns null', none, null);

  // Empty input returns null.
  VERIFY.assertEqual('empty input returns null', Scheduler._weightedSample([], []), null);

  // Distribution: over 10,000 trials with weights [1, 3], item B should be picked
  // roughly 75% of the time (± 3%).
  let bCount = 0;
  for (let i = 0; i < 10000; i++) {
    const pick = Scheduler._weightedSample([{ v: 'a' }, { v: 'b' }], [1, 3]);
    if (pick.v === 'b') bCount++;
  }
  const ratio = bCount / 10000;
  VERIFY.assert('weight [1,3] picks B ~75% of the time',
    ratio > 0.72 && ratio < 0.78,
    `got ${ratio.toFixed(3)}`);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Open `http://localhost:8000/verify.html` in a browser (start the server first with `python -m http.server 8000` if not running). Expected: three FAILs in the `_weightedSample` group (function not defined).

- [ ] **Step 3: Implement `_weightedSample`**

Add this method to the `Scheduler` object in `js/scheduler.js`, between `calculateRetrievability` and `buildQueue`:

```javascript
  /**
   * Pick one item from `items` weighted by `weights` (parallel arrays).
   * Returns null if items is empty or all weights are zero.
   *
   * @param {Array} items
   * @param {Array<number>} weights - non-negative, same length as items
   * @returns {*} selected item or null
   */
  _weightedSample(items, weights) {
    if (items.length === 0) return null;
    let total = 0;
    for (const w of weights) total += w;
    if (total <= 0) return null;

    let r = Math.random() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1]; // floating-point safety net
  },
```

- [ ] **Step 4: Run the test and verify it passes**

Reload `http://localhost:8000/verify.html`. Expected: all four assertions in `_weightedSample` PASS.

- [ ] **Step 5: Commit**

```bash
git add js/scheduler.js js/verify.js
git commit -m "Add Scheduler._weightedSample with tests"
```

---

## Task 3: Implement `pickNextCard` with tests

**Files:**
- Modify: `js/scheduler.js`
- Modify: `js/verify.js`

- [ ] **Step 1: Write failing tests for `pickNextCard`**

Add this test group to `js/verify.js` immediately after the `_weightedSample` group:

```javascript
// ---- pickNextCard ----
window.TESTS.push(function () {
  VERIFY.group('pickNextCard');

  const originalSettings = localStorage.getItem('flashcards_settings');
  const originalReviews = localStorage.getItem('flashcards_reviews');
  const originalCards = localStorage.getItem('flashcards_cards');

  try {
    SettingsStorage.update({ pickerAlpha: 1.0, newCardsPerSession: 5 });
    const deckId = '__verify_pick__';
    const day = 86400000;
    const now = Date.now();

    // Three cards:
    //   c_due: reviewed 20 days ago, one correct → R ≈ 0 (very due)
    //   c_fresh: reviewed 1 hour ago, one correct → R ≈ 1 (not due)
    //   c_new: never reviewed → R = 0 (maximally due)
    const cards = [
      { id: 'c_due', deckId, question: 'due', answer: 'due', isArchived: false, createdAt: new Date().toISOString() },
      { id: 'c_fresh', deckId, question: 'fresh', answer: 'fresh', isArchived: false, createdAt: new Date().toISOString() },
      { id: 'c_new', deckId, question: 'new', answer: 'new', isArchived: false, createdAt: new Date().toISOString() }
    ];
    localStorage.setItem('flashcards_cards', JSON.stringify(cards));

    const reviews = [
      { id: 'rv1', cardId: 'c_due', deckId, startedAt: new Date(now - 20 * day).toISOString(),
        answeredAt: new Date(now - 20 * day).toISOString(), durationMs: 1000, outcome: 'correct' },
      { id: 'rv2', cardId: 'c_fresh', deckId, startedAt: new Date(now - 3600000).toISOString(),
        answeredAt: new Date(now - 3600000).toISOString(), durationMs: 1000, outcome: 'correct' }
    ];
    localStorage.setItem('flashcards_reviews', JSON.stringify(reviews));

    // Distribution check: over 2000 picks, c_fresh should appear rarely (< 5%),
    // and c_due + c_new should dominate.
    const counts = { c_due: 0, c_fresh: 0, c_new: 0 };
    for (let i = 0; i < 2000; i++) {
      const card = Scheduler.pickNextCard(deckId, {});
      counts[card.id]++;
    }
    VERIFY.assert('c_fresh picked rarely (< 5%)',
      counts.c_fresh < 100,
      `got ${counts.c_fresh}/2000`);
    VERIFY.assert('c_due + c_new dominate (> 95%)',
      counts.c_due + counts.c_new > 1900,
      `got ${counts.c_due + counts.c_new}/2000`);

    // Random start: two separate picks don't always return the same card.
    const picks = new Set();
    for (let i = 0; i < 50; i++) picks.add(Scheduler.pickNextCard(deckId, {}).id);
    VERIFY.assert('first pick varies across runs', picks.size >= 2, `got ${picks.size} distinct`);

    // excludeCardId: pickNextCard honors exclusion.
    for (let i = 0; i < 100; i++) {
      const pick = Scheduler.pickNextCard(deckId, { excludeCardId: 'c_due' });
      if (pick.id === 'c_due') {
        VERIFY.assert('excludeCardId honored', false, 'picker returned excluded card');
        return;
      }
    }
    VERIFY.assert('excludeCardId honored', true);

    // excludeNew: new cards are excluded when flag set.
    for (let i = 0; i < 100; i++) {
      const pick = Scheduler.pickNextCard(deckId, { excludeNew: true });
      if (pick.id === 'c_new') {
        VERIFY.assert('excludeNew honored', false, 'picker returned new card');
        return;
      }
    }
    VERIFY.assert('excludeNew honored', true);

    // Empty deck: returns null.
    VERIFY.assertEqual('empty deck returns null',
      Scheduler.pickNextCard('__no_such_deck__', {}), null);

    // Only excluded card available: returns null.
    localStorage.setItem('flashcards_cards', JSON.stringify([cards[0]]));
    VERIFY.assertEqual('all cards excluded returns null',
      Scheduler.pickNextCard(deckId, { excludeCardId: 'c_due' }), null);
  } finally {
    if (originalSettings === null) localStorage.removeItem('flashcards_settings');
    else localStorage.setItem('flashcards_settings', originalSettings);
    if (originalReviews === null) localStorage.removeItem('flashcards_reviews');
    else localStorage.setItem('flashcards_reviews', originalReviews);
    if (originalCards === null) localStorage.removeItem('flashcards_cards');
    else localStorage.setItem('flashcards_cards', originalCards);
  }
});
```

- [ ] **Step 2: Run tests and verify they fail**

Reload `http://localhost:8000/verify.html`. Expected: multiple FAILs in `pickNextCard` group (`Scheduler.pickNextCard is not a function`).

- [ ] **Step 3: Implement `pickNextCard`**

Add this method to `Scheduler` in `js/scheduler.js`, between `_weightedSample` and `buildQueue`:

```javascript
  /**
   * Pick the next card for the session using weighted-random sampling over all
   * non-excluded cards, weighted by (1 − R)^alpha.
   *
   * @param {string} deckId
   * @param {Object} opts
   * @param {string|null} [opts.excludeCardId] - card to skip this turn
   * @param {boolean} [opts.excludeNew] - if true, skip never-reviewed cards
   * @param {number} [opts.alpha] - override settings.pickerAlpha
   * @returns {Object|null} selected card or null if none eligible
   */
  pickNextCard(deckId, opts = {}) {
    const settings = SettingsStorage.get();
    const alpha = opts.alpha != null ? opts.alpha : (settings.pickerAlpha != null ? settings.pickerAlpha : 1.0);
    const now = Date.now();

    const cards = CardStorage.getByDeck(deckId);
    const eligible = [];
    const weights = [];

    for (const card of cards) {
      if (opts.excludeCardId && card.id === opts.excludeCardId) continue;
      const stats = ReviewStorage.getCardStats(card.id);
      const isNew = stats.totalReviews === 0;
      if (opts.excludeNew && isNew) continue;

      const R = isNew ? 0 : this.calculateRetrievability(stats.stability, stats.lastReviewedAt, now);
      const weight = Math.pow(Math.max(0, 1 - R), alpha);
      eligible.push(card);
      weights.push(weight);
    }

    return this._weightedSample(eligible, weights);
  },
```

- [ ] **Step 4: Run tests and verify they pass**

Reload `http://localhost:8000/verify.html`. Expected: all assertions in `pickNextCard` PASS.

- [ ] **Step 5: Commit**

```bash
git add js/scheduler.js js/verify.js
git commit -m "Add Scheduler.pickNextCard with weighted-random sampling"
```

---

## Task 4: Remove obsolete scheduler methods and their tests

**Files:**
- Modify: `js/scheduler.js`
- Modify: `js/verify.js`

- [ ] **Step 1: Delete the old `buildQueue` test group from `js/verify.js`**

In `js/verify.js`, delete the entire test group starting at `window.TESTS.push(function () {` whose next line is `VERIFY.group('buildQueue');` and ending at the matching `});`. This is the block currently spanning roughly lines 170–251 (find it by searching for `VERIFY.group('buildQueue')`).

- [ ] **Step 2: Delete the old methods from `js/scheduler.js`**

In `js/scheduler.js`, delete the following methods from the `Scheduler` object:
- `buildQueue` (currently the method with JSDoc "Build a review queue ranked by Ebbinghaus retrievability.")
- `priorityShuffle` (currently the method with JSDoc "Shuffle cards while maintaining priority bias")
- `getNextCard` (currently the method with JSDoc "Pick the single next card to review, ranked by retrievability.")

Keep: `calculateStability`, `calculateRetrievability`, `_weightedSample`, `pickNextCard`, `getUrgentCards`, `getMasteredCards`, `getProgress`.

- [ ] **Step 3: Run the verify harness and confirm no regressions**

Reload `http://localhost:8000/verify.html`. Expected: zero failures. The `buildQueue` group is gone; all other groups (`calculateStability`, `calculateRetrievability`, `getCardStats integration`, `_weightedSample`, `pickNextCard`, `parseCsv`, `parseSheetUrl`, `syncCards round-trips`) PASS.

- [ ] **Step 4: Grep for any remaining references to the removed methods**

Use the Grep tool:
```
pattern: "buildQueue|priorityShuffle|getNextCard"
path: /Users/erykwarren/perso/dev/flash-cards
```

Expected matches: only inside documentation files (`CLAUDE.md`, `docs/superpowers/specs/...`). Any match in `js/` or `index.html` must be cleaned up before committing.

- [ ] **Step 5: Commit**

```bash
git add js/scheduler.js js/verify.js
git commit -m "Remove buildQueue, getNextCard, priorityShuffle — replaced by pickNextCard"
```

---

## Task 5: Rework `session.start` to drop the pre-built queue

**Files:**
- Modify: `js/app.js:201-260`

- [ ] **Step 1: Update the `session` store's field declarations**

In `js/app.js`, locate the `Alpine.store('session', { ... })` call (starts around line 201). Replace the field block (from `// State: 'question' | 'answer' | 'flipping'` down through `isActive: false,`) with:

```javascript
    // State: 'question' | 'answer' | 'flipping'
    state: 'question',

    // Deck currently being studied
    currentDeckId: null,

    // Current card being reviewed
    currentCard: null,

    // Next card (preloaded during flip animation)
    nextCardData: null,

    // Session start time
    sessionStartedAt: null,

    // Current card start time
    cardStartedAt: null,

    // Cards reviewed in this session
    reviewedCount: 0,

    // Correct answers in this session
    correctCount: 0,

    // Session-local retry queue: cards answered incorrectly, waiting to reappear.
    // Each entry: { cardId: string, counter: number } — counter decrements after each
    // subsequent answer; card resurfaces when counter <= 0.
    retryQueue: [],

    // Count of never-reviewed cards surfaced this session (for newCardsPerSession cap)
    newCardsSurfaced: 0,

    // Is session active
    isActive: false,
```

- [ ] **Step 2: Add `_pickNext` and `_isNew` helpers to the `session` store**

Immediately before the `start(deckId)` method in the same store, insert:

```javascript
    /**
     * Return true if the card has never been reviewed.
     */
    _isNew(cardId) {
      return ReviewStorage.getCardStats(cardId).totalReviews === 0;
    },

    /**
     * Pick the next card to surface, consulting the retry queue first.
     *
     * @param {string|null} justAnsweredId - card just answered (excluded from immediate repeat)
     * @returns {Object|null} card object or null if no candidate
     */
    _pickNext(justAnsweredId) {
      // 1. Retry queue: any counter <= 0 means "due now". If multiple, smallest counter wins.
      const dueRetries = this.retryQueue
        .filter(r => r.counter <= 0)
        .sort((a, b) => a.counter - b.counter);
      if (dueRetries.length > 0) {
        const retryId = dueRetries[0].cardId;
        this.retryQueue = this.retryQueue.filter(r => r.cardId !== retryId);
        const card = CardStorage.getById(retryId);
        if (card && !card.isArchived) return card;
      }

      // 2. Weighted picker. Exclude the just-answered card for this turn.
      //    Cap new cards: if we've hit newCardsPerSession, exclude never-reviewed.
      const settings = SettingsStorage.get();
      const excludeNew = this.newCardsSurfaced >= (settings.newCardsPerSession || 0);

      const picked = Scheduler.pickNextCard(this.currentDeckId, {
        excludeCardId: justAnsweredId,
        excludeNew
      });

      // 3. If picker returned nothing AND we excluded new cards, relax the cap as a
      //    fallback so the session never stalls in a tiny deck.
      if (!picked && excludeNew) {
        return Scheduler.pickNextCard(this.currentDeckId, {
          excludeCardId: justAnsweredId,
          excludeNew: false
        });
      }
      return picked;
    },
```

- [ ] **Step 3: Replace the `start()` method**

In the same store, replace the entire `start(deckId) { ... }` method (currently ends around line 260) with:

```javascript
    /**
     * Start a new session. No pre-built queue — cards are picked one at a time
     * via Scheduler.pickNextCard after each answer.
     */
    start(deckId) {
      const cards = CardStorage.getByDeck(deckId);
      if (cards.length === 0) {
        Alpine.store('app').showError('No cards in this deck. Add a deck from Settings and refresh.');
        return false;
      }

      this.currentDeckId = deckId;
      this.sessionStartedAt = Date.now();
      this.reviewedCount = 0;
      this.correctCount = 0;
      this.retryQueue = [];
      this.newCardsSurfaced = 0;
      this.isActive = true;
      this.state = 'question';
      this.nextCardData = null;

      // Pick the first card.
      const first = this._pickNext(null);
      if (!first) {
        Alpine.store('app').showError('No cards to review right now.');
        this.isActive = false;
        return false;
      }

      this.currentCard = first;
      if (this._isNew(first.id)) this.newCardsSurfaced++;
      this.cardStartedAt = Date.now();

      Alpine.store('app').navigate('session');
      return true;
    },
```

- [ ] **Step 4: Commit**

This intentionally leaves `answer()` / `end()` / `getProgress` temporarily referencing the removed `queue` field. Do NOT reload the app yet — the next task fixes those.

```bash
git add js/app.js
git commit -m "Rework session.start: drop pre-built queue, add retry-queue helpers"
```

---

## Task 6: Rework `session.answer` / `end` / `getProgress`

**Files:**
- Modify: `js/app.js` (the `answer()`, `getProgress()`, and `end()` methods in the `session` store)

- [ ] **Step 1: Replace the `answer()` method**

Replace the entire `answer(correct) { ... }` method in the `session` store with:

```javascript
    /**
     * Answer the card. Records the review, updates the retry queue, then picks
     * the next card via the continuous picker.
     *
     * @param {boolean} correct
     */
    answer(correct) {
      if (this.state !== 'answer' || !this.currentCard) return;

      const answeredAt = Date.now();
      const durationMs = answeredAt - this.cardStartedAt;
      const answeredCardId = this.currentCard.id;

      ReviewStorage.create({
        cardId: answeredCardId,
        deckId: this.currentCard.deckId,
        startedAt: new Date(this.cardStartedAt).toISOString(),
        answeredAt: new Date(answeredAt).toISOString(),
        durationMs,
        outcome: correct ? 'correct' : 'incorrect'
      });

      this.reviewedCount++;
      if (correct) this.correctCount++;

      // Decrement every retry counter (tick one step of session time).
      this.retryQueue = this.retryQueue.map(r => ({ ...r, counter: r.counter - 1 }));
      // Drop any lingering retry entry for the card we just answered.
      this.retryQueue = this.retryQueue.filter(r => r.cardId !== answeredCardId);

      // On incorrect, schedule a retry with counter drawn uniformly from [5, 15],
      // clamped so we don't exceed (deck size − 1).
      if (!correct) {
        const deckSize = CardStorage.getByDeck(this.currentDeckId).length;
        const maxK = Math.max(1, deckSize - 1);
        const k = Math.min(maxK, 5 + Math.floor(Math.random() * 11)); // 5..15 inclusive
        this.retryQueue.push({ cardId: answeredCardId, counter: k });
      }

      const next = this._pickNext(answeredCardId);
      if (!next) {
        // Deck is effectively empty (e.g., one-card deck). End gracefully.
        this.end();
        return;
      }

      this.nextCardData = next;
      this.state = 'flipping';

      setTimeout(() => {
        this.currentCard = this.nextCardData;
        this.nextCardData = null;
        if (this._isNew(this.currentCard.id)) this.newCardsSurfaced++;
        this.cardStartedAt = Date.now();
        this.state = 'question';
      }, 600);
    },
```

- [ ] **Step 2: Replace `getProgress()` with a reviewed-count readout helper**

Still in the `session` store, replace the entire `getProgress()` method with:

```javascript
    /**
     * Summary for the session header. Returns a short human-readable line.
     */
    getSummary() {
      if (this.reviewedCount === 0) return '0 reviewed';
      const rate = Math.round((this.correctCount / this.reviewedCount) * 100);
      return `${this.reviewedCount} reviewed · ${rate}% correct`;
    },
```

- [ ] **Step 3: Update `end()` to clear retry state**

In the same store, replace the `end()` method with:

```javascript
    /**
     * End the session. Wipes retry queue and session counters.
     */
    end() {
      this.isActive = false;
      this.currentCard = null;
      this.currentDeckId = null;
      this.retryQueue = [];
      this.newCardsSurfaced = 0;
      Alpine.store('app').navigate('home');

      if (this.reviewedCount > 0) {
        const rate = Math.round((this.correctCount / this.reviewedCount) * 100);
        Alpine.store('app').showSuccess(
          `Session ended. ${this.reviewedCount} cards reviewed, ${rate}% correct.`
        );
      }
    },
```

- [ ] **Step 4: Commit**

The app still references `queue.length` and `getProgress` in `index.html` — the next task fixes those. Don't reload yet.

```bash
git add js/app.js
git commit -m "Use continuous picker + retry queue in session.answer"
```

---

## Task 7: Update session UI in `index.html`

**Files:**
- Modify: `index.html:280-292` (session progress header)

- [ ] **Step 1: Replace the progress bar block**

In `index.html`, locate the `<!-- Progress Bar -->` block (around line 280). Replace the entire block (from `<!-- Progress Bar -->` through its closing `</div>` on line 292 — i.e., through the `</div>` that closes `class="w-full max-w-md mb-8"`) with:

```html
          <!-- Session header (unbounded session — no fixed total) -->
          <div class="w-full max-w-md mb-8 text-center">
            <p class="text-sm text-text-muted" x-text="$store.session.getSummary()"></p>
          </div>
```

- [ ] **Step 2: Verify no remaining references to `queue.length` or `getProgress`**

Use the Grep tool:
```
pattern: "queue\\.length|getProgress"
path: /Users/erykwarren/perso/dev/flash-cards/index.html
```

Expected: zero matches.

Also:
```
pattern: "\\.queue\\b"
path: /Users/erykwarren/perso/dev/flash-cards/js
```

Expected: zero matches (the session store no longer has a `queue` field).

- [ ] **Step 3: Manual browser smoke test**

Start the dev server if not running: `python -m http.server 8000`. Open `http://localhost:8000`. Start a study session on any deck with ≥ 10 cards.

Verify:
- Session starts without errors in the console.
- The header shows "0 reviewed" initially, then updates to "N reviewed · X% correct" after answering.
- No "N remaining" text appears.
- Answering "Missed" on a card: within the next 5–15 answers, that card reappears.
- Clicking "End Session" / pressing ESC returns to home and shows the success toast.
- Starting a new session picks a different first card than last time (try 2–3 starts).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Replace session progress bar with reviewed-count summary"
```

---

## Task 8: Expose `pickerAlpha` in Settings UI

**Files:**
- Modify: `index.html` (Settings view, after the New Cards Per Session block around line 589)

- [ ] **Step 1: Add the α slider**

In `index.html`, find the `<!-- New Cards Per Session -->` block (around line 575) and its closing `</div>` (around line 589). Immediately after that closing `</div>` and before `<!-- Reset Button -->`, insert:

```html
            <!-- Due-card Bias (α) -->
            <div>
              <div class="flex justify-between mb-2">
                <label class="text-text-muted">Due-card Bias (α)</label>
                <span class="font-mono text-accent" x-text="$store.settings.values.pickerAlpha"></span>
              </div>
              <input
                type="range"
                min="0.5" max="3.0" step="0.1"
                class="w-full"
                x-model="$store.settings.values.pickerAlpha"
                @change="$store.settings.update('pickerAlpha', $event.target.value)"
              >
              <p class="text-xs text-text-muted mt-1">Higher = stronger bias toward cards with low recall</p>
            </div>
```

- [ ] **Step 2: Manual browser smoke test**

Reload `http://localhost:8000`. Navigate to Settings.

Verify:
- The new "Due-card Bias (α)" slider appears below "New Cards Per Session".
- Default value reads `1` (may display as `1` or `1.0` depending on stored type).
- Dragging the slider updates the displayed number.
- Clicking "Reset to Defaults" restores α to 1.
- Starting a session still works with the new value.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Expose pickerAlpha slider in settings view"
```

---

## Task 9: Update `CLAUDE.md` scheduler description

**Files:**
- Modify: `CLAUDE.md` (the Scheduler and Session state machine sections)

- [ ] **Step 1: Update the Scheduler section**

In `CLAUDE.md`, find the paragraph starting with `` `Scheduler.calculateStability` folds `` (under the `### Scheduler` heading). Replace the whole paragraph (the one that describes `buildQueue` and `priorityShuffle`) with:

```
`Scheduler.calculateStability` folds a card's review events into a stability value `S` (days), multiplying by `successMultiplier` on correct and `failureMultiplier` on incorrect, clamped to `minStability`. `Scheduler.calculateRetrievability(S, lastReviewedAt, now)` returns `R = exp(−t/S)` — the predicted recall probability. `Scheduler.pickNextCard(deckId, opts)` picks the next card via weighted-random sampling over all eligible cards, with weight `(1 − R)^α`; this keeps the top-priority position stochastic (random session start) while still heavily favoring low-R cards. Card state is not persisted — stability is recomputed from the append-only `ReviewEvent` log on each `getCardStats` call, keeping the log as the single source of truth.

Algorithm parameters (`successMultiplier`, `failureMultiplier`, `initialStability`, `pickerAlpha`) are user-tunable in the Settings view. A browser-based verification harness lives at `/verify.html` (loads `js/verify.js`); it runs assertions covering stability folding, retrievability, `getCardStats` integration, weighted sampling, `pickNextCard`, CSV parsing, URL parsing, and `syncCards` round-trips.
```

- [ ] **Step 2: Update the Session state machine section**

Find the `### Session state machine` section and replace it with:

```
### Session state machine

`Alpine.store('session')` has three states: `question` → (tap) → `answer` → (grade button) → `flipping` → (600 ms timeout) → `question` with the next card. The 600 ms matches the CSS flip animation duration; changing one requires changing the other. Answers are only accepted in the `answer` state.

Sessions are unbounded: there is no pre-built queue. After each answer, `session._pickNext` consults a session-local `retryQueue` (cards answered incorrectly, scheduled to reappear after 5–15 answers) before falling back to `Scheduler.pickNextCard`. The session ends only when the user clicks "End Session" or presses ESC — or when the deck is effectively empty (e.g., a one-card deck with the just-answered card excluded). The `newCardsPerSession` cap is enforced by excluding never-reviewed cards from the picker once the cap is reached, and relaxed as a fallback if that would leave no candidate.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Update CLAUDE.md for continuous picker and unbounded sessions"
```

---

## Task 10: End-to-end verification

- [ ] **Step 1: Run the full verify harness**

Open `http://localhost:8000/verify.html`. Expected: a green "N passed, 0 failed" summary covering these groups:
- `calculateStability`
- `calculateRetrievability`
- `getCardStats integration`
- `_weightedSample`
- `pickNextCard`
- `parseCsv`
- `parseSheetUrl`
- `syncCards round-trips`

- [ ] **Step 2: Full interactive smoke test**

Open `http://localhost:8000`. With a deck of at least 10 cards:

1. Start a session. Verify the first card isn't always the same across 3 fresh starts.
2. Answer 5 cards correctly. Note that none of them reappear in the next 5 answers.
3. Answer one card "Missed". Continue answering the next 15 cards. Verify the missed card reappears within that window.
4. End the session via the button. Verify the toast shows "N cards reviewed, X% correct."
5. End another session via ESC. Same behavior.
6. Go to Settings, lower α to 0.5. Start a session and confirm it still works (distribution is just flatter).
7. Reset defaults. Confirm α returns to 1.0.
8. Reload the page; start a session. Confirm no errors and behavior matches.

- [ ] **Step 3: Final grep for stale references**

Use Grep to confirm no code (non-docs) references the removed symbols:
```
pattern: "buildQueue|priorityShuffle|getNextCard|session\\.queue|\\.getProgress\\("
path: /Users/erykwarren/perso/dev/flash-cards
```

Expected non-doc matches: zero. If anything shows up in `js/` or `index.html`, stop and clean it up before wrapping.

- [ ] **Step 4: Final commit (only if step 3 produced cleanups)**

If step 3 required any edits:

```bash
git add -A
git commit -m "Clean up stale references to removed scheduler symbols"
```

Otherwise skip — the feature is complete.
