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
- ~~**PowerPoint has no scriptable save-as** in its modern AppleScript dictionary; Keynote
  imports `.pptx` instead and covers macOS-without-LibreOffice.~~ Wrong, at least by
  PowerPoint 16.112.3: `save … as save as PDF` works, and there is a PowerPoint engine now.
  See 2026-10-20 below.
- Sidecar naming `X.pdf` → `X.notes.json` is a contract with
  `presentation-commander-client`, which was updated to read both the new envelope and
  the old bare `{"1":"note"}` map — see **presentation commander**.

Verified on macOS against real Keynote-authored fixtures (conversion, hidden-slide
mapping, batch/tree mirroring, incremental skip, collision detection, GUI, watch folder,
worker endpoint). **Unverified: the Nextcloud app** — this Mac has neither PHP nor Docker,
so it has never been run or lint-checked.

## Two Keynotes, and a PowerPoint engine (2026-10-20)

The Mac: macOS 26.4.1 (25E253), no LibreOffice, and installed side by side:

| App | Path | Bundle id |
| --- | --- | --- |
| Keynote 14.5 | `/Applications/Keynote.app` | `com.apple.iWork.Keynote` |
| Keynote Creator Studio 15.3.1 | `/Applications/Keynote Creator Studio.app` | `com.apple.Keynote` |
| Microsoft PowerPoint 16.112.3 | `/Applications/Microsoft PowerPoint.app` | `com.microsoft.Powerpoint` |

**What went wrong first.** Another session, building LivePremier Plus's PDF import that
morning, drove Keynote the way this engine does and got nowhere:

- `Application('com.apple.iWork.Keynote')` lost its connection, **-609**, with Creator Studio
  running. A second try launched Keynote 14.5, which sat on a modal — *Use the New Version
  of Keynote: Keynote 14.5 is out of date and can be deleted* — until the script was killed.
  Nothing gets through while that modal is up.
- Creator Studio addressed as `com.apple.Keynote`, from AppleScript, opened the `.pptx` (two
  windows) and then answered **-1728** "Can't get every document" and **-1700** "Can't make
  unmerge id … into type specifier".

**What I found.**

- The engine as shipped in v0.2.3 converted the Canva fixture first time. It asked for
  `Application('Keynote')` by name, and Launch Services resolved that name to Creator Studio
  (`path to application "Keynote"` → `/Applications/Keynote Creator Studio.app/`). With two
  apps called Keynote that's a coin toss, so the engine now picks by bundle id: Creator
  Studio when it's installed, the iWork Keynote only when it isn't. `doctor` names the one.
- **Creator Studio can be driven.** JXA `open(Path(p))` returns the document, from cold and
  with Keynote already running; `open` followed by `documents[0]` works as well. One oddity:
  on a cold launch, `String()` of the returned specifier throws -1700 "Can't convert types",
  though the specifier itself works. Don't log it.
- **AppleScript fails when the `POSIX file` is inside the `tell` block.** `tell application
  id "com.apple.Keynote" to open (POSIX file p)` gets an alert in Keynote — *"a.pptx" can't be
  imported. The file couldn't be opened.* — and `open` returns missing value, so the next line
  is **-1700** "Can't make missing value into type specifier", or **-1719** "Can't get
  document 1. Invalid index." if you went for `front document`. Write `set f to POSIX file p`
  before the `tell` and the same script works, `open` and `front document` alike. Creator
  Studio is sandboxed; my reading is that a reference the app resolves itself arrives without
  the sandbox extension a reference made by the script carries. That, and the next point, are
  my best guess at the earlier session's errors; I didn't get "unmerge id" myself.
- **-1728 "Can't get every document"** (and "Message not understood" for `count of
  documents`) is what Creator Studio says while a document is being saved or renamed. I got it
  right after editing an imported `.pptx`: autosave moved the untitled import into iCloud Drive
  as `~/Library/Mobile Documents/com~apple~Keynote/Documents/<name>.key`, and for a moment
  there were no documents to get. It cleared by itself. The engine never edits a deck, so it
  never sets this off; a script that does should save the document somewhere first. (I put the
  test file in the Bin.)
- Opening the same `.pptx` twice imports it twice (`deck`, then `deck 2`). Opening a `.key`
  that's already open hands back the open one, same id. The check for "was this already open?"
  now compares document ids. The old one compared `deck` with `deck.pptx`, and only got the
  right answer by never matching.
- **A damaged deck** (5 KB of `/dev/urandom` called `.pptx`): Keynote puts up an alert, *can't
  be opened right now. The file format is invalid.*, and `open` returns null — once after about
  60 s, once straight away. The engine now says the deck may be damaged instead of "null is not
  an object". The alert stays up; the next conversion took 28 s instead of 2, and worked.
- Not tried: Keynote 14.5 on a Mac *without* Creator Studio. I assume the modal needs a newer
  Keynote to point at, but I didn't uninstall anything to find out.

**The PowerPoint engine.** `save thePres in f as save as PDF` works on 16.112.3. The method
came from LivePremier Plus (`plugins/bg-slicer/convert.js`), where it was worked out the same
day:

- Copy the deck into PowerPoint's sandbox container,
  `~/Library/Containers/com.microsoft.Powerpoint/Data/tmp/`, under a name nothing else has.
  Ask a sandboxed PowerPoint to save anywhere else and it stops to ask for the folder ("Grant
  File Access").
- Find it with `presentation docName`, never `active presentation`, which is whatever the
  user last clicked.
- Close it `saving no`, and quit PowerPoint only if it wasn't running before — and, my
  addition, only if nothing else is open in it.

PowerPoint's PDF leaves hidden slides out: the five-slide fixture with slide 3 hidden
(`keynote-hidden-slide.pptx`, made in Creator Studio) came back as four pages with slide 4 on
page 3, alignment `adjusted`. Keynote does the same with it, and with the `.key` it came
from. PowerPoint goes ahead of Keynote and behind LibreOffice: it draws the deck in the
deck's own fonts (the Canva fixture came out in Canva's embedded font, where Keynote
substituted Helvetica), but it can't run headless or two at a time.

A `.ppt` (made with PowerPoint's `save as presentation`) renders too, hidden slide and all,
but its notes still go through LibreOffice's promote-to-`.pptx`, so without LibreOffice it
converts only with `--no-sidecar`. PowerPoint has `save as Open XML presentation`, which could
do that promotion instead; not built.

Verified only with PowerPoint already running: Allan had a deck open in it, which was left
alone throughout. Starting PowerPoint from cold, and the first-run Automation prompt, aren't
verified; the terminal I ran from already had permission. Warm, PowerPoint takes about a second
a deck. Keynote takes about ten seconds to start from cold, then about two a deck.

`PRESENTATION_CONVERTER_LIVE_APPS=1 npm test` drives both apps against the hidden-slide
fixture. It's off by default because it launches them.
