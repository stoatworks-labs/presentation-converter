import { XMLParser } from 'fast-xml-parser'

/**
 * XML is parsed in `preserveOrder` mode throughout.
 *
 * This matters for correctness, not tidiness: a note paragraph interleaves
 * `<a:r>` text runs with `<a:br>` line breaks, and a name-keyed parse collapses
 * them into separate buckets — every run in one array, every break in another —
 * which silently drops the line breaks' positions and runs words together.
 * Preserving order costs a couple of small helpers and keeps notes verbatim.
 *
 * In this mode every node is `{ "<tag>": Child[] }`, optionally carrying
 * `":@"` with its attributes; text is `{ "#text": "..." }`.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // `attributesGroupName` must NOT be set here: in preserveOrder mode the
  // parser already groups attributes under ':@', and supplying the option adds
  // a second identical wrapper, so every attribute lookup silently misses.
  preserveOrder: true,
  parseAttributeValue: false,
  parseTagValue: false,
  // Notes text carries meaningful leading/trailing spaces inside <a:t> runs.
  trimValues: false,
  textNodeName: '#text'
})

export type XmlNode = Record<string, unknown>
export type XmlTree = XmlNode[]

export function parseXml(source: string): XmlTree {
  return parser.parse(source) as XmlTree
}

const ATTRS_KEY = ':@'
const TEXT_KEY = '#text'

/** The element name of a node, or undefined for a text node. */
export function tagOf(node: XmlNode): string | undefined {
  const key = Object.keys(node).find((k) => k !== ATTRS_KEY)
  return key === TEXT_KEY ? undefined : key
}

/** Child nodes, in document order. */
export function childrenOf(node: XmlNode): XmlTree {
  const tag = tagOf(node)
  if (!tag) return []
  const value = node[tag]
  return Array.isArray(value) ? (value as XmlTree) : []
}

export function attr(node: XmlNode | undefined, name: string): string | undefined {
  if (!node) return undefined
  const attrs = node[ATTRS_KEY] as Record<string, unknown> | undefined
  const value = attrs?.[`@_${name}`]
  return value === undefined || value === null ? undefined : String(value)
}

/** The raw text of a text node, or '' for an element. */
export function rawText(node: XmlNode): string {
  const value = node[TEXT_KEY]
  return value === undefined || value === null ? '' : String(value)
}

/**
 * Every descendant element with the given tag, depth-first in document order.
 * Used instead of hand-walking, because OOXML nesting depth varies with how the
 * authoring app happened to group shapes.
 */
export function findAll(tree: XmlTree, tagName: string): XmlNode[] {
  const found: XmlNode[] = []
  const visit = (nodes: XmlTree): void => {
    for (const node of nodes) {
      if (tagOf(node) === tagName) found.push(node)
      visit(childrenOf(node))
    }
  }
  visit(tree)
  return found
}

export function findFirst(tree: XmlTree, tagName: string): XmlNode | undefined {
  return findAll(tree, tagName)[0]
}

/** Direct children with the given tag, without descending further. */
export function childrenNamed(node: XmlNode, tagName: string): XmlNode[] {
  return childrenOf(node).filter((child) => tagOf(child) === tagName)
}

/**
 * Flattens an element's text content.
 *
 * `breakTags` produce a newline (OOXML `a:br`, ODF `text:line-break`), and
 * `paragraphTags` are terminated by one, so a multi-paragraph note round-trips
 * with its structure intact rather than as one run-on line.
 */
export function collectText(
  nodes: XmlTree,
  options: {
    breakTags?: string[]
    paragraphTags?: string[]
    /**
     * Tags replaced by literal text rather than their content — ODF encodes
     * runs of whitespace as empty `<text:s/>` / `<text:tab/>` elements, which
     * would otherwise vanish.
     */
    substitute?: (node: XmlNode, tag: string) => string | undefined
  } = {}
): string {
  const breakTags = new Set(options.breakTags ?? [])
  const paragraphTags = new Set(options.paragraphTags ?? [])
  let out = ''

  const visit = (tree: XmlTree): void => {
    for (const node of tree) {
      const tag = tagOf(node)
      if (tag === undefined) {
        out += rawText(node)
        continue
      }
      if (breakTags.has(tag)) {
        out += '\n'
        continue
      }
      const replacement = options.substitute?.(node, tag)
      if (replacement !== undefined) {
        out += replacement
        continue
      }
      visit(childrenOf(node))
      if (paragraphTags.has(tag)) out += '\n'
    }
  }

  visit(nodes)
  return out
}

/** Trims trailing blank lines while keeping intentional internal spacing. */
export function tidyNotes(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
}
