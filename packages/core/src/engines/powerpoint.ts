import { copyFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  runAppleScript,
  macAppInfo,
  describeMacApp,
  osascriptMessage,
  isMacOS
} from '../util/exec.js'
import type { EngineAvailability, PdfEngine, PdfRenderResult, RenderOptions } from '../types.js'

const POWERPOINT_BUNDLE_ID = 'com.microsoft.Powerpoint'

/**
 * The one folder a sandboxed PowerPoint may write to without asking. Asked to
 * save anywhere else it stops to ask for the folder ("Grant File Access"),
 * which nobody is there to answer, so the deck is copied in here and the PDF
 * exported beside it.
 */
export function powerPointScratchRoot(home = homedir()): string {
  return join(home, 'Library', 'Containers', POWERPOINT_BUNDLE_ID, 'Data', 'tmp')
}

/**
 * Opens the copy, finds it by its own name, saves it as PDF, closes it
 * unsaved, and quits PowerPoint only if this started it and nothing else is
 * open in it.
 *
 * - The copy's name is unique, and the presentation is found by it — never
 *   `active presentation`, which is whatever the user last clicked if they
 *   have PowerPoint open.
 * - The `POSIX file` references are made outside the `tell` block. Inside it
 *   they are resolved by the app, and a sandboxed app is handed a file it may
 *   not read: Keynote Creator Studio answers that with "can't be imported".
 *   PowerPoint gets away with it because the copy is in its own container,
 *   but there is no reason to rely on that.
 * - `save … as save as PDF` is PowerPoint's export. Its PDF leaves hidden
 *   slides out, which `sidecar.ts` reconciles from the deck's own XML.
 */
export const POWERPOINT_SCRIPT = `on run argv
  set inFile to POSIX file (item 1 of argv)
  set outFile to POSIX file (item 2 of argv)
  set docName to item 3 of argv
  set wasRunning to application id "${POWERPOINT_BUNDLE_ID}" is running
  with timeout of 3600 seconds
    tell application id "${POWERPOINT_BUNDLE_ID}"
      open inFile
      set thePres to presentation docName
      try
        save thePres in outFile as save as PDF
      on error msg number n
        close thePres saving no
        if not wasRunning and (count of presentations) is 0 then quit
        error msg number n
      end try
      close thePres saving no
      if not wasRunning and (count of presentations) is 0 then quit
    end tell
  end timeout
  return "ok"
end run`

/** AppleScript's errors, in words someone can act on. */
export function explainPowerPointError(error: unknown): string {
  const said = osascriptMessage(error)
  if (/-1743|Not authori[sz]ed to send Apple events/i.test(said)) {
    return (
      'macOS has not let this process control PowerPoint. Allow it in System Settings ▸ ' +
      'Privacy & Security ▸ Automation, then try again.'
    )
  }
  if (/-1712|timed out/i.test(said)) return `PowerPoint did not finish: ${said}. Is a dialog open in it?`
  return `PowerPoint could not export the deck: ${said}`
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

export const powerPointEngine: PdfEngine = {
  id: 'powerpoint',
  label: 'PowerPoint (macOS)',
  formats: ['pptx', 'ppt'],
  // One app, one export at a time: a second would be a second document in the
  // same PowerPoint, and the copy-and-find-by-name dance assumes it is alone.
  maxConcurrency: 1,

  async probe(): Promise<EngineAvailability> {
    if (!isMacOS()) {
      return { available: false, reason: 'PowerPoint is only driven on macOS' }
    }
    const app = await macAppInfo(POWERPOINT_BUNDLE_ID)
    if (!app) return { available: false, reason: 'PowerPoint is not installed' }
    return { available: true, version: describeMacApp(app) }
  },

  async render(options: RenderOptions): Promise<PdfRenderResult> {
    const root = powerPointScratchRoot()
    await mkdir(root, { recursive: true })
    const workDir = await mkdtemp(join(root, 'presentation-converter-'))
    const name = `pc-${randomBytes(6).toString('hex')}${extname(options.sourcePath).toLowerCase()}`
    const deck = join(workDir, name)
    const pdf = join(workDir, `${name.replace(/\.[^.]+$/, '')}.pdf`)

    try {
      await copyFile(options.sourcePath, deck)
      try {
        await runAppleScript(POWERPOINT_SCRIPT, [deck, pdf, name], {
          timeoutMs: options.timeoutMs ?? 600_000,
          ...(options.signal ? { signal: options.signal } : {})
        })
      } catch (error) {
        throw new Error(explainPowerPointError(error), { cause: error })
      }
      if (!(await exists(pdf))) {
        throw new Error(
          `PowerPoint reported success but produced no PDF for ${options.sourcePath}. ` +
            'The file may be password-protected or corrupt.'
        )
      }
      await mkdir(dirname(options.outputPath), { recursive: true })
      await copyFile(pdf, options.outputPath)
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
    return { pdfPath: options.outputPath, engine: powerPointEngine.id }
  }
}
