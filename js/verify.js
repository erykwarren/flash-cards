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
