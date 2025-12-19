/**
 * Sync Module
 * Handles synchronization between Google Sheets and local storage
 */

const SyncService = {
  
  /**
   * Sync a deck with its source spreadsheet
   * @param {string} deckId - The deck ID to sync
   * @returns {Promise<{success: boolean, message: string, stats?: Object}>}
   */
  async syncDeck(deckId) {
    const deck = DeckStorage.getById(deckId);
    
    if (!deck) {
      return { success: false, message: 'Deck not found' };
    }

    if (!deck.spreadsheetId) {
      return { success: false, message: 'This deck is not linked to a spreadsheet' };
    }

    // Check if authenticated
    const accessToken = GoogleAuth.getAccessToken();
    if (!accessToken) {
      return { success: false, message: 'Not authenticated. Please sign in again.' };
    }

    Alpine.store('app').setLoading(true);

    try {
      // Read spreadsheet data
      const result = await SheetsService.readSpreadsheet(deck.spreadsheetId);
      
      if (!result.success) {
        return { success: false, message: result.error };
      }

      // Sync cards with local storage
      const syncStats = await CardStorage.syncCards(deck.id, result.cards);
      
      // Update deck metadata
      DeckStorage.update(deck.id, {
        lastSyncedAt: new Date().toISOString()
      });

      // Reload app data
      Alpine.store('app').loadDecks();
      
      const message = `Synced successfully! ${syncStats.created} new, ${syncStats.updated} updated, ${syncStats.archived} archived.`;
      
      return { 
        success: true, 
        message,
        stats: {
          totalCards: result.cards.length,
          ...syncStats
        }
      };

    } catch (error) {
      console.error('syncDeck error:', error);
      return { success: false, message: 'Sync failed: ' + error.message };
    } finally {
      Alpine.store('app').setLoading(false);
    }
  },

  /**
   * Sync all decks that are linked to spreadsheets
   * @returns {Promise<{success: boolean, results: Array}>}
   */
  async syncAllDecks() {
    const decks = DeckStorage.getAll().filter(d => d.spreadsheetId);
    
    if (decks.length === 0) {
      return { success: true, results: [] };
    }

    const results = [];
    
    for (const deck of decks) {
      const result = await this.syncDeck(deck.id);
      results.push({
        deckId: deck.id,
        deckName: deck.name,
        ...result
      });
    }

    const allSuccess = results.every(r => r.success);
    return { success: allSuccess, results };
  },

  /**
   * Get sync status for a deck
   * @param {string} deckId - The deck ID
   * @returns {Object} Sync status info
   */
  getSyncStatus(deckId) {
    const deck = DeckStorage.getById(deckId);
    
    if (!deck) {
      return { status: 'unknown', message: 'Deck not found' };
    }

    if (!deck.spreadsheetId) {
      return { status: 'local', message: 'Local deck (not synced)' };
    }

    if (!deck.lastSyncedAt) {
      return { status: 'never', message: 'Never synced' };
    }

    const lastSync = new Date(deck.lastSyncedAt);
    const now = new Date();
    const hoursSince = (now - lastSync) / (1000 * 60 * 60);

    if (hoursSince < 1) {
      return { status: 'fresh', message: 'Synced recently' };
    } else if (hoursSince < 24) {
      return { status: 'ok', message: `Synced ${Math.floor(hoursSince)} hours ago` };
    } else {
      const daysSince = Math.floor(hoursSince / 24);
      return { status: 'stale', message: `Synced ${daysSince} day${daysSince > 1 ? 's' : ''} ago` };
    }
  },

  /**
   * Check if we're online
   * @returns {boolean}
   */
  isOnline() {
    return navigator.onLine;
  },

  /**
   * Auto-sync on app start (if online and authenticated)
   */
  async autoSync() {
    if (!this.isOnline()) {
      console.log('Offline - skipping auto-sync');
      return;
    }

    if (!GoogleAuth.getAccessToken()) {
      console.log('Not authenticated - skipping auto-sync');
      return;
    }

    const decks = DeckStorage.getAll().filter(d => d.spreadsheetId);
    
    for (const deck of decks) {
      const status = this.getSyncStatus(deck.id);
      
      // Only auto-sync if last sync was more than 1 hour ago
      if (status.status === 'stale' || status.status === 'never') {
        console.log(`Auto-syncing deck: ${deck.name}`);
        await this.syncDeck(deck.id);
      }
    }
  }
};

// Export
window.SyncService = SyncService;

// Listen for online/offline events
window.addEventListener('online', () => {
  console.log('Back online');
  Alpine.store('app').showSuccess('Back online');
});

window.addEventListener('offline', () => {
  console.log('Gone offline');
  Alpine.store('app').showError('You are offline. Changes will sync when you reconnect.');
});

