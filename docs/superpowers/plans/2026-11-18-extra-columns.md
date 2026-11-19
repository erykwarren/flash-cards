# Extra Card Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Columns C and later of each sheet tab are typed by their header (syllabic, audio, example, notes, image, or labeled text) and shown on the answer side, without changing how existing sheets import.

**Architecture:** A new `js/extras.js` (global `CardExtras`) owns the header→kind mapping, row→extras conversion, the merge rule and the display grouping. `sheets.js` uses it to parse, `storage.js` stores `card.extras` instead of `card.example`, and `index.html` renders `CardExtras.layout(card)` on the card back and in the card detail view.

**Tech Stack:** Vanilla JS globals, Alpine.js + Tailwind via CDN, localStorage. Tests are the in-browser `verify.html` runner (`window.TESTS.push(fn)` + `VERIFY.assert*`).

**Spec:** `docs/superpowers/specs/2026-11-18-extra-columns-design.md`

## Global Constraints

- Card IDs unchanged: `generateCardId(deckId, question, answer)` only.
- `isHeaderRow`'s existing substring rule on A/B stays **byte-for-byte unchanged**; only an OR-clause is added.
- No header row → column C is `example`, later columns ignored.
- Header row → column C is `example` unless its header is a recognized kind; unrecognized C header keeps `example` with the header as label.
- Columns D+ : recognized header → that kind; non-empty unrecognized → `text`; empty header → ignored.
- Header matching: case-insensitive, accent-insensitive, trimmed.
- Header aliases (exact, after normalization):
  - `syllabic`: syllabic, syllabics, syllabique, syllabiques, ᖃᓂᐅᔮᖅᐸᐃᑦ
  - `audio`: audio, son, sound, pronunciation, prononciation
  - `example`: example, examples, exemple, exemples
  - `notes`: notes, note, remarque, remarques
  - `image`: image, img, picture, photo
- Extras appear only on the answer side. No autoplay. 🔊 tap must not flip the card.
- Syllabics font: *Noto Sans Canadian Aboriginal* via the existing Google Fonts `<link>`.
- Script order becomes `version.js → storage.js → extras.js → scheduler.js → sheets.js → sync.js → app.js` (verify.html: `storage → extras → scheduler → sheets → verify`).

## Review Focus

1. Cells that are whitespace-only → no extra entry (test in Task 1).
2. Rows shorter than the header (trailing cells missing in CSV) → no crash, fewer extras (test in Task 2).
3. Header variants like `"  Exemple "`, `SYLLABIQUE`, `Prononciation` → recognized (test in Task 1).
4. An audio URL the browser can't play (Drive link) → button becomes an "open link" anchor, never a silent no-op (manual check in Task 4).
5. A card with syllabic + audio + example + notes + image → nothing clipped on the card back, flip still 600 ms (manual check in Task 4).

## How to run tests

```bash
./update-version.sh && python3 -m http.server 8000
```
Open http://localhost:8000/verify.html (or drive it with Playwright). Pass = the final `<h2>` reads `N passed, 0 failed`.

---

### Task 1: `CardExtras` module

**Files:**
- Create: `js/extras.js`
- Modify: `verify.html` (add `<script src="js/extras.js?v=4"></script>` after storage.js), `index.html:842-844` (add `<script src="js/extras.js"></script>` after storage.js)
- Test: `js/verify.js` (append)

**Interfaces:**
- Produces (global `window.CardExtras`):
  - `KINDS: { syllabic: string[], audio: string[], example: string[], notes: string[], image: string[] }` — the alias lists above.
  - `normalizeHeader(h: string) → string` — `NFD`, strip `\p{M}`, lowercase, trim.
  - `kindForHeader(h: string) → 'syllabic'|'audio'|'example'|'notes'|'image'|null`
  - `columnKinds(headerRow: string[]|null, width: number) → Array<{kind, label}|null>` indexed by column; indexes 0–1 always `null`. Rules from Global Constraints; label = trimmed original header, or `'Example'` when there is no header / empty C header.
  - `fromRow(row: string[], columns) → Array<{kind, label, value}>` — column order, values trimmed, empty dropped, missing cells treated as empty.
  - `forCard(card) → Array<{kind,label,value}>` — `card.extras` if it's an array; else `[{kind:'example', label:'Example', value: card.example}]` when `card.example` is truthy; else `[]`.
  - `mergeInto(target: Array, more: Array) → Array` — appends entries of `more` whose `kind+'\u0000'+label` isn't already in `target`; returns `target`.
  - `layout(card) → { syllabic: string[], audio: string[], body: Array<{kind,label,value}>, images: string[] }` — groups `forCard(card)`; `body` holds `example`, `notes`, `text` in order.

- [ ] **Step 1: Write the failing tests** (append to `js/verify.js`)

```js
window.TESTS.push(function () {
  VERIFY.group('CardExtras');
  const k = CardExtras.kindForHeader;
  VERIFY.assertEqual('Syllabic', k('Syllabic'), 'syllabic');
  VERIFY.assertEqual('SYLLABIQUE', k('SYLLABIQUE'), 'syllabic');
  VERIFY.assertEqual('inuktitut header', k('ᖃᓂᐅᔮᖅᐸᐃᑦ'), 'syllabic');
  VERIFY.assertEqual('padded Exemple', k('  Exemple '), 'example');
  VERIFY.assertEqual('Prononciation', k('Prononciation'), 'audio');
  VERIFY.assertEqual('Remarque', k('Remarque'), 'notes');
  VERIFY.assertEqual('Photo', k('Photo'), 'image');
  VERIFY.assertEqual('unknown → null', k('Genre'), null);
  VERIFY.assertEqual('substring is not a match', k('audio file'), null);

  const none = CardExtras.columnKinds(null, 5);
  VERIFY.assertEqual('no header → C is example', JSON.stringify(none[2]), JSON.stringify({ kind: 'example', label: 'Example' }));
  VERIFY.assertEqual('no header → D ignored', none[3], null);

  const h = CardExtras.columnKinds(['Français', 'Inuktitut', 'Phrase', 'Audio', 'Genre', ''], 6);
  VERIFY.assertEqual('unrecognized C → example labeled', JSON.stringify(h[2]), JSON.stringify({ kind: 'example', label: 'Phrase' }));
  VERIFY.assertEqual('D audio', h[3].kind, 'audio');
  VERIFY.assertEqual('unknown D+ → text', JSON.stringify(h[4]), JSON.stringify({ kind: 'text', label: 'Genre' }));
  VERIFY.assertEqual('empty D+ header → ignored', h[5], null);
  VERIFY.assertEqual('C syllabic when named', CardExtras.columnKinds(['q', 'a', 'Syllabic'], 3)[2].kind, 'syllabic');

  const cols = CardExtras.columnKinds(['q', 'a', 'Syllabic', 'Audio', 'Notes'], 5);
  const ex = CardExtras.fromRow(['Bienvenu', 'tungngasugit', ' ᑐᙵᓱᒋᑦ ', '   ', 'x'], cols);
  VERIFY.assertEqual('whitespace-only dropped, trimmed', JSON.stringify(ex),
    JSON.stringify([{ kind: 'syllabic', label: 'Syllabic', value: 'ᑐᙵᓱᒋᑦ' }, { kind: 'notes', label: 'Notes', value: 'x' }]));
  VERIFY.assertEqual('short row → no crash', CardExtras.fromRow(['a', 'b'], cols).length, 0);

  VERIFY.assertEqual('legacy example fallback', JSON.stringify(CardExtras.forCard({ example: 'e' })),
    JSON.stringify([{ kind: 'example', label: 'Example', value: 'e' }]));
  VERIFY.assertEqual('no extras → []', CardExtras.forCard({ example: null }).length, 0);

  const t = [{ kind: 'notes', label: 'Notes', value: '1' }];
  CardExtras.mergeInto(t, [{ kind: 'notes', label: 'Notes', value: '2' }, { kind: 'audio', label: 'Audio', value: 'u' }]);
  VERIFY.assertEqual('merge keeps first, adds missing', t.map(e => e.value).join(','), '1,u');

  const lay = CardExtras.layout({ extras: [
    { kind: 'image', label: 'Image', value: 'i' }, { kind: 'notes', label: 'Notes', value: 'n' },
    { kind: 'syllabic', label: 'Syllabic', value: 's' }, { kind: 'audio', label: 'Audio', value: 'u' },
    { kind: 'text', label: 'Genre', value: 'g' }] });
  VERIFY.assertEqual('layout syllabic', lay.syllabic.join(), 's');
  VERIFY.assertEqual('layout audio', lay.audio.join(), 'u');
  VERIFY.assertEqual('layout images', lay.images.join(), 'i');
  VERIFY.assertEqual('layout body order', lay.body.map(e => e.value).join(), 'n,g');
});
```

- [ ] **Step 2: Run verify.html** — Expected: `CardExtras` group fails with "test threw — CardExtras is not defined".
- [ ] **Step 3: Implement `js/extras.js`** per the Interfaces block; attach `window.CardExtras`. Add the script tags to `verify.html` and `index.html`.
- [ ] **Step 4: Run verify.html** — Expected: `N passed, 0 failed`.
- [ ] **Step 5: Commit** — `git add js/extras.js js/verify.js verify.html index.html && git commit -m "Add CardExtras: header-typed extra card columns"`

---

### Task 2: Parse extras from CSV, backward compatible

**Files:**
- Modify: `js/sheets.js` (`parseCsv` ~204-221, `isHeaderRow` ~289-297, merge in `fetchSpreadsheet` ~133)
- Test: `js/verify.js` (update `parseCsv` group and the categories test's `loup.example` assertion; append a compat group)

**Interfaces:**
- Consumes: `CardExtras.columnKinds`, `fromRow`, `kindForHeader`, `mergeInto`.
- Produces: `SheetsService.parseCsv(text) → Array<{question, answer, extras}>` (no `example` key). `fetchSpreadsheet` cards carry `extras` + `categories`.

- [ ] **Step 1: Update/write the failing tests**

Replace the two `.example` assertions in the `parseCsv` group:
```js
VERIFY.assertEqual('plain CSV → card[1] extras', JSON.stringify(plain[1].extras),
  JSON.stringify([{ kind: 'example', label: 'Example', value: 'exsecond' }]));
VERIFY.assertEqual('missing example column → no extras', noExample[0].extras.length, 0);
```
In the categories test replace `loup.example` with:
```js
VERIFY.assertEqual('duplicate word picks up example', loup.extras[0].value, 'ex');
```
Append (one assertion per row of the spec's compatibility table):
```js
window.TESTS.push(function () {
  VERIFY.group('parseCsv backward compatibility');
  const P = t => SheetsService.parseCsv(t);
  const noHdr = P('chien,dog,ex1,junk\n');
  VERIFY.assertEqual('no header: C = example, D ignored', JSON.stringify(noHdr[0].extras),
    JSON.stringify([{ kind: 'example', label: 'Example', value: 'ex1' }]));
  VERIFY.assertEqual('no header, first word has "a": still dropped (unchanged)', P('chat,cat\nchien,dog\n').length, 1);
  VERIFY.assertEqual('header Exemple: skipped, C example', P('Question,Answer,Exemple\nchien,dog,e\n')[0].extras[0].kind, 'example');
  const phrase = P('Question,Answer,Phrase\nchien,dog,e\n');
  VERIFY.assertEqual('unrecognized C header: example', phrase[0].extras[0].kind, 'example');
  VERIFY.assertEqual('unrecognized C header: label kept', phrase[0].extras[0].label, 'Phrase');
  const newHdr = P('chien,dog,Syllabic,Audio\nBienvenu,tungngasugit,ᑐᙵᓱᒋᑦ,http://x/t.mp3\n');
  VERIFY.assertEqual('C+ kind name makes row a header', newHdr.length, 1);
  VERIFY.assertEqual('syllabic + audio parsed', newHdr[0].extras.map(e => e.kind).join(), 'syllabic,audio');
  VERIFY.assertEqual('short row under header', P('Mot,Traduction,Syllabic,Audio\nchien,dog\n')[0].extras.length, 0);
  VERIFY.assertEqual('D+ text column shown', P('Question,Answer,Exemple,Genre\nchien,dog,e,m\n')[0].extras[1].label, 'Genre');
});
```
Note: the C+ header test uses `chien,dog` in A/B so only the new rule can detect it (the old substring rule would already match e.g. "tungngasugit"). `'Mot,Traduction,…'` is a header via the old rule (`traduction` contains "a") or the new C+ rule — either is fine.

- [ ] **Step 2: Run verify.html** — Expected: the updated/new assertions FAIL.
- [ ] **Step 3: Implement.** `isHeaderRow(row)`: keep the existing body as-is, and OR in `row.slice(2).some(c => CardExtras.kindForHeader(c) !== null)`. `parseCsv`: `header = isHeaderRow(rows[0]) ? rows[0] : null`; `width = max row length`; `columns = CardExtras.columnKinds(header, width)`; each card `{ question, answer, extras: CardExtras.fromRow(row, columns) }`. `fetchSpreadsheet` merge: replace the `example` line with `CardExtras.mergeInto(existing.extras, card.extras)`. Update the `parseCsv` JSDoc.
- [ ] **Step 4: Run verify.html** — Expected: `N passed, 0 failed`.
- [ ] **Step 5: Commit** — `git commit -am "Parse header-typed extra columns from sheets"`

---

### Task 3: Store `extras` on cards

**Files:**
- Modify: `js/storage.js` (`create` ~179-207, `syncCards` ~244-285)
- Test: `js/verify.js` (update the existing syncCards round-trip tests at ~370-420 that pass `example:` to pass `extras:`; append a group)

**Interfaces:**
- Consumes: `CardExtras.forCard`.
- Produces: stored cards have `extras: Array<{kind,label,value}>` and no `example` key once written by the new code. Legacy cards keep `example` until next sync.

- [ ] **Step 1: Write the failing tests**

```js
window.TESTS.push(async function () {
  VERIFY.group('syncCards extras');
  const original = localStorage.getItem('flashcards_cards');
  try {
    const deckId = '__verify_extras__';
    const id = await generateCardId(deckId, 'chien', 'dog');
    localStorage.setItem('flashcards_cards', JSON.stringify([
      { id, deckId, question: 'chien', answer: 'dog', example: 'old', categories: [], isArchived: false }
    ]));
    const extras = [{ kind: 'syllabic', label: 'Syllabic', value: 'ᕿᒻᒥᖅ' }];
    const s = await CardStorage.syncCards(deckId, [{ question: 'chien', answer: 'dog', extras, categories: [] }]);
    const c = CardStorage.getById(id);
    VERIFY.assertEqual('legacy card updated, same id', s.updated, 1);
    VERIFY.assertEqual('extras stored', JSON.stringify(c.extras), JSON.stringify(extras));
    VERIFY.assertEqual('example key removed', 'example' in c, false);
    const s2 = await CardStorage.syncCards(deckId, [{ question: 'chien', answer: 'dog', extras, categories: [] }]);
    VERIFY.assertEqual('unchanged extras → no update', s2.updated, 0);
    await CardStorage.syncCards(deckId, [{ question: 'loup', answer: 'wolf', extras, categories: [] }]);
    const w = CardStorage.getById(await generateCardId(deckId, 'loup', 'wolf'));
    VERIFY.assertEqual('new card gets extras', w.extras[0].value, 'ᕿᒻᒥᖅ');
  } finally {
    if (original === null) localStorage.removeItem('flashcards_cards');
    else localStorage.setItem('flashcards_cards', original);
  }
});
```

- [ ] **Step 2: Run verify.html** — Expected: `syncCards extras` assertions FAIL.
- [ ] **Step 3: Implement.** In `create` and `syncCards`, replace `example` with `extras: data.extras || []`; change detection is `JSON.stringify(CardExtras.forCard(existing)) !== JSON.stringify(data.extras || [])`; on update pass `example: undefined` so the key disappears when serialized. Update the JSDoc `{question, answer, example}` → `{question, answer, extras}`.
- [ ] **Step 4: Run verify.html** — Expected: `N passed, 0 failed`.
- [ ] **Step 5: Commit** — `git commit -am "Store extras on cards instead of example"`

---

### Task 4: Render extras on the answer side

**Files:**
- Modify: `index.html` (fonts link :21, card back :320-330, card detail :465-475, settings help :772), `css/custom.css` (`.font-syllabic`, back-face overflow), `CLAUDE.md` (script order, Sheets import columns paragraph)

**Interfaces:**
- Consumes: `CardExtras.layout(card)`.

- [ ] **Step 1: Font.** Add `&family=Noto+Sans+Canadian+Aboriginal:wght@400;600` to the Google Fonts URL; add `.font-syllabic { font-family: 'Noto Sans Canadian Aboriginal', sans-serif; }`.
- [ ] **Step 2: Card back.** Replace the `example` block with markup driven by `x-data="{ x: CardExtras.layout($store.session.currentCard) }"` (re-evaluate when `currentCard` changes, e.g. key the template on `currentCard.id`):
  - under the answer: each `x.syllabic` value in `text-2xl font-syllabic`; each `x.audio` URL as a 🔊 button with `@click.stop` and local state `{ failed: false, playing: false }`: `play()` does `new Audio(url).play()`; a rejected promise or `error` event sets `failed = true`, which swaps the button for `<a href=url target="_blank" rel="noopener" @click.stop>open link</a>`.
  - below a border: `x.body` as `label` (small uppercase muted) + value (`italic` when `kind === 'example'`, `whitespace-pre-line`).
  - `x.images`: `<img loading="lazy" class="max-h-40 mx-auto rounded">`; `@error` swaps it for a link.
  - the back face scrolls instead of clipping: `.card-face.back { overflow-y: auto; }` with content aligned to the top when it overflows (`justify-content: safe center` or equivalent). The 600 ms flip transition stays as is.
- [ ] **Step 3: Card detail view.** Same extras rendering (syllabic, audio, body, images) under the answer, using `CardExtras.layout(card)`.
- [ ] **Step 4: Settings help.** Replace "Column C is optional — examples appear on the answer side." with: "Optional extra columns, named in the header row: Syllabic, Audio (link), Example, Notes, Image (link). Any other named column is shown as-is. Extras appear on the answer side."
- [ ] **Step 5: CLAUDE.md.** Update the script order and the Sheets import "Columns:" sentence to describe header-typed extras and `card.extras`.
- [ ] **Step 6: Verify.** `verify.html` → `N passed, 0 failed`. Then in the app (Playwright or by hand) seed localStorage with a deck and a card whose `extras` hold syllabic `ᑐᙵᓱᒋᑦ`, audio `https://drive.google.com/file/d/x/view`, example, notes, image; start a session and check:
  - syllabics render as glyphs (not boxes) under the answer;
  - tapping 🔊 doesn't flip the card, and the Drive URL turns into "open link";
  - nothing is clipped on the back (it scrolls), and the flip still animates;
  - a legacy card with only `example` still shows its example;
  - the card detail view shows the same extras.
  Take a screenshot of the card back.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "Show syllabics, audio, notes and images on the answer side"`
