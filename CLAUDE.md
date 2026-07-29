# presentation-converter

Converts Keynote/PowerPoint/Google Slides/ODP presentations to PDF **plus a
`.notes.json` presenter-notes sidecar**. npm-workspaces monorepo (Node/TS) + a
Nextcloud app. Public repo, MIT (the Nextcloud app is AGPL, as Nextcloud apps must be).

## Commands
- Build: `npm run build` (core → web → server → cli)
- Test: `npm test` (core unit tests; builds first)
- Typecheck: `npm run typecheck`
- Run GUI + API: `npm run dev`, or `node packages/cli/dist/index.js serve`
- Engine check: `node packages/cli/dist/index.js doctor`

## Layout
- `packages/core` — engines, notes extraction, sidecar, batch, watch. The library other apps import.
- `packages/cli` — the `presentation-converter` binary (`convert`/`batch`/`watch`/`serve`/`doctor`)
- `packages/server` — HTTP API, SSE progress, GUI host, **and the macOS worker endpoint**
- `packages/web` — Vite/React GUI
- `nextcloud/presentationconverter` — PHP app; shells out to the CLI, or POSTs to a Mac worker

## Non-obvious things that matter
- **Notes extraction is decoupled from PDF rendering.** Office/ODF notes are parsed from
  the source package XML, never from the renderer. Keep it that way — it's why notes are
  exact and why headless hosts work.
- **Slide count ≠ PDF page count.** Exporters drop hidden/skipped slides (verified: a
  4-slide Keynote deck with one skipped slide → 3-page PDF). `sidecar.ts` reconciles this
  and records `alignment: exact | adjusted | mismatch`. Don't "simplify" it to 1:1.
- **fast-xml-parser in `preserveOrder` mode: do NOT set `attributesGroupName`.** It
  double-nests attributes under `:@`, so every attribute lookup silently returns undefined
  and you get slides with no notes, titles or hidden flags. Cost an hour once.
- Order-preserving XML parsing is deliberate: `<a:br>` line breaks interleave with text
  runs, and a name-keyed parse reorders them.
- **Keynote engine `maxConcurrency` must stay 1** — it drives a single foreground
  document; two at once exports the wrong file.
- LibreOffice needs a private `-env:UserInstallation` profile per invocation or parallel
  runs fail intermittently.
- PowerPoint's modern AppleScript dictionary has **no scriptable save-as**, only a
  `default save format` property. Don't try to build a PowerPoint engine — Keynote imports
  `.pptx` and covers macOS-without-LibreOffice.
- Sidecar naming (`X.pdf` → `X.notes.json`) is a contract with
  `presentation-commander-client`; changing it breaks that app.

## Settings & credentials
- `core/settings.ts` stores cloud credentials at the OS config dir, mode **0600**. The
  store is provider-keyed (`google`, `canva`) so a new provider is an additive change.
- **Env vars beat the settings file.** An operator setting
  `GOOGLE_APPLICATION_CREDENTIALS` must not be silently overridden by a stale config.
- `/api/google/callback` is exempt from the bearer-token middleware — Google redirects a
  *browser* there, which cannot send an Authorization header. It is guarded by a
  single-use `state` instead. Don't "tidy" that exemption away.
- OAuth needs `access_type=offline` **and** `prompt=consent`; without the forced consent
  Google returns no refresh token and unattended conversion dies after an hour.
- Secrets are never returned to the browser — only `…Set: boolean`. A blank secret field
  means "keep the stored one", so the GUI can avoid echoing it.

## Canva
Implemented, both routes: a manual *Download → PPTX* export (no setup), and the Connect API
(convert from a Canva URL). See `docs/canva.md`.

- The engine exports **PPTX, never PDF**, and renders it locally. Canva's API has no notes
  field, so a PPTX is needed regardless; one artefact halves the API cost and guarantees
  notes and pages match. Don't "optimise" this into a direct PDF export.
- **Canva mandates PKCE/S256**, and **rotates refresh tokens** — each refresh invalidates
  the old one, so the replacement is persisted immediately. Miss that and the integration
  works exactly once.
- **No service account exists** for Canva, so headless use needs a stored user token.
- `packages/core/test/fixtures/canva-export.pptx` is a real export — don't delete it; it's
  what stops a refactor silently losing Canva notes.
- **Canva writes no `<p:ph>` placeholders at all.** `titleOf()` falls back to the slide's
  first line of text, but only when a deck uses no placeholders anywhere — where
  placeholders exist and none is a title, the author genuinely has no title and guessing
  from body text would be worse.

## Cloud sources are URLs, not paths
`formatForSource()` (not `formatForPath()`) is the entry point for anything user-supplied.
Extension matching alone returns undefined for a Google/Canva URL, which silently rejected
them as "not a presentation" — that was a real shipped bug. Related: remote formats can't
be incremental (no local mtime), never appear in folder scans or watch folders, and get
their output named from the deck title via `PdfRenderResult.suggestedName`.

## Verification status
Verified on macOS against real Keynote-authored fixtures: `.key`/`.pptx` conversion,
hidden-slide mapping, batch + tree mirroring, incremental skip, collision detection, watch
folder, GUI, worker endpoint, and a real Canva PPTX export. Settings/OAuth endpoints verified: 0600 storage, redaction,
forged-`state` rejection, consent-URL parameters, blank-secret preservation.
**Unverified:** the Nextcloud app (no PHP/Docker on this machine — never run or
lint-checked), the LibreOffice engine (not installed), and a real Google OAuth round trip
or Slides conversion (needs real credentials + a human at the consent screen).

## Notes
- "Commit" = commit **and** push.
- Ships the user-facing AI disclaimer in the README.
