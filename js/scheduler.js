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

  /**
   * Build a review queue ranked by Ebbinghaus retrievability.
   * New cards (never reviewed) are treated as maximally due (R=0, priority=1).
   * Reviewed cards are ranked by ascending R (lowest recall first).
   *
   * @param {string} deckId - Deck ID
   * @param {number} maxCards - Maximum cards to include (default: all)
   * @returns {Array<Object>} Ordered array of card objects to review
   */
  buildQueue(deckId, maxCards = Infinity) {
    const cards = CardStorage.getByDeck(deckId);
    if (cards.length === 0) return [];

    const settings = SettingsStorage.get();
    const now = Date.now();

    const newCards = [];
    const reviewedCards = [];

    for (const card of cards) {
      const stats = ReviewStorage.getCardStats(card.id);
      if (stats.totalReviews === 0) {
        newCards.push({ card, stats, priority: 1 });
      } else {
        const R = this.calculateRetrievability(stats.stability, stats.lastReviewedAt, now);
        reviewedCards.push({ card, stats, priority: 1 - R });
      }
    }

    // Sort reviewed cards by priority descending (lowest R first)
    reviewedCards.sort((a, b) => b.priority - a.priority);

    // Cap new cards per session (insertion order)
    const newCardsLimit = settings.newCardsPerSession || 5;
    const selectedNew = newCards.slice(0, newCardsLimit);

    // Fill remaining slots from ranked reviewed cards
    const remainingSlots = Math.max(0, maxCards - selectedNew.length);
    const selectedReviewed = reviewedCards.slice(0, remainingSlots);

    const combined = [...selectedNew, ...selectedReviewed];
    return this.priorityShuffle(combined);
  },

  /**
   * Shuffle cards while maintaining priority bias
   * High priority cards tend to appear earlier
   * 
   * @param {Array} prioritized - Array of {card, stats, priority} objects
   * @returns {Array<Object>} Array of card objects (not prioritized objects)
   */
  priorityShuffle(prioritized) {
    if (prioritized.length <= 1) {
      return prioritized.map(p => p.card);
    }

    // Sort by priority descending, then add some randomness
    const sorted = [...prioritized].sort((a, b) => b.priority - a.priority);
    
    // Apply partial shuffle - swap adjacent cards with some probability
    for (let i = 0; i < sorted.length - 1; i++) {
      // Higher chance to swap if priorities are similar
      const priorityDiff = Math.abs(sorted[i].priority - sorted[i + 1].priority);
      const swapProbability = Math.max(0, 0.4 - priorityDiff * 0.1);
      
      if (Math.random() < swapProbability) {
        [sorted[i], sorted[i + 1]] = [sorted[i + 1], sorted[i]];
      }
    }

    return sorted.map(p => p.card);
  },

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

