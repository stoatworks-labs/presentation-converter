import { readFile } from 'node:fs/promises'
import { unzipSync, strFromU8 } from 'fflate'

/**
 * Reads an entire zip container into memory.
 *
 * Presentations are read-only inputs here and even a large deck's XML is a few
 * MB, so a whole-file read keeps the notes extractors free of streaming state.
 * The slide media (the bulk of a deck's size) is skipped by `filter`.
 */
export class ZipArchive {
  private constructor(private readonly entries: Record<string, Uint8Array>) {}

  static async open(
    path: string,
    filter?: (name: string) => boolean
  ): Promise<ZipArchive> {
    const buffer = await readFile(path)
    const entries = unzipSync(new Uint8Array(buffer), filter ? { filter: (f) => filter(f.name) } : undefined)
    return new ZipArchive(entries)
  }

  has(name: string): boolean {
    return name in this.entries
  }

  /** Returns the entry's text, or undefined when the entry is absent. */
  text(name: string): string | undefined {
    const entry = this.entries[name]
    return entry ? strFromU8(entry) : undefined
  }

  names(): string[] {
    return Object.keys(this.entries)
  }

  /** Entry names matching a prefix, e.g. `ppt/notesSlides/`. */
  namesUnder(prefix: string): string[] {
    return this.names().filter((name) => name.startsWith(prefix))
  }
}

/** Only the XML parts a notes extractor needs — skips images, video, fonts. */
export const XML_ONLY = (name: string): boolean =>
  name.endsWith('.xml') || name.endsWith('.rels')
