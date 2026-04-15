/**
 * Sync Module
 * Handles synchronization between a public Google Sheet (via CSV export) and local storage.
 */

const SyncService = {

  /**
   * Sync a deck with its source sheet.
   * @param {string} deckId
   * @returns {Promise<{success: boolean, message: string, stats?: Object}>}
   */
  async syncDeck(deckId) {
    const deck = DeckStorage.getById(deckId);

    if (!deck) {
      return { success: false, message: 'Deck not found' };
    }

    if (!deck.csvUrl) {
      return { success: false, message: 'This deck is not linked to a spreadsheet' };
    }

    Alpine.store('app').setLoading(true);

    try {
      const result = await SheetsService.fetchCsv(deck.csvUrl);

      if (!result.success) {
        return { success: false, message: result.error };
      }

      const syncStats = await CardStorage.syncCards(deck.id, result.cards);

      DeckStorage.update(deck.id, {
        lastSyncedAt: new Date().toISOString()
      });

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
   * Sync all decks that have a csvUrl. Runs on app load.
   * Failures per-deck are logged but do not abort the batch.
   */
  async syncAllDecks() {
    const decks = DeckStorage.getAll().filter(d => d.csvUrl);

    if (decks.length === 0) {
      return { success: true, results: [] };
    }

    const results = await Promise.all(
      decks.map(async deck => {
        const r = await this.syncDeck(deck.id);
        return { deckId: deck.id, deckName: deck.name, ...r };
      })
    );

    const allSuccess = results.every(r => r.success);
    return { success: allSuccess, results };
  },

  /**
   * Sync status for the deck list UI. Unchanged shape from the prior auth-based flow.
   */
  getSyncStatus(deckId) {
    const deck = DeckStorage.getById(deckId);

    if (!deck) {
      return { status: 'unknown', message: 'Deck not found' };
    }

    if (!deck.csvUrl) {
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

  isOnline() {
    return navigator.onLine;
  }
};

window.SyncService = SyncService;

window.addEventListener('online', () => {
  console.log('Back online');
  if (window.Alpine && Alpine.store('app')) {
    Alpine.store('app').showSuccess('Back online');
  }
});

window.addEventListener('offline', () => {
  console.log('Gone offline');
  if (window.Alpine && Alpine.store('app')) {
    Alpine.store('app').showError('You are offline. Cached cards are still available.');
  }
});
