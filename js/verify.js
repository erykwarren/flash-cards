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
    SettingsStorage.update({ pickerAlpha: 1.0, newCardsPerSession: 0 });
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
  VERIFY.assertEqual('plain CSV → card[1] extras', JSON.stringify(plain[1].extras),
    JSON.stringify([{ kind: 'example', label: 'Example', value: 'exsecond' }]));

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
  VERIFY.assertEqual('missing example column → no extras', noExample[0].extras.length, 0);
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

// ---- SheetsService.parseTabList ----
window.TESTS.push(function () {
  VERIFY.group('parseTabList');

  const html =
    'items.push({name: "Noms propres", pageUrl: "https:\\/\\/x\\/htmlview\\/sheet?headers\\x3dtrue&gid=0", gid: "0",initialSheet: ("0" == gid)});' +
    'items.push({name: "d\\xe9monstratifs \\"x\\"", pageUrl: "https:\\/\\/x?gid=123", gid: "123",initialSheet: ("123" == gid)});' +
    'items.push({name: "Noms propres", pageUrl: "dup", gid: "0",initialSheet: false});';
  const tabs = SheetsService.parseTabList(html);
  VERIFY.assertEqual('finds 2 unique tabs', tabs.length, 2);
  VERIFY.assertEqual('first tab name', tabs[0] && tabs[0].name, 'Noms propres');
  VERIFY.assertEqual('first tab gid', tabs[0] && tabs[0].gid, '0');
  VERIFY.assertEqual('decodes \\x and \\" escapes', tabs[1] && tabs[1].name, 'démonstratifs "x"');
  VERIFY.assertEqual('second tab gid', tabs[1] && tabs[1].gid, '123');
  VERIFY.assertEqual('no tabs → empty list', SheetsService.parseTabList('<html></html>').length, 0);
});

// Note: words avoid 'a'/'q' so isHeaderRow doesn't eat first rows (see parseCsv note).
// ---- Categories: fetchSpreadsheet merge + syncCards + filtering ----
window.TESTS.push(async function () {
  VERIFY.group('categories');

  const originalFetch = window.fetch;
  const originalCards = localStorage.getItem('flashcards_cards');
  const pages = {
    htmlview:
      'items.push({name: "verbes", pageUrl: "u", gid: "0",initialSheet: true});' +
      'items.push({name: "animaux", pageUrl: "u", gid: "7",initialSheet: false});' +
      'items.push({name: "vide", pageUrl: "u", gid: "9",initialSheet: false});',
    '0': 'question,answer\nmordre,to bite\nloup,wolf\n',
    '7': 'loup,wolf,ex\nchien,dog\n',
    '9': ''
  };
  window.fetch = async (url) => {
    const key = url.endsWith('/htmlview') ? 'htmlview' : url.match(/gid=(\d+)/)[1];
    return new Response(pages[key], { status: 200 });
  };

  try {
    const r = await SheetsService.fetchSpreadsheet('SHEET');
    VERIFY.assert('fetchSpreadsheet succeeds', r.success, r.error);
    VERIFY.assertEqual('keeps all 3 tabs (incl. empty)', r.tabs.length, 3);
    VERIFY.assertEqual('merges duplicate word → 3 cards', r.cards.length, 3);
    const loup = r.cards.find(c => c.question === 'loup');
    VERIFY.assertEqual('duplicate word is in both categories', loup.categories.join(','), '0,7');
    VERIFY.assertEqual('duplicate word picks up example', loup.extras[0].value, 'ex');

    const deckId = '__verify_cat_deck__';
    localStorage.setItem('flashcards_cards', JSON.stringify([]));
    await CardStorage.syncCards(deckId, r.cards);
    VERIFY.assertEqual('all categories → 3 cards',
      CardStorage.getByDeckAndCategories(deckId, null).length, 3);
    VERIFY.assertEqual('verbes only → 2 cards',
      CardStorage.getByDeckAndCategories(deckId, ['0']).length, 2);
    VERIFY.assertEqual('animaux only → 2 cards',
      CardStorage.getByDeckAndCategories(deckId, ['7']).length, 2);

    // Move "mordre" from verbes to animaux: same card id, history kept, category updated.
    const mangerId = await generateCardId(deckId, 'mordre', 'to bite');
    const moved = r.cards.map(c => c.question === 'mordre' ? { ...c, categories: ['7'] } : c);
    const s = await CardStorage.syncCards(deckId, moved);
    VERIFY.assertEqual('moving a word archives nothing', s.archived, 0);
    VERIFY.assertEqual('moved word now in animaux',
      CardStorage.getById(mangerId).categories.join(','), '7');
    VERIFY.assertEqual('animaux now → 3 cards',
      CardStorage.getByDeckAndCategories(deckId, ['7']).length, 3);

    for (let i = 0; i < 30; i++) {
      const pick = Scheduler.pickNextCard(deckId, { categories: ['0'] });
      if (!pick || !pick.categories.includes('0')) {
        VERIFY.assert('pickNextCard respects categories', false, pick && pick.question);
        break;
      }
      if (i === 29) VERIFY.assert('pickNextCard respects categories', true);
    }

    // A failing (non-empty) tab fails the whole fetch, so sync never archives on partial data.
    window.fetch = async (url) => {
      if (url.includes('gid=7')) return new Response('', { status: 500 });
      const key = url.endsWith('/htmlview') ? 'htmlview' : url.match(/gid=(\d+)/)[1];
      return new Response(pages[key], { status: 200 });
    };
    const bad = await SheetsService.fetchSpreadsheet('SHEET');
    VERIFY.assert('one tab failing → whole fetch fails', !bad.success);
  } finally {
    window.fetch = originalFetch;
    if (originalCards === null) localStorage.removeItem('flashcards_cards');
    else localStorage.setItem('flashcards_cards', originalCards);
  }
});

// ---- CardExtras ----
window.TESTS.push(function () {
  VERIFY.group('CardExtras');
  const k = CardExtras.kindForHeader;
  VERIFY.assertEqual('Syllabaire', k('Syllabaire'), 'syllabic');
  VERIFY.assertEqual('Syllabic', k('Syllabic'), 'syllabic');
  VERIFY.assertEqual('SYLLABIQUE', k('SYLLABIQUE'), 'syllabic');
  VERIFY.assertEqual('inuktitut header', k('ᖃᓂᐅᔮᖅᐸᐃᑦ'), 'syllabic');
  VERIFY.assertEqual('padded Exemple', k('  Exemple '), 'example');
  VERIFY.assertEqual('Prononciation', k('Prononciation'), 'audio');
  VERIFY.assertEqual('Remarque', k('Remarque'), 'notes');
  VERIFY.assertEqual('Photo', k('Photo'), 'image');
  VERIFY.assertEqual('unknown → null', k('Genre'), null);
  VERIFY.assertEqual('substring is not a match', k('audio file'), null);

  const none = CardExtras.columnKinds(null, 5);
  VERIFY.assertEqual('no header → C is example', JSON.stringify(none[2]), JSON.stringify({ kind: 'example', label: 'Example' }));
  VERIFY.assertEqual('no header → D ignored', none[3], null);

  const h = CardExtras.columnKinds(['Français', 'Inuktitut', 'Phrase', 'Audio', 'Genre', ''], 6);
  VERIFY.assertEqual('unrecognized C → example labeled', JSON.stringify(h[2]), JSON.stringify({ kind: 'example', label: 'Phrase' }));
  VERIFY.assertEqual('D audio', h[3].kind, 'audio');
  VERIFY.assertEqual('unknown D+ → text', JSON.stringify(h[4]), JSON.stringify({ kind: 'text', label: 'Genre' }));
  VERIFY.assertEqual('empty D+ header → ignored', h[5], null);
  VERIFY.assertEqual('C syllabic when named', CardExtras.columnKinds(['q', 'a', 'Syllabic'], 3)[2].kind, 'syllabic');

  const cols = CardExtras.columnKinds(['q', 'a', 'Syllabic', 'Audio', 'Notes'], 5);
  const ex = CardExtras.fromRow(['Bienvenu', 'tungngasugit', ' ᑐᙵᓱᒋᑦ ', '   ', 'x'], cols);
  VERIFY.assertEqual('whitespace-only dropped, trimmed', JSON.stringify(ex),
    JSON.stringify([{ kind: 'syllabic', label: 'Syllabic', value: 'ᑐᙵᓱᒋᑦ' }, { kind: 'notes', label: 'Notes', value: 'x' }]));
  VERIFY.assertEqual('short row → no crash', CardExtras.fromRow(['a', 'b'], cols).length, 0);

  VERIFY.assertEqual('legacy example fallback', JSON.stringify(CardExtras.forCard({ example: 'e' })),
    JSON.stringify([{ kind: 'example', label: 'Example', value: 'e' }]));
  VERIFY.assertEqual('no extras → []', CardExtras.forCard({ example: null }).length, 0);

  const t = [{ kind: 'notes', label: 'Notes', value: '1' }];
  CardExtras.mergeInto(t, [{ kind: 'notes', label: 'Notes', value: '2' }, { kind: 'audio', label: 'Audio', value: 'u' }]);
  VERIFY.assertEqual('merge keeps first, adds missing', t.map(e => e.value).join(','), '1,u');

  const lay = CardExtras.layout({ extras: [
    { kind: 'image', label: 'Image', value: 'i' }, { kind: 'notes', label: 'Notes', value: 'n' },
    { kind: 'syllabic', label: 'Syllabic', value: 's' }, { kind: 'audio', label: 'Audio', value: 'u' },
    { kind: 'text', label: 'Genre', value: 'g' }] });
  VERIFY.assertEqual('layout syllabic', lay.syllabic.join(), 's');
  VERIFY.assertEqual('Glose header', k('Glose'), 'gloss');
  VERIFY.assertEqual('layout gloss', CardExtras.layout({ extras: [{ kind: 'gloss', label: 'Glose', value: 'ABS.S' }] }).gloss.join(), 'ABS.S');
  VERIFY.assertEqual('layout audio', lay.audio.join(), 'u');
  VERIFY.assertEqual('layout images', lay.images.join(), 'i');
  VERIFY.assertEqual('layout body order', lay.body.map(e => e.value).join(), 'n,g');
});

// ---- parseCsv backward compatibility ----
window.TESTS.push(function () {
  VERIFY.group('parseCsv backward compatibility');
  const P = t => SheetsService.parseCsv(t);
  const noHdr = P('chien,dog,ex1,junk\n');
  VERIFY.assertEqual('no header: C = example, D ignored', JSON.stringify(noHdr[0].extras),
    JSON.stringify([{ kind: 'example', label: 'Example', value: 'ex1' }]));
  VERIFY.assertEqual('no header, first word has "a": still dropped (unchanged)', P('chat,cat\nchien,dog\n').length, 1);
  VERIFY.assertEqual('header Exemple: skipped, C example', P('Question,Answer,Exemple\nchien,dog,e\n')[0].extras[0].kind, 'example');
  const phrase = P('Question,Answer,Phrase\nchien,dog,e\n');
  VERIFY.assertEqual('unrecognized C header: example', phrase[0].extras[0].kind, 'example');
  VERIFY.assertEqual('unrecognized C header: label kept', phrase[0].extras[0].label, 'Phrase');
  const newHdr = P('chien,dog,Syllabaire,Audio\nBienvenu,tungngasugit,ᑐᙵᓱᒋᑦ,http://x/t.mp3\n');
  VERIFY.assertEqual('C+ kind name makes row a header', newHdr.length, 1);
  VERIFY.assertEqual('syllabic + audio parsed', newHdr[0].extras.map(e => e.kind).join(), 'syllabic,audio');
  VERIFY.assertEqual('short row under header', P('Mot,Traduction,Syllabic,Audio\nchien,dog\n')[0].extras.length, 0);
  VERIFY.assertEqual('D+ text column shown', P('Question,Answer,Exemple,Genre\nchien,dog,e,m\n')[0].extras[1].label, 'Genre');
});
