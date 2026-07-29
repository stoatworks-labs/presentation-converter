import { relative } from 'node:path'
import type { ConversionResult } from '@presentation-converter/core'

const isTTY = process.stdout.isTTY === true
const useColour = isTTY && !process.env.NO_COLOR

const paint = (code: string, text: string): string =>
  useColour ? `\u001b[${code}m${text}\u001b[0m` : text

export const dim = (text: string): string => paint('2', text)
export const bold = (text: string): string => paint('1', text)
export const green = (text: string): string => paint('32', text)
export const yellow = (text: string): string => paint('33', text)
export const red = (text: string): string => paint('31', text)
export const cyan = (text: string): string => paint('36', text)

export function shortPath(path: string): string {
  // A cloud source is a URL, not a path. `relative` resolves it against the
  // working directory and mangles it into "https:/host/..." — show it as-is.
  if (/^https?:\/\//i.test(path)) return path
  const rel = relative(process.cwd(), path)
  return rel && !rel.startsWith('..') ? rel : path
}

const STATUS_MARK: Record<ConversionResult['status'], string> = {
  ok: green('✓'),
  skipped: dim('–'),
  failed: red('✗')
}

/** One line per file, in the shape people expect from a build tool. */
export function formatResult(result: ConversionResult): string {
  const mark = STATUS_MARK[result.status]
  const name = shortPath(result.sourcePath)

  if (result.status === 'failed') {
    return `${mark} ${name}\n  ${red(result.message ?? 'failed')}`
  }
  if (result.status === 'skipped') {
    return `${mark} ${name} ${dim(result.message ?? 'skipped')}`
  }

  const bits: string[] = []
  if (result.pageCount !== undefined) bits.push(`${result.pageCount} pages`)
  if (result.notedSlides !== undefined) bits.push(`${result.notedSlides} notes`)
  if (result.engines) bits.push(`${result.engines.pdf}/${result.engines.notes}`)

  let line = `${mark} ${name} ${dim(bits.join(' · '))}`
  if (result.alignment === 'mismatch') {
    line += `\n  ${yellow('! notes may be misaligned — see the sidecar warnings')}`
  }
  for (const warning of result.warnings) {
    line += `\n  ${yellow(`! ${warning}`)}`
  }
  return line
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`
}
