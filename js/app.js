/**
 * Main Application - Alpine.js stores and initialization
 */

document.addEventListener('alpine:init', () => {
  
  /**
   * Main application store
   * Manages global state, navigation, and data
   */
  Alpine.store('app', {
    // Current view: 'home' | 'session' | 'stats' | 'settings' | 'picker' | 'login'
    currentView: 'home',
    
    // Currently selected deck
    currentDeck: null,
    
    // All decks
    decks: [],
    
    // Loading state
    isLoading: false,
    
    // Error message
    error: null,
    
    // Success message
    success: null,
    
    // Is user authenticated with Google
    isAuthenticated: false,
    
    // User info from Google
    user: null,

    /**
     * Initialize the app
     */
    init() {
      this.loadDecks();
      this.checkAuth();
      console.log('Flashcards app initialized');
    },

    /**
     * Load decks from storage
     */
    loadDecks() {
      this.decks = DeckStorage.getAll();
      // Auto-select first deck if exists and none selected
      if (this.decks.length > 0 && !this.currentDeck) {
        this.selectDeck(this.decks[0].id);
      }
    },

    /**
     * Select a deck
     */
    selectDeck(deckId) {
      this.currentDeck = DeckStorage.getById(deckId);
    },

    /**
     * Navigate to a view
     */
    navigate(view) {
      this.currentView = view;
      this.clearMessages();
    },

    /**
     * Check if user is authenticated
     */
    checkAuth() {
      const token = AuthStorage.getToken();
      this.isAuthenticated = !!(token && token.access_token);
      if (token && token.user) {
        this.user = token.user;
      }
    },

    /**
     * Set loading state
     */
    setLoading(loading) {
      this.isLoading = loading;
    },

    /**
     * Show error message
     */
    showError(message) {
      this.error = message;
      setTimeout(() => this.error = null, 5000);
    },

    /**
     * Show success message
     */
    showSuccess(message) {
      this.success = message;
      setTimeout(() => this.success = null, 3000);
    },

    /**
     * Clear all messages
     */
    clearMessages() {
      this.error = null;
      this.success = null;
    },

    /**
     * Create a new deck
     */
    createDeck(name, spreadsheetId = null, spreadsheetName = null) {
      const deck = DeckStorage.create({
        name,
        spreadsheetId,
        spreadsheetName
      });
      this.loadDecks();
      this.selectDeck(deck.id);
      return deck;
    },

    /**
     * Delete a deck
     */
    deleteDeck(deckId) {
      DeckStorage.delete(deckId);
      if (this.currentDeck && this.currentDeck.id === deckId) {
        this.currentDeck = null;
      }
      this.loadDecks();
    },

    /**
     * Sign out
     */
    signOut() {
      AuthStorage.clearToken();
      this.isAuthenticated = false;
      this.user = null;
      this.showSuccess('Signed out successfully');
    }
  });

  /**
   * Session store
   * Manages flashcard review session state
   * 
   * State machine:
   *   SHOWING_QUESTION -> (tap) -> SHOWING_ANSWER
   *   SHOWING_ANSWER -> (button click) -> FLIPPING_BACK
   *   FLIPPING_BACK -> (animation done) -> SHOWING_QUESTION (with new card)
   */
  Alpine.store('session', {
    // State: 'question' | 'answer' | 'flipping'
    state: 'question',
    
    // Current card being reviewed
    currentCard: null,
    
    // Next card (preloaded during flip animation)
    nextCardData: null,
    
    // Session start time
    sessionStartedAt: null,
    
    // Current card start time
    cardStartedAt: null,
    
    // Cards reviewed in this session
    reviewedCount: 0,
    
    // Correct answers in this session
    correctCount: 0,
    
    // Cards remaining in queue
    queue: [],
    
    // Is session active
    isActive: false,

    /**
     * Start a new session
     */
    start(deckId) {
      const cards = CardStorage.getByDeck(deckId);
      if (cards.length === 0) {
        Alpine.store('app').showError('No cards in this deck. Sync from Google Sheets first.');
        return false;
      }

      this.sessionStartedAt = Date.now();
      this.reviewedCount = 0;
      this.correctCount = 0;
      this.isActive = true;
      this.state = 'question';
      this.nextCardData = null;
      
      // Use scheduler to build queue
      this.queue = Scheduler.buildQueue(deckId);
      
      if (this.queue.length === 0) {
        Alpine.store('app').showError('No cards to review right now.');
        return false;
      }

      // Load first card
      this.currentCard = this.queue.shift();
      this.cardStartedAt = Date.now();
      
      Alpine.store('app').navigate('session');
      return true;
    },

    /**
     * Flip the card to show answer
     */
    flip() {
      if (this.state === 'question') {
        this.state = 'answer';
      }
    },

    /**
     * Answer the card
     * @param {boolean} correct - Was the answer correct
     */
    answer(correct) {
      // Only accept answers when showing the answer
      if (this.state !== 'answer' || !this.currentCard) return;

      const answeredAt = Date.now();
      const durationMs = answeredAt - this.cardStartedAt;

      // Record the review
      ReviewStorage.create({
        cardId: this.currentCard.id,
        deckId: this.currentCard.deckId,
        startedAt: new Date(this.cardStartedAt).toISOString(),
        answeredAt: new Date(answeredAt).toISOString(),
        durationMs,
        outcome: correct ? 'correct' : 'incorrect'
      });

      this.reviewedCount++;
      if (correct) {
        this.correctCount++;
      }

      // Check if there are more cards
      if (this.queue.length === 0) {
        this.end();
        return;
      }

      // Preload next card data
      this.nextCardData = this.queue.shift();
      
      // Transition to flipping state (card flips back, but content stays)
      this.state = 'flipping';
      
      // After flip animation completes, swap the card content
      setTimeout(() => {
        this.currentCard = this.nextCardData;
        this.nextCardData = null;
        this.cardStartedAt = Date.now();
        this.state = 'question';
      }, 600); // Full animation duration
    },

    /**
     * End the session
     */
    end() {
      this.isActive = false;
      this.currentCard = null;
      Alpine.store('app').navigate('home');
      
      if (this.reviewedCount > 0) {
        const rate = Math.round((this.correctCount / this.reviewedCount) * 100);
        Alpine.store('app').showSuccess(
          `Session complete! ${this.reviewedCount} cards reviewed, ${rate}% correct.`
        );
      }
    },

    /**
     * Get session progress
     */
    getProgress() {
      const total = this.reviewedCount + this.queue.length;
      if (total === 0) return 0;
      return Math.round((this.reviewedCount / total) * 100);
    }
  });

  /**
   * Stats store
   * Manages statistics display
   */
  Alpine.store('stats', {
    // Current view: 'deck' | 'card'
    view: 'deck',
    
    // Selected card for detail view
    selectedCard: null,
    
    // Deck stats cache
    deckStats: null,
    
    // Card stats cache
    cardStats: [],

    /**
     * Load deck statistics
     */
    loadDeckStats(deckId) {
      this.deckStats = ReviewStorage.getDeckStats(deckId);
      this.loadCardStats(deckId);
    },

    /**
     * Load per-card statistics
     */
    loadCardStats(deckId) {
      const cards = CardStorage.getByDeck(deckId);
      this.cardStats = cards.map(card => ({
        ...card,
        stats: ReviewStorage.getCardStats(card.id)
      }));
      
      // Sort by most needs review (lowest success rate, then by least seen)
      this.cardStats.sort((a, b) => {
        const aRate = a.stats.totalReviews > 0 
          ? a.stats.correct / a.stats.totalReviews 
          : 0;
        const bRate = b.stats.totalReviews > 0 
          ? b.stats.correct / b.stats.totalReviews 
          : 0;
        if (aRate !== bRate) return aRate - bRate;
        return a.stats.totalReviews - b.stats.totalReviews;
      });
    },

    /**
     * Select a card for detail view
     */
    selectCard(card) {
      this.selectedCard = card;
      this.view = 'card';
    },

    /**
     * Go back to deck view
     */
    backToDeck() {
      this.selectedCard = null;
      this.view = 'deck';
    }
  });

  /**
   * Settings store
   * Manages algorithm settings
   */
  Alpine.store('settings', {
    // Current settings
    values: {},

    /**
     * Load settings
     */
    load() {
      this.values = SettingsStorage.get();
    },

    /**
     * Update a setting
     */
    update(key, value) {
      this.values[key] = parseFloat(value);
      SettingsStorage.update(this.values);
    },

    /**
     * Reset to defaults
     */
    reset() {
      this.values = SettingsStorage.reset();
      Alpine.store('app').showSuccess('Settings reset to defaults');
    }
  });

  // Initialize stores
  Alpine.store('app').init();
  Alpine.store('settings').load();
});

// Scheduler is loaded from js/scheduler.js

