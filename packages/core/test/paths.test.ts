import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatForPath,
  isPresentation,
  pdfPathFor,
  sidecarPathFor,
  batchOutputPath,
  resolveZipPath,
  isInside
} from '../dist/index.js'

test('recognises the presentation formats it handles', () => {
  assert.equal(formatForPath('/d/Talk.key'), 'keynote')
  assert.equal(formatForPath('/d/Talk.PPTX'), 'pptx')
  assert.equal(formatForPath('/d/Talk.ppt'), 'ppt')
  assert.equal(formatForPath('/d/Talk.odp'), 'odp')
  assert.equal(formatForPath('/d/notes.txt'), undefined)
})

test('ignores lock files and resource forks that look like decks', () => {
  // Office leaves ~$deck.pptx next to an open file; converting it fails noisily.
  assert.equal(isPresentation('/d/~$Talk.pptx'), false)
  assert.equal(isPresentation('/d/._Talk.pptx'), false)
  assert.equal(isPresentation('/d/Talk.pptx'), true)
})

test('derives the sidecar path the way presentation-commander does', () => {
  assert.equal(sidecarPathFor('/out/Q3 Review.pdf'), '/out/Q3 Review.notes.json')
  assert.equal(sidecarPathFor('/out/Q3 Review.PDF'), '/out/Q3 Review.notes.json')
})

test('places the PDF beside the source when no output directory is given', () => {
  assert.equal(pdfPathFor('/decks/Q3 Review.key'), '/decks/Q3 Review.pdf')
  assert.equal(pdfPathFor('/decks/Q3 Review.key', '/out'), '/out/Q3 Review.pdf')
})

test('mirrors the input tree under the output directory', () => {
  assert.equal(
    batchOutputPath('/in/Theatre A/Mon/Talk.key', '/in', '/out', true),
    '/out/Theatre A/Mon/Talk.pdf'
  )
  assert.equal(batchOutputPath('/in/Theatre A/Mon/Talk.key', '/in', '/out', false), '/out/Talk.pdf')
})

test('resolves zip-internal relationship targets', () => {
  // Notes parts are referenced from ppt/slides/ as ../notesSlides/notesSlideN.xml
  assert.equal(
    resolveZipPath('ppt/slides', '../notesSlides/notesSlide1.xml'),
    'ppt/notesSlides/notesSlide1.xml'
  )
  assert.equal(resolveZipPath('ppt', 'slides/slide1.xml'), 'ppt/slides/slide1.xml')
  assert.equal(resolveZipPath('ppt/slides', '/ppt/slides/slide2.xml'), 'ppt/slides/slide2.xml')
})

test('detects an output directory nested inside the input directory', () => {
  assert.equal(isInside('/in/out', '/in'), true)
  assert.equal(isInside('/in', '/in'), true)
  assert.equal(isInside('/other', '/in'), false)
  // A sibling whose name merely starts the same must not count as inside.
  assert.equal(isInside('/input-pdfs', '/in'), false)
})
