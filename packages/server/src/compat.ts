/**
 * Re-exports the path helpers the server needs.
 *
 * Kept in one place so the server has a single import surface onto core, which
 * makes it obvious what the HTTP layer depends on.
 */
export {
  isPresentation,
  isInside,
  formatForPath,
  sidecarPathFor,
  pdfPathFor,
  stemOf
} from '@presentation-converter/core'

import { formatForPath } from '@presentation-converter/core'
import { basename } from 'node:path'

/** Office lock files and resource forks that would otherwise look convertible. */
export function isIgnoredFile(path: string): boolean {
  const name = basename(path)
  return name.startsWith('~$') || name.startsWith('._') || name.startsWith('.')
}

export function looksConvertible(path: string): boolean {
  return formatForPath(path) !== undefined && !isIgnoredFile(path)
}
