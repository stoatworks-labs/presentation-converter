import { ZipArchive, XML_ONLY } from '../util/zip.js'
import {
  parseXml,
  findAll,
  findFirst,
  childrenOf,
  attr,
  collectText,
  tidyNotes,
  tagOf,
  type XmlNode,
  type XmlTree
} from '../util/xml.js'
import { resolveZipPath } from '../util/paths.js'
import type { ExtractedNotes, ExtractedSlide } from '../types.js'

const NOTES_SLIDE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide'
const SLIDE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'

/**
 * Placeholders on a notes page that are not the notes.
 *
 * A notes page normally holds three shapes: a thumbnail of the slide
 * (`sldImg`), the notes body, and a slide number (`sldNum`). Anything that is
 * not one of these decorations is treated as notes text, which is more robust
 * than requiring `type="body"` — some authoring tools omit the type and use a
 * bare `idx` instead.
 */
const NON_NOTES_PLACEHOLDERS = new Set(['sldImg', 'sldNum', 'dt', 'ftr', 'hdr'])

const TITLE_PLACEHOLDERS = new Set(['title', 'ctrTitle'])

/** The `type` of a shape's placeholder, e.g. `body`, `title`, `sldImg`. */
function placeholderType(shape: XmlNode): string | undefined {
  const ph = findFirst(childrenOf(shape), 'p:ph')
  return ph ? attr(ph, 'type') : undefined
}

/** Flattens a shape's text body, keeping paragraph and line breaks. */
function shapeText(shape: XmlNode): string {
  const body = findFirst(childrenOf(shape), 'p:txBody')
  if (!body) return ''
  return collectText(childrenOf(body), {
    breakTags: ['a:br'],
    paragraphTags: ['a:p']
  })
}

/** Reads a `.rels` part into a relationship-id to target map. */
function relationships(archive: ZipArchive, partPath: string): Map<string, { target: string; type: string }> {
  const dir = partPath.slice(0, partPath.lastIndexOf('/'))
  const name = partPath.slice(partPath.lastIndexOf('/') + 1)
  const relsPath = `${dir}/_rels/${name}.rels`
  const map = new Map<string, { target: string; type: string }>()
  const xml = archive.text(relsPath)
  if (!xml) return map

  for (const rel of findAll(parseXml(xml), 'Relationship')) {
    // External targets are URLs, not parts inside the package.
    if (attr(rel, 'TargetMode') === 'External') continue
    const id = attr(rel, 'Id')
    const target = attr(rel, 'Target')
    const type = attr(rel, 'Type') ?? ''
    if (id && target) map.set(id, { target: resolveZipPath(dir, target), type })
  }
  return map
}

/** Slide part paths in presentation order, as listed by `p:sldIdLst`. */
function slideOrder(archive: ZipArchive): string[] {
  const presentation = archive.text('ppt/presentation.xml')
  if (!presentation) return []

  const rels = relationships(archive, 'ppt/presentation.xml')
  const list = findFirst(parseXml(presentation), 'p:sldIdLst')
  if (!list) return []

  const paths: string[] = []
  for (const entry of childrenOf(list)) {
    if (tagOf(entry) !== 'p:sldId') continue
    const relId = attr(entry, 'r:id')
    const rel = relId ? rels.get(relId) : undefined
    if (rel) paths.push(rel.target)
  }
  return paths
}

/**
 * Fallback ordering for decks whose `p:sldIdLst` is missing or unreadable:
 * sort the slide parts by their trailing number.
 *
 * This is only a guess at the author's order — OOXML puts the real order in the
 * id list, and `slide7.xml` can legitimately be the second slide — so callers
 * surface it as a warning rather than trusting it silently.
 */
function slidePartsByNumber(archive: ZipArchive): string[] {
  return archive
    .namesUnder('ppt/slides/')
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0)
      const numB = Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0)
      return numA - numB
    })
}

/** Longest first line still plausibly a title rather than a paragraph. */
const MAX_TITLE_LENGTH = 120

function titleOf(slideTree: XmlTree): string | undefined {
  const shapes = findAll(slideTree, 'p:sp')

  for (const shape of shapes) {
    const type = placeholderType(shape)
    if (type && TITLE_PLACEHOLDERS.has(type)) {
      const text = tidyNotes(shapeText(shape))
      if (text) return text.split('\n')[0]
    }
  }

  // Some exporters lay every slide out with plain shapes and no placeholders at
  // all — Canva's PPTX export is one, verified against a real export. Those
  // decks have no title placeholder to find, so fall back to the first piece of
  // text on the slide, but only when the deck genuinely uses no placeholders:
  // where placeholders exist and none is a title, the author really has no
  // title and guessing one from body text would be worse than leaving it unset.
  if (shapes.some((shape) => placeholderType(shape) !== undefined)) return undefined

  for (const shape of shapes) {
    const text = tidyNotes(shapeText(shape))
    const firstLine = text.split('\n')[0]?.trim()
    if (firstLine && firstLine.length <= MAX_TITLE_LENGTH) return firstLine
  }
  return undefined
}

function notesOf(archive: ZipArchive, slidePath: string): string {
  const rels = relationships(archive, slidePath)
  const notesRel = [...rels.values()].find((rel) => rel.type === NOTES_SLIDE_REL)
  if (!notesRel) return ''

  const xml = archive.text(notesRel.target)
  if (!xml) return ''

  const tree = parseXml(xml)
  const parts: string[] = []
  for (const shape of findAll(tree, 'p:sp')) {
    const type = placeholderType(shape)
    if (type && NON_NOTES_PLACEHOLDERS.has(type)) continue
    const text = shapeText(shape)
    if (text.trim()) parts.push(text)
  }
  return tidyNotes(parts.join('\n'))
}

export interface OoxmlExtraction extends ExtractedNotes {
  warnings: string[]
}

/**
 * Reads presenter notes straight out of a `.pptx` package.
 *
 * Deliberately independent of whatever renders the PDF: parsing the OOXML gives
 * the author's exact text, whereas asking LibreOffice or PowerPoint for notes
 * means trusting a re-layout of them.
 */
export async function extractPptxNotes(sourcePath: string): Promise<OoxmlExtraction> {
  const archive = await ZipArchive.open(sourcePath, XML_ONLY)
  const warnings: string[] = []

  let paths = slideOrder(archive)
  if (paths.length === 0) {
    paths = slidePartsByNumber(archive)
    if (paths.length > 0) {
      warnings.push(
        'Slide order list (p:sldIdLst) was missing or empty; slides were ordered by part number, which may not match the deck.'
      )
    }
  }

  if (paths.length === 0) {
    throw new Error(`No slides found in ${sourcePath} — the file may not be a valid .pptx package`)
  }

  const slides: ExtractedSlide[] = paths.map((slidePath, i) => {
    const xml = archive.text(slidePath)
    const tree = xml ? parseXml(xml) : []
    const root = tree.find((node) => tagOf(node) === 'p:sld')
    // `show="0"` marks a slide hidden; absent means visible.
    const hidden = attr(root, 'show') === '0'
    const title = titleOf(tree)
    return {
      index: i + 1,
      ...(title ? { title } : {}),
      notes: notesOf(archive, slidePath),
      hidden
    }
  })

  return { slides, engine: 'ooxml', warnings }
}

/** Exposed so the ODF extractor and tests can share the relationship reader. */
export const __internals = { relationships, slideOrder, SLIDE_REL }
