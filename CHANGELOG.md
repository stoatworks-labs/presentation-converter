# Changelog

All notable changes to this project are recorded here. Versions follow
[semantic versioning](https://semver.org/).

## [0.1.0] — 2026-07-29

First release. Converts Keynote, PowerPoint, Google Slides, Canva and OpenDocument
presentations to PDF, and recovers the presenter notes into a `.notes.json` sidecar.

### Core

- **Presenter-notes sidecar.** Every conversion writes `<name>.notes.json` beside the PDF,
  mapping PDF page numbers to note text, with per-slide detail, provenance and the engines
  used. Format documented in [docs/sidecar-format.md](docs/sidecar-format.md).
- **Hidden-slide reconciliation.** Exporters silently drop hidden and skipped slides, so a
  deck's slide count and its PDF's page count routinely disagree — a 4-slide Keynote deck
  with one skipped slide exports 3 pages. The PDF is read back and the mapping reconciled,
  recorded as `alignment: exact | adjusted | mismatch`. A `mismatch` is reported rather
  than quietly emitting notes that are a page out.
- **Notes extraction independent of PDF rendering.** For Office and ODF formats the notes
  are parsed from the source package's XML, never from the renderer, so they are the
  author's exact text on any platform and work headless with no application installed.

### Formats

| Format | PDF rendered by | Notes read from |
| --- | --- | --- |
| `.key` | Keynote (macOS) | Keynote |
| `.pptx` | LibreOffice, or Keynote on macOS | the `.pptx` package (OOXML) |
| `.ppt` | LibreOffice | promoted to `.pptx`, then the package |
| `.odp` | LibreOffice | the `.odp` package (ODF) |
| Google Slides | Drive export | Slides API |
| Canva | PPTX export, rendered locally | the exported `.pptx` (OOXML) |

### Interfaces

- **CLI** — `convert`, `batch`, `watch`, `serve` and `doctor`, all with `--json` and a
  non-zero exit when anything fails.
- **GUI** — individual files, whole folder, watch folder and settings, with live progress
  over server-sent events.
- **Library** — `@presentation-converter/core` for embedding in other apps.
- **Nextcloud app** — keeps PDFs of every presentation in a folder tree up to date, using
  LibreOffice locally and optionally forwarding `.key` files to a paired macOS worker.

### Notable behaviour

- Batches mirror the input folder tree, run incrementally (a repeat over an unchanged
  folder takes milliseconds), and refuse to convert two decks whose outputs would collide
  rather than silently overwriting one with the other.
- Watch folders wait for a file to stop changing before converting, because authoring apps
  write a deck in several passes.
- Cloud presentations are addressed by URL, with output named from the deck's title.
- Credentials are stored in the user config directory at mode `0600`, and are never
  returned to the browser. Environment variables take precedence.

### Known limitations

- The **Nextcloud app has not been run against a live server** — it was written on a
  machine with neither PHP nor Docker, so it has never been executed or lint-checked. See
  [docs/nextcloud.md](docs/nextcloud.md).
- **Live OAuth round trips are unverified** for both Google and Canva; each needs real
  credentials and a human at the consent screen. The endpoints, PKCE generation, credential
  storage and consent URLs are verified.
- The **LibreOffice engine is unverified** — LibreOffice was not installed on the
  development machine, so Office and ODF rendering was exercised through Keynote instead.
- Keynote cannot run on Linux, so a Linux host needs a paired Mac for `.key` files.

[0.1.0]: https://github.com/stoatworks-labs/presentation-converter/releases/tag/v0.1.0
