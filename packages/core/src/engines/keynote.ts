import { rm, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { runJxa, macAppInstalled, isMacOS } from '../util/exec.js'
import type {
  EngineAvailability,
  ExtractedNotes,
  ExtractedSlide,
  NotesEngine,
  PdfEngine,
  PdfRenderResult,
  RenderOptions
} from '../types.js'

const KEYNOTE_BUNDLE_ID = 'com.apple.iWork.Keynote'

/**
 * Opens a deck, reads every slide's notes, and optionally exports a PDF — in
 * one Apple event round trip.
 *
 * JXA rather than AppleScript so results come back as real JSON instead of
 * hand-parsed list text, matching the approach in presentation-commander-client.
 *
 * Export options are set explicitly rather than left to Keynote's defaults:
 * `skippedSlides: false` fixes the hidden-slide behaviour the notes mapping
 * depends on, and `exportStyle: 'IndividualSlides'` prevents Keynote from
 * helpfully burning the presenter notes into the PDF itself — which would
 * defeat the entire purpose of a sidecar.
 *
 * A document the user already had open is left open; only documents this script
 * opened are closed.
 */
const OPEN_SCRIPT = `
function run(argv) {
  const filePath = argv[0]
  const pdfPath = argv[1]
  const Keynote = Application('Keynote')

  const wasOpen = Keynote.documents().some(function (d) {
    try { return d.name() === filePath.split('/').pop() } catch (e) { return false }
  })

  const doc = Keynote.open(Path(filePath))
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

async function openDeck(
  sourcePath: string,
  pdfPath: string | null,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<KeynoteRun> {
  const raw = await runJxa(OPEN_SCRIPT, [sourcePath, pdfPath ?? ''], {
    timeoutMs: options.timeoutMs ?? 600_000,
    ...(options.signal ? { signal: options.signal } : {})
  })
  if (!raw) throw new Error(`Keynote returned no data for ${sourcePath}`)
  const result: KeynoteRun = { slides: normaliseSlides(JSON.parse(raw)) }
  remember(await cacheKey(sourcePath), result)
  return result
}

async function probeKeynote(): Promise<EngineAvailability> {
  if (!isMacOS()) {
    return { available: false, reason: 'Keynote is only available on macOS' }
  }
  if (!(await macAppInstalled(KEYNOTE_BUNDLE_ID))) {
    return { available: false, reason: 'Keynote is not installed' }
  }
  return { available: true }
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
