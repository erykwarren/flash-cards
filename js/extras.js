/**
 * Card Extras Module
 * Columns C and later of a sheet tab carry optional extras (syllabics, gloss, audio,
 * example, notes, image, or any labeled text). The header row names each
 * column's kind; a tab without headers keeps the legacy meaning: C = example.
 *
 * A card stores them as `extras: [{ kind, label, value }]`, in column order.
 */

const CardExtras = {

  // Header aliases per kind, compared after normalizeHeader().
  KINDS: {
    syllabic: ['syllabaire', 'syllabaires', 'syllabic', 'syllabics', 'syllabique', 'syllabiques', 'ᖃᓂᐅᔮᖅᐸᐃᑦ'],
    gloss: ['glose', 'gloses', 'gloss', 'glosses'],
    audio: ['audio', 'son', 'sound', 'pronunciation', 'prononciation'],
    example: ['example', 'examples', 'exemple', 'exemples'],
    notes: ['notes', 'note', 'remarque', 'remarques'],
    image: ['image', 'img', 'picture', 'photo']
  },

  /** Lowercase, trimmed, accents stripped. */
  normalizeHeader(h) {
    return String(h || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  },

  /** The kind a header names, or null when it isn't a known name. */
  kindForHeader(h) {
    const n = CardExtras.normalizeHeader(h);
    if (!n) return null;
    for (const [kind, aliases] of Object.entries(CardExtras.KINDS)) {
      if (aliases.some(a => CardExtras.normalizeHeader(a) === n)) return kind;
    }
    return null;
  },

  /**
   * What each column holds. Indexes 0–1 (question, answer) are always null.
   * @param {string[]|null} headerRow - the header row, or null when the tab has none
   * @param {number} width - number of columns to describe
   * @returns {Array<{kind:string, label:string}|null>}
   */
  columnKinds(headerRow, width) {
    const cols = [];
    for (let i = 0; i < width; i++) {
      if (i < 2) { cols.push(null); continue; }
      if (!headerRow) {
        cols.push(i === 2 ? { kind: 'example', label: 'Example' } : null);
        continue;
      }
      const label = String(headerRow[i] || '').trim();
      const kind = CardExtras.kindForHeader(label);
      if (i === 2) {
        cols.push({ kind: kind || 'example', label: label || 'Example' });
      } else if (kind) {
        cols.push({ kind, label });
      } else {
        cols.push(label ? { kind: 'text', label } : null);
      }
    }
    return cols;
  },

  /** Extras of one data row, in column order; empty cells are dropped. */
  fromRow(row, columns) {
    const extras = [];
    columns.forEach((col, i) => {
      if (!col) return;
      const value = String(row[i] || '').trim();
      if (value) extras.push({ kind: col.kind, label: col.label, value });
    });
    return extras;
  },

  /** A card's extras, falling back to the legacy `example` field. */
  forCard(card) {
    if (!card) return [];
    if (Array.isArray(card.extras)) return card.extras;
    if (card.example) return [{ kind: 'example', label: 'Example', value: card.example }];
    return [];
  },

  /** Append entries of `more` whose kind+label `target` doesn't have yet. */
  mergeInto(target, more) {
    const key = e => `${e.kind}\u0000${e.label}`;
    const have = new Set(target.map(key));
    for (const e of more || []) {
      if (!have.has(key(e))) {
        target.push(e);
        have.add(key(e));
      }
    }
    return target;
  },

  /** Group a card's extras for display on the answer side. */
  layout(card) {
    const out = { syllabic: [], gloss: [], audio: [], body: [], images: [] };
    for (const e of CardExtras.forCard(card)) {
      if (e.kind === 'syllabic') out.syllabic.push(e.value);
      else if (e.kind === 'gloss') out.gloss.push(e.value);
      else if (e.kind === 'audio') out.audio.push(e.value);
      else if (e.kind === 'image') out.images.push(e.value);
      else out.body.push(e);
    }
    return out;
  }
};

window.CardExtras = CardExtras;
