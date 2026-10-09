/**
 * A rich text field the agent edits as text, without flattening it (AGE-8).
 *
 * A description saved from Ship's editor is a block document (SPEC §13.3,
 * `estiva-blocks-1`), and every block carries an id a comment can anchor to
 * (§13.6). The agent reads and writes text. Writing that text back untagged
 * replaces the document with marker text, which has no ids (§13.1), and every
 * anchored comment detaches — silently, because a detached comment renders like
 * one that was never anchored.
 *
 * So the agent is shown the document as marker text, one chunk per block,
 * and what it sends back is matched against those chunks:
 *
 * 1. **A chunk that comes back unchanged keeps its block verbatim** — id, attrs,
 *    marks, and anything marker text cannot spell (a table, an attachment).
 * 2. **What changed is re-parsed** with protocol's `markerTextToBlockDocument`,
 *    given the blocks it replaced, so an edited block keeps its id by that
 *    module's rule (same type and text, else same type at the same index). A
 *    re-parsed block keeps the old block's attrs and its list items' ids
 *    wherever the text still spells them — a level-3 heading prints as `#`.
 * 3. **A changed stretch that held a block marker text cannot spell is
 *    refused**, because re-parsing it would quietly turn a table into a
 *    paragraph. Deleting such a block outright — its lines gone, nothing in
 *    their place — is allowed.
 *
 * Generic rather than Ship's: the block document is the protocol's, and any
 * app's prose field declaring `estiva-blocks-1` is edited the same way.
 */
import {
  BLOCK_DOCUMENT_FORMAT,
  blockDocumentToMarkerText,
  inlineTextOf,
  markerTextToBlockDocument,
  parseBlockDocument,
  serializeBlockDocument,
  validateBlockDocument,
  type Block,
  type BlockDocument,
  type ContentFormat,
} from '@estiva-app/protocol'
import { BadRequest } from './cli'

const doc = (content: Block[]): BlockDocument => ({ type: 'doc', content })

/** Child blocks, as opposed to an inline run or nothing. */
const childBlocks = (block: Block): Block[] | undefined =>
  Array.isArray(block.content) && block.content.length > 0 && block.content.every((node) => typeof (node as Block).id === 'string')
    ? (block.content as Block[])
    : undefined

/** JSON with sorted keys, so two blocks built in different orders compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * A block as protocol prints it — with the whitespace that ends each run of
 * text dropped first. Ship's editor saves some list items as `"kickoff done\n"`,
 * which nobody sees but which prints a blank line inside the list, and a blank
 * line ends a list: read back, it would be two.
 */
const protocolText = (block: Block) => blockDocumentToMarkerText(doc([trimRuns(block)]))

function trimRuns(block: Block): Block {
  const children = childBlocks(block)
  if (children) return { ...block, content: children.map(trimRuns) }
  if (!Array.isArray(block.content) || block.content.length === 0) return block
  const run = [...(block.content as { type: string; text?: string }[])]
  while (run.length) {
    const last = run[run.length - 1]
    if (last.type !== 'text' || typeof last.text !== 'string') break
    const trimmedText = last.text.replace(/\s+$/, '')
    if (trimmedText) {
      run[run.length - 1] = { ...last, text: trimmedText }
      break
    }
    run.pop()
  }
  return { ...block, content: run as Block['content'] }
}

/**
 * A changed stretch of text as blocks, carrying ids, attrs and list-item ids
 * from the blocks it replaces wherever they still correspond.
 */
function reparse(text: string, previous: Block[]): Block[] {
  const old = new Map(previous.filter((block) => block.id).map((block) => [block.id, block]))
  return markerTextToBlockDocument(text, doc(previous)).content.map((fresh) => {
    const before = old.get(fresh.id)
    if (!before) return fresh
    const children = carryChildIds(childBlocks(before) ?? [], childBlocks(fresh))
    const updated = { ...fresh, ...(children ? { content: children } : {}) }
    if (readsTheSame(before, updated)) return before
    // The old block with the new text, when that still prints the same: keeps attrs the text cannot spell.
    const { content: _content, ...beforeShape } = before
    const kept: Block = { ...beforeShape, ...(updated.content !== undefined ? { content: updated.content } : {}) }
    return protocolText(kept) === protocolText(updated) ? kept : updated
  })
}

/**
 * List items keep their ids by the same rule as blocks: one that still reads
 * the same is kept whole, wherever it moved; else the item at the same index
 * keeps its id and attrs with the new text.
 */
function carryChildIds(before: Block[], after: Block[] | undefined): Block[] | undefined {
  if (!after) return undefined
  const used = new Set<number>()
  // By key, not by comparing every pair: a list of thousands of items is anybody's to publish (§12.3).
  const waiting = new Map<string, number[]>()
  before.forEach((candidate, j) => waiting.set(screenKey(candidate), [...(waiting.get(screenKey(candidate)) ?? []), j]))
  const unchanged: (number | undefined)[] = after.map((child) => {
    const i = waiting.get(screenKey(child))?.shift()
    if (i === undefined) return undefined
    used.add(i)
    return i
  })
  return after.map((child, i) => {
    if (unchanged[i] !== undefined) return before[unchanged[i]!]
    const candidate = before[i]
    if (!candidate || used.has(i) || candidate.type !== child.type) return child
    used.add(i)
    const { content: _content, ...shape } = candidate
    return { ...shape, ...(child.content !== undefined ? { content: child.content } : {}) }
  })
}

/** Same type and the same thing on screen, whatever the ids. */
const readsTheSame = (a: Block, b: Block) => screenKey(a) === screenKey(b)
const screenKey = (block: Block) => canonical(visible({ ...block, id: '' }))

/**
 * Whether text can carry this block: printing it and reading it back gives the
 * same block, id and all. A table, an attachment, a nested list or an inline
 * node marker text has no syntax for does not.
 */
function spellable(block: Block): boolean {
  const text = protocolText(block)
  if (!text.trim()) return false
  const back = reparse(text, [block])
  return back.length === 1 && canonical(visible(back[0])) === canonical(visible(block))
}

/**
 * The block as a reader sees it. Two things Ship's editor saves that text
 * cannot show, and that losing changes nothing on screen: whitespace at the end
 * of a block's text (`"something\n"`), and which side of a mark a space falls
 * on (`**Extend **` is drawn as `**Extend** `). Every other difference counts.
 */
function visible(block: Block): unknown {
  const children = childBlocks(block)
  if (children) return { ...block, content: children.map(visible) }
  if (!Array.isArray(block.content)) return block
  const characters: [string, string][] = []
  for (const node of block.content as { type: string; text?: string; marks?: unknown[] }[]) {
    if (node.type !== 'text' || typeof node.text !== 'string') {
      characters.push(['', canonical(node)])
      continue
    }
    const { text, type: _type, ...rest } = node
    const marks = canonical(rest)
    for (const character of text) characters.push([character, /\s/.test(character) ? '' : marks])
  }
  while (characters.length && characters[characters.length - 1][0] !== '' && /\s/.test(characters[characters.length - 1][0])) characters.pop()
  return { ...block, content: characters.map(([character, marks]) => character + '\u0000' + marks).join('\u0001') }
}

/** A line for a block text cannot carry — readable, and unique enough to be matched when it comes back unchanged. */
function standIn(block: Block): string {
  const attrs = block.attrs ?? {}
  if (block.type === 'table') {
    const rows = childBlocks(block) ?? []
    return rows
      .map((row) => `| ${(childBlocks(row) ?? []).map((cell) => cellText(cell)).join(' | ')} |`)
      .join('\n')
  }
  if (block.type === 'attachment') {
    const name = typeof attrs.filename === 'string' && attrs.filename ? attrs.filename : typeof attrs.url === 'string' ? attrs.url : block.id
    return `[attachment: ${name}]`
  }
  const text = protocolText(block)
  return text.trim() ? text : `[${block.type}: ${block.id}]`
}

const cellText = (cell: Block): string =>
  (childBlocks(cell) ?? []).map((child) => (childBlocks(child) ? cellText(child) : inlineTextOf(child))).join(' ').replace(/\s+/g, ' ').trim()

/** What one block reads as, in the text the agent is shown. */
const blockText = (block: Block) => {
  let text = printed.get(block)
  if (text === undefined) printed.set(block, (text = spellable(block) ? protocolText(block) : standIn(block)))
  return text
}
/** `spellable` re-parses a block, and one block is printed several times per edit — and per project in `ship projects`. */
const printed = new WeakMap<Block, string>()

/**
 * A description as the text the agent reads and sends back. A block document
 * prints one chunk per block, a blank line apart; marker text is itself.
 */
export function descriptionText(value: string, format: ContentFormat | undefined): string {
  if (format !== 'blocks') return value
  try {
    return parseBlockDocument(value).content.map(blockText).join('\n\n')
  } catch {
    return value
  }
}

/** The wire name of a format, as `show` prints it. */
export const formatName = (format: ContentFormat | undefined) =>
  format === 'blocks' ? BLOCK_DOCUMENT_FORMAT : format === 'unknown' ? 'unknown' : 'marker'

/**
 * Every place `chunk` stands as whole blocks in `text`: a blank line (or the
 * edge) on each side, and not inside a code fence, whose blank lines are not
 * block boundaries.
 */
function chunkPositions(text: string, chunk: string, fences: number[]): number[] {
  const lead = text.length - text.trimStart().length
  const tail = text.trimEnd().length
  const positions: number[] = []
  for (let at = text.indexOf(chunk); at >= 0; at = text.indexOf(chunk, at + 1)) {
    const end = at + chunk.length
    const opensBlock = at <= lead || (text[at - 1] === '\n' && text[at - 2] === '\n')
    const closesBlock = end >= tail || (text[end] === '\n' && text[end + 1] === '\n')
    const fenced = fences.filter((fence) => fence < at).length % 2 === 1
    if (opensBlock && closesBlock && !fenced) positions.push(at)
    if (positions.length > MAX_MATCHES) break
  }
  return positions
}

/**
 * Which old blocks come back unchanged, and where: the longest chain of
 * matches in order on both sides. First-occurrence matching is not enough —
 * delete one of two identical paragraphs and the earlier block would match the
 * later copy, and every block in between would lose its id.
 */
const MAX_MATCHES = 4000

function unchangedBlocks(text: string, chunks: string[]): { i: number; at: number; end: number }[] {
  const fences = [...text.matchAll(/^```/gm)].map((fence) => fence.index)
  /*
    The chain is quadratic in matches, and a document of many identical blocks
    has matches in the square of its size. Real descriptions have a few dozen;
    past the cap, refuse rather than stall.
  */
  const matches: { i: number; at: number; end: number }[] = []
  chunks.forEach((chunk, i) => {
    if (!chunk.trim()) return
    for (const at of chunkPositions(text, chunk, fences)) matches.push({ i, at, end: at + chunk.length })
    if (matches.length > MAX_MATCHES) {
      throw new BadRequest('This description repeats the same block too often for its blocks to be matched safely. Nothing was published.')
    }
  })
  matches.sort((a, b) => a.at - b.at || a.i - b.i)
  const length = matches.map(() => 1)
  const previous = matches.map(() => -1)
  matches.forEach((match, c) => {
    for (let d = 0; d < c; d++) {
      if (matches[d].i < match.i && matches[d].end <= match.at && length[d] + 1 > length[c]) {
        length[c] = length[d] + 1
        previous[c] = d
      }
    }
  })
  let last = -1
  length.forEach((n, c) => {
    if (last < 0 || n > length[last]) last = c
  })
  const chain: { i: number; at: number; end: number }[] = []
  for (let c = last; c >= 0; c = previous[c]) chain.unshift(matches[c])
  return chain
}

export interface BlockEdit {
  /** The new document, serialised — what goes on the wire, tagged `estiva-blocks-1`. */
  value: string
  /** Blocks kept exactly as they were. */
  kept: number
  /** Blocks re-written from the new text that kept their id. */
  edited: number
  /** Blocks the new text added. */
  added: number
  /** Ids no longer in the document — a comment anchored to one is detached (§13.6). */
  removed: string[]
}

/**
 * The new text of a block document, applied to the old one so every block the
 * text did not change keeps its id and its exact content.
 */
export function editBlockDocument(previous: string, text: string): BlockEdit {
  const before = parseBlockDocument(previous).content
  const chunks = before.map(blockText)

  type Piece = { keep: Block } | { text: string; replaces: Block[] }
  const pieces: Piece[] = []
  let cursor = 0
  let next = 0
  for (const { i, at, end } of unchangedBlocks(text, chunks)) {
    pieces.push({ text: text.slice(cursor, at), replaces: before.slice(next, i) }, { keep: before[i] })
    cursor = end
    next = i + 1
  }
  pieces.push({ text: text.slice(cursor), replaces: before.slice(next) })

  const out: Block[] = []
  let kept = 0
  let edited = 0
  let added = 0
  for (const piece of pieces) {
    if ('keep' in piece) {
      out.push(piece.keep)
      kept++
      continue
    }
    const { text: stretch, replaces } = piece
    if (stretch.trim() === replaces.map(blockText).join('\n\n').trim()) {
      // Whitespace only, or blocks that print as nothing: unchanged.
      out.push(...replaces)
      kept += replaces.length
      continue
    }
    if (stretch.trim() === '') continue // deleted outright
    const fixed = replaces.find((block) => !spellable(block))
    if (fixed) {
      throw new BadRequest(
        `The new description changes the text around a ${fixed.type} block (${JSON.stringify(blockText(fixed).slice(0, 60))}), ` +
          'and text cannot carry that block: writing it would replace it with plain text. The block is matched only when its ' +
          'lines are exactly as `show` printed them with a blank line on each side; its content can be changed only in Ship. Nothing was published.',
      )
    }
    const ids = new Set(replaces.map((block) => block.id))
    for (const block of reparse(stretch, replaces)) {
      out.push(block)
      if (ids.has(block.id)) edited++
      else added++
    }
  }

  const result = doc(out)
  const problems = validateBlockDocument(result)
  if (problems.length) throw new BadRequest(`The new description is not a valid block document: ${problems.join('; ')}. Nothing was published.`)
  const present = new Set(allIds(out))
  return {
    value: serializeBlockDocument(result),
    kept,
    edited,
    added,
    removed: allIds(before).filter((id) => !present.has(id)),
  }
}

function allIds(blocks: Block[]): string[] {
  return blocks.flatMap((block) => [block.id, ...allIds(childBlocks(block) ?? [])]).filter(Boolean)
}

/**
 * The value to publish for a new description, given the one it replaces: the
 * text itself for marker text, an edited document for a block document. A
 * format this version cannot read is refused rather than overwritten.
 */
export function describe(
  previous: string,
  format: ContentFormat | undefined,
  text: string,
): { value: string; contentFormat?: string; blocks?: Omit<BlockEdit, 'value'> } {
  if (format === 'unknown') {
    throw new BadRequest('This description is in a content format this version does not read, so it cannot be edited without losing it. Nothing was published.')
  }
  if (format !== 'blocks') return { value: text }
  try {
    parseBlockDocument(previous)
  } catch {
    throw new BadRequest('This description is tagged as a block document but does not parse as one, so it cannot be edited safely. Nothing was published.')
  }
  const { value, ...blocks } = editBlockDocument(previous, text)
  return { value, contentFormat: BLOCK_DOCUMENT_FORMAT, blocks }
}
