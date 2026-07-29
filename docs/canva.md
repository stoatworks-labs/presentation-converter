# Canva

Canva presentations convert to PDF **with their speaker notes**, two ways:

1. **Manually** — export from Canva with *Download → PPTX* and convert that file. Works
   with no setup at all.
2. **Directly from a Canva link** — connect a Canva account once, then pass the design URL.

```bash
presentation-converter convert "https://www.canva.com/design/DAFxyz123/edit" -o ~/PDFs
```

## Why it works at all

Canva's Connect API exposes **no speaker-notes field** anywhere — not on
[designs](https://www.canva.dev/docs/connect/api-reference/designs/get-design/), not on
[design pages](https://www.canva.dev/docs/connect/api-reference/designs/get-design-pages/),
and not as an [export](https://www.canva.dev/docs/connect/api-reference/exports/create-design-export-job/)
option. Unlike Google Slides, whose API hands over `slideProperties.notesPage` directly,
Canva notes are reachable *only* inside a PPTX export.

Fortunately Canva's PPTX **does** embed notes in the standard OOXML `ppt/notesSlides/`
parts — verified against a real export, kept as
`packages/core/test/fixtures/canva-export.pptx` — so the existing `package-xml` extractor
reads them unchanged.

## How the engine works

The Canva engine deliberately exports **PPTX only, never PDF**, even though Canva can
produce PDF directly:

1. Export the design as PPTX (async: create job → poll → download).
2. Render *that file* to PDF locally, via LibreOffice or Keynote.
3. Read the notes from the same file.
4. Reconcile slides against PDF pages exactly as every other format does.

Two reasons for taking the PDF from the PPTX rather than asking Canva for one:

- **Half the API calls.** Canva's export quota is roughly 75 per 5 minutes and 500 per day
  per user; two exports per deck would halve the number of decks you can convert.
- **Pages and notes always agree.** Two separate exports could straddle an edit, leaving
  notes describing a deck that the pages no longer match. One artefact cannot.

The downloaded PPTX is cached briefly (5 minutes, keyed by design id) so a single
conversion exports once rather than twice.

## Connecting an account

Optional — only needed for converting from a URL.

1. Create an integration in the [Canva developer portal](https://www.canva.com/developers/integrations)
   with the `design:content:read` and `design:meta:read` scopes.
2. Add the redirect URL shown on the Settings page, e.g.
   `http://127.0.0.1:4747/api/canva/callback`.
3. Paste the client id and secret into **Settings → Canva**, then **Connect**.

Or set the environment variables, which take precedence:

```bash
export PRESENTATION_CONVERTER_CANVA_CLIENT_ID=...
export PRESENTATION_CONVERTER_CANVA_CLIENT_SECRET=...
export PRESENTATION_CONVERTER_CANVA_REFRESH_TOKEN=...
```

### Two things that will bite you if changed

- **Canva mandates PKCE** with SHA-256. A plain code challenge is rejected outright.
- **Canva rotates refresh tokens.** Every refresh returns a *new* token and invalidates the
  old one, so the replacement is written straight back to the settings store. Skip that and
  the integration works exactly once, then locks the account out until someone reconnects
  by hand.

## Limits and caveats

- **No service account.** Canva offers OAuth only, so unattended use — the Nextcloud case —
  means storing a user's refresh token and keeping it rotated. There is no machine identity
  to use instead.
- **No local files.** Canva has no local format, so the watch folder and the Nextcloud
  scanner have nothing to pick up. Canva decks must be named by URL or id.
- **A local pptx renderer is still required.** The engine renders the exported PPTX itself,
  so it needs LibreOffice (any platform) or Keynote (macOS). Without one it fails with that
  explicit message rather than a confusing engine error.
- **Rate limits** — roughly 75 exports per user per 5 minutes, 500 per day.
- **Output naming.** A design id makes a poor filename, so the PDF is named after the
  deck's Canva title where `design:meta:read` allows it (falling back to the id), unless you
  passed an explicit output path.

## Verification status

Verified without a Canva account: PKCE generation (challenge is `base64url(sha256(verifier))`,
fresh per attempt), the authorisation URL's parameters and scopes, design-id parsing from
every URL form, credential storage at mode 0600 with no secret returned to the browser,
forged-`state` rejection, and notes extraction from a real Canva PPTX export.

**Not verified:** the live round trip — OAuth handshake, export job, download and refresh
rotation — which needs a real Canva integration and a human at the consent screen.

## Sources

- [Canva Connect APIs](https://www.canva.dev/docs/connect/)
- [Authentication](https://www.canva.dev/docs/connect/authentication/)
- [Generate an access token](https://www.canva.dev/docs/connect/api-reference/authentication/generate-access-token/)
- [Create design export job](https://www.canva.dev/docs/connect/api-reference/exports/create-design-export-job/)
- [Get design export job](https://www.canva.dev/docs/connect/api-reference/exports/get-design-export-job/)
- [Scopes](https://www.canva.dev/docs/connect/appendix/scopes/)
