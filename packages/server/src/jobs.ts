import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import {
  convertFolder,
  convertFile,
  WatchFolder,
  type BatchOptions,
  type ConversionResult,
  type ProgressEvent
} from '@presentation-converter/core'

export type JobKind = 'convert' | 'batch' | 'watch'
export type JobState = 'running' | 'done' | 'failed' | 'cancelled'

export interface Job {
  id: string
  kind: JobKind
  state: JobState
  /** Input folder or file this job is working on, for display. */
  target: string
  startedAt: string
  finishedAt?: string
  results: ConversionResult[]
  message?: string
  /** Latest progress line, so a client that connects late has something to show. */
  progress?: ProgressEvent
}

export interface JobEvents {
  update: [Job]
  progress: [{ jobId: string; event: ProgressEvent }]
  result: [{ jobId: string; result: ConversionResult }]
}

/**
 * Tracks conversions in flight.
 *
 * Jobs are held in memory only: this is a local, single-user tool, and a
 * conversion that outlives the process has nothing useful to resume — the CLI
 * is the right tool for unattended work.
 */
export class JobManager extends EventEmitter<JobEvents> {
  private readonly jobs = new Map<string, Job>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly watchers = new Map<string, WatchFolder>()

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  private create(kind: JobKind, target: string): Job {
    const job: Job = {
      id: randomUUID(),
      kind,
      state: 'running',
      target,
      startedAt: new Date().toISOString(),
      results: []
    }
    this.jobs.set(job.id, job)
    this.emit('update', job)
    return job
  }

  private settle(job: Job, state: JobState, message?: string): void {
    job.state = state
    job.finishedAt = new Date().toISOString()
    if (message) job.message = message
    this.controllers.delete(job.id)
    this.emit('update', job)
  }

  /** Converts specific files. Returns immediately; progress arrives by event. */
  startConvert(sources: string[], options: Partial<BatchOptions> = {}): Job {
    const job = this.create('convert', sources.length === 1 ? sources[0]! : `${sources.length} files`)
    const controller = new AbortController()
    this.controllers.set(job.id, controller)

    void (async () => {
      try {
        for (const source of sources) {
          if (controller.signal.aborted) break
          const result = await convertFile({
            ...options,
            sourcePath: source,
            signal: controller.signal,
            onProgress: (event) => {
              job.progress = event
              this.emit('progress', { jobId: job.id, event })
            }
          })
          job.results.push(result)
          this.emit('result', { jobId: job.id, result })
        }
        this.settle(job, controller.signal.aborted ? 'cancelled' : 'done')
      } catch (error) {
        this.settle(job, 'failed', error instanceof Error ? error.message : String(error))
      }
    })()

    return job
  }

  startBatch(inputDir: string, options: Partial<BatchOptions> = {}): Job {
    const job = this.create('batch', inputDir)
    const controller = new AbortController()
    this.controllers.set(job.id, controller)

    void (async () => {
      try {
        await convertFolder(inputDir, {
          ...options,
          signal: controller.signal,
          onProgress: (event) => {
            job.progress = event
            this.emit('progress', { jobId: job.id, event })
          },
          onFileComplete: (result) => {
            job.results.push(result)
            this.emit('result', { jobId: job.id, result })
          }
        })
        this.settle(job, controller.signal.aborted ? 'cancelled' : 'done')
      } catch (error) {
        this.settle(job, 'failed', error instanceof Error ? error.message : String(error))
      }
    })()

    return job
  }

  startWatch(inputDir: string, options: Partial<BatchOptions> = {}): Job {
    const job = this.create('watch', inputDir)
    let watcher: WatchFolder
    try {
      watcher = new WatchFolder(inputDir, options)
    } catch (error) {
      this.settle(job, 'failed', error instanceof Error ? error.message : String(error))
      return job
    }

    this.watchers.set(job.id, watcher)

    watcher.on('progress', (event) => {
      job.progress = event
      this.emit('progress', { jobId: job.id, event })
    })
    watcher.on('converted', (result) => {
      job.results.push(result)
      this.emit('result', { jobId: job.id, result })
      this.emit('update', job)
    })
    watcher.on('error', (error) => {
      job.message = error.message
      this.emit('update', job)
    })

    void watcher.start().catch((error: unknown) => {
      this.settle(job, 'failed', error instanceof Error ? error.message : String(error))
    })

    return job
  }

  /** Stops a running job. Watches are closed; conversions are aborted. */
  async stop(id: string): Promise<boolean> {
    const job = this.jobs.get(id)
    if (!job || job.state !== 'running') return false

    const watcher = this.watchers.get(id)
    if (watcher) {
      await watcher.stop()
      this.watchers.delete(id)
    }
    this.controllers.get(id)?.abort()
    this.settle(job, 'cancelled')
    return true
  }

  /** Closes every watcher — used on server shutdown. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.watchers.values()].map((watcher) => watcher.stop()))
    this.watchers.clear()
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
  }
}
