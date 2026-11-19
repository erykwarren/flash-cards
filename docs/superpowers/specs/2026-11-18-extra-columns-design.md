# Extra card columns (syllabics, audio, image, notes, example)

## Intent

Vocab decks for learning Inuktitut have more to show than question → answer:
the word in syllabics and a pronunciation recording, plus examples, notes and
sometimes an image. Example row:

| Français | Inuktitut | Syllabic | Audio |
|---|---|---|---|
| Bienvenu | tungngasugit | ᑐᙵᓱᒋᑦ | https://…/tungngasugit.mp3 |

Every extra shows up **only with the answer**. The question side doesn't change.

## Goals / non-goals

- Goal: column A = question and column B = answer, as today. Columns C and
  later can come in any order, and each one's kind comes from its header.
- Goal: existing sheets keep working. In a tab with no header row, column C
  is the example, as it is today.
- Non-goal: the reverse direction (syllabics → French) and reading drills.
  Cards stay one-directional.
- Anti-goal: syllabics showing as empty boxes, or an audio link that fails
  without any sign. Both would defeat the purpose.

## Approaches

1. **Header names (chosen).** The header row names the columns. Known names
   map to a kind, and unknown headers show as labeled text. Columns can be in
   any order, the sheets stay readable, and new kinds need no code.
2. Guess from the content (file extension). Rejected: it can't tell notes from
   examples and misreads links without an extension (Drive and others).
3. Fixed positions (C = example, D = notes, …). Rejected: too rigid, and every
   new kind needs another slot.

## Design

**Kinds and header names.** Matching ignores case, accents and surrounding
whitespace.

| Kind | Headers | Shown as |
|---|---|---|
| `syllabic` | syllabaire, syllabaires, syllabic, syllabics, syllabique, syllabiques, ᖃᓂᐅᔮᖅᐸᐃᑦ | large text right under the answer |
| `audio` | audio, son, sound, pronunciation, prononciation | 🔊 play button next to the syllabics/answer |
| `example` | example, examples, exemple, exemples | labeled, italic (as today) |
| `notes` | notes, note, remarque, remarques | labeled text |
| `image` | image, img, picture, photo | image at the bottom |
| `text` | any other non-empty header | labeled text, label = header |

Columns D and later with an empty header are ignored. **Column C keeps its
current meaning unless its header is recognized**: if its header is empty or
unrecognized, it's still `example`. In a tab without headers, column C is
`example` and every later column is ignored, exactly as today.

**Header detection (backward compatible).** The existing `isHeaderRow` rule
(substring keyword match on A/B) stays **unchanged**. The only addition: the
first row is also a header if any cell in column C or later exactly matches a
known kind name. So a row that's skipped today is still skipped, and a row
that's kept today is only skipped now if it has a cell that is exactly
"audio", "notes", "syllabic", etc., which means it's a real header. The
known "a"-substring bug stays as it is. Fixing it would change which rows
are skipped in existing sheets, so it's out of scope here.

**Backward compatibility, case by case:**

| Existing sheet | Today | After |
|---|---|---|
| No header, A/B/C | C = example | same |
| No header, first word contains "a"/"q" | first row dropped (bug) | same (unchanged) |
| Header row, C = "Exemple"/"Example" | header skipped, C = example | same |
| Header row, C = something else ("Phrase") | C = example | same (unrecognized C → example) |
| Columns D+ present | ignored | **shown on the answer side** if their header is recognized or non-empty |
| Stored cards with `example` | — | shown via the legacy fallback until the next sync rewrites them; IDs and review history unchanged |

The one visible change is the last-but-one row: a sheet that already has
labeled columns D and later (helper/scratch columns) would start showing
them.

**Card data.** `example` is replaced by `extras: [{ kind, label, value }]` in
column order. `label` is the original header text, falling back to the kind's
display name. Empty values are dropped. Card IDs don't change: they're still
the hash of (deck, question, answer), so review history is kept. `syncCards`
and `create` detect changes by comparing extras as JSON instead of comparing
`example`. When the same word appears in several tabs, the merge adds
entries from the other tabs whose `kind+label` the card doesn't have yet,
just as `example` is filled in today when missing. Cards stored with only
`example` are rewritten on the next sync. Until then, the display treats a
legacy `example` as one `example` extra.

**Display.** This applies to both the study card back and the card detail
view in stats:

```
         tungngasugit
           ᑐᙵᓱᒋᑦ         🔊
  ─────────────────────────
  Exemple  …
  Notes    …
  [image]
```

- Syllabics are rendered in *Noto Sans Canadian Aboriginal*, added to the
  existing Google Fonts link.
- Audio: tapping 🔊 plays the URL with an `Audio` element and doesn't flip the
  card (`@click.stop`). No autoplay. If playback fails (Drive links, a CORS or
  format error), the button turns into an "open link" anchor in a new tab.
- Image: `<img loading="lazy">` with a capped height. If it fails to load, it
  becomes a link.
- The card back has to fit the extra content without cutting anything off or
  breaking the 600 ms flip.

**Also updated:** the Settings help text (currently "Column C is
optional…"), the `verify.js` cases (header mapping, headerless fallback,
unknown headers, extras round-trip through `syncCards`, the multi-tab merge,
and each row of the backward-compatibility table as a regression test) and
the Sheets section of CLAUDE.md.

## Left to the builder

- How the card back fits more content (scroll inside the face vs. a taller
  card), within the constraint above.
- How the 🔊 control looks and its loading/playing state.

## Calls I made (to check)

- No autoplay on reveal.
- Header detection keeps today's rule (plus C+ kind names) for backward
  compatibility. The "a"-substring bug is not fixed here.
- Labeled columns D and later in existing sheets will start to show.
- `js/google.js` (not loaded by `index.html`) isn't touched.
