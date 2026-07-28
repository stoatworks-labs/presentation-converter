# The notes sidecar format

A converted presentation produces two files:

```
Q3 Review.pdf
Q3 Review.notes.json
```

The sidecar's name is derived from the PDF's by replacing the `.pdf` extension with
`.notes.json`. That derivation is the contract with
[presentation-commander-client](https://github.com/allansargeant/presentation-commander-client),
which computes it the same way — don't change one without the other.

## Schema (version 1)

```jsonc
{
  "schemaVersion": 1,
  "generator": "presentation-converter 0.1.0",
  "convertedAt": "2026-07-28T16:20:24.230Z",

  "source": {
    "file": "Q3 Review.key",     // basename only, never a full path
    "format": "keynote",          // keynote | pptx | ppt | odp | google-slides
    "modifiedAt": "2026-07-28T16:11:54.292Z",
    "sizeBytes": 489786,
    "remoteId": "1AbC…"           // Google Slides only
  },

  "pdf": { "file": "Q3 Review.pdf", "pageCount": 3 },

  "slideCount": 4,                // slides in the SOURCE, hidden ones included
  "engines": { "pdf": "keynote", "notes": "keynote" },
  "alignment": "adjusted",

  "notes": {                      // PDF page number -> note text
    "1": "Thank the sponsors.",
    "3": "Hand over to Alex."
  },

  "slides": [
    { "index": 1, "page": 1,    "title": "Welcome",       "notes": "…", "hidden": false },
    { "index": 3, "page": null, "title": "Hidden Backup", "notes": "…", "hidden": true  },
    { "index": 4, "page": 3,    "title": "Thanks",        "notes": "…", "hidden": false }
  ],

  "warnings": []
}
```

### `notes` vs `slides`

`notes` is what consumers read: **PDF page number → note text**, as string keys, with
empty notes omitted entirely.

`slides` is the full record. Every source slide appears, in source order:

- `index` — 1-based position in the source deck, counting hidden slides
- `page` — 1-based PDF page, or `null` when the slide was not rendered
- `hidden` — whether the deck marks it hidden (`.pptx`) or skipped (Keynote)

A hidden slide keeps its `notes` in `slides` — useful when someone unhides it later — but
contributes nothing to the `notes` map, because it has no page.

## `alignment` — how much to trust the mapping

Exporters drop hidden slides, so slide numbers and page numbers drift apart. This field
records how that was resolved:

| Value | Meaning |
| --- | --- |
| `exact` | slide count equals page count; mapped 1:1 |
| `adjusted` | page count equals the count of *visible* slides; hidden slides skipped and the gaps closed |
| `mismatch` | neither fits — notes mapped positionally and a warning added |

Only `mismatch` is a problem. Treat it as "these notes may be off by a page", and check
`warnings` for the detail. Verified behaviour: a 4-slide Keynote deck with one skipped
slide exports a 3-page PDF and lands on `adjusted`.

## Reading it

Consumers should accept **both** this format and the bare legacy map that
presentation-commander-client wrote before this tool existed:

```json
{ "1": "first note", "2": "second note" }
```

The distinguishing test is a numeric `schemaVersion` plus a `notes` object:

```ts
function notesFrom(parsed: unknown): Record<string, string> {
  const source =
    parsed && typeof parsed === 'object' && 'schemaVersion' in parsed
      ? (parsed as { notes: Record<string, string> }).notes
      : parsed
  // …then keep only numeric keys with string values
}
```

`@presentation-converter/core` exports `notesFromSidecar()`, `readSidecar()` and
`isCurrentSidecar()` which do exactly this.

## Writing it back

If you let users edit notes, **preserve the envelope**. Serialising a bare note map over a
generated sidecar discards the provenance, the per-slide detail and the hidden-slide
mapping. Use `updateSidecarNotes()`, which merges into the existing envelope when there is
one and falls back to the legacy shape when there isn't.

## Compatibility

`schemaVersion` is incremented only for a breaking change to the shape. Additive fields
do not bump it, so readers should ignore unknown keys rather than reject them.
