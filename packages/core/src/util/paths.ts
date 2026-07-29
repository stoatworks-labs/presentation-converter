import { extname, basename, dirname, join, resolve, relative, sep } from 'node:path'
import { stat } from 'node:fs/promises'
import { PRESENTATION_EXTENSIONS, type PresentationFormat } from '../types.js'

/** The presentation format implied by a path's extension, if any. */
export function formatForPath(path: string): PresentationFormat | undefined {
  return PRESENTATION_EXTENSIONS[extname(path).toLowerCase()]
}

/** Hosts whose URLs identify a cloud presentation. */
const URL_FORMATS: Array<{ pattern: RegExp; format: PresentationFormat }> = [
  { pattern: /docs\.google\.com\/presentation\//i, format: 'google-slides' },
  { pattern: /(?:www\.)?canva\.com\/design\//i, format: 'canva' }
]

/**
 * The format of anything a user can pass as a source: a file path, or a URL to
 * a cloud presentation.
 *
 * Extension matching alone is not enough — a Google Slides or Canva URL has no
 * meaningful extension, so `formatForPath` returns undefined for it and the
 * conversion is rejected as "not a presentation". Every entry point should use
 * this rather than `formatForPath`.
 */
export function formatForSource(source: string): PresentationFormat | undefined {
  if (/^https?:\/\//i.test(source)) {
    return URL_FORMATS.find((entry) => entry.pattern.test(source))?.format
  }
  return formatForPath(source)
}

export function isPresentation(path: string): boolean {
  return formatForPath(path) !== undefined && !isIgnoredFile(path)
}

/**
 * Files that look like presentations but are not: Office lock files
 * (`~$deck.pptx`), macOS resource forks, and anything hidden.
 */
export function isIgnoredFile(path: string): boolean {
  const name = basename(path)
  return name.startsWith('~$') || name.startsWith('._') || name.startsWith('.')
}

/** Strips the presentation extension, e.g. `Q3 Review.key` -> `Q3 Review`. */
export function stemOf(path: string): string {
  return basename(path, extname(path))
}

/** `/decks/Q3.key` -> `/decks/Q3.pdf`, or into `outputDir` when given. */
export function pdfPathFor(sourcePath: string, outputDir?: string): string {
  const name = `${stemOf(sourcePath)}.pdf`
  return outputDir ? join(outputDir, name) : join(dirname(sourcePath), name)
}

/**
 * The sidecar path for a PDF: `Q3.pdf` -> `Q3.notes.json`.
 * This naming is the contract with presentation-commander-client, which derives
 * it the same way — do not change it without changing that too.
 */
export function sidecarPathFor(pdfPath: string): string {
  return pdfPath.replace(/\.pdf$/i, '.notes.json')
}

/**
 * Where a batch should write `sourcePath`'s PDF, mirroring the input tree under
 * `outputDir` when `preserveTree` is set.
 */
export function batchOutputPath(
  sourcePath: string,
  inputRoot: string,
  outputDir: string | undefined,
  preserveTree: boolean
): string {
  if (!outputDir) return pdfPathFor(sourcePath)
  if (!preserveTree) return pdfPathFor(sourcePath, outputDir)
  const rel = relative(resolve(inputRoot), resolve(dirname(sourcePath)))
  const targetDir = rel && !rel.startsWith('..') ? join(outputDir, rel) : outputDir
  return pdfPathFor(sourcePath, targetDir)
}

/** Resolves a zip-internal relationship target, honouring `../` segments. */
export function resolveZipPath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const segments = `${baseDir}/${target}`.split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return out.join('/')
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function mtimeOf(path: string): Promise<Date | undefined> {
  try {
    return (await stat(path)).mtime
  } catch {
    return undefined
  }
}

/**
 * True when `outputs` all exist and are newer than `source` — the test an
 * incremental batch uses to leave an already-converted deck alone.
 */
export async function outputsAreFresh(source: string, outputs: string[]): Promise<boolean> {
  const sourceMtime = await mtimeOf(source)
  if (!sourceMtime) return false
  for (const output of outputs) {
    const outputMtime = await mtimeOf(output)
    if (!outputMtime || outputMtime < sourceMtime) return false
  }
  return true
}

/** Guards against a batch writing its output back into the folder it is watching. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..')
}
