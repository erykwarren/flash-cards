/**
 * Google Integration Module
 * Handles OAuth authentication and Google APIs (Drive, Sheets)
 */

// Configuration - Replace with your own Client ID from Google Cloud Console
const GOOGLE_CONFIG = {
  // You need to create this in Google Cloud Console:
  // 1. Go to https://console.cloud.google.com
  // 2. Create a new project or select existing
  // 3. Enable Google Sheets API and Google Drive API
  // 4. Create OAuth 2.0 credentials (Web application)
  // 5. Add authorized JavaScript origins (localhost for dev, your domain for prod)
  // 6. Copy the Client ID here
  CLIENT_ID: '937370375354-7juqso09dojuisf1fq744c9sdusvqmp2.apps.googleusercontent.com',
  
  // API endpoints
  SHEETS_API: 'https://sheets.googleapis.com/v4/spreadsheets',
  DRIVE_API: 'https://www.googleapis.com/drive/v3/files',
  
  // OAuth scopes
  SCOPES: [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/drive.readonly'
  ].join(' ')
};

/**
 * Google Authentication Service
 */
const GoogleAuth = {
  // Token client instance
  tokenClient: null,
  
  // Whether the API is loaded
  isLoaded: false,
  
  // Whether we're currently refreshing silently
  isRefreshing: false,
  
  // Pending operations waiting for token refresh
  pendingRefreshCallbacks: [],

  /**
   * Initialize Google Identity Services
   * Called when the GIS script loads
   */
  init() {
    if (typeof google === 'undefined' || !google.accounts) {
      console.warn('Google Identity Services not loaded yet');
      return;
    }

    this.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CONFIG.CLIENT_ID,
      scope: GOOGLE_CONFIG.SCOPES,
      callback: (tokenResponse) => this.handleTokenResponse(tokenResponse),
      error_callback: (error) => this.handleError(error)
    });

    this.isLoaded = true;
    console.log('Google Auth initialized');

    // Check for existing token
    const stored = AuthStorage.getToken();
    if (stored && stored.access_token) {
      // Check if token is expired or about to expire (within 5 minutes)
      const isExpired = stored.expires_at && Date.now() > stored.expires_at;
      const isExpiringSoon = stored.expires_at && Date.now() > (stored.expires_at - 5 * 60 * 1000);
      
      if (isExpired || isExpiringSoon) {
        console.log('Token expired or expiring soon, attempting silent refresh...');
        // Set user info from stored data so UI shows logged in state
        if (stored.user) {
          Alpine.store('app').user = stored.user;
        }
        this.silentRefresh();
      } else {
        // Token still valid, verify it
        this.validateToken(stored.access_token);
      }
    }
  },

  /**
   * Attempt to silently refresh the access token
   * This works if the user has previously authorized the app
   */
  silentRefresh() {
    if (!this.isLoaded || this.isRefreshing) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      this.isRefreshing = true;
      console.log('Attempting silent token refresh...');
      
      // Store the resolve callback
      this.pendingRefreshCallbacks.push(resolve);
      
      // Try to get a new token without showing the consent screen
      // Using empty string for prompt attempts silent auth
      try {
        this.tokenClient.requestAccessToken({ prompt: '' });
      } catch (error) {
        console.log('Silent refresh failed:', error);
        this.isRefreshing = false;
        this.pendingRefreshCallbacks.forEach(cb => cb(false));
        this.pendingRefreshCallbacks = [];
      }
    });
  },

  /**
   * Start the sign-in flow
   */
  signIn() {
    if (!this.isLoaded) {
      Alpine.store('app').showError('Google Sign-In not ready. Please refresh the page.');
      return;
    }

    if (GOOGLE_CONFIG.CLIENT_ID === 'YOUR_CLIENT_ID.apps.googleusercontent.com') {
      Alpine.store('app').showError('Please configure your Google Client ID in js/google.js');
      return;
    }

    // Request access token with consent prompt
    this.tokenClient.requestAccessToken({ prompt: 'consent' });
  },

  /**
   * Handle token response from OAuth flow
   */
  handleTokenResponse(tokenResponse) {
    const wasRefreshing = this.isRefreshing;
    this.isRefreshing = false;
    
    if (tokenResponse.error) {
      this.handleError(tokenResponse);
      return;
    }

    console.log('Token received' + (wasRefreshing ? ' (silent refresh)' : ''));

    // Get user info (or use stored user info for silent refresh)
    const stored = AuthStorage.getToken();
    const userPromise = (wasRefreshing && stored && stored.user) 
      ? Promise.resolve(stored.user)
      : this.getUserInfo(tokenResponse.access_token);

    userPromise.then(user => {
      // Store token and user info
      AuthStorage.setToken({
        access_token: tokenResponse.access_token,
        expires_in: tokenResponse.expires_in,
        expires_at: Date.now() + (tokenResponse.expires_in * 1000),
        user: user
      });

      // Update app state
      Alpine.store('app').isAuthenticated = true;
      Alpine.store('app').user = user;
      
      // Resolve any pending refresh callbacks
      if (wasRefreshing) {
        console.log('Silent refresh successful');
        this.pendingRefreshCallbacks.forEach(cb => cb(true));
        this.pendingRefreshCallbacks = [];
      } else {
        // Only show message and navigate on explicit sign-in
        Alpine.store('app').showSuccess('Signed in successfully!');
        Alpine.store('app').navigate('picker');
        DriveService.loadSpreadsheets();
      }
    });
  },

  /**
   * Handle OAuth errors
   */
  handleError(error) {
    const wasRefreshing = this.isRefreshing;
    this.isRefreshing = false;
    
    console.error('Google Auth error:', error);
    
    // Handle silent refresh failure gracefully
    if (wasRefreshing) {
      console.log('Silent refresh failed, user will need to sign in again');
      // Clear the stored token since it's no longer valid
      AuthStorage.clearToken();
      Alpine.store('app').isAuthenticated = false;
      // Resolve pending callbacks with failure
      this.pendingRefreshCallbacks.forEach(cb => cb(false));
      this.pendingRefreshCallbacks = [];
      return;
    }
    
    let message = 'Sign-in failed. Please try again.';
    
    if (error.type === 'popup_closed') {
      message = 'Sign-in cancelled.';
    } else if (error.type === 'popup_failed_to_open') {
      message = 'Could not open sign-in popup. Please allow popups.';
    }
    
    Alpine.store('app').showError(message);
  },

  /**
   * Get user info from Google
   */
  async getUserInfo(accessToken) {
    try {
      const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      
      if (!response.ok) throw new Error('Failed to get user info');
      
      const data = await response.json();
      return {
        id: data.id,
        name: data.name,
        email: data.email,
        picture: data.picture
      };
    } catch (error) {
      console.error('getUserInfo error:', error);
      return { name: 'User', email: '' };
    }
  },

  /**
   * Validate stored token
   */
  async validateToken(accessToken) {
    try {
      const response = await fetch(
        `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${accessToken}`
      );
      
      if (response.ok) {
        const stored = AuthStorage.getToken();
        Alpine.store('app').isAuthenticated = true;
        Alpine.store('app').user = stored.user;
        console.log('Token validated');
      } else {
        // Token expired or invalid, try silent refresh
        console.log('Token invalid, attempting silent refresh...');
        const refreshed = await this.silentRefresh();
        if (!refreshed) {
          // Silent refresh failed, clear auth state but don't sign out
          // This preserves user info for display but marks as unauthenticated
          Alpine.store('app').isAuthenticated = false;
        }
      }
    } catch (error) {
      console.error('Token validation failed:', error);
    }
  },

  /**
   * Sign out
   */
  signOut() {
    const token = AuthStorage.getToken();
    
    if (token && token.access_token && typeof google !== 'undefined') {
      // Revoke the token
      google.accounts.oauth2.revoke(token.access_token, () => {
        console.log('Token revoked');
      });
    }

    AuthStorage.clearToken();
    Alpine.store('app').isAuthenticated = false;
    Alpine.store('app').user = null;
    Alpine.store('app').showSuccess('Signed out successfully');
    Alpine.store('app').navigate('home');
  },

  /**
   * Get current access token (does not refresh)
   */
  getAccessToken() {
    const stored = AuthStorage.getToken();
    
    if (!stored || !stored.access_token) {
      return null;
    }

    // Check if token is expired
    if (stored.expires_at && Date.now() > stored.expires_at) {
      console.log('Token expired');
      return null;
    }

    return stored.access_token;
  },

  /**
   * Ensure we have a valid access token, refreshing if needed
   * @returns {Promise<string|null>} The access token or null if not available
   */
  async ensureAccessToken() {
    const stored = AuthStorage.getToken();
    
    if (!stored || !stored.access_token) {
      return null;
    }

    // Check if token is expired or about to expire (within 1 minute)
    const isExpired = stored.expires_at && Date.now() > stored.expires_at;
    const isExpiringSoon = stored.expires_at && Date.now() > (stored.expires_at - 60 * 1000);
    
    if (isExpired || isExpiringSoon) {
      console.log('Token expired or expiring soon, attempting silent refresh...');
      const refreshed = await this.silentRefresh();
      if (refreshed) {
        // Get the new token
        const newStored = AuthStorage.getToken();
        return newStored?.access_token || null;
      } else {
        return null;
      }
    }

    return stored.access_token;
  }
};

/**
 * Google Drive Service
 * Lists and browses spreadsheets in Drive
 */
const DriveService = {
  // List of spreadsheets
  spreadsheets: [],
  
  // Loading state
  isLoading: false,

  /**
   * Load spreadsheets from Drive
   */
  async loadSpreadsheets() {
    const accessToken = await GoogleAuth.ensureAccessToken();
    if (!accessToken) {
      Alpine.store('app').showError('Not authenticated. Please sign in again.');
      return;
    }

    this.isLoading = true;
    Alpine.store('app').setLoading(true);

    try {
      // Query for Google Sheets files
      const query = encodeURIComponent("mimeType='application/vnd.google-apps.spreadsheet'");
      const fields = encodeURIComponent('files(id,name,modifiedTime,owners)');
      
      const response = await fetch(
        `${GOOGLE_CONFIG.DRIVE_API}?q=${query}&fields=${fields}&orderBy=modifiedTime desc&pageSize=50`,
        {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        }
      );

      if (!response.ok) {
        if (response.status === 401) {
          // Token might have been invalidated server-side
          Alpine.store('app').showError('Session expired. Please sign in again.');
          Alpine.store('app').isAuthenticated = false;
          return;
        }
        throw new Error('Failed to load spreadsheets');
      }

      const data = await response.json();
      this.spreadsheets = data.files || [];
      
      console.log(`Loaded ${this.spreadsheets.length} spreadsheets`);
      
    } catch (error) {
      console.error('loadSpreadsheets error:', error);
      Alpine.store('app').showError(error.message);
    } finally {
      this.isLoading = false;
      Alpine.store('app').setLoading(false);
    }
  },

  /**
   * Select a spreadsheet and create a deck
   */
  async selectSpreadsheet(spreadsheet) {
    console.log('Selected spreadsheet:', spreadsheet);
    
    Alpine.store('app').setLoading(true);

    try {
      // Read the spreadsheet content
      const result = await SheetsService.readSpreadsheet(spreadsheet.id);
      
      if (!result.success) {
        throw new Error(result.error);
      }

      // Create or update deck
      let deck = Alpine.store('app').decks.find(d => d.spreadsheetId === spreadsheet.id);
      
      if (deck) {
        // Update existing deck
        DeckStorage.update(deck.id, {
          name: spreadsheet.name,
          lastSyncedAt: new Date().toISOString()
        });
      } else {
        // Create new deck
        deck = DeckStorage.create({
          name: spreadsheet.name,
          spreadsheetId: spreadsheet.id,
          spreadsheetName: spreadsheet.name,
          lastSyncedAt: new Date().toISOString()
        });
      }

      // Sync cards
      const syncResult = await CardStorage.syncCards(deck.id, result.cards);
      
      // Reload app data
      Alpine.store('app').loadDecks();
      Alpine.store('app').selectDeck(deck.id);
      
      Alpine.store('app').showSuccess(
        `Imported ${result.cards.length} cards! (${syncResult.created} new, ${syncResult.archived} archived)`
      );
      
      Alpine.store('app').navigate('home');
      
    } catch (error) {
      console.error('selectSpreadsheet error:', error);
      Alpine.store('app').showError(error.message);
    } finally {
      Alpine.store('app').setLoading(false);
    }
  }
};

/**
 * Google Sheets Service
 * Reads spreadsheet content
 */
const SheetsService = {
  /**
   * Read flashcard data from a spreadsheet
   * Expects Column A = Question, Column B = Answer, Column C = Example (optional)
   */
  async readSpreadsheet(spreadsheetId) {
    // Use ensureAccessToken to automatically refresh expired tokens
    const accessToken = await GoogleAuth.ensureAccessToken();
    if (!accessToken) {
      return { success: false, error: 'Not authenticated. Please sign in again.' };
    }

    try {
      // Read columns A, B, and C from the first sheet
      const range = encodeURIComponent('A:C');
      
      const response = await fetch(
        `${GOOGLE_CONFIG.SHEETS_API}/${spreadsheetId}/values/${range}`,
        {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        }
      );

      if (!response.ok) {
        if (response.status === 401) {
          GoogleAuth.signOut();
          return { success: false, error: 'Session expired. Please sign in again.' };
        }
        if (response.status === 403) {
          return { success: false, error: 'Access denied. Make sure you have permission to read this spreadsheet.' };
        }
        if (response.status === 404) {
          return { success: false, error: 'Spreadsheet not found.' };
        }
        return { success: false, error: 'Failed to read spreadsheet' };
      }

      const data = await response.json();
      const rows = data.values || [];

      if (rows.length === 0) {
        return { success: false, error: 'Spreadsheet is empty' };
      }

      // Parse rows into cards
      // Skip first row if it looks like a header
      const startIndex = this.isHeaderRow(rows[0]) ? 1 : 0;
      
      const cards = [];
      for (let i = startIndex; i < rows.length; i++) {
        const row = rows[i];
        const question = (row[0] || '').trim();
        const answer = (row[1] || '').trim();
        const example = (row[2] || '').trim();
        
        // Skip empty rows
        if (question && answer) {
          cards.push({ question, answer, example: example || null });
        }
      }

      if (cards.length === 0) {
        return { 
          success: false, 
          error: 'No valid cards found. Make sure Column A has questions and Column B has answers.' 
        };
      }

      return { success: true, cards };

    } catch (error) {
      console.error('readSpreadsheet error:', error);
      return { success: false, error: 'Failed to read spreadsheet: ' + error.message };
    }
  },

  /**
   * Check if a row looks like a header
   */
  isHeaderRow(row) {
    if (!row || row.length === 0) return false;
    
    const headerKeywords = ['question', 'answer', 'front', 'back', 'term', 'definition', 'q', 'a'];
    const firstCell = (row[0] || '').toLowerCase().trim();
    const secondCell = (row[1] || '').toLowerCase().trim();
    
    return headerKeywords.some(kw => 
      firstCell.includes(kw) || secondCell.includes(kw)
    );
  },

  /**
   * Extract spreadsheet ID from a Google Sheets URL
   * Supports formats:
   * - https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
   * - https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit#gid=0
   * - https://docs.google.com/spreadsheets/d/SPREADSHEET_ID
   */
  extractSpreadsheetId(url) {
    if (!url) return null;
    
    // Match the spreadsheet ID from the URL
    const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : null;
  },

  /**
   * Import flashcards from a Google Sheets URL
   * @param {string} url - The Google Sheets URL
   */
  async importFromUrl(url) {
    // Extract spreadsheet ID
    const spreadsheetId = this.extractSpreadsheetId(url);
    
    if (!spreadsheetId) {
      Alpine.store('app').showError('Invalid Google Sheets URL. Please paste a valid spreadsheet link.');
      return;
    }

    // Check authentication (will try silent refresh if needed)
    const accessToken = await GoogleAuth.ensureAccessToken();
    if (!accessToken) {
      Alpine.store('app').showError('Please sign in with Google first.');
      Alpine.store('app').navigate('login');
      return;
    }

    Alpine.store('app').setLoading(true);

    try {
      // Read spreadsheet content
      const result = await this.readSpreadsheet(spreadsheetId);
      
      if (!result.success) {
        throw new Error(result.error);
      }

      // Get spreadsheet metadata for the name (use fresh token)
      let sheetName = 'Imported Deck';
      try {
        const currentToken = await GoogleAuth.ensureAccessToken();
        const metaResponse = await fetch(
          `${GOOGLE_CONFIG.SHEETS_API}/${spreadsheetId}?fields=properties.title`,
          { headers: { 'Authorization': `Bearer ${currentToken}` } }
        );
        if (metaResponse.ok) {
          const meta = await metaResponse.json();
          sheetName = meta.properties?.title || sheetName;
        }
      } catch (e) {
        console.warn('Could not fetch spreadsheet name:', e);
      }

      // Check if deck already exists for this spreadsheet
      let deck = Alpine.store('app').decks.find(d => d.spreadsheetId === spreadsheetId);
      
      if (deck) {
        // Update existing deck
        DeckStorage.update(deck.id, {
          name: sheetName,
          lastSyncedAt: new Date().toISOString()
        });
      } else {
        // Create new deck
        deck = DeckStorage.create({
          name: sheetName,
          spreadsheetId: spreadsheetId,
          spreadsheetName: sheetName,
          lastSyncedAt: new Date().toISOString()
        });
      }

      // Sync cards
      const syncResult = await CardStorage.syncCards(deck.id, result.cards);
      
      // Reload app data
      Alpine.store('app').loadDecks();
      Alpine.store('app').selectDeck(deck.id);
      
      Alpine.store('app').showSuccess(
        `Imported "${sheetName}" with ${result.cards.length} cards!`
      );
      
      Alpine.store('app').navigate('home');

    } catch (error) {
      console.error('importFromUrl error:', error);
      Alpine.store('app').showError(error.message || 'Failed to import spreadsheet');
    } finally {
      Alpine.store('app').setLoading(false);
    }
  }
};

// Export services
window.GoogleAuth = GoogleAuth;
window.DriveService = DriveService;
window.SheetsService = SheetsService;
window.GOOGLE_CONFIG = GOOGLE_CONFIG;

// Initialize when GIS loads
window.handleGoogleLoad = function() {
  GoogleAuth.init();
};

