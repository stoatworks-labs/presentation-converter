#!/usr/bin/env node
import { resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { Command, Option } from 'commander'
import {
  convertFile,
  convertFolder,
  discoverPresentations,
  describeEngines,
  WatchFolder,
  VERSION,
  type BatchOptions,
  type ConversionResult
} from '@presentation-converter/core'
import { formatResult, formatDuration, bold, dim, green, red, yellow, cyan, shortPath } from './format.js'

const program = new Command()

program
  .name('presentation-converter')
  .description(
    'Convert Keynote, PowerPoint, Google Slides and ODP presentations to PDF,\n' +
      'with a .notes.json sidecar holding the presenter notes.'
  )
  .version(VERSION)

/*
 * The same facts as the About window in the web UI and every other Stoatworks
 * Labs product, for a terminal. The links are duplicated from
 * packages/web/public/about-data.js rather than imported: that file is a
 * browser global written by stoatworks-backend's sync-about.py, and the CLI has
 * no DOM to run it in.
 */
program
  .command('about')
  .description('show the version, the documentation links and how to support the work')
  .action(() => {
    const rows: Array<[string, string]> = [
      ['User guide', 'https://stoatworks-labs.com/software/presentation-converter/guide/'],
      ['Project page', 'https://stoatworks-labs.com/software/presentation-converter/'],
      ['Source on GitHub', 'https://github.com/stoatworks-labs/presentation-converter']
    ]
    const funding: Array<[string, string]> = [
      ['GitHub Sponsors', 'https://github.com/sponsors/stoatworks-labs'],
      ['Ko-fi', 'https://ko-fi.com/stoatworkslabs'],
      ['Patreon', 'https://patreon.com/StoatworksLabs'],
      ['Liberapay', 'https://liberapay.com/stoatworks-labs']
    ]
    const pad = (items: Array<[string, string]>): number =>
      items.reduce((width, [label]) => Math.max(width, label.length), 0)

    console.log(`${bold('Presentation Converter')} v${VERSION}`)
    console.log('Decks in, PDF and presenter notes out')
    console.log('MIT licensed')
    console.log()
    for (const [label, url] of rows) console.log(`  ${label.padEnd(pad(rows))}  ${dim(url)}`)
    console.log()
    console.log('Support the work:')
    for (const [label, url] of funding) console.log(`  ${label.padEnd(pad(funding))}  ${dim(url)}`)
    console.log()
    console.log(dim('Stoatworks Labs — Open tools for the people who run the show.'))
    console.log(dim('https://stoatworks-labs.com'))
  })

/** Options every conversion command shares. */
function addConversionOptions(command: Command): Command {
  return command
    .option('-o, --out-dir <dir>', 'write PDFs to this directory instead of beside the source')
    .option('--force', 'reconvert even when the output is already up to date')
    .option('--no-sidecar', 'write only the PDF, no .notes.json')
    .option('--pdf-engine <id>', 'force a PDF engine (keynote, libreoffice, google-slides)')
    .option('--notes-engine <id>', 'force a notes engine (keynote, package-xml, google-slides)')
    .option('--timeout <seconds>', 'per-file timeout', (value) => Number(value) * 1000)
    .option('--json', 'emit machine-readable JSON instead of human output')
    .option('-q, --quiet', 'only report failures')
}

interface CommonOptions {
  outDir?: string
  force?: boolean
  sidecar?: boolean
  pdfEngine?: string
  notesEngine?: string
  timeout?: number
  json?: boolean
  quiet?: boolean
}

function conversionOptionsFrom(options: CommonOptions): Partial<BatchOptions> {
  return {
    ...(options.outDir ? { outputDir: resolve(options.outDir) } : {}),
    ...(options.force ? { incremental: false } : {}),
    ...(options.sidecar === false ? { skipSidecar: true } : {}),
    ...(options.pdfEngine ? { pdfEngineId: options.pdfEngine } : {}),
    ...(options.notesEngine ? { notesEngineId: options.notesEngine } : {}),
    ...(options.timeout ? { timeoutMs: options.timeout } : {})
  }
}

/** Non-zero when anything failed, so scripts and the Nextcloud job can detect it. */
function exitCodeFor(results: ConversionResult[]): number {
  return results.some((result) => result.status === 'failed') ? 1 : 0
}

function printSummary(results: ConversionResult[], durationMs: number): void {
  const ok = results.filter((r) => r.status === 'ok').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  const failed = results.filter((r) => r.status === 'failed').length

  const parts = [green(`${ok} converted`)]
  if (skipped > 0) parts.push(dim(`${skipped} up to date`))
  if (failed > 0) parts.push(red(`${failed} failed`))

  process.stderr.write(`\n${parts.join('  ')}  ${dim(`in ${formatDuration(durationMs)}`)}\n`)
}

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

addConversionOptions(
  program
    .command('convert')
    .argument('<sources...>', 'presentation files, or Google Slides URLs/ids')
    .description('convert one or more presentations')
).action(async (sources: string[], options: CommonOptions) => {
  const startedAt = Date.now()
  const results: ConversionResult[] = []

  for (const source of sources) {
    // A Google Slides URL or bare file id is not a path; leave it untouched.
    const isLocal = !/^https?:\/\//.test(source)
    const sourcePath = isLocal ? resolve(source) : source

    const result = await convertFile({
      sourcePath,
      ...conversionOptionsFrom(options)
    })
    results.push(result)
    if (!options.json && (!options.quiet || result.status === 'failed')) {
      process.stdout.write(`${formatResult(result)}\n`)
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ results, durationMs: Date.now() - startedAt }, null, 2)}\n`)
  } else if (results.length > 1) {
    printSummary(results, Date.now() - startedAt)
  }

  process.exitCode = exitCodeFor(results)
})

// ---------------------------------------------------------------------------
// batch
// ---------------------------------------------------------------------------

addConversionOptions(
  program
    .command('batch')
    .argument('<dir>', 'folder to convert')
    .description('convert every presentation in a folder')
    .option('--no-recursive', 'do not descend into subfolders')
    .option('--flat', 'write all output into the output directory without mirroring subfolders')
    .option('-c, --concurrency <n>', 'how many files to convert at once', (v) => Number(v), 4)
    .option('--exclude <text...>', 'skip paths containing this text')
    .option('--dry-run', 'list what would be converted, then stop')
).action(
  async (
    dir: string,
    options: CommonOptions & {
      recursive?: boolean
      flat?: boolean
      concurrency?: number
      exclude?: string[]
      dryRun?: boolean
    }
  ) => {
    const root = resolve(dir)

    if (options.dryRun) {
      const files = await discoverPresentations(root, {
        ...(options.recursive === false ? { recursive: false } : {}),
        ...(options.exclude ? { exclude: options.exclude } : {})
      })
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ files: files.map((f) => f.path) }, null, 2)}\n`)
      } else {
        for (const file of files) process.stdout.write(`${shortPath(file.path)}\n`)
        process.stderr.write(`\n${files.length} presentation(s) found\n`)
      }
      return
    }

    const result = await convertFolder(root, {
      ...conversionOptionsFrom(options),
      ...(options.recursive === false ? { recursive: false } : {}),
      ...(options.flat ? { preserveTree: false } : {}),
      ...(options.concurrency ? { concurrency: options.concurrency } : {}),
      ...(options.exclude ? { exclude: options.exclude } : {}),
      onFileComplete: (file) => {
        if (!options.json && (!options.quiet || file.status === 'failed')) {
          process.stdout.write(`${formatResult(file)}\n`)
        }
      }
    })

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      printSummary(result.results, result.durationMs)
    }

    process.exitCode = exitCodeFor(result.results)
  }
)

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

addConversionOptions(
  program
    .command('watch')
    .argument('<dir>', 'folder to watch')
    .description('watch a folder and convert presentations as they appear or change')
    .option('--no-recursive', 'do not watch subfolders')
    .option('--flat', 'write all output into the output directory without mirroring subfolders')
    .option('-c, --concurrency <n>', 'how many files to convert at once', (v) => Number(v), 2)
    .option('--exclude <text...>', 'skip paths containing this text')
    .option('--no-existing', 'ignore files already present when the watch starts')
    .option('--stability <ms>', 'how long a file must stop changing before converting', (v) => Number(v), 2000)
).action(
  async (
    dir: string,
    options: CommonOptions & {
      recursive?: boolean
      flat?: boolean
      concurrency?: number
      exclude?: string[]
      existing?: boolean
      stability?: number
    }
  ) => {
    const root = resolve(dir)
    const info = await stat(root).catch(() => undefined)
    if (!info?.isDirectory()) {
      process.stderr.write(`${red(`${root} is not a directory`)}\n`)
      process.exitCode = 1
      return
    }

    const watcher = new WatchFolder(root, {
      ...conversionOptionsFrom(options),
      ...(options.recursive === false ? { recursive: false } : {}),
      ...(options.flat ? { preserveTree: false } : {}),
      ...(options.concurrency ? { concurrency: options.concurrency } : {}),
      ...(options.exclude ? { exclude: options.exclude } : {}),
      ...(options.existing === false ? { convertExisting: false } : {}),
      ...(options.stability !== undefined ? { stabilityThresholdMs: options.stability } : {})
    })

    watcher.on('converted', (result) => {
      if (options.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`)
      } else if (!options.quiet || result.status === 'failed') {
        process.stdout.write(`${formatResult(result)}\n`)
      }
    })
    watcher.on('error', (error) => {
      process.stderr.write(`${red(error.message)}\n`)
    })

    await watcher.start()
    if (!options.json) {
      process.stderr.write(`${cyan('Watching')} ${shortPath(root)} ${dim('— press Ctrl-C to stop')}\n`)
    }

    const shutdown = (): void => {
      void watcher.stop().then(() => process.exit(0))
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }
)

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

program
  .command('serve')
  .description('run the HTTP API and GUI (also the macOS worker endpoint for the Nextcloud app)')
  .option('-p, --port <n>', 'port to listen on', (v) => Number(v), 4747)
  .option('--host <host>', 'address to bind', '127.0.0.1')
  .addOption(
    new Option('--token <token>', 'require this bearer token on every request').env(
      'PRESENTATION_CONVERTER_TOKEN'
    )
  )
  .option('--allow-remote', 'bind to all interfaces (implies a token is strongly advised)')
  .action(async (options: { port: number; host: string; token?: string; allowRemote?: boolean }) => {
    const { startServer } = await import('@presentation-converter/server')
    const host = options.allowRemote ? '0.0.0.0' : options.host

    if (options.allowRemote && !options.token) {
      process.stderr.write(
        `${yellow('Warning:')} --allow-remote without --token leaves conversion open to anyone who can reach this port.\n`
      )
    }

    const { url } = await startServer({
      port: options.port,
      host,
      ...(options.token ? { token: options.token } : {})
    })
    process.stderr.write(`${cyan('presentation-converter')} listening on ${bold(url)}\n`)
  })

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

program
  .command('doctor')
  .description('report which conversion engines are available on this machine')
  .option('--json', 'emit machine-readable JSON')
  .action(async (options: { json?: boolean }) => {
    const engines = await describeEngines()

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ version: VERSION, engines }, null, 2)}\n`)
      return
    }

    process.stdout.write(`${bold(`presentation-converter ${VERSION}`)}\n\n`)
    for (const kind of ['pdf', 'notes'] as const) {
      process.stdout.write(`${bold(kind === 'pdf' ? 'PDF engines' : 'Notes engines')}\n`)
      for (const engine of engines.filter((e) => e.kind === kind)) {
        const mark = engine.availability.available ? green('✓') : red('✗')
        const detail = engine.availability.available
          ? dim(engine.availability.version ?? '')
          : yellow(engine.availability.reason ?? 'unavailable')
        process.stdout.write(
          `  ${mark} ${engine.label} ${dim(`[${engine.formats.join(', ')}]`)}\n` +
            (detail ? `      ${detail}\n` : '')
        )
      }
      process.stdout.write('\n')
    }

    const anyPdf = engines.some((e) => e.kind === 'pdf' && e.availability.available)
    if (!anyPdf) {
      process.stdout.write(
        `${red('No PDF engine is available.')} Install LibreOffice, or run on a Mac with Keynote.\n`
      )
      process.exitCode = 1
    }
  })

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${red(error instanceof Error ? error.message : String(error))}\n`)
  process.exit(1)
})
