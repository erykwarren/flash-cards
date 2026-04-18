/**
 * Diagnose picker behavior using real localStorage data.
 * Run: node diagnose.js
 */

const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));

const cards = data.flashcards_cards.filter(c => !c.isArchived);
const reviews = data.flashcards_reviews;
const settings = {
  successMultiplier: 2.0,
  failureMultiplier: 0.5,
  initialStability: 1.0,
  minStability: 0.5,
  newCardsPerSession: 0,
  pickerAlpha: 1.0,
};

function getCardStats(cardId) {
  const cardReviews = reviews.filter(r => r.cardId === cardId);
  if (cardReviews.length === 0) {
    return { totalReviews: 0, lastReviewedAt: null, stability: settings.initialStability };
  }
  const sorted = [...cardReviews].sort((a, b) => new Date(a.answeredAt) - new Date(b.answeredAt));
  const lastReviewedAt = new Date(sorted[sorted.length - 1].answeredAt).getTime();
  let S = settings.initialStability;
  for (const r of sorted) {
    S = Math.max(settings.minStability, S * (r.outcome === 'correct' ? settings.successMultiplier : settings.failureMultiplier));
  }
  return { totalReviews: cardReviews.length, lastReviewedAt, stability: S };
}

function calculateR(stability, lastReviewedAt, now) {
  if (lastReviewedAt == null) return 0;
  const days = (now - lastReviewedAt) / 86400000;
  return Math.exp(-days / stability);
}

// --- Analysis ---
const now = Date.now();
console.log(`=== Picker Diagnosis ===`);
console.log(`Total non-archived cards: ${cards.length}`);
console.log(`Total review events: ${reviews.length}`);
console.log();

// Compute stats for every card
const cardData = cards.map(card => {
  const stats = getCardStats(card.id);
  const R = stats.totalReviews === 0 ? 0 : calculateR(stats.stability, stats.lastReviewedAt, now);
  const weight = Math.pow(Math.max(0, 1 - R), settings.pickerAlpha);
  const daysSinceReview = stats.lastReviewedAt ? (now - stats.lastReviewedAt) / 86400000 : null;
  return { ...card, stats, R, weight, daysSinceReview };
});

// Split into reviewed vs new
const reviewed = cardData.filter(c => c.stats.totalReviews > 0);
const newCards = cardData.filter(c => c.stats.totalReviews === 0);
console.log(`Reviewed cards: ${reviewed.length}`);
console.log(`New (never reviewed) cards: ${newCards.length}`);
console.log();

// Sort reviewed by weight (highest = most likely to be picked)
reviewed.sort((a, b) => b.weight - a.weight);

console.log('--- Top 30 reviewed cards by picker weight ---');
console.log('(These are what the picker cycles through)');
console.log(`${'Weight'.padStart(8)}  ${'R'.padStart(6)}  ${'S(days)'.padStart(8)}  ${'DaysAgo'.padStart(8)}  ${'Reviews'.padStart(7)}  Question`);
for (const c of reviewed.slice(0, 30)) {
  console.log(
    `${c.weight.toFixed(4).padStart(8)}  ${c.R.toFixed(4).padStart(6)}  ${c.stats.stability.toFixed(1).padStart(8)}  ${(c.daysSinceReview || 0).toFixed(1).padStart(8)}  ${String(c.stats.totalReviews).padStart(7)}  ${c.question.substring(0, 40)}`
  );
}

console.log();
console.log('--- Bottom 30 reviewed cards by picker weight ---');
console.log('(These almost never get picked)');
for (const c of reviewed.slice(-30)) {
  console.log(
    `${c.weight.toFixed(4).padStart(8)}  ${c.R.toFixed(4).padStart(6)}  ${c.stats.stability.toFixed(1).padStart(8)}  ${(c.daysSinceReview || 0).toFixed(1).padStart(8)}  ${String(c.stats.totalReviews).padStart(7)}  ${c.question.substring(0, 40)}`
  );
}

// Weight distribution
console.log();
console.log('--- Weight distribution of reviewed cards ---');
const buckets = [0.001, 0.01, 0.1, 0.5, 1.0];
for (let i = 0; i < buckets.length; i++) {
  const lo = i === 0 ? 0 : buckets[i - 1];
  const hi = buckets[i];
  const count = reviewed.filter(c => c.weight >= lo && c.weight < hi).length;
  console.log(`  weight [${lo.toFixed(3)}, ${hi.toFixed(3)}): ${count} cards`);
}
const fullWeight = reviewed.filter(c => c.weight >= 1.0).length;
console.log(`  weight = 1.0 (R=0, shouldn't happen for reviewed): ${fullWeight} cards`);

// Total weight analysis
const totalReviewedWeight = reviewed.reduce((sum, c) => sum + c.weight, 0);
const totalNewWeight = newCards.length; // each has weight 1.0
console.log();
console.log(`Total weight from reviewed cards: ${totalReviewedWeight.toFixed(4)}`);
console.log(`Total weight from new cards (if included): ${totalNewWeight.toFixed(1)}`);
console.log(`Ratio new/reviewed weight: ${(totalNewWeight / totalReviewedWeight).toFixed(1)}x`);

// Simulate 200 picks with current state
console.log();
console.log('=== Simulating 200 picks from current state ===');
const seenIds = new Set();
let newSurfaced = 0;
const pickCounts = new Map();
const ANSWER_INTERVAL_MS = 8000;
const simReviews = [...reviews]; // copy
const simStart = now;

function simGetCardStats(cardId) {
  const cardReviews = simReviews.filter(r => r.cardId === cardId);
  if (cardReviews.length === 0) {
    return { totalReviews: 0, lastReviewedAt: null, stability: settings.initialStability };
  }
  const sorted = [...cardReviews].sort((a, b) => new Date(a.answeredAt) - new Date(b.answeredAt));
  const lastReviewedAt = new Date(sorted[sorted.length - 1].answeredAt).getTime();
  let S = settings.initialStability;
  for (const r of sorted) {
    S = Math.max(settings.minStability, S * (r.outcome === 'correct' ? settings.successMultiplier : settings.failureMultiplier));
  }
  return { totalReviews: cardReviews.length, lastReviewedAt, stability: S };
}

function simPick(excludeCardId, simNow) {
  const cap = settings.newCardsPerSession;
  let excludeNew = cap > 0 && newSurfaced >= cap;

  // THE FIX: relax when all reviewed cards have been seen
  if (excludeNew) {
    const reviewedCardIds = new Set(simReviews.map(r => r.cardId));
    const hasUnseenReviewed = cards.some(c =>
      c.id !== excludeCardId &&
      !seenIds.has(c.id) &&
      reviewedCardIds.has(c.id)
    );
    if (!hasUnseenReviewed) excludeNew = false;
  }

  const eligible = [];
  const weights = [];
  for (const card of cards) {
    if (card.id === excludeCardId) continue;
    const stats = simGetCardStats(card.id);
    const isNew = stats.totalReviews === 0;
    if (excludeNew && isNew) continue;
    const R = isNew ? 0 : calculateR(stats.stability, stats.lastReviewedAt, simNow);
    const weight = Math.pow(Math.max(0, 1 - R), settings.pickerAlpha);
    eligible.push(card);
    weights.push(weight);
  }

  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (let i = 0; i < eligible.length; i++) {
    r -= weights[i];
    if (r <= 0) return eligible[i];
  }
  return eligible[eligible.length - 1];
}

let current = simPick(null, simStart);
if (!current) { console.log('No card available!'); process.exit(1); }
seenIds.add(current.id);
if (simGetCardStats(current.id).totalReviews === 0) newSurfaced++;
pickCounts.set(current.id, 1);

for (let q = 0; q < 200; q++) {
  const simNow = simStart + (q + 1) * ANSWER_INTERVAL_MS;
  const correct = Math.random() < 0.95;
  simReviews.push({
    cardId: current.id,
    answeredAt: new Date(simNow).toISOString(),
    outcome: correct ? 'correct' : 'incorrect',
  });

  const next = simPick(current.id, simNow);
  if (!next) { console.log(`Ended at question ${q + 1}`); break; }
  seenIds.add(next.id);
  if (simGetCardStats(next.id).totalReviews === 0) newSurfaced++;
  current = next;
  pickCounts.set(current.id, (pickCounts.get(current.id) || 0) + 1);
}

console.log(`Unique cards seen: ${pickCounts.size} / ${cards.length}`);
console.log(`New cards surfaced: ${newSurfaced}`);

const counts = Array.from(pickCounts.entries()).sort((a, b) => b[1] - a[1]);
console.log('\nTop 20 most-picked:');
for (const [id, count] of counts.slice(0, 20)) {
  const card = cards.find(c => c.id === id);
  console.log(`  ${String(count).padStart(3)}x  ${(card?.question || id).substring(0, 50)}`);
}

console.log('\nPick frequency:');
const freqMap = new Map();
for (const [, count] of counts) freqMap.set(count, (freqMap.get(count) || 0) + 1);
for (const [picks, numCards] of Array.from(freqMap.entries()).sort((a, b) => b[0] - a[0])) {
  console.log(`  ${picks} picks: ${numCards} card(s)`);
}
