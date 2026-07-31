# AGENTS.md — bringing an LLM up to speed on Presentation Converter

Orientation for an AI assistant (or a new human) picking this project up cold.

There **is** a [`CLAUDE.md`](CLAUDE.md) here and it is the detailed reference — commands,
per-file traps, the Canva integration, credential handling. This document is the map you
read first; go to `CLAUDE.md` for the specifics.

---

## 1. What this is

Converts **Keynote, PowerPoint, Google Slides, Canva and OpenDocument** presentations to
PDF — **plus a `.notes.json` presenter-notes sidecar** carrying the speaker notes.

npm-workspaces monorepo (Node/TS) plus a Nextcloud app. Public repo, MIT — except the
Nextcloud app, which is **AGPL, as Nextcloud apps must be**. Current release **v0.1.1**.

## 2. The two ideas that shape everything

**a. Notes extraction is decoupled from PDF rendering.** For Office and ODF formats the
notes are parsed from the source package's own XML, never from the renderer. That is why the
notes are the author's exact text on any platform, and why headless hosts work with no
presentation application installed. Keep it that way.

**b. Slide count ≠ PDF page count.** Exporters silently drop hidden and skipped slides — a
verified case: a 4-slide Keynote deck with one skipped slide exports a 3-page PDF. The PDF is
read back and the mapping reconciled, recorded as `alignment: exact | adjusted | mismatch`. A
`mismatch` is reported rather than quietly emitting notes that are a page out. **Do not
"simplify" `sidecar.ts` to a 1:1 mapping** — that is the whole problem this tool solves.

## 3. Layout

```
packages/core      Engines, notes extraction, sidecar, batch, watch. The library others import.
packages/cli       The `presentation-converter` binary — convert/batch/watch/serve/doctor
packages/server    HTTP API, SSE progress, GUI host, and the macOS worker endpoint
packages/web       Vite/React GUI
nextcloud/presentationconverter   PHP app; shells out to the CLI, or POSTs to a Mac worker
docs/              sidecar-format.md, canva.md, nextcloud.md, diagnostics.md
```

## 4. Commands

```bash
npm run build       # core → web → server → cli, in that order
npm test            # core unit tests (builds first)
npm run typecheck
npm run dev         # GUI + API
node packages/cli/dist/index.js doctor   # which rendering engines this machine actually has
```

`doctor` is the first thing to run when a conversion fails on a new machine — most failures
are a missing engine, not a bug.

## 5. Contracts with other repos

This project sits between two others, and both couplings are easy to break silently:

- **`nc-filedropbatch` / `resolve-configurator`** — not a code dependency, but the same
  event-workflow family.
- **`presentation-commander-client` depends on the sidecar naming contract**: `X.pdf` →
  `X.notes.json`. Changing that filename rule breaks that app, and nothing in this repo's
  tests would notice.

The sidecar format itself is documented in [docs/sidecar-format.md](docs/sidecar-format.md).
Treat it as published.

## 6. Status — what is actually verified

Verified on macOS against real Keynote-authored fixtures: `.key` and `.pptx` conversion,
hidden-slide mapping, batch and tree mirroring, incremental skip, collision detection, watch
folder, GUI, the worker endpoint, and a real Canva PPTX export. Settings and OAuth endpoints
verified for 0600 storage, redaction, forged-`state` rejection, consent-URL parameters and
blank-secret preservation.

**Unverified, and the README says so:**

- The **Nextcloud app has never been run** — written on a machine with neither PHP nor
  Docker, so never executed or even lint-checked.
- The **LibreOffice engine** — LibreOffice was not installed; Office and ODF rendering was
  exercised through Keynote instead.
- **Live OAuth round trips** for Google and Canva — each needs real credentials and a human
  at the consent screen.

Do not let a new build quietly upgrade any of these to "working".

## 7. Traps

The expensive ones are in `CLAUDE.md`; the two worth knowing before you touch anything:

- **fast-xml-parser in `preserveOrder` mode: do NOT set `attributesGroupName`.** It
  double-nests attributes under `:@`, so every attribute lookup silently returns `undefined`
  and you get slides with no notes, titles or hidden flags.
- **The Keynote engine's `maxConcurrency` must stay 1.** It drives a single foreground
  document; two at once exports the wrong file.

## 8. Conventions

- Public repo. "Commit" means commit **and** push.
- Ships the user-facing AI disclaimer in the README.
- Cloud sources are **URLs, not paths** — `formatForSource()` is the entry point for
  anything user-supplied, never `formatForPath()`.

## Diagnostics

Log via `log` (structured) or `say` (console-shaped) from the vendored `diag` module — never
`console`. Anything written to stdout corrupts `--collect-diagnostics`, whose stdout is a
path. File writes are synchronous on purpose: an async stream loses the crashing run's log.
See [docs/diagnostics.md](docs/diagnostics.md).
