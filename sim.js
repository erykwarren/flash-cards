/**
 * Picker simulation — diagnose why a 146-card deck shows the same small subset.
 * Run: node sim.js
 */

const NUM_CARDS = 146;
const NUM_QUESTIONS = 200;
const SUCCESS_RATE = 0.95;

const settings = {
  successMultiplier: 2.0,
  failureMultiplier: 0.5,
  initialStability: 1.0,
  minStability: 0.5,
  newCardsPerSession: 5,
  pickerAlpha: 1.0,
};

// Cards: all brand-new, never reviewed
const cards = Array.from({ length: NUM_CARDS }, (_, i) => ({
  id: `card_${i}`,
  deckId: 'deck_1',
  isArchived: false,
}));

// Review log
const reviews = [];

function getCardStats(cardId) {
  const cardReviews = reviews.filter(r => r.cardId === cardId);
  if (cardReviews.length === 0) {
    return {
      totalReviews: 0,
      lastReviewedAt: null,
      stability: settings.initialStability,
    };
  }
  const sorted = [...cardReviews].sort((a, b) => a.answeredAt - b.answeredAt);
  const lastReviewedAt = sorted[sorted.length - 1].answeredAt;
  let S = settings.initialStability;
  for (const r of sorted) {
    S = Math.max(
      settings.minStability,
      S * (r.outcome === 'correct' ? settings.successMultiplier : settings.failureMultiplier)
    );
  }
  return { totalReviews: cardReviews.length, lastReviewedAt, stability: S };
}

function calculateRetrievability(stability, lastReviewedAt, now) {
  if (lastReviewedAt == null) return 0;
  const days = (now - lastReviewedAt) / 86400000;
  return Math.exp(-days / stability);
}

function weightedSample(items, weights) {
  if (items.length === 0) return null;
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function pickNextCard(excludeCardId, excludeNew, now) {
  const alpha = settings.pickerAlpha;
  const eligible = [];
  const weights = [];
  for (const card of cards) {
    if (card.id === excludeCardId) continue;
    const stats = getCardStats(card.id);
    const isNew = stats.totalReviews === 0;
    if (excludeNew && isNew) continue;
    const R = isNew ? 0 : calculateRetrievability(stats.stability, stats.lastReviewedAt, now);
    const weight = Math.pow(Math.max(0, 1 - R), alpha);
    eligible.push(card);
    weights.push(weight);
  }
  return weightedSample(eligible, weights);
}

// --- Session simulation WITH THE FIX ---

let retryQueue = [];
let newCardsSurfaced = 0;
const seenCardIds = new Set();
const pickedCounts = new Map();
const sessionStart = Date.now();
const ANSWER_INTERVAL_MS = 8000;

function sessionPickNext(justAnsweredId, now) {
  // Check retry queue
  const dueRetries = retryQueue
    .filter(r => r.counter <= 0)
    .sort((a, b) => a.counter - b.counter);
  if (dueRetries.length > 0) {
    const retryId = dueRetries[0].cardId;
    retryQueue = retryQueue.filter(r => r.cardId !== retryId);
    const card = cards.find(c => c.id === retryId);
    if (card && !card.isArchived) return card;
  }

  let excludeNew = newCardsSurfaced >= (settings.newCardsPerSession || 0);

  // FIX: relax the cap when every non-new eligible card has already been seen
  if (excludeNew) {
    const hasUnseenReviewed = cards.some(c =>
      c.id !== justAnsweredId &&
      !c.isArchived &&
      !seenCardIds.has(c.id) &&
      getCardStats(c.id).totalReviews > 0
    );
    if (!hasUnseenReviewed) excludeNew = false;
  }

  const picked = pickNextCard(justAnsweredId, excludeNew, now);
  if (!picked && excludeNew) {
    return pickNextCard(justAnsweredId, false, now);
  }
  return picked;
}

// --- Run ---

console.log('=== Picker Simulation (WITH FIX) ===');
console.log(`Cards: ${NUM_CARDS}, Questions: ${NUM_QUESTIONS}, Success rate: ${SUCCESS_RATE * 100}%`);
console.log(`Settings: newCardsPerSession=${settings.newCardsPerSession}, pickerAlpha=${settings.pickerAlpha}`);
console.log();

let currentCard = null;
let now = sessionStart;

currentCard = sessionPickNext(null, now);
seenCardIds.add(currentCard.id);
if (getCardStats(currentCard.id).totalReviews === 0) newCardsSurfaced++;
pickedCounts.set(currentCard.id, (pickedCounts.get(currentCard.id) || 0) + 1);

for (let q = 0; q < NUM_QUESTIONS; q++) {
  now = sessionStart + (q + 1) * ANSWER_INTERVAL_MS;
  const correct = Math.random() < SUCCESS_RATE;

  reviews.push({
    cardId: currentCard.id,
    deckId: 'deck_1',
    answeredAt: now,
    outcome: correct ? 'correct' : 'incorrect',
  });

  retryQueue = retryQueue.map(r => ({ ...r, counter: r.counter - 1 }));
  retryQueue = retryQueue.filter(r => r.cardId !== currentCard.id);

  if (!correct) {
    const maxK = Math.max(1, cards.length - 1);
    const k = Math.min(maxK, 5 + Math.floor(Math.random() * 11));
    retryQueue.push({ cardId: currentCard.id, counter: k });
  }

  const answeredId = currentCard.id;
  const next = sessionPickNext(answeredId, now);
  if (!next) {
    console.log(`Session ended at question ${q + 1} — no card available.`);
    break;
  }

  seenCardIds.add(next.id);
  if (getCardStats(next.id).totalReviews === 0) newCardsSurfaced++;
  currentCard = next;
  pickedCounts.set(currentCard.id, (pickedCounts.get(currentCard.id) || 0) + 1);
}

// --- Report ---
console.log('--- Results ---');
console.log(`Unique cards seen: ${pickedCounts.size} / ${NUM_CARDS}`);
console.log(`New cards surfaced: ${newCardsSurfaced}`);
console.log(`Retry queue size at end: ${retryQueue.length}`);
console.log();

const counts = Array.from(pickedCounts.entries()).sort((a, b) => b[1] - a[1]);

console.log('Top 20 most-picked cards:');
for (const [id, count] of counts.slice(0, 20)) {
  const idx = id.replace('card_', '');
  const bar = '█'.repeat(Math.min(count, 60));
  console.log(`  card ${idx.padStart(3)}: ${String(count).padStart(3)} picks  ${bar}`);
}

console.log();
console.log('Pick frequency distribution:');
const freqMap = new Map();
for (const [, count] of counts) {
  freqMap.set(count, (freqMap.get(count) || 0) + 1);
}
const freqs = Array.from(freqMap.entries()).sort((a, b) => b[0] - a[0]);
for (const [picks, numCards] of freqs) {
  console.log(`  ${picks} picks: ${numCards} card(s)`);
}

console.log();
console.log(`Cards never seen: ${NUM_CARDS - pickedCounts.size}`);
console.log(`Total reviews logged: ${reviews.length}`);
