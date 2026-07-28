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
import type { ExtractedNotes, ExtractedSlide } from '../types.js'

/**
 * ODF encodes repeated spaces and tabs as empty elements rather than literal
 * whitespace, so they have to be substituted back in during text collection.
 */
function substituteWhitespace(node: XmlNode, tag: string): string | undefined {
  if (tag === 'text:s') {
    const count = Number(attr(node, 'text:c') ?? '1')
    return ' '.repeat(Number.isFinite(count) && count > 0 ? count : 1)
  }
  if (tag === 'text:tab') return '\t'
  return undefined
}

function frameText(node: XmlNode): string {
  return collectText(childrenOf(node), {
    breakTags: ['text:line-break'],
    paragraphTags: ['text:p'],
    substitute: substituteWhitespace
  })
}

/**
 * Names of drawing-page styles marked hidden.
 *
 * ODP does not flag a hidden slide on the slide itself — it points the slide at
 * an automatic style whose drawing-page properties carry
 * `presentation:visibility="hidden"`, so the style table has to be read first.
 */
function hiddenStyleNames(tree: XmlTree): Set<string> {
  const hidden = new Set<string>()
  for (const style of findAll(tree, 'style:style')) {
    if (attr(style, 'style:family') !== 'drawing-page') continue
    const name = attr(style, 'style:name')
    if (!name) continue
    const props = findFirst(childrenOf(style), 'style:drawing-page-properties')
    if (props && attr(props, 'presentation:visibility') === 'hidden') hidden.add(name)
  }
  return hidden
}

function titleOf(page: XmlNode): string | undefined {
  for (const frame of findAll(childrenOf(page), 'draw:frame')) {
    if (attr(frame, 'presentation:class') !== 'title') continue
    const text = tidyNotes(frameText(frame))
    if (text) return text.split('\n')[0]
  }
  return undefined
}

function notesOf(page: XmlNode): string {
  const notes = findFirst(childrenOf(page), 'presentation:notes')
  if (!notes) return ''

  const parts: string[] = []
  for (const frame of findAll(childrenOf(notes), 'draw:frame')) {
    // The notes page also carries a thumbnail of the slide itself; only the
    // outline/notes text frame holds anything worth keeping.
    if (attr(frame, 'presentation:class') === 'page') continue
    const text = frameText(frame)
    if (text.trim()) parts.push(text)
  }
  return tidyNotes(parts.join('\n'))
}

/** Reads presenter notes and slide metadata from an OpenDocument `.odp`. */
export async function extractOdpNotes(sourcePath: string): Promise<ExtractedNotes & { warnings: string[] }> {
  const archive = await ZipArchive.open(sourcePath, XML_ONLY)
  const xml = archive.text('content.xml')
  if (!xml) {
    throw new Error(`No content.xml in ${sourcePath} — the file may not be a valid .odp package`)
  }

  const tree = parseXml(xml)
  const hiddenStyles = hiddenStyleNames(tree)

  // draw:page appears only inside office:presentation, so a document-wide
  // search is safe and avoids depending on the body's exact nesting.
  const pages = findAll(tree, 'draw:page').filter((page) => tagOf(page) === 'draw:page')

  if (pages.length === 0) {
    throw new Error(`No slides found in ${sourcePath}`)
  }

  const slides: ExtractedSlide[] = pages.map((page, i) => {
    const styleName = attr(page, 'draw:style-name')
    const title = titleOf(page)
    return {
      index: i + 1,
      ...(title ? { title } : {}),
      notes: notesOf(page),
      hidden: styleName ? hiddenStyles.has(styleName) : false
    }
  })

  return { slides, engine: 'odf', warnings: [] }
}
