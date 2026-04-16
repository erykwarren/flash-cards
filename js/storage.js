/**
 * Storage Module - localStorage wrapper with CRUD operations
 * Handles persistence for Decks, Cards, ReviewEvents, and Settings
 */

const STORAGE_KEYS = {
  DECKS: 'flashcards_decks',
  CARDS: 'flashcards_cards',
  REVIEWS: 'flashcards_reviews',
  SETTINGS: 'flashcards_settings'
};

const DEFAULT_SETTINGS = {
  successMultiplier: 2.0,     // S grows by this factor on correct
  failureMultiplier: 0.5,     // S shrinks by this factor on incorrect
  initialStability: 1.0,      // days; S for first review
  minStability: 0.5,          // days; floor so S never collapses
  newCardsPerSession: 5,      // cap on brand-new cards per session
  pickerAlpha: 1.0            // exponent on (1 − R) in the session picker; higher = sharper bias to due cards
};

/**
 * Generic storage operations
 */
const Storage = {
  /**
   * Get data from localStorage
   * @param {string} key - Storage key
   * @param {*} defaultValue - Default value if key doesn't exist
   * @returns {*} Parsed data or default value
   */
  get(key, defaultValue = null) {
    try {
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : defaultValue;
    } catch (error) {
      console.error(`Storage.get error for key ${key}:`, error);
      return defaultValue;
    }
  },

  /**
   * Set data in localStorage
   * @param {string} key - Storage key
   * @param {*} value - Value to store (will be JSON stringified)
   */
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.error(`Storage.set error for key ${key}:`, error);
      throw new Error('Failed to save data. Storage might be full.');
    }
  },

  /**
   * Remove data from localStorage
   * @param {string} key - Storage key
   */
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error(`Storage.remove error for key ${key}:`, error);
    }
  },

  /**
   * Clear all app data
   */
  clearAll() {
    Object.values(STORAGE_KEYS).forEach(key => this.remove(key));
  }
};

/**
 * Generate a unique ID
 * @param {string} prefix - ID prefix (e.g., 'deck', 'rev')
 * @returns {string} Unique ID
 */
function generateId(prefix = 'id') {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}${random}`;
}

/**
 * Generate a stable card ID using SHA-256 hash
 * @param {string} deckId - Deck ID
 * @param {string} question - Card question
 * @param {string} answer - Card answer
 * @returns {Promise<string>} 16-character hex hash
 */
async function generateCardId(deckId, question, answer) {
  const normalized = `${deckId}:${question.trim().toLowerCase()}:${answer.trim().toLowerCase()}`;
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Deck operations
 */
const DeckStorage = {
  getAll() {
    return Storage.get(STORAGE_KEYS.DECKS, []);
  },

  getById(id) {
    const decks = this.getAll();
    return decks.find(d => d.id === id) || null;
  },

  create(deck) {
    const decks = this.getAll();
    const newDeck = {
      id: generateId('deck'),
      name: deck.name || 'Untitled Deck',
      spreadsheetId: deck.spreadsheetId || null,
      gid: deck.gid || null,
      csvUrl: deck.csvUrl || null,
      lastSyncedAt: null,
      createdAt: new Date().toISOString(),
      ...deck
    };
    decks.push(newDeck);
    Storage.set(STORAGE_KEYS.DECKS, decks);
    return newDeck;
  },

  update(id, updates) {
    const decks = this.getAll();
    const index = decks.findIndex(d => d.id === id);
    if (index === -1) return null;
    
    decks[index] = { ...decks[index], ...updates };
    Storage.set(STORAGE_KEYS.DECKS, decks);
    return decks[index];
  },

  delete(id) {
    const decks = this.getAll();
    const filtered = decks.filter(d => d.id !== id);
    Storage.set(STORAGE_KEYS.DECKS, filtered);
    // Also archive all cards in this deck
    CardStorage.archiveByDeck(id);
  }
};

/**
 * Card operations
 */
const CardStorage = {
  getAll() {
    return Storage.get(STORAGE_KEYS.CARDS, []);
  },

  getByDeck(deckId, includeArchived = false) {
    const cards = this.getAll();
    return cards.filter(c => c.deckId === deckId && (includeArchived || !c.isArchived));
  },

  getById(id) {
    const cards = this.getAll();
    return cards.find(c => c.id === id) || null;
  },

  async create(card) {
    const cards = this.getAll();
    const id = await generateCardId(card.deckId, card.question, card.answer);
    
    // Check if card already exists
    const existing = cards.find(c => c.id === id);
    if (existing) {
      // Unarchive if it was archived, and update example if provided
      if (existing.isArchived || card.example !== existing.example) {
        return this.update(id, { 
          isArchived: false,
          example: card.example || null
        });
      }
      return existing;
    }

    const newCard = {
      id,
      deckId: card.deckId,
      question: card.question.trim(),
      answer: card.answer.trim(),
      example: card.example || null,
      isArchived: false,
      createdAt: new Date().toISOString()
    };
    cards.push(newCard);
    Storage.set(STORAGE_KEYS.CARDS, cards);
    return newCard;
  },

  update(id, updates) {
    const cards = this.getAll();
    const index = cards.findIndex(c => c.id === id);
    if (index === -1) return null;

    cards[index] = { ...cards[index], ...updates };
    Storage.set(STORAGE_KEYS.CARDS, cards);
    return cards[index];
  },

  archive(id) {
    return this.update(id, { isArchived: true });
  },

  archiveByDeck(deckId) {
    const cards = this.getAll();
    const updated = cards.map(c => 
      c.deckId === deckId ? { ...c, isArchived: true } : c
    );
    Storage.set(STORAGE_KEYS.CARDS, updated);
  },

  delete(id) {
    const cards = this.getAll();
    const filtered = cards.filter(c => c.id !== id);
    Storage.set(STORAGE_KEYS.CARDS, filtered);
  },

  /**
   * Bulk create/update cards (for sync)
   * @param {string} deckId - Deck ID
   * @param {Array} cardData - Array of {question, answer, example} objects
   * @returns {Promise<{created: number, updated: number, archived: number}>}
   */
  async syncCards(deckId, cardData) {
    const existingCards = this.getByDeck(deckId, true);
    const newCardIds = new Set();
    let created = 0;
    let updated = 0;

    // Create or update cards from spreadsheet
    for (const data of cardData) {
      const id = await generateCardId(deckId, data.question, data.answer);
      newCardIds.add(id);
      
      const existing = existingCards.find(c => c.id === id);
      if (existing) {
        // Update if archived or if example has changed
        if (existing.isArchived || existing.example !== (data.example || null)) {
          this.update(id, { 
            isArchived: false,
            example: data.example || null
          });
          updated++;
        }
      } else {
        await this.create({ deckId, ...data });
        created++;
      }
    }

    // Archive cards that are no longer in spreadsheet
    let archived = 0;
    for (const card of existingCards) {
      if (!newCardIds.has(card.id) && !card.isArchived) {
        this.archive(card.id);
        archived++;
      }
    }

    return { created, updated, archived };
  }
};

/**
 * Review Event operations
 */
const ReviewStorage = {
  getAll() {
    return Storage.get(STORAGE_KEYS.REVIEWS, []);
  },

  getByCard(cardId) {
    const reviews = this.getAll();
    return reviews.filter(r => r.cardId === cardId);
  },

  getByDeck(deckId) {
    const reviews = this.getAll();
    return reviews.filter(r => r.deckId === deckId);
  },

  create(review) {
    const reviews = this.getAll();
    const newReview = {
      id: generateId('rev'),
      cardId: review.cardId,
      deckId: review.deckId,
      startedAt: review.startedAt,
      answeredAt: review.answeredAt || new Date().toISOString(),
      durationMs: review.durationMs,
      outcome: review.outcome // 'correct' or 'incorrect'
    };
    reviews.push(newReview);
    Storage.set(STORAGE_KEYS.REVIEWS, reviews);
    return newReview;
  },

  /**
   * Get statistics for a specific card
   * @param {string} cardId - Card ID
   * @returns {Object} Card statistics
   */
  getCardStats(cardId) {
    const reviews = this.getByCard(cardId);
    const settings = SettingsStorage.get();

    if (reviews.length === 0) {
      return {
        totalReviews: 0,
        correct: 0,
        incorrect: 0,
        lastSeenAt: null,
        lastReviewedAt: null,
        avgDurationMs: 0,
        streak: 0,
        stability: settings.initialStability
      };
    }

    const correct = reviews.filter(r => r.outcome === 'correct').length;
    const incorrect = reviews.length - correct;
    const sorted = [...reviews].sort(
      (a, b) => new Date(b.answeredAt) - new Date(a.answeredAt)
    );
    const lastSeenAt = new Date(sorted[0].answeredAt).getTime();
    const avgDurationMs = reviews.reduce((sum, r) => sum + r.durationMs, 0) / reviews.length;

    let streak = 0;
    for (const review of sorted) {
      if (review.outcome === 'correct') streak++;
      else break;
    }

    const stability = Scheduler.calculateStability(reviews, settings);

    return {
      totalReviews: reviews.length,
      correct,
      incorrect,
      lastSeenAt,
      lastReviewedAt: lastSeenAt,
      avgDurationMs: Math.round(avgDurationMs),
      streak,
      stability
    };
  },

  /**
   * Get global statistics for a deck
   * @param {string} deckId - Deck ID
   * @returns {Object} Deck statistics
   */
  getDeckStats(deckId) {
    const reviews = this.getByDeck(deckId);
    const cards = CardStorage.getByDeck(deckId);
    
    if (reviews.length === 0) {
      return {
        totalReviews: 0,
        totalCards: cards.length,
        cardsStudied: 0,
        correctRate: 0,
        avgDurationMs: 0
      };
    }

    const correct = reviews.filter(r => r.outcome === 'correct').length;
    const cardsStudied = new Set(reviews.map(r => r.cardId)).size;
    const avgDurationMs = reviews.reduce((sum, r) => sum + r.durationMs, 0) / reviews.length;

    return {
      totalReviews: reviews.length,
      totalCards: cards.length,
      cardsStudied,
      correctRate: Math.round((correct / reviews.length) * 100),
      avgDurationMs: Math.round(avgDurationMs)
    };
  }
};

/**
 * Settings operations
 */
const SettingsStorage = {
  get() {
    return Storage.get(STORAGE_KEYS.SETTINGS, { ...DEFAULT_SETTINGS });
  },

  update(updates) {
    const settings = this.get();
    const newSettings = { ...settings, ...updates };
    Storage.set(STORAGE_KEYS.SETTINGS, newSettings);
    return newSettings;
  },

  reset() {
    Storage.set(STORAGE_KEYS.SETTINGS, { ...DEFAULT_SETTINGS });
    return { ...DEFAULT_SETTINGS };
  }
};

// Export for use in other modules
window.Storage = Storage;
window.DeckStorage = DeckStorage;
window.CardStorage = CardStorage;
window.ReviewStorage = ReviewStorage;
window.SettingsStorage = SettingsStorage;
window.generateId = generateId;
window.generateCardId = generateCardId;

