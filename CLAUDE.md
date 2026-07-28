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

## Verification status
Verified on macOS against real Keynote-authored fixtures: `.key`/`.pptx` conversion,
hidden-slide mapping, batch + tree mirroring, incremental skip, collision detection, GUI,
worker endpoint. **Unverified:** the Nextcloud app (no PHP/Docker on this machine — never
run or lint-checked), the LibreOffice engine (not installed), Google Slides (no creds).

## Notes
- "Commit" = commit **and** push.
- Ships the user-facing AI disclaimer in the README.
