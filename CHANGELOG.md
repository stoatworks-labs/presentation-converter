# Changelog

All notable changes to this project are recorded here. Versions follow
[semantic versioning](https://semver.org/).

## [0.1.2] — 2026-08-03

A security and packaging release. No conversion behaviour changed.

### Fixed

- **`fast-xml-parser` moved to v5**, clearing the XMLBuilder injection advisory.
- **The published tarballs were named 0.1.1.** The first v0.1.2 tag bumped only the root
  `package.json`, and `npm pack` reads each workspace package's own version — so the
  release advertised a version it did not contain. That tag and release were withdrawn.
  Bumping all four workspace packages then exposed the second half of it: `cli` and
  `server` pin their siblings by exact version, so they would have shipped depending on a
  0.1.2 sibling that did not exist.
- **The Nextcloud app was still going out labelled 0.1.1.** The release tars it straight
  from `appinfo/info.xml`, which is a fifth version number nothing else touches.

### Added

- A Download section with direct per-platform links, and `AGENTS.md`.
- A Dependabot config, so version drift stops being invisible.

### Changed

- The README points at the re-filmed tour.

## [0.1.1] — 2026-07-30

A maintenance release. No conversion behaviour changed.

### Added

- **Built-in logging and crash diagnostics.** Structured logging through the vendored
  `diag` module, and `--collect-diagnostics` to gather a run into a single bundle. File
  writes are synchronous on purpose — an async stream loses the crashing run's log. See
  [docs/diagnostics.md](docs/diagnostics.md).
- A walkthrough video, linked from the README.
- Sponsor button configuration (GitHub Sponsors and Liberapay).

### Fixed

- **The v0.1.0 release carried no artefacts.** The workflow built them and then failed to
  attach them, so the release page offered nothing to download. They are attached now.
- Internal workspace version pins are bumped alongside the package versions, so a fresh
  install of the CLI resolves the matching `core` rather than the previous one.

### Changed

- GitHub URLs throughout the docs now point at the `stoatworks-labs` account.

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

[0.1.1]: https://github.com/stoatworks-labs/presentation-converter/releases/tag/v0.1.1
[0.1.0]: https://github.com/stoatworks-labs/presentation-converter/releases/tag/v0.1.0
