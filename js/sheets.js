/**
 * Sheets Module
 * Fetches and parses public Google Sheets CSV exports. No auth.
 *
 * Source sheet must be shared as "Anyone with the link → Viewer".
 * URL template: https://docs.google.com/spreadsheets/d/{spreadsheetId}/export?format=csv&gid={gid}
 */

const CSV_EXPORT_TEMPLATE =
  'https://docs.google.com/spreadsheets/d/{id}/export?format=csv&gid={gid}';

const SheetsService = {

  /**
   * Parse a Google Sheets URL into { spreadsheetId, gid }.
   * Returns null on any malformed input.
   */
  parseSheetUrl(url) {
    if (typeof url !== 'string') return null;
    const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!idMatch) return null;
    const gidMatch = url.match(/[#&?]gid=([0-9]+)/);
    return {
      spreadsheetId: idMatch[1],
      gid: gidMatch ? gidMatch[1] : '0'
    };
  },

  /**
   * Build a CSV export URL from a spreadsheetId + gid.
   */
  buildCsvUrl(spreadsheetId, gid = '0') {
    return CSV_EXPORT_TEMPLATE
      .replace('{id}', spreadsheetId)
      .replace('{gid}', gid);
  },

  /**
   * Fetch and parse a deck's CSV.
   * @param {string} csvUrl
   * @returns {Promise<{success:boolean, cards?:Array, error?:string}>}
   */
  async fetchCsv(csvUrl) {
    if (!csvUrl) {
      return { success: false, error: 'No CSV URL configured for this deck.' };
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { success: false, error: 'offline' };
    }

    let response;
    try {
      response = await fetch(csvUrl, { redirect: 'follow' });
    } catch (err) {
      return { success: false, error: "Couldn't refresh. Using cached cards." };
    }

    if (!response.ok) {
      if (response.status === 403 || response.status === 404) {
        return {
          success: false,
          error: 'Sheet not found or not public. Check sharing.'
        };
      }
      return { success: false, error: `Fetch failed (${response.status}).` };
    }

    let text;
    try {
      text = await response.text();
    } catch (err) {
      return { success: false, error: "Couldn't read sheet format." };
    }

    let cards;
    try {
      cards = this.parseCsv(text);
    } catch (err) {
      console.warn('parseCsv failed:', err);
      return { success: false, error: "Couldn't read sheet format." };
    }

    if (cards.length === 0) {
      return { success: false, error: 'No valid cards found.' };
    }

    return { success: true, cards };
  },

  /**
   * Parse a CSV string into [{question, answer, example}].
   * - Respects double-quoted fields, embedded commas, embedded newlines, and "" escapes.
   * - Accepts \r\n or \n line terminators.
   * - Skips rows where question or answer is blank after trim.
   * - Skips the first row if isHeaderRow matches.
   */
  parseCsv(text) {
    const rows = this._splitCsv(text);
    if (rows.length === 0) return [];

    const startIndex = this.isHeaderRow(rows[0]) ? 1 : 0;

    const cards = [];
    for (let i = startIndex; i < rows.length; i++) {
      const row = rows[i];
      const question = (row[0] || '').trim();
      const answer = (row[1] || '').trim();
      const example = (row[2] || '').trim();
      if (question && answer) {
        cards.push({ question, answer, example });
      }
    }
    return cards;
  },

  /**
   * Row splitter: returns Array<Array<string>>. Handles quoted fields with
   * embedded commas, embedded newlines, and "" escapes.
   */
  _splitCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\r') {
        // handle \r\n and bare \r
        if (text[i + 1] === '\n') i++;
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
      } else if (ch === '\n') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
      } else {
        field += ch;
      }
    }

    // Flush trailing field/row if any content remains
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }

    // Strip fully-empty trailing rows
    while (rows.length > 0 && rows[rows.length - 1].every(c => c.trim() === '')) {
      rows.pop();
    }

    return rows;
  },

  /**
   * Header-row heuristic: matches keywords against the first two cells.
   */
  isHeaderRow(row) {
    if (!row || row.length === 0) return false;
    const headerKeywords = ['question', 'answer', 'front', 'back', 'term', 'definition', 'q', 'a'];
    const firstCell = (row[0] || '').toLowerCase().trim();
    const secondCell = (row[1] || '').toLowerCase().trim();
    return headerKeywords.some(kw =>
      firstCell.includes(kw) || secondCell.includes(kw)
    );
  }
};

window.SheetsService = SheetsService;
