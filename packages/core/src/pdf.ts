import { readFile } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'

/**
 * Page count of a produced PDF.
 *
 * Read back from the file rather than trusted from the slide count, because
 * every exporter drops hidden/skipped slides — so the deck's slide count and
 * the PDF's page count routinely disagree, and that difference is exactly what
 * the notes mapping has to account for.
 */
export async function pdfPageCount(pdfPath: string): Promise<number> {
  const bytes = await readFile(pdfPath)
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false
  })
  return doc.getPageCount()
}
