import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pdfEngineFor, notesEngineFor, NoEngineError } from './engines/registry.js'
import { buildSidecar, writeSidecar } from './sidecar.js'
import { pdfPageCount } from './pdf.js'
import { GENERATOR } from './version.js'
import {
  formatForPath,
  pdfPathFor,
  sidecarPathFor,
  outputsAreFresh
} from './util/paths.js'
import type { ConversionResult, ConvertOptions, ProgressEvent } from './types.js'

/**
 * Converts one presentation to PDF plus a notes sidecar.
 *
 * The two halves are deliberately independent: one engine renders the PDF and a
 * separate one recovers the notes, so note fidelity never depends on what the
 * renderer did to the text. `sidecar.ts` then reconciles the two, which is
 * where hidden slides are accounted for.
 */
export async function convertFile(options: ConvertOptions): Promise<ConversionResult> {
  const startedAt = Date.now()
  const { sourcePath } = options
  const warnings: string[] = []

  const report = (event: Omit<ProgressEvent, 'sourcePath'>): void => {
    options.onProgress?.({ sourcePath, ...event })
  }

  const finish = (result: Omit<ConversionResult, 'durationMs' | 'sourcePath' | 'warnings'>): ConversionResult => ({
    sourcePath,
    warnings,
    durationMs: Date.now() - startedAt,
    ...result
  })

  const format = formatForPath(sourcePath)
  if (!format) {
    report({ phase: 'failed', message: 'Unrecognised file type' })
    return finish({
      status: 'failed',
      message: `${sourcePath} is not a presentation this tool recognises`
    })
  }

  const pdfPath = options.outputPath ?? pdfPathFor(sourcePath, options.outputDir)
  const sidecarPath = sidecarPathFor(pdfPath)
  const wantSidecar = options.skipSidecar !== true

  // Google Slides sources are remote, so freshness cannot be judged from an
  // mtime on disk and an incremental run would skip decks that had changed.
  const incremental = options.incremental !== false && format !== 'google-slides'
  if (incremental) {
    const outputs = wantSidecar ? [pdfPath, sidecarPath] : [pdfPath]
    if (await outputsAreFresh(sourcePath, outputs)) {
      report({ phase: 'skipped', message: 'Already up to date' })
      return finish({
        status: 'skipped',
        pdfPath,
        ...(wantSidecar ? { sidecarPath } : {}),
        message: 'Already up to date'
      })
    }
  }

  try {
    report({ phase: 'probing' })
    const pdfEngine = await pdfEngineFor(format, options.pdfEngineId)
    const notesEngine = wantSidecar ? await notesEngineFor(format, options.notesEngineId) : undefined

    await mkdir(dirname(pdfPath), { recursive: true })

    report({ phase: 'rendering', message: pdfEngine.label })
    await pdfEngine.render({
      sourcePath,
      outputPath: pdfPath,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {})
    })

    const pageCount = await pdfPageCount(pdfPath)

    if (!notesEngine) {
      report({ phase: 'done' })
      return finish({
        status: 'ok',
        pdfPath,
        pageCount,
        engines: { pdf: pdfEngine.id, notes: 'none' }
      })
    }

    report({ phase: 'extracting-notes', message: notesEngine.label })
    const extracted = await notesEngine.extract(sourcePath, options.signal)
    if ('warnings' in extracted && Array.isArray((extracted as { warnings: string[] }).warnings)) {
      warnings.push(...(extracted as { warnings: string[] }).warnings)
    }

    report({ phase: 'writing-sidecar' })
    const info = await stat(sourcePath).catch(() => undefined)
    const sidecar = buildSidecar({
      sourcePath,
      sourceFormat: format,
      ...(info ? { sourceModifiedAt: info.mtime, sourceSizeBytes: info.size } : {}),
      pdfPath,
      pdfPageCount: pageCount,
      slides: extracted.slides,
      pdfEngine: pdfEngine.id,
      notesEngine: extracted.engine,
      generator: GENERATOR,
      warnings
    })
    await writeSidecar(sidecarPath, sidecar)

    report({ phase: 'done' })
    return finish({
      status: 'ok',
      pdfPath,
      sidecarPath,
      slideCount: sidecar.slideCount,
      pageCount,
      notedSlides: Object.keys(sidecar.notes).length,
      alignment: sidecar.alignment,
      engines: sidecar.engines
    })
  } catch (error) {
    const message =
      error instanceof NoEngineError
        ? [error.message, ...error.reasons].join('\n  ')
        : error instanceof Error
          ? error.message
          : String(error)
    report({ phase: 'failed', message })
    return finish({ status: 'failed', message })
  }
}
