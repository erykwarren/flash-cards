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

  // Test cases get appended below by later tasks. Runner awaits async test fns.
  window.addEventListener('load', async () => {
    for (const fn of (window.TESTS || [])) {
      try {
        await fn();
      } catch (err) {
        failed++;
        render('fail', `  FAIL  test threw — ${err && err.message}`);
      }
    }
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

// ---- SheetsService.parseCsv ----
// Note: test cells are chosen to not contain header keywords (q, a, question,
// answer, front, back, term, definition) so isHeaderRow doesn't misclassify
// data rows as headers.
window.TESTS.push(function () {
  VERIFY.group('parseCsv');

  // Plain three-column rows
  const plain = SheetsService.parseCsv('hello,world,exfirst\nfoo,blue,exsecond\n');
  VERIFY.assertEqual('plain CSV → 2 cards', plain.length, 2);
  VERIFY.assertEqual('plain CSV → card[0].question', plain[0].question, 'hello');
  VERIFY.assertEqual('plain CSV → card[1].example', plain[1].example, 'exsecond');

  // Header row auto-skipped
  const withHeader = SheetsService.parseCsv('Question,Answer,Example\nhello,world,exfirst\n');
  VERIFY.assertEqual('header row skipped → 1 card', withHeader.length, 1);
  VERIFY.assertEqual('header row skipped → question value', withHeader[0].question, 'hello');

  // Quoted field with comma
  const withComma = SheetsService.parseCsv('"hello, world",blue,ex\n');
  VERIFY.assertEqual('quoted comma preserved', withComma[0].question, 'hello, world');

  // Escaped "" inside quoted field
  const withQuote = SheetsService.parseCsv('"hello ""world""",blue,ex\n');
  VERIFY.assertEqual('escaped "" produces literal quote', withQuote[0].question, 'hello "world"');

  // Embedded newline inside quoted field
  const withNewline = SheetsService.parseCsv('"line1\nline2",blue,ex\n');
  VERIFY.assertEqual('embedded newline inside quotes', withNewline[0].question, 'line1\nline2');

  // \r\n line terminator
  const crlf = SheetsService.parseCsv('hello,world,exfirst\r\nfoo,blue,exsecond\r\n');
  VERIFY.assertEqual('\\r\\n terminator → 2 cards', crlf.length, 2);

  // Trailing blank rows stripped
  const trailing = SheetsService.parseCsv('hello,world,exfirst\n\n\n');
  VERIFY.assertEqual('trailing blank rows stripped', trailing.length, 1);

  // Missing third column → example is ''
  const noExample = SheetsService.parseCsv('hello,world\n');
  VERIFY.assertEqual('missing example column → empty string', noExample[0].example, '');
});

// ---- SheetsService.parseSheetUrl ----
window.TESTS.push(function () {
  VERIFY.group('parseSheetUrl');

  const full = SheetsService.parseSheetUrl(
    'https://docs.google.com/spreadsheets/d/ABC123/edit#gid=456'
  );
  VERIFY.assertEqual('standard URL → spreadsheetId', full && full.spreadsheetId, 'ABC123');
  VERIFY.assertEqual('standard URL → gid', full && full.gid, '456');

  const noGid = SheetsService.parseSheetUrl(
    'https://docs.google.com/spreadsheets/d/XYZ789/edit'
  );
  VERIFY.assertEqual('no gid → default "0"', noGid && noGid.gid, '0');

  const withQuery = SheetsService.parseSheetUrl(
    'https://docs.google.com/spreadsheets/d/QRY111/edit?usp=sharing#gid=42'
  );
  VERIFY.assertEqual('URL with query params → gid', withQuery && withQuery.gid, '42');

  VERIFY.assertEqual('non-Sheets URL → null',
    SheetsService.parseSheetUrl('https://example.com/somewhere'), null);

  VERIFY.assertEqual('bare ID → null',
    SheetsService.parseSheetUrl('ABC123'), null);
});

// ---- CardStorage.syncCards round-trips ----
window.TESTS.push(async function () {
  VERIFY.group('syncCards round-trips');

  const originalCards = localStorage.getItem('flashcards_cards');
  const originalReviews = localStorage.getItem('flashcards_reviews');
  const originalDecks = localStorage.getItem('flashcards_decks');

  try {
    const deckId = '__verify_sync_deck__';
    // Start from a clean slate for the three collections we touch.
    localStorage.setItem('flashcards_cards', JSON.stringify([]));
    localStorage.setItem('flashcards_reviews', JSON.stringify([]));
    localStorage.setItem('flashcards_decks', JSON.stringify([]));

    // Initial sync: 3 rows
    const initial = [
      { question: 'q1', answer: 'a1', example: 'e1' },
      { question: 'q2', answer: 'a2', example: 'e2' },
      { question: 'q3', answer: 'a3', example: 'e3' }
    ];
    const r1 = await CardStorage.syncCards(deckId, initial);
    VERIFY.assertEqual('initial sync creates 3', r1.created, 3);

    // Capture q2's id so we can attach a review to it and verify log preservation
    const q2Id = await generateCardId(deckId, 'q2', 'a2');
    const fakeReview = {
      id: 'rev_q2',
      cardId: q2Id,
      deckId,
      startedAt: new Date().toISOString(),
      answeredAt: new Date().toISOString(),
      durationMs: 1000,
      outcome: 'correct'
    };
    localStorage.setItem('flashcards_reviews', JSON.stringify([fakeReview]));

    // Re-sync with one row added (q1, q2, q3 still present + q4 new)
    const added = [
      ...initial,
      { question: 'q4', answer: 'a4', example: '' }
    ];
    const r2 = await CardStorage.syncCards(deckId, added);
    VERIFY.assertEqual('added row → creates 1', r2.created, 1);
    VERIFY.assertEqual('added row → archives 0', r2.archived, 0);

    // Re-sync with q2 removed → should archive exactly 1
    const removed = initial.filter(r => r.question !== 'q2').concat([
      { question: 'q4', answer: 'a4', example: '' }
    ]);
    const r3 = await CardStorage.syncCards(deckId, removed);
    VERIFY.assertEqual('removed row → archives 1', r3.archived, 1);

    // Review events for archived q2 are still readable from the log
    const q2Reviews = ReviewStorage.getByCard(q2Id);
    VERIFY.assertEqual('archived card\'s review log preserved', q2Reviews.length, 1);

    // Edit q1's question text → old q1 archived, new card with different id created
    const edited = [
      { question: 'q1_edited', answer: 'a1', example: 'e1' },
      ...removed.filter(r => r.question !== 'q1')
    ];
    const oldQ1Id = await generateCardId(deckId, 'q1', 'a1');
    const newQ1Id = await generateCardId(deckId, 'q1_edited', 'a1');
    VERIFY.assert('edited text produces different id', oldQ1Id !== newQ1Id);
    await CardStorage.syncCards(deckId, edited);
    const oldQ1 = CardStorage.getById(oldQ1Id);
    const newQ1 = CardStorage.getById(newQ1Id);
    VERIFY.assert('old card archived after edit', oldQ1 && oldQ1.isArchived === true);
    VERIFY.assert('new card created after edit, not archived',
      newQ1 && newQ1.isArchived === false);
  } finally {
    if (originalCards === null) localStorage.removeItem('flashcards_cards');
    else localStorage.setItem('flashcards_cards', originalCards);
    if (originalReviews === null) localStorage.removeItem('flashcards_reviews');
    else localStorage.setItem('flashcards_reviews', originalReviews);
    if (originalDecks === null) localStorage.removeItem('flashcards_decks');
    else localStorage.setItem('flashcards_decks', originalDecks);
  }
});
