import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractPptxNotes } from '../dist/index.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/**
 * A real Canva "Download as PPTX" export.
 *
 * Canva's Connect API exposes no speaker-notes field, so exporting PPTX and
 * reading the OOXML is the only route to Canva notes. This fixture is what
 * makes that route a verified fact rather than an assumption — if a future
 * change breaks it, Canva support silently loses its notes.
 */
test('reads speaker notes from a real Canva PPTX export', async () => {
  const result = await extractPptxNotes(join(fixtures, 'canva-export.pptx'))

  assert.equal(result.slides.length, 1)
  assert.equal(result.slides[0]?.notes, 'this is a note')
  assert.deepEqual(result.warnings, [])
})

test('falls back to slide text for titles when a deck uses no placeholders', async () => {
  // Canva lays slides out with plain shapes and no <p:ph> at all, so there is
  // no title placeholder to find.
  const result = await extractPptxNotes(join(fixtures, 'canva-export.pptx'))
  assert.equal(result.slides[0]?.title, 'This is a slide')
})
