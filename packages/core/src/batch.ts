import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { convertFile } from './convert.js'
import { pdfEngineFor } from './engines/registry.js'
import { Semaphore, SemaphoreGroup } from './util/semaphore.js'
import { formatForPath, isIgnoredFile, isPresentation, batchOutputPath, isInside } from './util/paths.js'
import type { BatchOptions, BatchResult, ConversionResult } from './types.js'

/** Directories never worth descending into. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__MACOSX', '.Trash'])

export interface DiscoveredFile {
  path: string
  sizeBytes: number
}

/** Finds every presentation under `root`, newest-first within each directory. */
export async function discoverPresentations(
  root: string,
  options: { recursive?: boolean; exclude?: string[] } = {}
): Promise<DiscoveredFile[]> {
  const recursive = options.recursive !== false
  const exclude = options.exclude ?? []
  const found: DiscoveredFile[] = []

  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Unreadable directory (permissions, a vanished mount) — skip it rather
      // than aborting a batch that can still do useful work.
      return
    }

    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (exclude.some((pattern) => full.includes(pattern))) continue

      if (entry.isDirectory()) {
        if (!recursive || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        // A Keynote bundle is a directory on disk; treat it as a file.
        if (formatForPath(entry.name)) {
          found.push({ path: full, sizeBytes: 0 })
          continue
        }
        await walk(full)
        continue
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      if (isIgnoredFile(full) || !isPresentation(full)) continue

      const info = await stat(full).catch(() => undefined)
      if (info) found.push({ path: full, sizeBytes: info.size })
    }
  }

  await walk(resolve(root))
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Converts every presentation under `inputDir`.
 *
 * Concurrency is enforced twice: a global cap from `options.concurrency`, and a
 * per-engine cap from the engine itself. Both are needed — Keynote must stay
 * strictly serial no matter what the caller asks for, while LibreOffice jobs
 * can overlap.
 */
export async function convertFolder(
  inputDir: string,
  options: BatchOptions = {}
): Promise<BatchResult> {
  const startedAt = Date.now()
  const root = resolve(inputDir)

  if (options.outputDir && isInside(options.outputDir, root) && options.recursive !== false) {
    // Otherwise a recursive run would keep finding its own output on re-runs.
    // PDFs are not presentations so this cannot actually loop, but sidecars and
    // future output types would, and the surprise is not worth allowing.
    throw new Error(
      `Output directory ${options.outputDir} is inside the input directory ${root}. ` +
        'Choose an output directory outside the folder being converted.'
    )
  }

  const files = await discoverPresentations(root, {
    ...(options.recursive !== undefined ? { recursive: options.recursive } : {}),
    ...(options.exclude ? { exclude: options.exclude } : {})
  })

  const preserveTree = options.preserveTree !== false

  /**
   * Two decks that differ only by extension — `talk.key` and `talk.pptx` — both
   * want `talk.pdf`, and whichever finishes last silently wins. Detect that up
   * front and fail the whole group loudly; quietly overwriting one deck's
   * output with another's is far worse than refusing.
   */
  const byOutput = new Map<string, string[]>()
  for (const file of files) {
    const target = batchOutputPath(file.path, root, options.outputDir, preserveTree)
    const key = process.platform === 'win32' || process.platform === 'darwin' ? target.toLowerCase() : target
    byOutput.set(key, [...(byOutput.get(key) ?? []), file.path])
  }
  const collided = new Map<string, string[]>()
  for (const [, sources] of byOutput) {
    if (sources.length > 1) {
      for (const source of sources) collided.set(source, sources)
    }
  }

  const globalLimit = new Semaphore(Math.max(1, options.concurrency ?? 4))
  const perEngine = new SemaphoreGroup()
  const results: ConversionResult[] = []
  let completed = 0

  const runOne = async (path: string): Promise<void> => {
    const clash = collided.get(path)
    if (clash) {
      const others = clash.filter((other) => other !== path)
      const result: ConversionResult = {
        status: 'failed',
        sourcePath: path,
        warnings: [],
        durationMs: 0,
        message:
          `Would overwrite the same PDF as ${others.join(', ')}. ` +
          'Rename one of them, or convert them to separate output folders.'
      }
      completed += 1
      results.push(result)
      options.onFileComplete?.(result)
      return
    }

    // Resolve the engine first so its concurrency limit can be applied before
    // any real work starts.
    let engineKey = 'unknown'
    let engineLimit = 1
    const format = formatForPath(path)
    if (format) {
      try {
        const engine = await pdfEngineFor(format, options.pdfEngineId)
        engineKey = engine.id
        engineLimit = engine.maxConcurrency
      } catch {
        // Leave the conservative default; convertFile reports the real error.
      }
    }

    const result = await globalLimit.run(() =>
      perEngine.get(engineKey, engineLimit).run(() =>
        convertFile({
          ...options,
          sourcePath: path,
          outputPath: batchOutputPath(path, root, options.outputDir, preserveTree),
          onProgress: (event) =>
            options.onProgress?.({
              ...event,
              fraction: files.length > 0 ? completed / files.length : undefined
            })
        })
      )
    )

    completed += 1
    results.push(result)
    options.onFileComplete?.(result)
  }

  await Promise.all(files.map((file) => runOne(file.path)))

  results.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))

  return {
    results,
    converted: results.filter((r) => r.status === 'ok').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    durationMs: Date.now() - startedAt
  }
}
