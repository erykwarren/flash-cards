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
   * Get the next single card to review
   * Useful for continuous review mode
   * 
   * @param {string} deckId - Deck ID
   * @param {string|null} excludeCardId - Card ID to exclude (e.g., current card)
   * @returns {Object|null} Next card to review, or null if no cards
   */
  getNextCard(deckId, excludeCardId = null) {
    const prioritized = this.calculateAllPriorities(deckId);
    
    // Filter out excluded card
    const filtered = excludeCardId 
      ? prioritized.filter(p => p.card.id !== excludeCardId)
      : prioritized;

    if (filtered.length === 0) {
      return null;
    }

    // Get top 5 by priority and randomly select one
    const sorted = [...filtered].sort((a, b) => b.priority - a.priority);
    const topN = sorted.slice(0, Math.min(5, sorted.length));
    const selected = this.weightedSelect(topN, 1);

    return selected.length > 0 ? selected[0].card : null;
  },

  /**
   * Get cards that need urgent review
   * (failed recently, not seen in a long time, or under-exposed)
   * 
   * @param {string} deckId - Deck ID
   * @param {number} threshold - Priority threshold (default: 3.0)
   * @returns {Array<Object>} Array of urgent cards with stats
   */
  getUrgentCards(deckId, threshold = 3.0) {
    const prioritized = this.calculateAllPriorities(deckId);
    return prioritized
      .filter(p => p.priority >= threshold)
      .sort((a, b) => b.priority - a.priority);
  },

  /**
   * Get cards that are considered "mastered"
   * (high success rate, met target exposures, good streak)
   * 
   * @param {string} deckId - Deck ID
   * @returns {Array<Object>} Array of mastered cards with stats
   */
  getMasteredCards(deckId) {
    const settings = SettingsStorage.get();
    const prioritized = this.calculateAllPriorities(deckId);
    
    return prioritized.filter(p => {
      const successRate = p.stats.totalReviews > 0 
        ? p.stats.correct / p.stats.totalReviews 
        : 0;
      
      return (
        p.stats.totalReviews >= settings.targetExposures &&
        successRate >= 0.8 &&
        p.stats.streak >= 2
      );
    });
  },

  /**
   * Get learning progress summary for a deck
   * 
   * @param {string} deckId - Deck ID
   * @returns {Object} Progress summary
   */
  getProgress(deckId) {
    const prioritized = this.calculateAllPriorities(deckId);
    const settings = SettingsStorage.get();
    
    let newCount = 0;
    let learningCount = 0;
    let masteredCount = 0;
    
    for (const p of prioritized) {
      if (p.stats.totalReviews === 0) {
        newCount++;
      } else {
        const successRate = p.stats.correct / p.stats.totalReviews;
        if (
          p.stats.totalReviews >= settings.targetExposures &&
          successRate >= 0.8 &&
          p.stats.streak >= 2
        ) {
          masteredCount++;
        } else {
          learningCount++;
        }
      }
    }

    return {
      total: prioritized.length,
      new: newCount,
      learning: learningCount,
      mastered: masteredCount,
      percentMastered: prioritized.length > 0 
        ? Math.round((masteredCount / prioritized.length) * 100) 
        : 0
    };
  }
};

// Export for use in other modules
window.Scheduler = Scheduler;

