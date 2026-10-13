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
 * 3. **A changed stretch that held a block text cannot spell is refused**,
 *    because re-parsing it would quietly turn it into a paragraph. Deleting
 *    such a block outright — its lines gone, nothing in their place — is
 *    allowed.
 *
 * Text is read as marker text plus one thing marker text has no syntax for: a
 * GFM pipe table, which becomes a §13.3 `table` block shaped as Ship's editor
 * saves one (RIC-20). So a table Ship's editor wrote is spellable when its
 * first row is a header and each cell one line of text, and the agent can edit
 * it as text; any other table still prints as `| … |` lines and is refused.
 * A checklist item prints as `- [ ] ` / `- [x] ` and a callout as a quote
 * opening `> [!NOTE]` (RIC-19), so the agent reads which items are ticked and
 * can tick one; an unchanged chunk keeps its block verbatim as before.
 *
 * **Every description the agent writes is a block document** (RIC-20, Miky
 * 2026-10-13: option 1). A new description, or an edit of a marker one, is the
 * text read as above and tagged `estiva-blocks-1`; marker text itself does not
 * learn tables, so Peek messages draw exactly as before.
 *
 * Generic rather than Ship's: the block document is the protocol's, and any
 * app's prose field declaring `estiva-blocks-1` is edited the same way.
 */
import {
  BLOCK_DOCUMENT_FORMAT,
  blockDocumentToMarkerText,
  inlineTextOf,
  markerTextToBlockDocument,
  newBlockId,
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
const protocolText = (block: Block) => blockDocumentToMarkerText(doc([trimRuns(block)]), DESCRIPTION)

/**
 * A description's text spells a checklist item (`- [ ] `, `- [x] `) and a
 * callout (a `> [!NOTE]` first line), as protocol reads them back (RIC-19,
 * Miky 2026-10-13); a message's text does not.
 */
const DESCRIPTION = { description: true }

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
  return textToBlocks(text, previous).map((fresh) => {
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
 * Text as blocks: protocol's marker reading, with each GFM pipe table — a
 * header row, a `| --- |` row, then rows — read as a `table` block. A table is
 * a block boundary, so it stands in the marker text as a placeholder
 * paragraph of its own, and the document is parsed once: `previous` then
 * lends ids by the same index the whole text has. A table takes the ids of a
 * table in `previous` that prints the same; failing that, of the table at its
 * position, but only when the text has as many tables as `previous` — else a
 * deleted table's ids would pass to the next one.
 */
function textToBlocks(text: string, previous: Block[]): Block[] {
  const tables: string[][][] = []
  const lines = text.split('\n')
  const out: string[] = []
  let fenced = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^ {0,3}```/.test(line)) fenced = !fenced
    const header = !fenced && TABLE_ROW.test(line) ? rowCells(line) : undefined
    if (!header || i + 1 >= lines.length || !isSeparator(lines[i + 1], header.length)) {
      out.push(line)
      continue
    }
    const rows = [header]
    for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]); i++) rows.push(rowCells(lines[i]))
    i--
    out.push('', `${PLACEHOLDER}${tables.length}${PLACEHOLDER}`, '')
    tables.push(rows)
  }
  if (!tables.length) return markerTextToBlockDocument(text, doc(previous), DESCRIPTION).content
  const oldTables = previous.filter((block) => block.type === 'table')
  const used = new Set<Block>()
  const lend = (rows: string[][], n: number): Block | undefined => {
    const printed = tableText(tableBlock(rows, undefined))
    const same = oldTables.find((old) => !used.has(old) && printed !== undefined && tableText(old) === printed)
    const positional = oldTables.length === tables.length && !used.has(oldTables[n]) ? oldTables[n] : undefined
    const old = same ?? positional
    if (old) used.add(old)
    return old
  }
  return markerTextToBlockDocument(out.join('\n'), doc(previous), DESCRIPTION).content.map((block) => {
    const n = block.type === 'paragraph' ? Number(PLACEHOLDER_PARAGRAPH.exec(inlineTextOf(block))?.[1] ?? NaN) : NaN
    // Text that merely spells a placeholder is left as it was written.
    return n < tables.length ? tableBlock(tables[n], lend(tables[n], n)) : block
  })
}

/** A private-use character, so no text a person writes is mistaken for a table's place. */
const PLACEHOLDER = '\uE000'
const PLACEHOLDER_PARAGRAPH = new RegExp(`^${PLACEHOLDER}(\\d+)${PLACEHOLDER}$`)
const TABLE_ROW = /^ {0,3}\|/

/** A row's cells, `\|` read as a literal pipe. */
function rowCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

/** GFM's delimiter row: one `---` (optionally `:`-aligned) per header cell. */
function isSeparator(line: string, width: number): boolean {
  if (!TABLE_ROW.test(line)) return false
  const cells = rowCells(line)
  return cells.length === width && cells.every((cell) => /^:?-+:?$/.test(cell))
}

function tableBlock(rows: string[][], old: Block | undefined): Block {
  const width = rows[0].length
  const oldRows = old ? (childBlocks(old) ?? []) : []
  return {
    type: 'table',
    id: old?.id ?? newBlockId(),
    content: rows.map((cells, r) => {
      const oldCells = oldRows[r] ? (childBlocks(oldRows[r]) ?? []) : []
      const type = r === 0 ? 'tableHeader' : 'tableCell'
      return {
        type: 'tableRow',
        id: oldRows[r]?.id ?? newBlockId(),
        content: Array.from({ length: width }, (_, c) => tableCell(type, cells[c] ?? '', oldCells[c]?.type === type ? oldCells[c] : undefined)),
      }
    }),
  }
}

/** A cell as Ship's editor saves one: one paragraph, the text's inline marks kept. */
function tableCell(type: string, text: string, old: Block | undefined): Block {
  const [parsed, ...more] = text ? markerTextToBlockDocument(text).content : []
  const paragraph: Block =
    parsed?.type === 'paragraph' && !more.length ? parsed : text ? { type: 'paragraph', id: '', content: [{ type: 'text', text }] } : { type: 'paragraph', id: '' }
  const oldParagraph = old ? childBlocks(old)?.[0] : undefined
  return {
    type,
    id: old?.id ?? newBlockId(),
    attrs: old?.attrs ?? { colspan: 1, rowspan: 1 },
    content: [{ ...paragraph, id: oldParagraph?.type === 'paragraph' ? oldParagraph.id : newBlockId() }],
  }
}

/**
 * A table as GFM text, for a table text can carry: a header row first, and
 * each cell one paragraph on one line. Anything else prints as its stand-in.
 */
function tableText(block: Block): string | undefined {
  const rows = (childBlocks(block) ?? []).map((row) => childBlocks(row) ?? [])
  if (!rows.length || !rows[0].length) return undefined
  const lines: string[] = []
  for (const [r, cells] of rows.entries()) {
    if (cells.some((cell) => cell.type !== (r === 0 ? 'tableHeader' : 'tableCell'))) return undefined
    const texts = cells.map((cell) => {
      const children = childBlocks(cell) ?? []
      if (children.length > 1 || (children[0] && children[0].type !== 'paragraph')) return undefined
      const line = children[0] && Array.isArray(children[0].content) ? protocolText(children[0]) : ''
      return line.includes('\n') ? undefined : line.replace(/\|/g, '\\|')
    })
    if (texts.some((t) => t === undefined)) return undefined
    lines.push(`| ${texts.join(' | ')} |`)
    if (r === 0) lines.push(`| ${cells.map(() => '---').join(' | ')} |`)
  }
  return lines.join('\n')
}

/** A block as text, when text has a syntax for it. */
const printable = (block: Block): string | undefined => (block.type === 'table' ? tableText(block) : protocolText(block))

/**
 * List items keep their ids by the same rule as blocks: one that still reads
 * the same is kept whole, wherever it moved; else the item at the same index
 * keeps its id and attrs with the new text — except its tick, which is the
 * text's (`- [x]`), so a tick never stays behind on an item the text moved
 * away from (RIC-19).
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
    const { content: _content, attrs, ...shape } = candidate
    const { checked: _was, ...rest } = attrs ?? {}
    const merged = { ...rest, ...(child.attrs?.checked !== undefined ? { checked: child.attrs.checked } : {}) }
    return { ...shape, ...(Object.keys(merged).length ? { attrs: merged } : {}), ...(child.content !== undefined ? { content: child.content } : {}) }
  })
}

/** Same type and the same thing on screen, whatever the ids. */
const readsTheSame = (a: Block, b: Block) => screenKey(a) === screenKey(b)
const screenKey = (block: Block) => canonical(visible({ ...block, id: '' }))

/**
 * Whether text can carry this block: printing it and reading it back gives the
 * same block, id and all. An attachment, a table that is not one header row
 * and one-line cells, or an inline node marker text has no syntax for does not.
 */
function spellable(block: Block): boolean {
  const text = printable(block)
  if (!text?.trim()) return false
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
  if (text === undefined) printed.set(block, (text = spellable(block) ? printable(block)! : standIn(block)))
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

  const present = new Set(allIds(out))
  return {
    value: serialized(out),
    kept,
    edited,
    added,
    removed: allIds(before).filter((id) => !present.has(id)),
  }
}

/** The document as it goes on the wire, refused if it is not a valid one. */
function serialized(blocks: Block[]): string {
  const problems = validateBlockDocument(doc(blocks))
  if (problems.length) throw new BadRequest(`The new description is not a valid block document: ${problems.join('; ')}. Nothing was published.`)
  return serializeBlockDocument(doc(blocks))
}

function allIds(blocks: Block[]): string[] {
  return blocks.flatMap((block) => [block.id, ...allIds(childBlocks(block) ?? [])]).filter(Boolean)
}

/**
 * The value to publish for a new description, given the one it replaces: an
 * edited document for a block document, and a new one read from the text for
 * marker text or none (`''`) — marker text has no block ids, so nothing
 * anchored to it is lost. An empty text stays empty. A format this version
 * cannot read is refused rather than overwritten.
 */
export function describe(
  previous: string,
  format: ContentFormat | undefined,
  text: string,
): { value: string; contentFormat?: string; blocks?: Omit<BlockEdit, 'value'> } {
  if (format === 'unknown') {
    throw new BadRequest('This description is in a content format this version does not read, so it cannot be edited without losing it. Nothing was published.')
  }
  if (format !== 'blocks') {
    if (!text.trim()) return { value: text }
    const blocks = textToBlocks(text, [])
    return { value: serialized(blocks), contentFormat: BLOCK_DOCUMENT_FORMAT, blocks: { kept: 0, edited: 0, added: blocks.length, removed: [] } }
  }
  try {
    parseBlockDocument(previous)
  } catch {
    throw new BadRequest('This description is tagged as a block document but does not parse as one, so it cannot be edited safely. Nothing was published.')
  }
  const { value, ...blocks } = editBlockDocument(previous, text)
  return { value, contentFormat: BLOCK_DOCUMENT_FORMAT, blocks }
}
