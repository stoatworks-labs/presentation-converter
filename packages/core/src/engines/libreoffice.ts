import { access, mkdtemp, rename, rm, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { run, isMacOS, isWindows } from '../util/exec.js'
import { stemOf } from '../util/paths.js'
import type { EngineAvailability, PdfEngine, PdfRenderResult, RenderOptions } from '../types.js'

/** Overrides discovery entirely; useful in containers and on the Nextcloud host. */
const SOFFICE_ENV = 'PRESENTATION_CONVERTER_SOFFICE'

const CANDIDATE_PATHS = (): string[] => {
  if (isMacOS()) {
    return [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/opt/homebrew/bin/soffice',
      '/usr/local/bin/soffice'
    ]
  }
  if (isWindows()) {
    return [
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
    ]
  }
  return [
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/usr/lib/libreoffice/program/soffice',
    '/snap/bin/libreoffice',
    '/opt/libreoffice/program/soffice'
  ]
}

let cachedBinary: string | null | undefined

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Locates `soffice`, preferring an explicit override, then PATH, then the usual install roots. */
export async function findSoffice(): Promise<string | null> {
  if (cachedBinary !== undefined) return cachedBinary

  const override = process.env[SOFFICE_ENV]
  if (override) {
    cachedBinary = (await isExecutable(override)) ? override : null
    return cachedBinary
  }

  for (const name of ['soffice', 'libreoffice']) {
    try {
      const { stdout } = await run(isWindows() ? 'where' : 'which', [name], { timeoutMs: 5000 })
      const found = stdout.trim().split('\n')[0]?.trim()
      if (found && (await isExecutable(found))) {
        cachedBinary = found
        return cachedBinary
      }
    } catch {
      // Not on PATH; fall through to the well-known locations.
    }
  }

  for (const candidate of CANDIDATE_PATHS()) {
    if (await isExecutable(candidate)) {
      cachedBinary = candidate
      return cachedBinary
    }
  }

  cachedBinary = null
  return cachedBinary
}

/** Clears the discovery cache. Used by tests and after a user changes the setting. */
export function resetSofficeCache(): void {
  cachedBinary = undefined
}

/**
 * Runs a headless conversion and returns the produced file's path.
 *
 * Every invocation gets a private `UserInstallation` profile: LibreOffice
 * refuses to start a second instance against a profile that is already in use,
 * so without this a batch running two files at once fails intermittently rather
 * than simply queueing.
 */
async function convert(
  binary: string,
  sourcePath: string,
  targetExtension: string,
  filter: string | undefined,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), 'presentation-converter-lo-'))
  const outDir = join(workDir, 'out')
  const profileDir = join(workDir, 'profile')
  await mkdir(outDir, { recursive: true })

  const convertTo = filter ? `${targetExtension}:${filter}` : targetExtension

  try {
    await run(
      binary,
      [
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        '--headless',
        '--norestore',
        '--invisible',
        '--nolockcheck',
        '--nodefault',
        '--nologo',
        '--convert-to',
        convertTo,
        '--outdir',
        outDir,
        sourcePath
      ],
      { timeoutMs: options.timeoutMs ?? 300_000, signal: options.signal }
    )

    const produced = join(outDir, `${stemOf(sourcePath)}.${targetExtension}`)
    try {
      await access(produced, constants.R_OK)
    } catch {
      throw new Error(
        `LibreOffice reported success but produced no ${targetExtension.toUpperCase()} for ${sourcePath}. ` +
          'The file may be password-protected or corrupt.'
      )
    }
    return produced
  } catch (error) {
    await rm(workDir, { recursive: true, force: true })
    throw error
  }
}

/** Moves across filesystems, which `rename` cannot do when /tmp is a separate mount. */
async function moveFile(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  try {
    await rename(from, to)
  } catch {
    const { copyFile, unlink } = await import('node:fs/promises')
    await copyFile(from, to)
    await unlink(from)
  }
}

/**
 * Converts a legacy `.ppt` to `.pptx` so its notes can be read as OOXML.
 *
 * The binary PowerPoint format has no practical pure-JS parser, but the notes
 * survive the round-trip through LibreOffice intact, which is enough to keep
 * `.ppt` decks working without a second extraction implementation.
 */
export async function convertToPptx(
  sourcePath: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<{ pptxPath: string; cleanup: () => Promise<void> }> {
  const binary = await findSoffice()
  if (!binary) {
    throw new Error(
      'LibreOffice is required to read notes from legacy .ppt files but was not found. ' +
        `Install LibreOffice or set ${SOFFICE_ENV}.`
    )
  }
  const produced = await convert(binary, sourcePath, 'pptx', undefined, options)
  const workDir = dirname(dirname(produced))
  return {
    pptxPath: produced,
    cleanup: () => rm(workDir, { recursive: true, force: true })
  }
}

export const libreOfficeEngine: PdfEngine = {
  id: 'libreoffice',
  label: 'LibreOffice (headless)',
  formats: ['pptx', 'ppt', 'odp'],
  // A single soffice process per conversion; parallelism comes from running
  // several, each with its own profile. Two is a safe default on a shared
  // Nextcloud host, where this competes with the web server for CPU.
  maxConcurrency: 2,

  async probe(): Promise<EngineAvailability> {
    const binary = await findSoffice()
    if (!binary) {
      return {
        available: false,
        reason: `LibreOffice not found. Install it, or set ${SOFFICE_ENV} to the soffice binary.`
      }
    }
    try {
      const { stdout } = await run(binary, ['--version'], { timeoutMs: 30_000 })
      return { available: true, version: stdout.trim().split('\n')[0] }
    } catch {
      // Present but not answering --version; still worth attempting a convert.
      return { available: true }
    }
  },

  async render(options: RenderOptions): Promise<PdfRenderResult> {
    const binary = await findSoffice()
    if (!binary) throw new Error('LibreOffice is not available')

    const produced = await convert(binary, options.sourcePath, 'pdf', 'impress_pdf_Export', {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {})
    })
    const workDir = dirname(dirname(produced))
    try {
      await moveFile(produced, options.outputPath)
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
    return { pdfPath: options.outputPath, engine: libreOfficeEngine.id }
  }
}
