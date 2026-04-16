/**
 * Scheduler Module - Spaced Repetition Algorithm
 * Implements priority-based card selection with tunable parameters
 */

const Scheduler = {

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
    return items[items.length - 1];
  },

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

  /**
   * "Mastered" = stability has grown to at least 60 days with ≥ 3 reviews.
   */
  getMasteredCards(deckId) {
    const cards = CardStorage.getByDeck(deckId);
    return cards
      .map(card => ({ card, stats: ReviewStorage.getCardStats(card.id) }))
      .filter(x => x.stats.totalReviews >= 3 && x.stats.stability >= 60);
  },

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
  }
};

// Export for use in other modules
window.Scheduler = Scheduler;

