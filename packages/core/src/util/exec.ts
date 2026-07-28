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

/** True when an app bundle is installed, checked without launching it. */
export async function macAppInstalled(bundleId: string): Promise<boolean> {
  if (!isMacOS()) return false
  try {
    const { stdout } = await run(
      'osascript',
      ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); function run(a){ return $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier($(a[0])) ? "yes" : "no" }', bundleId],
      { timeoutMs: 10_000 }
    )
    return stdout.trim() === 'yes'
  } catch {
    return false
  }
}
