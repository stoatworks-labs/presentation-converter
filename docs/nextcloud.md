# The Nextcloud app

`nextcloud/presentationconverter` keeps PDF versions of every presentation in the folders
your users nominate — including all subfolders — and writes a `.notes.json` sidecar
beside each one.

> **Status: written but not yet run against a live Nextcloud server.** The machine this
> was developed on has neither PHP nor Docker, so the PHP has never been executed or even
> lint-checked. The half it depends on — the worker HTTP endpoint — *has* been verified
> end to end with a real Keynote file. Treat the app itself as needing a first shakedown
> on a test instance before you point it at anything that matters.

## How it converts

Nextcloud runs on Linux, and **Keynote cannot run on Linux at all** — there is no
LibreOffice filter for `.key`. So the app has two routes:

- **Locally**, by running the `presentation-converter` CLI on the Nextcloud server, which
  uses headless LibreOffice. Handles `.pptx`, `.ppt`, `.pps`, `.ppsx`, `.pptm`, `.odp`, `.otp`.
- **Remotely**, by POSTing the file to a Mac running `presentation-converter serve`.
  Handles everything, Keynote included.

Configure either, or both. With both, Office files convert on the server and `.key` files
go to the Mac.

Files are streamed through a temporary directory rather than passed by path, because
Nextcloud storage may be object storage or an encrypted mount where a node has no
dependable local path.

## Install

1. Copy the app into your Nextcloud `apps/` (or `custom_apps/`) directory:

   ```bash
   cp -r nextcloud/presentationconverter /var/www/nextcloud/custom_apps/
   ```

2. Enable it:

   ```bash
   sudo -u www-data php occ app:enable presentationconverter
   ```

3. Install the converter itself somewhere the web server user can execute:

   ```bash
   git clone https://github.com/stoatworks-labs/presentation-converter.git /opt/presentation-converter
   cd /opt/presentation-converter && npm install && npm run build
   ```

4. Install LibreOffice for the Office formats:

   ```bash
   sudo apt install libreoffice-impress
   ```

5. In **Settings → Administration → Presentation Converter**, set the CLI path to a small
   wrapper (the CLI is a Node script, so it needs `node`):

   ```bash
   #!/bin/sh
   exec /usr/bin/node /opt/presentation-converter/packages/cli/dist/index.js "$@"
   ```

   Save it as `/usr/local/bin/presentation-converter`, `chmod +x`, and enter that path.
   Press **Test connection** — it should report the converter version and how many PDF
   engines it found.

## Pairing a Mac for Keynote files

On a Mac with Keynote installed:

```bash
presentation-converter serve --allow-remote --token "$(openssl rand -hex 32)"
```

Then in the admin settings set the **macOS worker URL** (e.g. `http://mac-mini.local:4747`)
and the same token.

`--allow-remote` binds to all interfaces. **Always set a token** — without one, anyone who
can reach the port can make that Mac convert arbitrary uploads. Keep it on a trusted
network, and put it behind TLS if it crosses one you don't control.

## Using it

Users open **Presentation Converter** in the app menu and add folder paths relative to
their own files, e.g. `/Events/2026`. Each folder gets converted:

- on a schedule, by a background job every 15 minutes; and
- immediately, via **Convert now**.

A file is only converted when the source is newer than the existing PDF and sidecar, so a
scan over an unchanged tree costs only a directory walk. Removing a folder from the list
stops future conversions; it does not delete PDFs that were already produced.

Background jobs need cron configured — `occ background:job:mode cron` plus the system
crontab entry. With **AJAX** mode, jobs only run when someone is browsing.

### Admin settings

| Setting | Notes |
| --- | --- |
| Run scheduled conversions | master switch for the background job |
| CLI path | executable by the web server user; needs LibreOffice for Office formats |
| macOS worker URL | required for `.key`; optional otherwise |
| Worker token | leave blank to keep the current one |
| Output subfolder | e.g. `PDF` to collect output in a subfolder instead of beside the source |
| Per-file timeout | default 300s; raise for very large decks |

## Notes and limits

- **Timeouts.** LibreOffice is slow on big decks. The per-file timeout applies to each
  file, and a single background run processes folders one after another.
- **Load.** Conversion is CPU-heavy and competes with the web server. Consider a
  dedicated worker rather than converting on the front end for large libraries.
- **Name collisions.** `talk.key` and `talk.pptx` in one folder both want `talk.pdf`. The
  second one is reported as a failure rather than silently overwriting the first — rename
  one, or use an output subfolder per format.
- **Encrypted storage** works, since files are streamed rather than read by path.
