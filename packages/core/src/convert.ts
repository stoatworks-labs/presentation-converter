import { mkdir, stat, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pdfEngineFor, notesEngineFor, NoEngineError } from './engines/registry.js'
import { buildSidecar, writeSidecar } from './sidecar.js'
import { pdfPageCount } from './pdf.js'
import { GENERATOR } from './version.js'
import {
  formatForSource,
  pdfPathFor,
  sidecarPathFor,
  outputsAreFresh,
  stemOf
} from './util/paths.js'
import { isRemoteFormat } from './types.js'
import type {
  ConversionResult,
  ConvertOptions,
  PresentationFormat,
  ProgressEvent
} from './types.js'

/**
 * Where a converted deck's PDF belongs.
 *
 * A cloud source is a URL, not a path, so `dirname` of it is meaningless — the
 * output goes to `outputDir` (or the working directory) under a name derived
 * from the deck rather than from the URL's last path segment, which for Canva
 * and Google is usually the useless word "edit".
 */
function remoteAwarePdfPath(
  source: string,
  format: PresentationFormat,
  outputDir?: string
): string {
  if (!isRemoteFormat(format)) return pdfPathFor(source, outputDir)
  const name = `${remoteStem(source, format)}.pdf`
  return outputDir ? join(outputDir, name) : join(process.cwd(), name)
}

/**
 * Strips characters that are illegal or awkward in a filename.
 *
 * A Canva or Slides title is free text and can contain slashes, colons and
 * newlines, none of which belong in a path.
 */
function safeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
}

/**
 * Renames a freshly written PDF to the deck's real title.
 *
 * Returns the new path, or undefined when the rename was skipped — an unusable
 * title, or a name already taken by something else. Failing to rename is never
 * worth failing a conversion over, so every problem here is non-fatal.
 */
async function renameToTitle(pdfPath: string, title: string): Promise<string | undefined> {
  const safe = safeFilename(title)
  if (!safe) return undefined

  const target = join(dirname(pdfPath), `${safe}.pdf`)
  if (target === pdfPath) return undefined

  try {
    await stat(target)
    // Something already occupies the title; keep the id-based name rather than
    // overwrite a file this conversion did not create.
    return undefined
  } catch {
    // Free — proceed.
  }

  try {
    await rename(pdfPath, target)
    return target
  } catch {
    return undefined
  }
}

/** A filesystem-safe name for a cloud deck, from its id. */
function remoteStem(source: string, format: PresentationFormat): string {
  const id =
    format === 'canva'
      ? source.match(/canva\.com\/design\/([A-Za-z0-9_-]+)/i)?.[1]
      : source.match(/\/presentation\/d\/([A-Za-z0-9_-]+)/)?.[1]
  if (id) return id
  const fallback = stemOf(source).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return fallback || 'presentation'
}

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

  // URL-aware: a Google Slides or Canva link has no meaningful extension, so
  // extension matching alone would reject it as "not a presentation".
  const format = formatForSource(sourcePath)
  if (!format) {
    report({ phase: 'failed', message: 'Unrecognised file type' })
    return finish({
      status: 'failed',
      message: `${sourcePath} is not a presentation this tool recognises`
    })
  }

  let pdfPath = options.outputPath ?? remoteAwarePdfPath(sourcePath, format, options.outputDir)
  let sidecarPath = sidecarPathFor(pdfPath)
  const wantSidecar = options.skipSidecar !== true

  // Cloud sources have no local mtime to compare against, so an incremental
  // run cannot tell a changed deck from an unchanged one and must always fetch.
  const incremental = options.incremental !== false && !isRemoteFormat(format)
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
    const rendered = await pdfEngine.render({
      sourcePath,
      outputPath: pdfPath,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {})
    })

    // A cloud deck is addressed by id, so the output would be called something
    // like `DAFxyz123.pdf`. If the engine learned the deck's real title while
    // fetching it, use that — but never override a path the caller chose.
    if (rendered.suggestedName && !options.outputPath) {
      const renamed = await renameToTitle(pdfPath, rendered.suggestedName)
      if (renamed) {
        pdfPath = renamed
        sidecarPath = sidecarPathFor(renamed)
      }
    }

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
    const remoteId = isRemoteFormat(format) ? remoteStem(sourcePath, format) : undefined

    const sidecar = buildSidecar({
      sourcePath,
      sourceFormat: format,
      // For a cloud deck, record the title (or failing that the id) rather than
      // the URL's last path segment, and keep the id so the source can be found
      // again. `source.format` already says which service it came from.
      ...(remoteId
        ? { sourceFile: rendered.suggestedName ?? remoteId, remoteId }
        : {}),
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
