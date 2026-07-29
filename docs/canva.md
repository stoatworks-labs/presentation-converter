# Canva

**Canva presentations convert today, notes included — via a manual PPTX export.**
Automating the download through Canva's Connect API is the remaining work, and is now a
well-understood job rather than a gamble.

Assessed July 2026 against the official [Canva Connect API docs](https://www.canva.dev/docs/connect/)
and **verified against a real Canva PPTX export**.

## What works right now, with no new code

Canva's *Download → PPTX* export embeds speaker notes in the standard OOXML
`ppt/notesSlides/` parts, so this tool's existing `package-xml` notes engine reads them
unchanged:

```bash
presentation-converter convert "This is a slide.pptx"
```

```jsonc
{
  "slideCount": 1,
  "engines": { "pdf": "keynote", "notes": "ooxml" },
  "alignment": "exact",
  "notes": { "1": "this is a note" }
}
```

Verified on a real export (`packages/core/test/fixtures/canva-export.pptx`, covered by
`test/ooxml.test.ts`). This was the open question in the original assessment, and the
answer is **yes — Canva's PPTX carries the notes.**

### One quirk worth knowing

Canva writes slides as plain shapes with **no `<p:ph>` placeholders at all**. Every other
exporter marks its title with a `title`/`ctrTitle` placeholder, so titles came back empty
for Canva decks until the extractor learned to fall back to the slide's first line of text
when a deck uses no placeholders anywhere. Notes were never affected — only the
cosmetic `title` field.

## What the Connect API would add

Automation: converting straight from a Canva URL or a Canva folder, instead of downloading
by hand first.

[Create design export job](https://www.canva.dev/docs/connect/api-reference/exports/create-design-export-job/)
supports **PDF** and **PPTX** (plus PNG, JPG, GIF, MP4, CSV, HTML). So a Canva engine would:

1. `POST` an export job for **PPTX** → notes, via the existing OOXML extractor.
2. Either export **PDF** separately for the pages, or render the PPTX locally.
3. Reconcile against the PDF page count exactly as every other format does.

### Why no notes come from the API itself

Checked directly — no endpoint exposes speaker notes:

| Endpoint | Returns | Notes? |
| --- | --- | --- |
| [Get design](https://www.canva.dev/docs/connect/api-reference/designs/get-design/) | design metadata, thumbnail, URLs | no |
| [Get design pages](https://www.canva.dev/docs/connect/api-reference/designs/get-design-pages/) | page number, dimensions, thumbnail | no |
| [Create export job](https://www.canva.dev/docs/connect/api-reference/exports/create-design-export-job/) | export formats and options | no notes option |

Unlike Google Slides, whose API hands over `slideProperties.notesPage` directly, Canva
notes are reachable *only* through the PPTX file. That is fine — it is the route that
works — but it means a Canva engine must always fetch PPTX, never PDF alone.

## What implementing it involves

- **Auth.** OAuth 2.0 with PKCE, and an integration registered in Canva's developer portal.
  Canva has **no service-account equivalent**, so unattended use — the Nextcloud case —
  means storing a user refresh token and refreshing it. The `SettingsStore` already has a
  `canva` slot shaped for this.
- **Async exports.** Unlike Drive's synchronous export, Canva needs create-then-poll. The
  `PdfEngine.render` contract already tolerates this (it is async and takes an
  `AbortSignal`).
- **Two exports per deck**, if PDF comes from Canva too — doubling cost against the rate
  limits below. Rendering the PPTX locally with LibreOffice instead halves the API cost and
  guarantees the PDF and the notes come from the same artefact, which makes the page
  mapping more trustworthy. Probably the better design.
- **Rate limits.** Roughly 75 exports per user per 5 minutes and 500 per day.
- **No local files.** Canva has no local format, so the watch folder and the Nextcloud
  scanner have nothing to pick up. Canva decks must be addressed by URL/id or enumerated
  from a Canva folder — a different interaction model from every other format here.

## Recommendation

Worth doing. The risk that killed the original assessment is gone: notes demonstrably
survive the PPTX export, and the parsing side is already built and tested.

Suggested shape: a `canva` engine that exports **PPTX only**, renders the PDF locally via
LibreOffice, and reuses `package-xml` for notes — one API call per deck, one artefact, and
notes and pages guaranteed to agree.

## Sources

- [Canva Connect APIs](https://www.canva.dev/docs/connect/)
- [Create design export job](https://www.canva.dev/docs/connect/api-reference/exports/create-design-export-job/)
- [Get design pages](https://www.canva.dev/docs/connect/api-reference/designs/get-design-pages/)
- [Designs endpoints](https://www.canva.dev/docs/connect/api-reference/designs/)
