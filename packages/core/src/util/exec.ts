import { execFile } from 'node:child_process'
import { platform } from 'node:os'

export interface RunResult {
  stdout: string
  stderr: string
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

/**
 * Runs a command without a shell, so arguments containing spaces, quotes or
 * `$` need no escaping — which matters because every path here comes from a
 * user's filesystem and event decks are full of spaces and ampersands.
 */
export function run(
  file: string,
  args: string[],
  options: { timeoutMs?: number; signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        timeout: options.timeoutMs ?? 0,
        signal: options.signal,
        cwd: options.cwd,
        env: options.env ?? process.env,
        maxBuffer: 32 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & { code?: number | string }
          if (err.name === 'AbortError') {
            reject(new CommandError(`${file} was cancelled`, null, stderr))
            return
          }
          const killed = (error as { killed?: boolean }).killed
          if (killed && options.timeoutMs) {
            reject(
              new CommandError(
                `${file} timed out after ${options.timeoutMs}ms`,
                null,
                stderr
              )
            )
            return
          }
          reject(
            new CommandError(
              stderr.trim() || error.message,
              typeof err.code === 'number' ? err.code : null,
              stderr
            )
          )
          return
        }
        resolve({ stdout, stderr })
      }
    )
    child.on('error', (error) => reject(new CommandError(error.message, null, '')))
  })
}

export const isMacOS = (): boolean => platform() === 'darwin'
export const isWindows = (): boolean => platform() === 'win32'

/**
 * Runs a JXA script via osascript. JXA rather than AppleScript so results come
 * back as real JSON instead of hand-parsed AppleScript list text — the same
 * approach presentation-commander-client uses for its Keynote bridge.
 */
export async function runJxa(
  script: string,
  args: string[] = [],
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', script, ...args], options)
  return stdout.trim()
}

/**
 * Runs an AppleScript via osascript. The PowerPoint engine's export was proved
 * in AppleScript, so that is what it stays in.
 */
export async function runAppleScript(
  script: string,
  args: string[] = [],
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const { stdout } = await run('osascript', ['-e', script, ...args], options)
  return stdout.trim()
}

export interface MacApp {
  bundleId: string
  /** The `.app` bundle Launch Services would launch for this id. */
  path: string
  /** `CFBundleShortVersionString`, read from the bundle. */
  version?: string
}

const MAC_APP_SCRIPT = `ObjC.import("AppKit")
function run(a) {
  var u = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier($(a[0]))
  if (!u || u.isNil()) return "{}"
  var b = $.NSBundle.bundleWithURL(u)
  var v = b.isNil() ? null : b.objectForInfoDictionaryKey($("CFBundleShortVersionString"))
  return JSON.stringify({ path: ObjC.unwrap(u.path), version: v && !v.isNil() ? ObjC.unwrap(v) : "" })
}`

/**
 * Where an app is installed, and its version, found by bundle id without
 * launching it — so a probe never starts Keynote or PowerPoint, and never
 * triggers an Automation prompt. Null when it is not installed.
 */
export async function macAppInfo(bundleId: string): Promise<MacApp | null> {
  if (!isMacOS()) return null
  try {
    const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', MAC_APP_SCRIPT, bundleId], {
      timeoutMs: 10_000
    })
    const found = JSON.parse(stdout.trim()) as { path?: string; version?: string }
    if (!found.path) return null
    return { bundleId, path: found.path, ...(found.version ? { version: found.version } : {}) }
  } catch {
    return null
  }
}

/** The name an app shows in Finder: its bundle's file name without `.app`. */
export function macAppName(app: MacApp): string {
  return (app.path.split('/').pop() ?? app.bundleId).replace(/\.app$/, '')
}

/** "Keynote Creator Studio 15.3.1 (com.apple.Keynote)", for `doctor`. */
export function describeMacApp(app: MacApp): string {
  return `${[macAppName(app), app.version].filter(Boolean).join(' ')} (${app.bundleId})`
}

/**
 * What osascript said, without its wrapping: `execution error: Error: Error:`
 * in front and the script's line and column. The error number stays, since
 * it is the part worth searching for (-1743 is Automation, -1712 a timeout).
 */
export function osascriptMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/^.*?execution error:\s*/s, '')
    .replace(/^(Error:\s*)+/, '')
    .trim()
}
