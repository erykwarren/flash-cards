# Flashcards

A web-based flashcard application with spaced repetition, powered by Google Sheets.

## Features

- **Google Sheets Integration**: Import flashcards from any Google Sheets spreadsheet
- **Spaced Repetition**: Smart algorithm prioritizes cards you need to review
- **Offline Support**: Study anywhere, even without internet (local storage)
- **Progress Tracking**: Detailed statistics for each card and overall progress
- **Tunable Algorithm**: Adjust learning parameters to fit your style
- **Mobile-Friendly**: Works great on phones, tablets, and desktops
- **No Backend Required**: Runs entirely in the browser, hosted on GitHub Pages

## Quick Start

### 1. Create Your Spreadsheet

Create a Google Sheets document with:
- **Column A**: Questions
- **Column B**: Answers

Example:
| A (Question) | B (Answer) |
|--------------|------------|
| Bonjour | Hello |
| Merci | Thank you |
| Au revoir | Goodbye |

### 2. Set Up Google Cloud (Required for Sync)

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (e.g., "Flashcards App")
3. Enable these APIs:
   - Google Sheets API
   - Google Drive API
4. Configure OAuth consent screen:
   - User type: External
   - App name: "Flashcards"
   - Add scopes: `spreadsheets.readonly`, `drive.readonly`
5. Create OAuth 2.0 credentials:
   - Application type: Web application
   - Authorized JavaScript origins:
     - `http://localhost:8000` (for development)
     - `https://yourusername.github.io` (for production)
6. Copy your **Client ID**


### 3. Configure the App

Edit `js/google.js` and replace the placeholder:

```javascript
CLIENT_ID: 'YOUR_ACTUAL_CLIENT_ID.apps.googleusercontent.com',
```

### 4. Run Locally

Start a local web server:

```bash
# Python 3
python -m http.server 8000

# Node.js (if you have npx)
npx serve . -l 8000

# PHP
php -S localhost:8000
```

Open http://localhost:8000 in your browser.

### 5. Deploy to GitHub Pages

1. Push to a GitHub repository
2. Go to Settings → Pages
3. Select "Deploy from a branch" → `main` / `root`
4. Your app will be live at `https://yourusername.github.io/repo-name`

Remember to add your GitHub Pages URL to the authorized origins in Google Cloud Console!

## Project Structure

```
flash-cards-ios/
├── index.html          # Main application
├── manifest.json       # PWA manifest
├── js/
│   ├── storage.js      # localStorage wrapper
│   ├── scheduler.js    # Spaced repetition algorithm
│   ├── google.js       # Google OAuth & APIs
│   ├── sync.js         # Spreadsheet sync logic
│   └── app.js          # Alpine.js stores & init
├── css/
│   └── custom.css      # Custom styles
├── assets/
│   └── icon.svg        # App icon
└── README.md           # This file
```

## Algorithm

The spaced repetition algorithm uses a priority score to select which cards to review:

```
Priority = (failureWeight × failureRate)
         + (recencyWeight × daysSinceLastSeen / maxRecencyDays)
         + (exposureWeight × exposureGap)
         - (recentPenalty)
```

### Default Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| Failure Weight | 3.0 | How much to prioritize failed cards |
| Recency Weight | 2.0 | How much to prioritize old cards |
| Exposure Weight | 1.5 | How much to prioritize under-reviewed cards |
| Target Exposures | 7 | Minimum reviews per card |
| New Cards/Session | 5 | Max new cards introduced per session |

All parameters can be adjusted in Settings.

## Technology Stack

- **Alpine.js**: Reactive UI framework (15KB, no build step)
- **Tailwind CSS**: Utility-first styling
- **Google Identity Services**: OAuth 2.0 authentication
- **localStorage**: Client-side data persistence

## Browser Support

Works on all modern browsers:
- Chrome 80+
- Firefox 75+
- Safari 13+
- Edge 80+

## Offline Mode

The app works offline for studying! Your cards and progress are stored locally. When you're back online, use "Sync Now" to fetch any new cards from your spreadsheet.

## Privacy

- All your data stays on your device (localStorage)
- Google access is read-only (we never modify your spreadsheets)
- No analytics or tracking
- No server-side storage

## Troubleshooting

### "Please configure your Google Client ID"
You need to set up Google Cloud credentials. See [Set Up Google Cloud](#2-set-up-google-cloud-required-for-sync).

### "Access denied" when selecting spreadsheet
Make sure the spreadsheet is accessible to your Google account. Try opening it directly in Google Sheets first.

### Cards not syncing
1. Check your internet connection
2. Try signing out and back in
3. Verify the spreadsheet still exists and is accessible

### App not loading
Make sure you're serving the files through a web server, not opening `index.html` directly (file:// URLs have CORS restrictions).

## Future Improvements

- [ ] PWA with full offline support (Service Worker)
- [ ] Multiple decks from different spreadsheets
- [ ] Rich content: images, audio
- [ ] Export/Import JSON backup
- [ ] Dark/Light theme toggle
- [ ] Keyboard shortcuts
- [ ] Study reminders

## License

MIT License - feel free to use and modify!

