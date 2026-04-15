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

    // c_low_R (reviewed 20d ago, R≈0) and the two new cards (R=0) all share top priority.
    // priorityShuffle sort is stable on ties, so all three land in the first 3 positions
    // in some order.
    const firstThreeIds = queue.slice(0, 3).map(c => c.id);
    VERIFY.assert('c_low_R appears in first 3 positions',
      firstThreeIds.includes('c_low_R'),
      `got ${firstThreeIds.join(', ')}`);

    // c_high_R (just-reviewed) should NOT be in first 3
    VERIFY.assert('c_high_R not in first 3 positions',
      !firstThreeIds.includes('c_high_R'),
      `got ${firstThreeIds.join(', ')}`);

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
