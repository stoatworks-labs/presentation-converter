# Notes

Working notes for this repo: status, decisions, and the traps that have actually bitten.
Migrated out of Claude Code's memory on 2026-08-24, so they are written in the first
person and dated by when each thing was learned — that date is usually the useful part.

Cross-cutting notes that are not specific to this repo live in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).

*presentation-converter — Keynote/PowerPoint/Slides/ODP → PDF + .notes.json presenter-notes sidecar; GUI + CLI + Nextcloud app*

**presentation-converter** — converts presentations to PDF *and* preserves the presenter
notes in a `.notes.json` sidecar. `~/Projects/presentation-converter`, GitHub **PUBLIC**
(github.com/allansargeant/presentation-converter), MIT (the Nextcloud app is AGPL).
Built 2026-07-28.

npm-workspaces monorepo: `packages/core` (engines, notes extraction, sidecar, batch,
watch) · `packages/cli` (convert/batch/watch/serve/doctor, all `--json`) ·
`packages/server` (HTTP API, SSE, GUI host, **macOS worker endpoint**) · `packages/web`
(React GUI) · `nextcloud/presentationconverter` (PHP app, background job).

Key design points worth remembering:
- **Notes extraction is decoupled from PDF rendering** — Office/ODF notes are parsed from
  the source package XML, not from the renderer, so text is exact and it works headless.
- **Slide count ≠ PDF page count**: exporters drop hidden/skipped slides (verified — a
  4-slide Keynote deck with one skipped slide gives a 3-page PDF). The sidecar reconciles
  and records `alignment: exact|adjusted|mismatch`.
- **PowerPoint has no scriptable save-as** in its modern AppleScript dictionary; Keynote
  imports `.pptx` instead and covers macOS-without-LibreOffice.
- Sidecar naming `X.pdf` → `X.notes.json` is a contract with
  `presentation-commander-client`, which was updated to read both the new envelope and
  the old bare `{"1":"note"}` map — see **presentation commander**.

Verified on macOS against real Keynote-authored fixtures (conversion, hidden-slide
mapping, batch/tree mirroring, incremental skip, collision detection, GUI, watch folder,
worker endpoint). **Unverified: the Nextcloud app** — this Mac has neither PHP nor Docker,
so it has never been run or lint-checked.
