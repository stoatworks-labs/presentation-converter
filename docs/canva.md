# Canva — feasibility assessment

**Short answer: PDF export is easy. Presenter notes are the problem, and notes are the
point of this tool.** Canva support is not implemented; this records what was checked and
what it would take.

Assessed July 2026 against the official [Canva Connect API
docs](https://www.canva.dev/docs/connect/).

## What the Connect API gives us

Canva's Connect API is a proper REST API with OAuth 2.0, and it can export a design:

- [Create design export job](https://www.canva.dev/docs/connect/api-reference/exports/create-design-export-job/)
  supports **PDF**, **PPTX**, PNG, JPG, GIF, MP4, CSV and HTML.
- Export is **asynchronous**: create a job, poll it, then download from the returned URL.
- PDF export takes a paper size and quality; PPTX export takes page selection only.

So producing the PDF half of our output is straightforward.

## Why notes are the problem

**No Connect API endpoint exposes speaker notes.** Checked directly:

| Endpoint | Returns | Notes? |
| --- | --- | --- |
| [Get design](https://www.canva.dev/docs/connect/api-reference/designs/get-design/) | design metadata, thumbnail, URLs | no |
| [Get design pages](https://www.canva.dev/docs/connect/api-reference/designs/get-design-pages/) | page number, dimensions, thumbnail | no |
| [Create export job](https://www.canva.dev/docs/connect/api-reference/exports/create-design-export-job/) | export formats and options | no notes option |

There is no "get notes" endpoint, no notes field on a page, and no export option that
includes notes. This is the opposite of Google Slides, whose API exposes
`slideProperties.notesPage` directly.

That leaves exactly one plausible route.

### The one plausible route: export PPTX and parse it

If Canva's PPTX export embeds speaker notes in the OOXML `notesSlide` parts, then
**the existing `package-xml` notes engine reads them with no new parsing code at all** —
this tool already extracts notes from `.pptx` that way, and it would be format-identical.

The pipeline would be:

1. `POST` an export job for **PDF** → the pages.
2. `POST` an export job for **PPTX** → the notes.
3. Parse the PPTX with the existing OOXML extractor.
4. Reconcile against the PDF page count exactly as every other format does.

**This hinges on an unverified assumption.** Third-party reports conflict on whether
Canva's PPTX export carries speaker notes — some testers say notes came through, and there
is a cottage industry of "how to get your Canva speaker notes out" guides and manual
workarounds, which is not what you would expect if it simply worked. It could not be
tested here: it needs a Canva account and a registered integration.

**Anyone can settle this in five minutes without writing any code:** open a Canva
presentation that has speaker notes, `Share → Download → PPTX`, then run

```bash
presentation-converter convert downloaded.pptx --pdf-engine libreoffice
```

and look at the resulting sidecar. If `notes` is populated, Canva support is a small,
well-understood job. If it is empty, the notes are not in the file and the API route is a
dead end.

## Other things that would need handling

- **Auth.** OAuth 2.0 with PKCE, and an integration registered in Canva's developer
  portal. Canva has **no service-account equivalent**, so unattended use — the Nextcloud
  case — means storing a user refresh token and refreshing it. The `SettingsStore` already
  has a `canva` slot shaped for this.
- **Async exports.** Unlike Drive's synchronous export, Canva needs create-then-poll, so
  the `PdfEngine.render` contract would need to tolerate a polling loop (it can — it is
  already async and takes an `AbortSignal`).
- **Two exports per deck.** PDF and PPTX are separate jobs, which doubles the cost against
  the rate limits below and roughly doubles conversion time.
- **Rate limits.** Around 75 exports per user per 5 minutes and 500 per user per day. At
  two exports per deck that is ~250 decks/day per user — fine for events, tight for a bulk
  library migration.
- **No local files.** Canva has no local file format, so there is nothing for the watch
  folder or the Nextcloud scanner to pick up. Canva decks would have to be addressed by
  URL or id, or enumerated from a Canva folder — a different interaction model from every
  other format here.

## Recommendation

Worth doing **only if the PPTX-notes test above passes.** If it does, budget roughly the
size of the Google Slides engine plus the async-export handling, and it slots into the
existing architecture cleanly.

If it fails, Canva can still be supported as **PDF-only, with no notes** — honest and
useful for some workflows, but it would be the only format here that silently gives up the
thing the tool exists for, so it should be labelled clearly in the UI rather than quietly
producing empty sidecars.

## Sources

- [Canva Connect APIs](https://www.canva.dev/docs/connect/)
- [Create design export job](https://www.canva.dev/docs/connect/api-reference/exports/create-design-export-job/)
- [Get design pages](https://www.canva.dev/docs/connect/api-reference/designs/get-design-pages/)
- [Designs endpoints](https://www.canva.dev/docs/connect/api-reference/designs/)
