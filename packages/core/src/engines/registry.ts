import { keynoteEngine, keynoteNotesEngine } from './keynote.js'
import { libreOfficeEngine } from './libreoffice.js'
import { packageNotesEngine } from './documentNotes.js'
import { googleSlidesEngine, googleSlidesNotesEngine } from './google.js'
import type {
  EngineAvailability,
  NotesEngine,
  PdfEngine,
  PresentationFormat
} from '../types.js'

export const PDF_ENGINES: PdfEngine[] = [libreOfficeEngine, keynoteEngine, googleSlidesEngine]
export const NOTES_ENGINES: NotesEngine[] = [
  keynoteNotesEngine,
  packageNotesEngine,
  googleSlidesNotesEngine
]

/**
 * Preferred PDF engine per format, most-preferred first.
 *
 * LibreOffice leads for the Office formats because it renders OOXML directly
 * and is the only option on a headless host; Keynote is the macOS fallback for
 * a Mac with no LibreOffice installed, since it imports PowerPoint decks.
 */
const PDF_PREFERENCE: Record<PresentationFormat, string[]> = {
  keynote: ['keynote'],
  pptx: ['libreoffice', 'keynote'],
  ppt: ['libreoffice', 'keynote'],
  odp: ['libreoffice'],
  'google-slides': ['google-slides']
}

/**
 * Preferred notes engine per format.
 *
 * For Office and ODF formats the source package is read directly, so the notes
 * are the author's exact text no matter which engine rendered the PDF.
 */
const NOTES_PREFERENCE: Record<PresentationFormat, string[]> = {
  keynote: ['keynote'],
  pptx: ['package-xml'],
  ppt: ['package-xml'],
  odp: ['package-xml'],
  'google-slides': ['google-slides']
}

const probeCache = new Map<string, Promise<EngineAvailability>>()

function probeOnce(engine: PdfEngine | NotesEngine, kind: string): Promise<EngineAvailability> {
  const key = `${kind}:${engine.id}`
  let cached = probeCache.get(key)
  if (!cached) {
    cached = engine.probe().catch((error: unknown) => ({
      available: false,
      reason: error instanceof Error ? error.message : String(error)
    }))
    probeCache.set(key, cached)
  }
  return cached
}

/** Forgets probe results, so a newly installed LibreOffice is picked up. */
export function resetEngineProbes(): void {
  probeCache.clear()
}

export class NoEngineError extends Error {
  constructor(
    message: string,
    readonly format: PresentationFormat,
    /** Why each candidate was rejected, for a genuinely actionable message. */
    readonly reasons: string[]
  ) {
    super(message)
    this.name = 'NoEngineError'
  }
}

async function select<T extends PdfEngine | NotesEngine>(
  engines: T[],
  preference: string[],
  format: PresentationFormat,
  kind: 'PDF' | 'notes',
  forcedId?: string
): Promise<T> {
  const reasons: string[] = []

  if (forcedId) {
    const forced = engines.find((engine) => engine.id === forcedId)
    if (!forced) {
      throw new NoEngineError(`Unknown ${kind} engine "${forcedId}"`, format, [
        `Known ${kind} engines: ${engines.map((engine) => engine.id).join(', ')}`
      ])
    }
    if (!forced.formats.includes(format)) {
      throw new NoEngineError(
        `${kind} engine "${forcedId}" does not handle ${format} files`,
        format,
        []
      )
    }
    const availability = await probeOnce(forced, kind)
    if (!availability.available) {
      throw new NoEngineError(
        `${kind} engine "${forcedId}" is not available: ${availability.reason ?? 'unknown reason'}`,
        format,
        []
      )
    }
    return forced
  }

  for (const id of preference) {
    const engine = engines.find((candidate) => candidate.id === id)
    if (!engine || !engine.formats.includes(format)) continue
    const availability = await probeOnce(engine, kind)
    if (availability.available) return engine
    reasons.push(`${engine.label}: ${availability.reason ?? 'unavailable'}`)
  }

  throw new NoEngineError(
    `No ${kind} engine available for ${format} files`,
    format,
    reasons
  )
}

export function pdfEngineFor(format: PresentationFormat, forcedId?: string): Promise<PdfEngine> {
  return select(PDF_ENGINES, PDF_PREFERENCE[format] ?? [], format, 'PDF', forcedId)
}

export function notesEngineFor(
  format: PresentationFormat,
  forcedId?: string
): Promise<NotesEngine> {
  return select(NOTES_ENGINES, NOTES_PREFERENCE[format] ?? [], format, 'notes', forcedId)
}

export interface EngineStatus {
  id: string
  label: string
  kind: 'pdf' | 'notes'
  formats: PresentationFormat[]
  availability: EngineAvailability
}

/** Probes everything — backs the CLI's `doctor` command and the GUI status panel. */
export async function describeEngines(): Promise<EngineStatus[]> {
  const pdf = await Promise.all(
    PDF_ENGINES.map(async (engine) => ({
      id: engine.id,
      label: engine.label,
      kind: 'pdf' as const,
      formats: engine.formats,
      availability: await probeOnce(engine, 'PDF')
    }))
  )
  const notes = await Promise.all(
    NOTES_ENGINES.map(async (engine) => ({
      id: engine.id,
      label: engine.label,
      kind: 'notes' as const,
      formats: engine.formats,
      availability: await probeOnce(engine, 'notes')
    }))
  )
  return [...pdf, ...notes]
}

/** Formats that can be converted end-to-end right now, for GUI messaging. */
export async function supportedFormats(): Promise<PresentationFormat[]> {
  const formats: PresentationFormat[] = ['keynote', 'pptx', 'ppt', 'odp', 'google-slides']
  const usable: PresentationFormat[] = []
  for (const format of formats) {
    try {
      await pdfEngineFor(format)
      await notesEngineFor(format)
      usable.push(format)
    } catch {
      // Not usable in this environment; omitted rather than reported here.
    }
  }
  return usable
}
