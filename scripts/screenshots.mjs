#!/usr/bin/env node
/**
 * Captures the README screenshots from the real running app.
 *
 * Drives headless Chrome over the DevTools Protocol using Node's built-in
 * WebSocket — no Puppeteer, so this adds no dependency to the project for
 * something that runs a handful of times a release.
 *
 * The screenshots are of the genuine UI against a real conversion, not mockups:
 *
 *   1. start the server and convert a demo folder (done by the caller)
 *   2. seed the UI's saved state so the form shows realistic paths
 *   3. screenshot each tab at 2x for a crisp image on high-density displays
 *
 * Usage:
 *   node scripts/screenshots.mjs --url http://127.0.0.1:4747 \
 *     --out docs/screenshots --input "/decks" --output "/pdfs"
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index !== -1 ? process.argv[index + 1] : fallback
}

const BASE_URL = arg('url', 'http://127.0.0.1:4747').replace(/\/$/, '')
const OUT_DIR = arg('out', 'docs/screenshots')
const INPUT_DIR = arg('input', '/Volumes/Show/Incoming')
const OUTPUT_DIR = arg('output', '/Volumes/Show/PDFs')
const PORT = Number(arg('debug-port', '9333'))

const VIEWPORT = { width: 1180, height: 900, scale: 2 }

/**
 * Views to capture.
 *
 * `until` is evaluated in the page and returns how tall the image should be.
 * Measuring beats hard-coded heights: the panels change size as the UI evolves,
 * and a fixed height silently starts clipping a panel mid-sentence or leaving a
 * band of empty background.
 */
const PANEL_BOTTOM = (index) =>
  `(() => {
     const panels = [...document.querySelectorAll('.panel')]
     const panel = panels[${index}] ?? panels[panels.length - 1]
     return panel ? Math.ceil(panel.getBoundingClientRect().bottom + 12) : 900
   })()`

const SHOTS = [
  // Form, results and the engine grid — the whole story on one page.
  { hash: '#folder', name: 'convert-folder.png', until: PANEL_BOTTOM(2) },
  // Google and Canva only. Deliberately stops before the Storage panel, which
  // shows an absolute config path containing the local username.
  { hash: '#settings', name: 'settings.png', until: PANEL_BOTTOM(1) },
  // Just the watch form; the results below it are already shown above.
  { hash: '#watch', name: 'watch-folder.png', until: PANEL_BOTTOM(0) }
]

/** Tall enough to render everything before measuring; the shot is clipped after. */
const MEASURE_HEIGHT = 2400

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function findChrome() {
  const { access } = await import('node:fs/promises')
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next one.
    }
  }
  throw new Error(`No Chrome or Chromium found. Looked in:\n  ${CHROME_CANDIDATES.join('\n  ')}`)
}

/** Minimal CDP client over the debugger WebSocket. */
class Cdp {
  #ws
  #nextId = 1
  #pending = new Map()

  static async attach(wsUrl) {
    const client = new Cdp()
    client.#ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      client.#ws.addEventListener('open', resolve, { once: true })
      client.#ws.addEventListener('error', () => reject(new Error('CDP connection failed')), {
        once: true
      })
    })
    client.#ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const pending = client.#pending.get(message.id)
      if (!pending) return
      client.#pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    return client
  }

  send(method, params = {}) {
    const id = this.#nextId++
    this.#ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }))
  }

  close() {
    this.#ws.close()
  }
}

async function main() {
  const chrome = await findChrome()
  const profile = await mkdtemp(join(tmpdir(), 'presentation-converter-shots-'))
  await mkdir(OUT_DIR, { recursive: true })

  const child = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      // Dark is the app's more distinctive look, and matches the fleet's other
      // READMEs.
      '--force-dark-mode',
      '--enable-features=WebContentsForceDark',
      'about:blank'
    ],
    { stdio: 'ignore' }
  )

  let cdp
  try {
    // Wait for the debugger to come up.
    let target
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
        const targets = await response.json()
        target = targets.find((entry) => entry.type === 'page')
        if (target) break
      } catch {
        // Not listening yet.
      }
      await sleep(250)
    }
    if (!target) throw new Error('Chrome did not expose a debuggable page')

    cdp = await Cdp.attach(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: VIEWPORT.scale,
      mobile: false
    })

    // Seed the saved UI state so the form shows realistic paths rather than
    // empty placeholders.
    await cdp.send('Page.navigate', { url: BASE_URL })
    await sleep(1200)
    await cdp.send('Runtime.evaluate', {
      expression: `localStorage.setItem('presentation-converter:ui', ${JSON.stringify(
        JSON.stringify({
          inputDir: INPUT_DIR,
          outputDir: OUTPUT_DIR,
          recursive: true,
          preserveTree: true,
          force: false,
          writeSidecar: true
        })
      )})`
    })

    let index = 0
    for (const shot of SHOTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: VIEWPORT.width,
        height: MEASURE_HEIGHT,
        deviceScaleFactor: VIEWPORT.scale,
        mobile: false
      })
      // The unique query matters: navigating between URLs that differ only by
      // hash is a *same-document* navigation, so React never remounts, the
      // saved UI state is never read, and the selected tab never changes.
      // Varying the query forces a real document load each time.
      await cdp.send('Page.navigate', { url: `${BASE_URL}/?shot=${index++}${shot.hash}` })
      // The app fetches status, engines and settings on load; give it room.
      await sleep(2000)

      const measured = await cdp.send('Runtime.evaluate', {
        expression: shot.until,
        returnByValue: true
      })
      const height = Math.max(320, Math.min(MEASURE_HEIGHT, Number(measured.result.value) || 900))

      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
        clip: {
          x: 0,
          y: 0,
          width: VIEWPORT.width,
          height,
          // 1, not VIEWPORT.scale: the device scale factor already renders at
          // 2x, and clip.scale multiplies on top of it — together they produce
          // a needlessly huge 4x image.
          scale: 1
        }
      })
      const path = join(OUT_DIR, shot.name)
      await writeFile(path, Buffer.from(data, 'base64'))
      process.stdout.write(`wrote ${path}\n`)
    }
  } finally {
    cdp?.close()
    child.kill()
    await rm(profile, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
