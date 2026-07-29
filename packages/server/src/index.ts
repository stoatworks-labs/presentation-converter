import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, extname } from 'node:path'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { timingSafeEqual } from 'node:crypto'
import express, { type Request, type Response, type NextFunction } from 'express'
import {
  convertFile,
  describeEngines,
  discoverPresentations,
  readSidecar,
  VERSION,
  type BatchOptions
} from '@presentation-converter/core'
import { JobManager } from './jobs.js'
import { browse, describePath } from './browse.js'
import { registerSettingsRoutes, PUBLIC_SETTINGS_PATHS } from './settingsRoutes.js'
import { collectDiagnostics, init as initDiag, log, say } from './diag/index.js';

// Before anything that can fail, so a failure during startup is logged and
// captured like any other.
initDiag({
  app: 'presentation-converter-server',
  envPrefix: 'PRESENTATION_CONVERTER',
  version: '0.1.0',
});

if (process.argv.includes('--collect-diagnostics')) {
  // stdout, so it can be used in a script; logging went to stderr.
  say.info(collectDiagnostics());
  process.exit(0);
}

export { JobManager, type Job } from './jobs.js'

export interface ServerOptions {
  port?: number
  host?: string
  /** When set, every API request must carry `Authorization: Bearer <token>`. */
  token?: string
}

export interface RunningServer {
  server: Server
  url: string
  jobs: JobManager
  close: () => Promise<void>
}

/** Largest deck the worker endpoint will accept, in bytes. */
const MAX_UPLOAD = 512 * 1024 * 1024

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a)
  const bufferB = Buffer.from(b)
  if (bufferA.length !== bufferB.length) return false
  return timingSafeEqual(bufferA, bufferB)
}

/** Pulls conversion options out of a request body, ignoring anything unknown. */
function optionsFrom(body: Record<string, unknown>): Partial<BatchOptions> {
  const options: Partial<BatchOptions> = {}
  if (typeof body.outputDir === 'string' && body.outputDir.trim()) {
    options.outputDir = resolve(body.outputDir)
  }
  if (body.incremental === false) options.incremental = false
  if (body.skipSidecar === true) options.skipSidecar = true
  if (body.recursive === false) options.recursive = false
  if (body.preserveTree === false) options.preserveTree = false
  if (typeof body.concurrency === 'number') options.concurrency = body.concurrency
  if (typeof body.pdfEngineId === 'string') options.pdfEngineId = body.pdfEngineId
  if (typeof body.notesEngineId === 'string') options.notesEngineId = body.notesEngineId
  if (Array.isArray(body.exclude)) {
    options.exclude = body.exclude.filter((item): item is string => typeof item === 'string')
  }
  return options
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const port = options.port ?? 4747
  const host = options.host ?? '127.0.0.1'
  const jobs = new JobManager()

  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '4mb' }))

  // ---- auth -------------------------------------------------------------
  if (options.token) {
    const expected = options.token
    app.use('/api', (req: Request, res: Response, next: NextFunction) => {
      // The OAuth callback is reached by a browser redirect from Google, which
      // cannot attach an Authorization header. It is protected by its
      // single-use `state` parameter instead.
      if (PUBLIC_SETTINGS_PATHS.includes(req.baseUrl + req.path) || PUBLIC_SETTINGS_PATHS.includes(req.originalUrl.split('?')[0] ?? '')) {
        next()
        return
      }
      const header = req.header('authorization') ?? ''
      const supplied = header.startsWith('Bearer ') ? header.slice(7) : ''
      if (!supplied || !constantTimeEquals(supplied, expected)) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      next()
    })
  }

  registerSettingsRoutes(app)

  // ---- status -----------------------------------------------------------
  app.get('/api/status', async (_req, res) => {
    res.json({
      version: VERSION,
      engines: await describeEngines(),
      jobs: jobs.list()
    })
  })

  app.get('/api/engines', async (_req, res) => {
    res.json({ engines: await describeEngines() })
  })

  // ---- filesystem browsing (for the GUI's picker) -----------------------
  app.get('/api/browse', async (req, res) => {
    try {
      const target = typeof req.query.path === 'string' ? req.query.path : undefined
      res.json(await browse(target))
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/api/inspect', async (req, res) => {
    const target = typeof req.query.path === 'string' ? req.query.path : ''
    if (!target) {
      res.status(400).json({ error: 'path is required' })
      return
    }
    res.json(await describePath(target))
  })

  /** Lists what a batch would convert, so the GUI can preview before starting. */
  app.get('/api/discover', async (req, res) => {
    const target = typeof req.query.path === 'string' ? req.query.path : ''
    if (!target) {
      res.status(400).json({ error: 'path is required' })
      return
    }
    try {
      const files = await discoverPresentations(resolve(target), {
        recursive: req.query.recursive !== 'false'
      })
      res.json({ files })
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  // ---- jobs -------------------------------------------------------------
  app.post('/api/convert', (req, res) => {
    const sources = Array.isArray(req.body?.sources)
      ? (req.body.sources as unknown[]).filter((s): s is string => typeof s === 'string')
      : []
    if (sources.length === 0) {
      res.status(400).json({ error: 'sources must be a non-empty array of paths' })
      return
    }
    res.json(jobs.startConvert(sources.map((s) => resolve(s)), optionsFrom(req.body ?? {})))
  })

  app.post('/api/batch', (req, res) => {
    const inputDir = typeof req.body?.inputDir === 'string' ? req.body.inputDir : ''
    if (!inputDir) {
      res.status(400).json({ error: 'inputDir is required' })
      return
    }
    res.json(jobs.startBatch(resolve(inputDir), optionsFrom(req.body ?? {})))
  })

  app.post('/api/watch', (req, res) => {
    const inputDir = typeof req.body?.inputDir === 'string' ? req.body.inputDir : ''
    if (!inputDir) {
      res.status(400).json({ error: 'inputDir is required' })
      return
    }
    res.json(jobs.startWatch(resolve(inputDir), optionsFrom(req.body ?? {})))
  })

  app.get('/api/jobs', (_req, res) => res.json({ jobs: jobs.list() }))

  app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id)
    if (!job) {
      res.status(404).json({ error: 'No such job' })
      return
    }
    res.json(job)
  })

  app.post('/api/jobs/:id/stop', async (req, res) => {
    const stopped = await jobs.stop(req.params.id)
    res.status(stopped ? 200 : 404).json({ stopped })
  })

  // ---- progress stream --------------------------------------------------
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    })
    // Nothing has happened yet on a fresh connection; send the current state so
    // a reloaded GUI is immediately correct rather than blank until the next event.
    res.write(`event: snapshot\ndata: ${JSON.stringify({ jobs: jobs.list() })}\n\n`)

    const send = (event: string, payload: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    }
    const onUpdate = (job: unknown): void => send('job', job)
    const onProgress = (payload: unknown): void => send('progress', payload)
    const onResult = (payload: unknown): void => send('result', payload)

    jobs.on('update', onUpdate)
    jobs.on('progress', onProgress)
    jobs.on('result', onResult)

    // Proxies and browsers drop an idle event-stream; a comment keeps it warm.
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000)

    req.on('close', () => {
      clearInterval(keepAlive)
      jobs.off('update', onUpdate)
      jobs.off('progress', onProgress)
      jobs.off('result', onResult)
    })
  })

  // ---- sidecar read (so the GUI can show what was produced) -------------
  app.get('/api/sidecar', async (req, res) => {
    const target = typeof req.query.path === 'string' ? req.query.path : ''
    if (!target) {
      res.status(400).json({ error: 'path is required' })
      return
    }
    const sidecar = await readSidecar(resolve(target))
    if (!sidecar) {
      res.status(404).json({ error: 'No sidecar at that path' })
      return
    }
    res.json(sidecar)
  })

  // ---- worker endpoint --------------------------------------------------
  /**
   * Converts an uploaded deck and returns the PDF inline.
   *
   * This is what the Nextcloud app calls for `.key` files, which cannot be
   * converted on a Linux host at all — the request is forwarded to a Mac
   * running `presentation-converter serve`. The body is the raw file rather
   * than multipart because both ends are ours, and raw keeps the PHP side to a
   * single stream copy.
   */
  app.post(
    '/api/worker/convert',
    express.raw({ type: '*/*', limit: MAX_UPLOAD }),
    async (req, res) => {
      const filename = req.header('x-filename')
      if (!filename) {
        res.status(400).json({ error: 'x-filename header is required' })
        return
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: 'Request body must be the presentation file' })
        return
      }

      // Keep only the basename; a caller-supplied path must never escape the
      // temporary working directory.
      const safeName = filename.replace(/[/\\]/g, '_')
      if (!extname(safeName)) {
        res.status(400).json({ error: 'x-filename must include a file extension' })
        return
      }

      const workDir = await mkdtemp(join(tmpdir(), 'presentation-converter-worker-'))
      const sourcePath = join(workDir, safeName)

      try {
        await writeFile(sourcePath, req.body)
        const result = await convertFile({
          sourcePath,
          outputDir: workDir,
          incremental: false
        })

        if (result.status !== 'ok' || !result.pdfPath) {
          res.status(422).json({ result })
          return
        }

        const pdf = await readFile(result.pdfPath)
        const sidecar = result.sidecarPath ? await readSidecar(result.sidecarPath) : undefined

        res.json({
          result,
          pdfBase64: pdf.toString('base64'),
          sidecar: sidecar?.sidecar ?? null
        })
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        await rm(workDir, { recursive: true, force: true })
      }
    }
  )

  app.get('/api/worker/health', async (_req, res) => {
    res.json({ version: VERSION, engines: await describeEngines() })
  })

  // ---- GUI --------------------------------------------------------------
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist')
  app.use(express.static(webRoot))
  // Anything not matched above is the single-page app.
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(join(webRoot, 'index.html'), (error) => {
      if (error) {
        res
          .status(404)
          .type('text/plain')
          .send('GUI not built. Run `npm run build` to build the web interface.')
      }
    })
  })

  const server = createServer(app)

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolvePromise()
    })
  })

  const displayHost = host === '0.0.0.0' ? 'localhost' : host

  return {
    server,
    url: `http://${displayHost}:${port}`,
    jobs,
    close: async () => {
      await jobs.shutdown()
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    }
  }
}
