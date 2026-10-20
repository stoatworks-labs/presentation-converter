import { rm, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  runJxa,
  macAppInfo,
  macAppName,
  describeMacApp,
  osascriptMessage,
  isMacOS,
  type MacApp
} from '../util/exec.js'
import type {
  EngineAvailability,
  ExtractedNotes,
  ExtractedSlide,
  NotesEngine,
  PdfEngine,
  PdfRenderResult,
  RenderOptions
} from '../types.js'

/**
 * The Keynotes this will drive, by bundle id, most-preferred first.
 *
 * Keynote Creator Studio (`com.apple.Keynote`, 15.x) installs beside the iWork
 * Keynote (`com.apple.iWork.Keynote`, 14.x) rather than replacing it. With both
 * installed, the old one launches to a modal "Use the New Version of Keynote"
 * and answers nothing until someone clicks it, so a conversion just hangs. It
 * is therefore never driven while Creator Studio is installed. Seen on macOS
 * 26.4.1 with Keynote 14.5 and Creator Studio 15.3.1, 2026-10-20; see
 * docs/NOTES.md.
 *
 * Keynote is always addressed by bundle id. `Application('Keynote')` asks
 * Launch Services to resolve the name, and with two apps called Keynote
 * installed that is a coin toss this code does not get to see.
 */
export const KEYNOTE_BUNDLE_IDS = ['com.apple.Keynote', 'com.apple.iWork.Keynote'] as const

/**
 * Opens a deck, reads every slide's notes, and optionally exports a PDF — in
 * one Apple event round trip.
 *
 * JXA rather than AppleScript so results come back as real JSON instead of
 * hand-parsed list text, matching the approach in presentation-commander-client.
 * It also builds the file reference on this side of the Apple event, which a
 * sandboxed Keynote needs: an AppleScript `open (POSIX file p)` written inside
 * the `tell` block reaches Creator Studio as a file it may not read, and it
 * says "can't be imported".
 *
 * Export options are set explicitly rather than left to Keynote's defaults:
 * `skippedSlides: false` fixes the hidden-slide behaviour the notes mapping
 * depends on, and `exportStyle: 'IndividualSlides'` prevents Keynote from
 * helpfully burning the presenter notes into the PDF itself — which would
 * defeat the entire purpose of a sidecar.
 *
 * A document the user already had open is left open; only documents this script
 * opened are closed. That is decided by document id, not name: opening a `.key`
 * that is already open hands back the open one, while a `.pptx` is imported
 * into a new document every time (`deck`, then `deck 2`).
 */
const OPEN_SCRIPT = `
function run(argv) {
  const filePath = argv[0]
  const pdfPath = argv[1]
  const Keynote = Application(argv[2])

  const openBefore = Keynote.documents.id()

  const doc = Keynote.open(Path(filePath))
  // A file Keynote cannot read gets an alert and, about a minute later, null.
  if (!doc) throw new Error('Keynote could not open the deck. It may be damaged, password-protected or not a presentation.')
  const wasOpen = openBefore.indexOf(doc.id()) !== -1
  const slides = doc.slides()

  const collected = slides.map(function (slide, i) {
    let title = ''
    try { title = String(slide.defaultTitleItem.objectText()) } catch (e) { title = '' }
    let notes = ''
    try { notes = String(slide.presenterNotes()) } catch (e) { notes = '' }
    let hidden = false
    try { hidden = Boolean(slide.skipped()) } catch (e) { hidden = false }
    return { index: i + 1, title: title, notes: notes, hidden: hidden }
  })

  if (pdfPath) {
    try {
      doc.export({
        to: Path(pdfPath),
        as: 'PDF',
        withProperties: {
          exportStyle: 'IndividualSlides',
          allStages: false,
          skippedSlides: false
        }
      })
    } catch (e) {
      // Older Keynote builds reject some option keys; a bare export still
      // yields individual slides without notes, which is what we want.
      doc.export({ to: Path(pdfPath), as: 'PDF' })
    }
  }

  if (!wasOpen) {
    try { doc.close({ saving: 'no' }) } catch (e) {}
  }

  return JSON.stringify({ slides: collected })
}
`

interface KeynoteRun {
  slides: ExtractedSlide[]
}

/**
 * Caches the last read of each deck, keyed by path and mtime.
 *
 * A conversion renders the PDF and then extracts notes; both need the deck
 * open. Without this the file would be opened in Keynote twice per conversion,
 * roughly doubling the slowest part of a batch.
 */
const recentReads = new Map<string, KeynoteRun>()
const MAX_CACHE_ENTRIES = 64

async function cacheKey(sourcePath: string): Promise<string> {
  try {
    const info = await stat(sourcePath)
    return `${sourcePath}:${info.mtimeMs}:${info.size}`
  } catch {
    return sourcePath
  }
}

function remember(key: string, value: KeynoteRun): void {
  if (recentReads.size >= MAX_CACHE_ENTRIES) {
    const oldest = recentReads.keys().next().value
    if (oldest !== undefined) recentReads.delete(oldest)
  }
  recentReads.set(key, value)
}

function normaliseSlides(raw: unknown): ExtractedSlide[] {
  const parsed = raw as { slides?: Array<{ index: number; title?: string; notes?: string; hidden?: boolean }> }
  return (parsed.slides ?? []).map((slide) => ({
    index: slide.index,
    ...(slide.title?.trim() ? { title: slide.title.trim().split('\n')[0] } : {}),
    notes: (slide.notes ?? '').replace(/\r\n?/g, '\n').trim(),
    hidden: Boolean(slide.hidden)
  }))
}

let chosenKeynote: Promise<MacApp | null> | undefined

/**
 * The installed Keynote to drive: the first of `KEYNOTE_BUNDLE_IDS` present.
 * Found without launching anything. Every probe looks again, so
 * `resetEngineProbes()` picks up a Keynote installed or removed since.
 */
function findKeynote(refresh = false): Promise<MacApp | null> {
  if (refresh || !chosenKeynote) {
    chosenKeynote = (async () => {
      for (const bundleId of KEYNOTE_BUNDLE_IDS) {
        const app = await macAppInfo(bundleId)
        if (app) return app
      }
      return null
    })()
  }
  return chosenKeynote
}

async function openDeck(
  sourcePath: string,
  pdfPath: string | null,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<KeynoteRun> {
  const keynote = await findKeynote()
  if (!keynote) throw new Error('Keynote is not installed')
  let raw: string
  try {
    raw = await runJxa(OPEN_SCRIPT, [sourcePath, pdfPath ?? '', keynote.bundleId], {
      timeoutMs: options.timeoutMs ?? 600_000,
      ...(options.signal ? { signal: options.signal } : {})
    })
  } catch (error) {
    const said = osascriptMessage(error)
    // A modal waits for a person and every Apple event queues behind it.
    const hint = /timed out|-1712/.test(said) ? ' Is a dialog open in it?' : ''
    throw new Error(`${macAppName(keynote)}: ${said}${hint}`, { cause: error })
  }
  if (!raw) throw new Error(`Keynote returned no data for ${sourcePath}`)
  const result: KeynoteRun = { slides: normaliseSlides(JSON.parse(raw)) }
  remember(await cacheKey(sourcePath), result)
  return result
}

async function probeKeynote(): Promise<EngineAvailability> {
  if (!isMacOS()) {
    return { available: false, reason: 'Keynote is only available on macOS' }
  }
  const keynote = await findKeynote(true)
  if (!keynote) {
    return { available: false, reason: 'Keynote is not installed' }
  }
  // Named in full, so `doctor` says which of two installed Keynotes is driven.
  return { available: true, version: describeMacApp(keynote) }
}

export const keynoteEngine: PdfEngine = {
  id: 'keynote',
  label: 'Keynote (macOS)',
  // Keynote imports PowerPoint decks too, which makes it the fallback renderer
  // on a Mac with no LibreOffice installed.
  formats: ['keynote', 'pptx', 'ppt'],
  // Drives one foreground document at a time; running two conversions at once
  // makes Keynote export the wrong document. Must stay 1.
  maxConcurrency: 1,
  probe: probeKeynote,

  async render(options: RenderOptions): Promise<PdfRenderResult> {
    await mkdir(dirname(options.outputPath), { recursive: true })
    // Keynote refuses to export over an existing file.
    await rm(options.outputPath, { force: true })

    await openDeck(options.sourcePath, options.outputPath, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {})
    })
    return { pdfPath: options.outputPath, engine: keynoteEngine.id }
  }
}

export const keynoteNotesEngine: NotesEngine = {
  id: 'keynote',
  label: 'Keynote presenter notes (macOS)',
  // Only `.key`: for PowerPoint decks the OOXML parser reads the author's exact
  // text, whereas Keynote would report notes as its importer re-rendered them.
  formats: ['keynote'],
  maxConcurrency: 1,
  probe: probeKeynote,

  async extract(sourcePath: string, signal?: AbortSignal): Promise<ExtractedNotes> {
    const cached = recentReads.get(await cacheKey(sourcePath))
    if (cached) return { slides: cached.slides, engine: keynoteNotesEngine.id }

    const result = await openDeck(sourcePath, null, signal ? { signal } : {})
    return { slides: result.slides, engine: keynoteNotesEngine.id }
  }
}

/** Clears the open-deck cache. Exposed for tests and long-running watch sessions. */
export function clearKeynoteCache(): void {
  recentReads.clear()
}
