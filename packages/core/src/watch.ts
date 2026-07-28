import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import { convertFile } from './convert.js'
import { pdfEngineFor } from './engines/registry.js'
import { Semaphore, SemaphoreGroup } from './util/semaphore.js'
import { formatForPath, isPresentation, isIgnoredFile, batchOutputPath, isInside } from './util/paths.js'
import type { ConversionResult, ConvertOptions, ProgressEvent } from './types.js'

export interface WatchOptions extends Omit<ConvertOptions, 'sourcePath' | 'outputPath'> {
  recursive?: boolean
  preserveTree?: boolean
  concurrency?: number
  exclude?: string[]
  /**
   * Convert everything already present when the watch starts. Default true —
   * a watch folder that ignores its existing contents surprises people.
   */
  convertExisting?: boolean
  /**
   * How long a file must stop changing before it is considered complete.
   * Presentations are written in several passes by their authoring app, and
   * converting a half-written deck produces a corrupt PDF.
   */
  stabilityThresholdMs?: number
}

export interface WatchFolderEvents {
  ready: []
  progress: [ProgressEvent]
  converted: [ConversionResult]
  error: [Error]
}

/**
 * Watches a folder and converts presentations as they appear or change.
 *
 * Uses chokidar's `awaitWriteFinish` rather than reacting to the first `add`:
 * Keynote and PowerPoint write a deck in several passes, and a file picked up
 * mid-save converts to a truncated or corrupt PDF.
 */
export class WatchFolder extends EventEmitter<WatchFolderEvents> {
  private watcher: FSWatcher | undefined
  private readonly root: string
  private readonly globalLimit: Semaphore
  private readonly perEngine = new SemaphoreGroup()
  /** Files currently converting, so a second event for the same path is ignored. */
  private readonly inFlight = new Set<string>()
  /** Paths that changed while converting and need another pass afterwards. */
  private readonly requeue = new Set<string>()

  constructor(
    inputDir: string,
    private readonly options: WatchOptions = {}
  ) {
    super()
    this.root = resolve(inputDir)
    this.globalLimit = new Semaphore(Math.max(1, options.concurrency ?? 2))

    if (options.outputDir && isInside(options.outputDir, this.root)) {
      throw new Error(
        `Output directory ${options.outputDir} is inside the watched folder ${this.root}. ` +
          'Choose an output directory outside it.'
      )
    }
  }

  start(): Promise<void> {
    const stability = this.options.stabilityThresholdMs ?? 2000

    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: this.options.convertExisting === false,
      depth: this.options.recursive === false ? 0 : undefined,
      awaitWriteFinish: {
        stabilityThreshold: stability,
        pollInterval: Math.min(500, Math.max(100, Math.floor(stability / 4)))
      },
      ignored: (path: string) => {
        if (isIgnoredFile(path)) return true
        return (this.options.exclude ?? []).some((pattern) => path.includes(pattern))
      }
    })

    const onChange = (path: string): void => {
      if (!isPresentation(path)) return
      void this.handle(path)
    }

    this.watcher.on('add', onChange)
    this.watcher.on('change', onChange)
    // A Keynote document is a bundle (a directory), so it arrives as addDir.
    this.watcher.on('addDir', (path: string) => {
      if (formatForPath(path)) void this.handle(path)
    })
    this.watcher.on('error', (error: unknown) =>
      this.emit('error', error instanceof Error ? error : new Error(String(error)))
    )

    return new Promise((resolvePromise) => {
      this.watcher?.once('ready', () => {
        this.emit('ready')
        resolvePromise()
      })
    })
  }

  private async handle(path: string): Promise<void> {
    if (this.inFlight.has(path)) {
      // Edited again mid-conversion; run once more when the current pass ends
      // so the output reflects the final state rather than an intermediate one.
      this.requeue.add(path)
      return
    }
    this.inFlight.add(path)

    try {
      let engineKey = 'unknown'
      let engineLimit = 1
      const format = formatForPath(path)
      if (format) {
        try {
          const engine = await pdfEngineFor(format, this.options.pdfEngineId)
          engineKey = engine.id
          engineLimit = engine.maxConcurrency
        } catch {
          // convertFile will report the real reason.
        }
      }

      const result = await this.globalLimit.run(() =>
        this.perEngine.get(engineKey, engineLimit).run(() =>
          convertFile({
            ...this.options,
            sourcePath: path,
            outputPath: batchOutputPath(
              path,
              this.root,
              this.options.outputDir,
              this.options.preserveTree !== false
            ),
            onProgress: (event) => this.emit('progress', event)
          })
        )
      )
      this.emit('converted', result)
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.inFlight.delete(path)
      if (this.requeue.delete(path)) void this.handle(path)
    }
  }

  async stop(): Promise<void> {
    await this.watcher?.close()
    this.watcher = undefined
  }
}
