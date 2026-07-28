import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, dirname, parse } from 'node:path'
import { isPresentation, isIgnoredFile } from './compat.js'

export interface BrowseEntry {
  name: string
  path: string
  isDirectory: boolean
  isPresentation: boolean
}

export interface BrowseResult {
  path: string
  parent: string | null
  entries: BrowseEntry[]
  shortcuts: Array<{ name: string; path: string }>
}

/**
 * Lists a directory for the GUI's folder picker.
 *
 * The GUI runs in a browser, which cannot hand back a real filesystem path from
 * a native file input, so picking is done server-side. That is safe here only
 * because the server binds to localhost by default and requires a token when it
 * does not — see `startServer`.
 */
export async function browse(target?: string): Promise<BrowseResult> {
  const home = homedir()
  const path = resolve(target && target.trim() ? target : home)

  const shortcuts = [
    { name: 'Home', path: home },
    { name: 'Desktop', path: join(home, 'Desktop') },
    { name: 'Documents', path: join(home, 'Documents') },
    { name: 'Downloads', path: join(home, 'Downloads') }
  ]

  const entries: BrowseEntry[] = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || isIgnoredFile(entry.name)) continue
    const full = join(path, entry.name)

    // A Keynote document is a bundle — a directory that should read as a file.
    const looksLikeDeck = isPresentation(full)
    entries.push({
      name: entry.name,
      path: full,
      isDirectory: entry.isDirectory() && !looksLikeDeck,
      isPresentation: looksLikeDeck
    })
  }

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true })
  })

  const parent = parse(path).root === path ? null : dirname(path)

  return { path, parent, entries, shortcuts }
}

/** Confirms a path exists and says whether it is a directory. */
export async function describePath(
  target: string
): Promise<{ exists: boolean; isDirectory: boolean }> {
  try {
    const info = await stat(resolve(target))
    return { exists: true, isDirectory: info.isDirectory() }
  } catch {
    return { exists: false, isDirectory: false }
  }
}
