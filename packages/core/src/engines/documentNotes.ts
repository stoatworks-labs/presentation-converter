import { extractPptxNotes } from '../notes/ooxml.js'
import { extractOdpNotes } from '../notes/odf.js'
import { convertToPptx, findSoffice } from './libreoffice.js'
import type { EngineAvailability, ExtractedNotes, NotesEngine } from '../types.js'
import { formatForPath } from '../util/paths.js'

/**
 * Reads notes straight out of the source package.
 *
 * This engine needs no application and no rendering, so notes fidelity is
 * independent of whichever engine produced the PDF — the author's exact text,
 * on any platform, including a headless Nextcloud host.
 */
export const packageNotesEngine: NotesEngine = {
  id: 'package-xml',
  label: 'Source package (OOXML / ODF)',
  formats: ['pptx', 'ppt', 'odp'],
  // Pure file reading and parsing; safe to run several at once.
  maxConcurrency: 8,

  async probe(): Promise<EngineAvailability> {
    // Always usable for pptx/odp. Legacy .ppt additionally needs LibreOffice to
    // reach a parseable format, which `extract` reports if it comes to it.
    return { available: true }
  },

  async extract(sourcePath: string, signal?: AbortSignal): Promise<ExtractedNotes> {
    const format = formatForPath(sourcePath)

    if (format === 'odp') {
      return extractOdpNotes(sourcePath)
    }

    if (format === 'ppt') {
      // The binary PowerPoint format has no practical pure-JS parser, so it is
      // promoted to .pptx first; the notes survive that round trip intact.
      const { pptxPath, cleanup } = await convertToPptx(sourcePath, signal ? { signal } : {})
      try {
        const result = await extractPptxNotes(pptxPath)
        return { ...result, engine: 'package-xml (via .pptx)' }
      } finally {
        await cleanup()
      }
    }

    return extractPptxNotes(sourcePath)
  }
}

/** Whether legacy `.ppt` notes can be read here — needs LibreOffice for the uplift. */
export async function canReadLegacyPpt(): Promise<boolean> {
  return (await findSoffice()) !== null
}
