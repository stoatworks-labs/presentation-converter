import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import {
  SIDECAR_SCHEMA_VERSION,
  type ExtractedSlide,
  type LegacyNotesSidecar,
  type NotesAlignment,
  type NotesSidecar,
  type PresentationFormat,
  type SidecarSlide
} from './types.js'

export interface BuildSidecarInput {
  sourcePath: string
  /**
   * Overrides the recorded source filename.
   *
   * `basename` of a cloud URL is its last path segment — usually the useless
   * word "edit" — so remote sources supply a real name here.
   */
  sourceFile?: string
  sourceFormat: PresentationFormat
  sourceModifiedAt?: Date
  sourceSizeBytes?: number
  remoteId?: string
  pdfPath: string
  pdfPageCount: number
  slides: ExtractedSlide[]
  pdfEngine: string
  notesEngine: string
  generator: string
  convertedAt?: Date
  warnings?: string[]
}

interface MappingResult {
  slides: SidecarSlide[]
  alignment: NotesAlignment
  warnings: string[]
}

/**
 * Maps source slides onto PDF pages.
 *
 * Exporters drop hidden slides from the PDF, so a deck with a hidden slide
 * three from the end produces notes that are one page out from slide four
 * onwards unless the gap is closed here. Verified against a real export: a
 * 4-slide Keynote deck with one skipped slide produces a 3-page PDF.
 */
function mapSlidesToPages(slides: ExtractedSlide[], pageCount: number): MappingResult {
  const warnings: string[] = []
  const visibleCount = slides.filter((slide) => !slide.hidden).length

  // The exporter kept every slide, hidden ones included — straight 1:1.
  if (pageCount === slides.length) {
    return {
      slides: slides.map((slide) => ({ ...slide, page: slide.index })),
      alignment: 'exact',
      warnings
    }
  }

  // The exporter dropped exactly the hidden slides; close the gaps.
  if (pageCount === visibleCount) {
    let page = 0
    return {
      slides: slides.map((slide) => ({
        ...slide,
        page: slide.hidden ? null : ++page
      })),
      alignment: 'adjusted',
      warnings
    }
  }

  // Neither reading fits. Fall back to positional mapping and say so loudly
  // rather than emitting confidently wrong page numbers.
  warnings.push(
    `Could not reconcile ${slides.length} slide(s) (${visibleCount} visible) with a ${pageCount}-page PDF. ` +
      'Notes were mapped positionally and may be off by one or more pages.'
  )
  return {
    slides: slides.map((slide) => ({
      ...slide,
      page: slide.index <= pageCount ? slide.index : null
    })),
    alignment: 'mismatch',
    warnings
  }
}

export function buildSidecar(input: BuildSidecarInput): NotesSidecar {
  const mapping = mapSlidesToPages(input.slides, input.pdfPageCount)

  const notes: Record<string, string> = {}
  for (const slide of mapping.slides) {
    if (slide.page !== null && slide.notes.trim()) notes[String(slide.page)] = slide.notes
  }

  return {
    schemaVersion: SIDECAR_SCHEMA_VERSION,
    generator: input.generator,
    convertedAt: (input.convertedAt ?? new Date()).toISOString(),
    source: {
      file: input.sourceFile ?? basename(input.sourcePath),
      format: input.sourceFormat,
      ...(input.sourceModifiedAt ? { modifiedAt: input.sourceModifiedAt.toISOString() } : {}),
      ...(input.sourceSizeBytes !== undefined ? { sizeBytes: input.sourceSizeBytes } : {}),
      ...(input.remoteId ? { remoteId: input.remoteId } : {})
    },
    pdf: {
      file: basename(input.pdfPath),
      pageCount: input.pdfPageCount
    },
    slideCount: input.slides.length,
    engines: { pdf: input.pdfEngine, notes: input.notesEngine },
    alignment: mapping.alignment,
    notes,
    slides: mapping.slides,
    warnings: [...(input.warnings ?? []), ...mapping.warnings]
  }
}

export async function writeSidecar(path: string, sidecar: NotesSidecar): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf-8')
}

/** True for a parsed sidecar in the current schema, as opposed to the legacy map. */
export function isCurrentSidecar(value: unknown): value is NotesSidecar {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<NotesSidecar>
  return (
    typeof candidate.schemaVersion === 'number' &&
    typeof candidate.notes === 'object' &&
    candidate.notes !== null
  )
}

/**
 * Reads either sidecar shape and returns just the page/note map.
 *
 * Consumers that only want notes (the presentation-commander client) should use
 * this, so a hand-written legacy sidecar keeps working alongside generated ones.
 */
export function notesFromSidecar(value: unknown): Record<string, string> {
  if (isCurrentSidecar(value)) return value.notes
  if (value && typeof value === 'object') {
    const out: Record<string, string> = {}
    for (const [key, note] of Object.entries(value as LegacyNotesSidecar)) {
      if (/^\d+$/.test(key) && typeof note === 'string') out[key] = note
    }
    return out
  }
  return {}
}

export async function readSidecar(
  path: string
): Promise<{ sidecar?: NotesSidecar; notes: Record<string, string> } | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'))
    return {
      ...(isCurrentSidecar(parsed) ? { sidecar: parsed } : {}),
      notes: notesFromSidecar(parsed)
    }
  } catch {
    return undefined
  }
}

/**
 * Writes edited notes back without discarding generated metadata.
 *
 * An editor that simply serialised its note map would strip the provenance,
 * per-slide detail and alignment warnings from a converted sidecar, so the
 * envelope is preserved when there is one.
 */
export async function updateSidecarNotes(
  path: string,
  notes: Record<string, string>
): Promise<void> {
  const existing = await readSidecar(path)
  if (existing?.sidecar) {
    const merged: NotesSidecar = {
      ...existing.sidecar,
      notes,
      slides: existing.sidecar.slides.map((slide) =>
        slide.page === null ? slide : { ...slide, notes: notes[String(slide.page)] ?? '' }
      )
    }
    await writeSidecar(path, merged)
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(notes, null, 2)}\n`, 'utf-8')
}
