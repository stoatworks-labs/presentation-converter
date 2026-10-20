import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  buildSidecar,
  convertFile,
  extractPptxNotes,
  readSidecar,
  pdfEngineFor,
  NoEngineError
} from '../dist/index.js'
import { KEYNOTE_BUNDLE_IDS } from '../dist/engines/keynote.js'
import {
  POWERPOINT_SCRIPT,
  explainPowerPointError,
  powerPointEngine
} from '../dist/engines/powerpoint.js'
import { osascriptMessage } from '../dist/util/exec.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/**
 * Five slides, "Slide 1 of 5" to "Slide 5 of 5", with notes on each and the
 * third hidden. Made in Keynote Creator Studio 15.3.1 and exported as
 * PowerPoint, so it is a real exporter's idea of a hidden slide, not a
 * hand-written `show="0"`.
 */
const hiddenSlideDeck = join(fixtures, 'keynote-hidden-slide.pptx')

test('a Keynote-exported deck reports its hidden slide', async () => {
  const result = await extractPptxNotes(hiddenSlideDeck)
  assert.deepEqual(
    result.slides.map((slide) => [slide.index, slide.notes, slide.hidden]),
    [
      [1, 'notes for slide 1', false],
      [2, 'notes for slide 2', false],
      [3, 'notes for slide 3', true],
      [4, 'notes for slide 4', false],
      [5, 'notes for slide 5', false]
    ]
  )
})

test("the hidden slide's PDF maps slide 4 to page 3", async () => {
  // PowerPoint 16.112.3 and Keynote 15.3.1 both export this deck as four
  // pages, slide 3 left out. Mapped 1:1, every note after it is a page out.
  const { slides } = await extractPptxNotes(hiddenSlideDeck)
  const sidecar = buildSidecar({
    sourcePath: hiddenSlideDeck,
    sourceFormat: 'pptx',
    pdfPath: '/out/keynote-hidden-slide.pdf',
    pdfPageCount: 4,
    slides,
    pdfEngine: 'powerpoint',
    notesEngine: 'ooxml',
    generator: 'presentation-converter test'
  })
  assert.equal(sidecar.alignment, 'adjusted')
  assert.deepEqual(sidecar.notes, {
    '1': 'notes for slide 1',
    '2': 'notes for slide 2',
    '3': 'notes for slide 4',
    '4': 'notes for slide 5'
  })
})

test('Keynote Creator Studio is preferred to the iWork Keynote', () => {
  // With both installed, Keynote 14.5 opens to an "out of date" modal and
  // answers nothing. It must only ever be the fallback.
  assert.deepEqual([...KEYNOTE_BUNDLE_IDS], ['com.apple.Keynote', 'com.apple.iWork.Keynote'])
})

test('the PowerPoint script resolves its files outside the tell block', () => {
  // Inside `tell`, `POSIX file` is resolved by the sandboxed app, which may
  // not be allowed to read it.
  const tell = POWERPOINT_SCRIPT.slice(
    POWERPOINT_SCRIPT.indexOf('tell application'),
    POWERPOINT_SCRIPT.indexOf('end tell')
  )
  assert.ok(tell.length > 0)
  assert.doesNotMatch(tell, /POSIX file/)
  assert.match(POWERPOINT_SCRIPT, /set thePres to presentation docName/)
  assert.doesNotMatch(POWERPOINT_SCRIPT, /active presentation/)
  assert.match(POWERPOINT_SCRIPT, /if not wasRunning and \(count of presentations\) is 0 then quit/)
})

test('osascript errors lose their wrapping and keep their number', () => {
  assert.equal(
    osascriptMessage(new Error('12:40: execution error: Error: Error: Keynote could not open the deck. (-2700)')),
    'Keynote could not open the deck. (-2700)'
  )
})

test('PowerPoint errors say what to do', () => {
  assert.match(
    explainPowerPointError(new Error('0:10: execution error: Not authorized to send Apple events to Microsoft PowerPoint. (-1743)')),
    /Privacy & Security ▸ Automation/
  )
  assert.match(
    explainPowerPointError(new Error('0:10: execution error: Microsoft PowerPoint got an error: AppleEvent timed out. (-1712)')),
    /Is a dialog open in it\?/
  )
  assert.match(
    explainPowerPointError(new Error('osascript timed out after 600000ms')),
    /Is a dialog open in it\?/
  )
  assert.equal(
    explainPowerPointError(new Error("0:10: execution error: Microsoft PowerPoint got an error: Can't get presentation \"x\". (-1728)")),
    'PowerPoint could not export the deck: Microsoft PowerPoint got an error: Can\'t get presentation "x". (-1728)'
  )
})

test('PowerPoint is tried before Keynote for PowerPoint decks', async () => {
  try {
    const engine = await pdfEngineFor('pptx')
    // On a Mac with LibreOffice, that wins; without it, PowerPoint must.
    if (engine.id === 'keynote') {
      const probe = await powerPointEngine.probe()
      assert.equal(probe.available, false, 'Keynote was chosen while PowerPoint is installed')
    }
  } catch (error) {
    assert.ok(error instanceof NoEngineError)
    const order = error.reasons.map((reason) => reason.split(':')[0])
    assert.deepEqual(order, ['LibreOffice (headless)', 'PowerPoint (macOS)', 'Keynote (macOS)'])
  }
})

/**
 * Drives the real apps. Off unless asked for, because it launches Keynote and
 * PowerPoint on the machine running the tests:
 *
 *     PRESENTATION_CONVERTER_LIVE_APPS=1 npm test
 *
 * Either app already running is left running; one the test launched is quit.
 */
const live = platform() === 'darwin' && process.env.PRESENTATION_CONVERTER_LIVE_APPS === '1'

const isRunning = (bundleId: string): boolean =>
  execFileSync('osascript', ['-e', `application id "${bundleId}" is running`]).toString().trim() === 'true'

for (const [engineId, bundleId] of [
  ['powerpoint', 'com.microsoft.Powerpoint'],
  ['keynote', 'com.apple.Keynote']
] as const) {
  test(`${engineId} exports the hidden-slide deck as four pages`, { skip: !live }, async () => {
    const wasRunning = isRunning(bundleId)
    const outputDir = await mkdtemp(join(tmpdir(), 'presentation-converter-live-'))
    try {
      const result = await convertFile({
        sourcePath: hiddenSlideDeck,
        outputDir,
        pdfEngineId: engineId,
        incremental: false,
        timeoutMs: 180_000
      })
      assert.equal(result.status, 'ok', result.message)
      assert.equal(result.pageCount, 4)
      assert.equal(result.alignment, 'adjusted')
      const read = await readSidecar(result.sidecarPath!)
      assert.equal(read?.notes['3'], 'notes for slide 4')
    } finally {
      await rm(outputDir, { recursive: true, force: true })
      // Quit only if nothing else is open in it: someone may have started
      // using the app while the test ran.
      const open = bundleId === 'com.apple.Keynote' ? 'documents' : 'presentations'
      if (!wasRunning && isRunning(bundleId)) {
        execFileSync('osascript', [
          '-e',
          `tell application id "${bundleId}" to if (count of ${open}) is 0 then quit`
        ])
      }
    }
  })
}
