import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSidecar, notesFromSidecar, isCurrentSidecar } from '../dist/index.js'
import type { ExtractedSlide } from '../dist/index.js'

const slide = (index: number, notes: string, hidden = false): ExtractedSlide => ({
  index,
  notes,
  hidden
})

const build = (slides: ExtractedSlide[], pageCount: number) =>
  buildSidecar({
    sourcePath: '/decks/Q3 Review.pptx',
    sourceFormat: 'pptx',
    pdfPath: '/out/Q3 Review.pdf',
    pdfPageCount: pageCount,
    slides,
    pdfEngine: 'libreoffice',
    notesEngine: 'package-xml',
    generator: 'presentation-converter test'
  })

test('maps notes 1:1 when no slides are hidden', () => {
  const sidecar = build([slide(1, 'first'), slide(2, 'second')], 2)
  assert.equal(sidecar.alignment, 'exact')
  assert.deepEqual(sidecar.notes, { '1': 'first', '2': 'second' })
})

test('closes the gap left by a hidden slide', () => {
  // The exporter drops the hidden slide, so the deck's 4th slide is the PDF's
  // 3rd page. Getting this wrong shifts every note after the hidden slide.
  const sidecar = build(
    [slide(1, 'intro'), slide(2, 'numbers'), slide(3, 'backup', true), slide(4, 'thanks')],
    3
  )
  assert.equal(sidecar.alignment, 'adjusted')
  assert.deepEqual(sidecar.notes, { '1': 'intro', '2': 'numbers', '3': 'thanks' })

  const hidden = sidecar.slides.find((s) => s.index === 3)
  assert.equal(hidden?.page, null, 'hidden slide maps to no page')
  assert.equal(hidden?.notes, 'backup', 'hidden slide keeps its notes for reference')
  assert.equal(sidecar.slides.find((s) => s.index === 4)?.page, 3)
})

test('treats a hidden slide that was still exported as exact', () => {
  const sidecar = build([slide(1, 'a'), slide(2, 'b', true), slide(3, 'c')], 3)
  assert.equal(sidecar.alignment, 'exact')
  assert.deepEqual(sidecar.notes, { '1': 'a', '2': 'b', '3': 'c' })
})

test('warns instead of guessing when counts cannot be reconciled', () => {
  const sidecar = build([slide(1, 'a'), slide(2, 'b'), slide(3, 'c')], 7)
  assert.equal(sidecar.alignment, 'mismatch')
  assert.equal(sidecar.warnings.length, 1)
  assert.match(sidecar.warnings[0]!, /may be off by one or more pages/)
  // Still emits a usable positional mapping rather than nothing at all.
  assert.deepEqual(sidecar.notes, { '1': 'a', '2': 'b', '3': 'c' })
})

test('omits empty notes from the page map but keeps the slide', () => {
  const sidecar = build([slide(1, 'kept'), slide(2, '   ')], 2)
  assert.deepEqual(sidecar.notes, { '1': 'kept' })
  assert.equal(sidecar.slides.length, 2)
})

test('reads notes from both the current and the legacy sidecar shape', () => {
  const current = build([slide(1, 'hello')], 1)
  assert.ok(isCurrentSidecar(current))
  assert.deepEqual(notesFromSidecar(current), { '1': 'hello' })

  // The bare map written by presentation-commander-client before this tool.
  const legacy = { '1': 'hello', '2': 'world' }
  assert.equal(isCurrentSidecar(legacy), false)
  assert.deepEqual(notesFromSidecar(legacy), legacy)
})

test('ignores non-numeric keys when reading a legacy sidecar', () => {
  assert.deepEqual(notesFromSidecar({ '1': 'ok', comment: 'not a page' }), { '1': 'ok' })
})
