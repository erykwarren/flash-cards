/**
 * Scheduler Module - Spaced Repetition Algorithm
 * Implements priority-based card selection with tunable parameters
 */

const Scheduler = {
  
  /**
   * Calculate priority score for a single card
   * Higher score = higher priority for review
   * 
   * @param {Object} card - The card object
   * @param {Object} stats - Card statistics from ReviewStorage.getCardStats()
   * @param {Object} settings - Algorithm settings from SettingsStorage.get()
   * @returns {number} Priority score
   */
  calculatePriority(card, stats, settings) {
    // Base score components
    const {
      failureWeight = 3.0,
      recencyWeight = 2.0,
      exposureWeight = 1.5,
      targetExposures = 7,
      maxRecencyDays = 30,
      recentPenaltyMinutes = 10
    } = settings;

    // 1. Failure rate component
    // Cards with higher failure rate get priority
    let failureRate;
    if (stats.totalReviews === 0) {
      // New cards get a neutral failure rate (slight boost)
      failureRate = 0.5;
    } else {
      failureRate = stats.incorrect / stats.totalReviews;
    }
    const failureScore = failureWeight * failureRate;

    // 2. Recency component
    // Cards not seen recently get priority
    let daysSinceLastSeen;
    if (stats.lastSeenAt === null) {
      // Never seen cards get max recency
      daysSinceLastSeen = maxRecencyDays;
    } else {
      const msSinceLastSeen = Date.now() - stats.lastSeenAt;
      daysSinceLastSeen = msSinceLastSeen / (1000 * 60 * 60 * 24);
    }
    const recencyScore = recencyWeight * Math.min(daysSinceLastSeen / maxRecencyDays, 1);

    // 3. Exposure gap component
    // Cards with fewer reviews than target get priority
    const exposureGap = Math.max(0, targetExposures - stats.totalReviews) / targetExposures;
    const exposureScore = exposureWeight * exposureGap;

    // 4. Recent penalty component
    // Penalize cards seen very recently (avoid immediate repetition)
    let recentPenalty = 0;
    if (stats.lastSeenAt !== null) {
      const minutesSinceLastSeen = (Date.now() - stats.lastSeenAt) / (1000 * 60);
      if (minutesSinceLastSeen < recentPenaltyMinutes) {
        // Strong penalty for very recent cards (exponential decay)
        recentPenalty = 5.0 * (1 - minutesSinceLastSeen / recentPenaltyMinutes);
      }
    }

    // 5. Streak penalty (optional)
    // Cards with long correct streaks get slightly lower priority
    const streakPenalty = Math.min(stats.streak * 0.1, 0.5);

    // Calculate final score
    const score = failureScore + recencyScore + exposureScore - recentPenalty - streakPenalty;

    return Math.max(0, score); // Ensure non-negative
  },

  /**
   * Calculate priority scores for all cards in a deck
   * 
   * @param {string} deckId - Deck ID
   * @returns {Array<{card: Object, stats: Object, priority: number}>}
   */
  calculateAllPriorities(deckId) {
    const cards = CardStorage.getByDeck(deckId);
    const settings = SettingsStorage.get();
    
    return cards.map(card => {
      const stats = ReviewStorage.getCardStats(card.id);
      const priority = this.calculatePriority(card, stats, settings);
      return { card, stats, priority };
    });
  },

  /**
   * Build a review queue using weighted random selection
   * Prioritizes high-priority cards but adds variety
   * 
   * @param {string} deckId - Deck ID
   * @param {number} maxCards - Maximum cards to include (default: all)
   * @returns {Array<Object>} Ordered array of cards to review
   */
  buildQueue(deckId, maxCards = Infinity) {
    const settings = SettingsStorage.get();
    const prioritized = this.calculateAllPriorities(deckId);
    
    if (prioritized.length === 0) {
      return [];
    }

    // Separate new cards (never seen) from reviewed cards
    const newCards = prioritized.filter(p => p.stats.totalReviews === 0);
    const reviewedCards = prioritized.filter(p => p.stats.totalReviews > 0);

    // Limit new cards per session
    const newCardsLimit = settings.newCardsPerSession || 5;
    const selectedNew = this.weightedSelect(newCards, Math.min(newCardsLimit, newCards.length));

    // Select from reviewed cards
    const remainingSlots = Math.max(0, maxCards - selectedNew.length);
    const selectedReviewed = this.weightedSelect(reviewedCards, Math.min(remainingSlots, reviewedCards.length));

    // Combine and shuffle slightly for variety
    const queue = [...selectedNew, ...selectedReviewed];
    
    // Shuffle with priority bias (high priority cards tend to come earlier)
    return this.priorityShuffle(queue);
  },

  /**
   * Select cards using weighted random selection based on priority
   * Higher priority cards are more likely to be selected
   * 
   * @param {Array} prioritized - Array of {card, stats, priority} objects
   * @param {number} count - Number of cards to select
   * @returns {Array} Selected cards
   */
  weightedSelect(prioritized, count) {
    if (prioritized.length === 0 || count <= 0) {
      return [];
    }

    // Make a copy to avoid mutating original
    const remaining = [...prioritized];
    const selected = [];

    while (selected.length < count && remaining.length > 0) {
      // Calculate total weight
      const totalWeight = remaining.reduce((sum, p) => sum + Math.max(p.priority, 0.1), 0);
      
      // Random selection
      let random = Math.random() * totalWeight;
      let selectedIndex = 0;
      
      for (let i = 0; i < remaining.length; i++) {
        random -= Math.max(remaining[i].priority, 0.1);
        if (random <= 0) {
          selectedIndex = i;
          break;
        }
      }

      // Add to selected and remove from remaining
      selected.push(remaining[selectedIndex]);
      remaining.splice(selectedIndex, 1);
    }

    return selected;
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

