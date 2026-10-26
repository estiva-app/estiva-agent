/**
 * AGE-8: a description saved from Ship's editor is a block document, and the
 * agent edits it as text without flattening it — every block it does not
 * change keeps its id, so a comment anchored to one (§13.6) still resolves.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildActionEvents } from '@estiva-app/interop'
import { markerTextToBlockDocument, resolveBlockAnchor, type Block } from '@estiva-app/protocol'
import { BadRequest } from '../lib/agent/cli'
import { describe, descriptionText, editBlockDocument } from '../lib/agent/descriptions'
import { issueEdits, projectEdits } from '../lib/agent/apps/ship'
import type { Issue, Project } from '../lib/agent/apps/ship-workspace'

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}
function refuses(label: string, action: () => unknown, contains: string) {
  try {
    action()
    check(label, false, 'it succeeded, which it must not')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(label, error instanceof BadRequest && message.includes(contains), message)
  }
}

const text = (t: string, marks?: string[]) => ({ type: 'text', text: t, ...(marks ? { marks: marks.map((type) => ({ type })) } : {}) })
const item = (id: string, ...content: object[]) => ({ type: 'listItem', id, content })
const cell = (id: string, t: string) => ({ type: 'tableCell', id, attrs: { colspan: 1, rowspan: 1 }, content: [{ type: 'paragraph', id: `${id}p`, content: [text(t)] }] })

// The shapes Ship's editor saves, as found in production's 141 block descriptions.
const document = {
  type: 'doc',
  content: [
    { type: 'paragraph', id: 'p1', content: [text('Who, when:', ['bold']), text(' the agent, landing RIC-18.')] },
    { type: 'paragraph', id: 'p2', content: [text('What changes: ', ['bold']), text('one part, not the whole.')] },
    { type: 'heading', id: 'h3', attrs: { level: 3 }, content: [text('A level-three heading')] },
    { type: 'heading', id: 'h2', attrs: { level: 2 }, content: [text('Progress')] },
    { type: 'bulletList', id: 'l1', content: [item('i1', text('kickoff done\n')), item('i2', text('PR opened'))] },
    { type: 'table', id: 't1', content: [{ type: 'tableRow', id: 'r1', content: [cell('c1', 'Who'), cell('c2', 'When')] }] },
    { type: 'attachment', id: 'a1', attrs: { url: 'https://example.invalid/x.png', filename: 'x.png' } },
    { type: 'paragraph', id: 'p3', content: [text('Related: RIC-7.')] },
  ],
}
const value = JSON.stringify(document)
const shown = descriptionText(value, 'blocks')
const blocksOf = (v: string) => (JSON.parse(v) as { content: Block[] }).content
const byId = (v: string, id: string) => {
  const walk = (blocks: Block[]): Block | undefined => {
    for (const block of blocks) {
      if (block.id === id) return block
      const hit = Array.isArray(block.content) && typeof (block.content[0] as Block)?.id === 'string' ? walk(block.content as Block[]) : undefined
      if (hit) return hit
    }
  }
  return walk(blocksOf(v))
}

console.log(shown)
check('a block document is printed as text, one chunk per block', shown.split('\n\n').length === document.content.length)
check('a table prints as a row a person can read', shown.includes('| Who | When |'))
check('an attachment prints as a line, not as nothing', shown.includes('[attachment: x.png]'))
check('marker text prints as itself', descriptionText('**hi**', 'marker') === '**hi**')

// Unchanged text is the same document, byte for byte.
check('text sent back unchanged is the same document', editBlockDocument(value, shown).value === value)

// The done-when: append a line, and the anchor on the second block still resolves.
{
  const edit = editBlockDocument(value, `${shown}\n\nAppended by the agent.`)
  check('an appended line keeps every block', edit.kept === document.content.length && edit.added === 1 && edit.removed.length === 0, JSON.stringify({ ...edit, value: undefined }))
  check('a comment anchored to the second block still resolves', resolveBlockAnchor('p2', edit.value, 'blocks').state === 'resolved')
  check('the table and the attachment are kept verbatim', JSON.stringify(byId(edit.value, 't1')) === JSON.stringify(document.content[5]) && JSON.stringify(byId(edit.value, 'a1')) === JSON.stringify(document.content[6]))
  check('the appended line is the last block', blocksOf(edit.value).at(-1)?.type === 'paragraph' && blocksOf(edit.value).length === document.content.length + 1)
}

// A Progress bullet added to the list: the list and its items keep their ids.
{
  const edit = editBlockDocument(value, shown.replace('- PR opened', '- PR opened\n- merged and verified'))
  const list = byId(edit.value, 'l1')
  const items = (list?.content ?? []) as Block[]
  check('a bullet added to a list keeps the list’s id', list?.type === 'bulletList' && items.length === 3)
  check('…and its existing items’ ids', items[0]?.id === 'i1' && items[1]?.id === 'i2' && !!items[2]?.id && items[2].id !== 'i1')
  check('…and an item’s trailing newline nobody can see is kept, untouched', JSON.stringify(items[0]) === JSON.stringify(document.content[4].content![0]))
  check('nothing else changed', edit.removed.length === 0 && edit.edited === 1, JSON.stringify({ ...edit, value: undefined }))
}

// A block's own text edited in place keeps its id; a level-3 heading stays level 3.
{
  const edit = editBlockDocument(value, shown.replace('one part, not the whole.', 'one block, not the document.').replace('A level-three heading', 'A renamed heading'))
  check('a paragraph edited in place keeps its id', JSON.stringify(byId(edit.value, 'p2')).includes('one block, not the document.'))
  const heading = byId(edit.value, 'h3')
  check('a heading edited in place keeps its id and its level', heading?.attrs?.level === 3 && JSON.stringify(heading).includes('A renamed heading'), JSON.stringify(heading))
}

// A deleted block is reported; a deleted attachment is allowed.
{
  const edit = editBlockDocument(value, shown.replace('\n\n[attachment: x.png]', ''))
  check('deleting an attachment’s line removes it and says so', edit.removed.join() === 'a1' && !byId(edit.value, 'a1'))
}

// Two identical blocks: deleting the first must not take the ids of everything up to the second.
{
  const twins = JSON.stringify({
    type: 'doc',
    content: [
      { type: 'paragraph', id: 'd1', content: [text('TBD')] },
      { type: 'paragraph', id: 'd2', content: [text('Context that stays.')] },
      { type: 'paragraph', id: 'd3', content: [text('TBD')] },
    ],
  })
  const edit = editBlockDocument(twins, 'Context that stays.\n\nTBD')
  check('deleting one of two identical blocks keeps the blocks between them', edit.removed.join() === 'd1' && edit.kept === 2, JSON.stringify({ ...edit, value: undefined }))
}

// A code fence holding a block's text is not that block coming back.
{
  const edit = editBlockDocument(value, shown.replace('Related: RIC-7.', '```\nexample\n\nRelated: RIC-7.\n```\n\nRelated: RIC-7.'))
  const last = blocksOf(edit.value).at(-1)
  check('a block’s text inside a new code fence does not split the fence', blocksOf(edit.value).some((b) => b.type === 'codeBlock' && JSON.stringify(b).includes('example\\n\\nRelated')) && last?.id === 'p3', JSON.stringify(blocksOf(edit.value).slice(-2)))
}

// issueEdits / projectEdits carry the format to the write.
{
  const subject = { description: value, descriptionFormat: 'blocks' as const }
  const issue = { ...subject, addr: '30851:x:y', id: 'y', author: 'x', createdAt: 0, title: 't', status: 'todo', folder: 'f', archived: false } as Issue
  const [edit] = issueEdits(issue, { positional: [], flags: { description: `${shown}\n\nMore.` } }, [])
  check('edit-issue writes a block description as estiva-blocks-1', edit.contentFormat === 'estiva-blocks-1' && edit.text === `${shown}\n\nMore.` && edit.blocks?.added === 1)
  const project = { ...subject, addr: '30850:x:p', id: 'p', author: 'x', createdAt: 0, title: 'p', status: 'planned', archived: false, contentFolder: 'f' } as Project
  const [projectEdit] = projectEdits(project, { positional: [], flags: { description: shown } }, 'x', { values: [] } as never)
  check('edit-project does too', projectEdit.contentFormat === 'estiva-blocks-1' && projectEdit.blocks?.kept === document.content.length)
  const [plain] = issueEdits({ ...issue, description: 'old', descriptionFormat: 'marker' }, { positional: [], flags: { description: 'new' } }, [])
  check('a marker description becomes a block document (RIC-20)', plain.contentFormat === 'estiva-blocks-1' && plain.text === 'new' && blocksOf(plain.value)[0].type === 'paragraph')
}

// A crafted document is anybody's to publish: printing or editing one must not stall the agent.
{
  const items = Array.from({ length: 2000 }, (_, i) => ({ type: 'listItem', id: `x${i}`, extra: true, content: [text(`item ${i}`)] }))
  const list = JSON.stringify({ type: 'doc', content: [{ type: 'bulletList', id: 'big', content: items }] })
  let started = Date.now()
  descriptionText(list, 'blocks')
  const printing = Date.now() - started
  check('a 2000-item list prints in well under a second', printing < 1000, `${printing} ms`)

  const same = JSON.stringify({ type: 'doc', content: Array.from({ length: 2000 }, (_, i) => ({ type: 'paragraph', id: `s${i}`, content: [text('same')] })) })
  started = Date.now()
  refuses('2000 identical blocks are refused, not matched for minutes', () => editBlockDocument(same, `${descriptionText(same, 'blocks')}\n\nMore.`), 'repeats the same block')
  const matching = Date.now() - started
  check('…and refused quickly', matching < 3000, `${matching} ms`)
}

refuses('editing a table’s text is refused rather than flattened', () => editBlockDocument(value, shown.replace('| Who | When |', '| Who | When | Why |')), 'text cannot carry')

// describe(): every description is written as a block document, an unknown format is refused.
check('a marker description is rewritten as a tagged block document', describe('old', 'marker', 'new').contentFormat === 'estiva-blocks-1')
check('an empty description stays empty, untagged', JSON.stringify(describe('old', 'marker', '')) === JSON.stringify({ value: '' }))
check('a block description is written as a block document, tagged', describe(value, 'blocks', shown).contentFormat === 'estiva-blocks-1')
refuses('a format this version cannot read is refused', () => describe('x', 'unknown', 'y'), 'cannot be edited')
refuses('a body tagged blocks that does not parse is refused', () => describe('not json', 'blocks', 'y'), 'does not parse')

// The event Ship's manifest builds from it carries the tag, so Ship draws blocks.
{
  const manifest = JSON.parse(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'conformance', 'ship-manifest.json'), 'utf8')).event.content)
  const self = 'a'.repeat(64)
  const { value: next, contentFormat } = describe(value, 'blocks', `${shown}\n\nAppended.`)
  const built = buildActionEvents({
    manifest,
    kind: 30851,
    address: `30851:${self}:issue-1`,
    objectAuthor: self,
    folder: 'f'.repeat(32),
    actionId: 'describe-issue',
    value: next,
    contentFormat,
    note: 'Description',
    pubkey: self,
    createdAtMs: 1_000_000,
  })
  if (typeof built === 'string') throw new Error(built)
  const tags = built[0].tags
  check('describe-issue carries content-format estiva-blocks-1', tags.some((t) => t[0] === 'content-format' && t[1] === 'estiva-blocks-1'), JSON.stringify(tags.map((t) => t[0])))
  check('…and the block document as its value', tags.find((t) => t[0] === 'value')?.[1] === next)
}

// RIC-20: a table the agent writes is a table, and every description it writes is a block document.
{
  const markdown = [
    '**Who, when:** the agent.',
    '',
    '| Option | **Good** | Bad |',
    '| --- | :---: | --- |',
    '| Blocks | no wire change | a \\| pipe |',
    '| Marker |',
    '',
    'After.',
  ].join('\n')
  const created = describe('', undefined, markdown)
  const blocks = blocksOf(created.value)
  const table = blocks.find((block) => block.type === 'table')
  const rows = (table?.content ?? []) as Block[]
  const cellsOf = (r: number) => (rows[r]?.content ?? []) as Block[]
  const cellText = (r: number, c: number) => ((cellsOf(r)[c]?.content as Block[] | undefined)?.[0]?.content as { text: string }[] | undefined)?.map((t) => t.text).join('') ?? ''
  check('a new description is a block document', created.contentFormat === 'estiva-blocks-1' && blocks.map((b) => b.type).join() === 'paragraph,table,paragraph', blocks.map((b) => b.type).join())
  check('…its table has a header row, then cell rows', rows.length === 3 && cellsOf(0).every((c) => c.type === 'tableHeader') && cellsOf(1).every((c) => c.type === 'tableCell'))
  check('…each cell shaped as Ship saves one', cellsOf(1).every((c) => JSON.stringify(c.attrs) === '{"colspan":1,"rowspan":1}' && (c.content as Block[]).length === 1 && (c.content as Block[])[0].type === 'paragraph'))
  check('…a cell keeps its marks', JSON.stringify(cellsOf(0)[1].content).includes('"bold"'))
  check('…an escaped pipe is a pipe', cellText(1, 2) === 'a | pipe', cellText(1, 2))
  check('…a short row is padded with empty cells', cellsOf(2).length === 3 && (cellsOf(2)[2].content as Block[])[0].content === undefined)
  const allHaveIds = (list: Block[]): boolean =>
    list.every((b) => b.type === 'text' || (typeof b.id === 'string' && b.id.length > 0 && allHaveIds(Array.isArray(b.content) ? (b.content as Block[]) : [])))
  check('…every block, row, cell and cell paragraph has an id', allHaveIds(blocks))

  // The negative control: text with no table reads exactly as protocol reads a description's text (d98a5636: nesting included).
  const plain = '# Heading\n\nA paragraph with **bold** and `code`.\n\n- one\n  - nested\n- two\n\n> quoted\n\n```\n| not | a table |\n| --- | --- |\n```'
  const strip = (v: unknown): unknown => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'id').map(([k, x]) => [k, strip(x)])) : v)
  check(
    'text with no table is the document protocol reads from it as a description',
    JSON.stringify(strip(blocksOf(describe('', undefined, plain).value))) === JSON.stringify(strip(markerTextToBlockDocument(plain, undefined, { description: true }).content)),
  )
  check('…its indented item nested, one list', JSON.stringify((blocksOf(describe('', undefined, plain).value)[2].content as Block[]).map((b) => b.attrs?.indent ?? 0)) === '[0,1,0]')
  check('…and a table inside a code fence stays code', !blocksOf(describe('', undefined, plain).value).some((b) => b.type === 'table'))

  // The agent reads its table back as the text it wrote, and can edit it.
  const back = descriptionText(created.value, 'blocks')
  check('a written table prints back as GFM', back.includes('| Option | **Good** | Bad |\n| --- | --- | --- |\n| Blocks | no wire change | a \\| pipe |\n| Marker |  |  |'), back)
  check('…and sent back unchanged is the same document', editBlockDocument(created.value, back).value === created.value)
  const edit = editBlockDocument(created.value, back.replace('no wire change', 'no wire change, ever'))
  const after = blocksOf(edit.value).find((b) => b.type === 'table')!
  check('editing one cell keeps the table, its rows and the other cells', after.id === table!.id && edit.removed.length === 0 && JSON.stringify((after.content as Block[])[0]) === JSON.stringify(rows[0]), JSON.stringify(edit.removed))
  check('…and changes that cell', JSON.stringify(after).includes('no wire change, ever'))

  // Two tables in one changed stretch: deleting the first does not hand its ids to the second.
  const two = describe('', undefined, '| A |\n| --- |\n| 1 |\n\n| B |\n| --- |\n| 2 |')
  const [first, second] = blocksOf(two.value)
  const shownTwo = descriptionText(two.value, 'blocks')
  const dropped = editBlockDocument(two.value, shownTwo.replace('| A |\n| --- |\n| 1 |\n\n', '').replace('| 2 |', '| 2, edited |'))
  check('deleting one table and editing the other never moves the deleted one’s ids', !byId(dropped.value, first.id) && dropped.removed.includes(first.id), JSON.stringify(dropped.removed))
  const kept = editBlockDocument(two.value, shownTwo.replace('| A |\n| --- |\n| 1 |\n\n', 'New paragraph.\n\n'))
  check('…and an unchanged table keeps its own', byId(kept.value, second.id)?.type === 'table')
  const spelled = describe('', undefined, '| A |\n| --- |\n\n7')
  check('text that spells a placeholder stays text', blocksOf(spelled.value).map((b) => b.type).join() === 'table,paragraph')

  // Ship's tables: a header row with one-line cells is editable; a heading in a cell is not.
  const header = (id: string, t: string) => ({ ...cell(id, t), type: 'tableHeader' })
  const shipTable = { type: 'doc', content: [{ type: 'table', id: 'st', content: [
    { type: 'tableRow', id: 'sr1', content: [header('sh1', 'Who'), header('sh2', 'When')] },
    { type: 'tableRow', id: 'sr2', content: [cell('sc1', 'Miky'), { type: 'tableCell', id: 'sc2', attrs: { colspan: 1, rowspan: 1 }, content: [{ type: 'paragraph', id: 'sc2p' }] }] },
  ] }] }
  const shipValue = JSON.stringify(shipTable)
  const shipShown = descriptionText(shipValue, 'blocks')
  check('a Ship table with a header row prints as GFM', shipShown === '| Who | When |\n| --- | --- |\n| Miky |  |', shipShown)
  const filled = editBlockDocument(shipValue, shipShown.replace('| Miky |  |', '| Miky | 2026-10-13 |'))
  check('…and filling its empty cell keeps every id', JSON.stringify(filled.removed) === '[]' && ['st', 'sr1', 'sr2', 'sh1', 'sc1', 'sc2', 'sc2p'].every((id) => byId(filled.value, id)) && filled.value.includes('2026-10-13'), JSON.stringify(filled.removed))
  const headed = JSON.stringify({ type: 'doc', content: [{ ...shipTable.content[0], content: [shipTable.content[0].content[0], { type: 'tableRow', id: 'sr3', content: [
    { type: 'tableCell', id: 'hc', attrs: { colspan: 1, rowspan: 1 }, content: [{ type: 'heading', id: 'hh', attrs: { level: 2 }, content: [text('A heading')] }] }, cell('hc2', 'x')] }] }] })
  refuses('a table with a heading in a cell is still refused, not flattened', () => editBlockDocument(headed, descriptionText(headed, 'blocks').replace('A heading', 'Changed')), 'text cannot carry')

  // create-issue's event: Ship's add-issue takes the block document, tagged.
  const manifest = JSON.parse(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'conformance', 'ship-manifest.json'), 'utf8')).event.content)
  const self = 'a'.repeat(64)
  const built = buildActionEvents({
    manifest,
    kind: 30850,
    address: `30850:${self}:project-1`,
    objectAuthor: self,
    folder: 'f'.repeat(32),
    actionId: 'add-issue',
    value: { title: 'A table', description: created.value },
    newId: 'issue-1',
    contentFormat: created.contentFormat,
    pubkey: self,
    createdAtMs: 1_000_000,
  })
  if (typeof built === 'string') throw new Error(built)
  check('add-issue carries content-format estiva-blocks-1 and the document', built[0].kind === 30851 && built[0].tags.some((t) => t[0] === 'content-format' && t[1] === 'estiva-blocks-1') && built[0].content === created.value, JSON.stringify(built[0].tags))
}

// RIC-19: a checklist item and a callout, as Ship's editor saves them.
{
  const tick = (id: string, t: string, checked?: boolean) => ({ type: 'listItem', id, ...(checked === undefined ? {} : { attrs: { checked } }), content: [text(t)] })
  const checklist = JSON.stringify({
    type: 'doc',
    content: [
      { type: 'bulletList', id: 'cl', content: [tick('k1', 'tests pass', true), tick('k2', 'merged', false), tick('k3', 'verified', false)] },
      { type: 'blockquote', id: 'q1', attrs: { tone: 'warning' }, content: [text('Blocked on the deploy.')] },
      { type: 'paragraph', id: 'p9', content: [text('After.')] },
    ],
  })
  const printed = descriptionText(checklist, 'blocks')
  check('a checklist prints its ticks', printed.startsWith('- [x] tests pass\n- [ ] merged\n- [ ] verified'), printed)
  check('a callout prints its tone', printed.includes('> [!WARNING]\n> Blocked on the deploy.'), printed)
  check('text sent back unchanged keeps the checklist and the callout', editBlockDocument(checklist, printed).value === checklist)

  const ticked = editBlockDocument(checklist, printed.replace('- [ ] merged', '- [x] merged'))
  check('ticking an item in the text ticks that item, under its id', byId(ticked.value, 'k2')?.attrs?.checked === true && byId(ticked.value, 'k1')?.attrs?.checked === true && byId(ticked.value, 'k3')?.attrs?.checked === false, ticked.value)

  // Reordered, and the moved item reworded: it matches nothing by text, so the item at its index lends its id — but never its tick.
  const moved = editBlockDocument(checklist, printed.replace('- [x] tests pass\n- [ ] merged', '- [ ] merged\n- [x] all tests pass'))
  const items = (blocksOf(moved.value)[0].content as Block[]).map((b) => [(b.content as { text: string }[])[0].text, b.attrs?.checked])
  check('a reordered checklist keeps each tick on its own item', JSON.stringify(items) === JSON.stringify([['merged', false], ['all tests pass', true], ['verified', false]]), JSON.stringify(items))

  const unticked = editBlockDocument(checklist, printed.replace('- [x] tests pass', '- tests pass'))
  check('a box taken away in the text leaves a plain item', byId(unticked.value, 'k1')?.attrs?.checked === undefined, JSON.stringify(byId(unticked.value, 'k1')))

  const toned = editBlockDocument(checklist, printed.replace('[!WARNING]', '[!NOTE]'))
  check('a callout\'s tone changes with its text, under its id', byId(toned.value, 'q1')?.attrs?.tone === 'note', JSON.stringify(byId(toned.value, 'q1')))

  const plain = editBlockDocument(checklist, printed.replace('> [!WARNING]\n', ''))
  check('a callout line taken away in the text leaves a plain quote, under its id', byId(plain.value, 'q1')?.attrs?.tone === undefined && byId(plain.value, 'q1') !== undefined, JSON.stringify(byId(plain.value, 'q1')))

  const raised = editBlockDocument(checklist, printed.replace('After.', '> [!NOTE]\n> After.'))
  check('a callout line added in the text makes a callout', blocksOf(raised.value).at(-1)?.attrs?.tone === 'note', raised.value)

  const numbered = describe('', undefined, '1. [x] one\n2. [ ] two')
  check('a numbered list reads ticks too', (blocksOf(numbered.value)[0].content as Block[]).map((b) => b.attrs?.checked).join() === 'true,false', numbered.value)

  const created = describe('', undefined, '- [ ] first\n- [x] second\n\n> [!TIP]\n> Read the logs first.')
  const createdBlocks = blocksOf(created.value)
  check('a new description reads a checklist and a callout from text', (createdBlocks[0].content as Block[]).map((b) => b.attrs?.checked).join() === 'false,true' && createdBlocks[1].attrs?.tone === 'tip', created.value)
}

// d98a5636: a nested list, a nested checklist item and a plain item that looks like a box are edited like any list.
{
  const at = (id: string, t: string, attrs?: object) => ({ type: 'listItem', id, ...(attrs ? { attrs } : {}), content: [text(t)] })
  const nested = JSON.stringify({
    type: 'doc',
    content: [
      { type: 'bulletList', id: 'dn', content: [at('n1', 'tests pass', { checked: true }), at('n2', 'merged', { checked: false }), at('n3', 'deployed', { checked: false, indent: 1 })] },
      { type: 'blockquote', id: 'dq', attrs: { tone: 'warning' }, content: [text('Never on a real issue.')] },
      { type: 'bulletList', id: 'de', content: [at('e1', '[ ] literally brackets')] },
      { type: 'heading', id: 'dh', attrs: { level: 2 }, content: [text('Progress')] },
      { type: 'bulletList', id: 'dp', content: [at('r1', 'kickoff done'), at('r2', 'checked as QA-1', { indent: 1 }), at('r3', 'nested twice', { indent: 2 })] },
    ],
  })
  const printed = descriptionText(nested, 'blocks')
  check('a nested list prints two spaces a level, ticks included', printed.includes('- [ ] merged\n  - [ ] deployed') && printed.includes('- kickoff done\n  - checked as QA-1\n    - nested twice'), printed)
  check('a plain item that would read as a box prints escaped', printed.includes('- \\[ ] literally brackets'), printed)
  check('text sent back unchanged keeps the whole document', editBlockDocument(nested, printed).value === nested)

  // The Done-when's edit: a Progress line inside the nested list, and the indented checklist item ticked.
  const edited = editBlockDocument(nested, printed.replace('    - nested twice', '    - nested twice\n- PR opened').replace('  - [ ] deployed', '  - [x] deployed'))
  const progress = byId(edited.value, 'dp')?.content as Block[]
  check('a line added inside a nested list keeps every item, id and depth', JSON.stringify(progress.map((b) => [b.id, b.attrs?.indent ?? 0])) === JSON.stringify([['r1', 0], ['r2', 1], ['r3', 2], [progress[3].id, 0]]) && (progress[3].content as { text: string }[])[0].text === 'PR opened', JSON.stringify(progress))
  check('the indented checklist item is ticked under its own id, still indented', byId(edited.value, 'n3')?.attrs?.checked === true && byId(edited.value, 'n3')?.attrs?.indent === 1, JSON.stringify(byId(edited.value, 'n3')))
  check('the callout and the escaped item are kept exactly', JSON.stringify(byId(edited.value, 'dq')) === JSON.stringify(byId(nested, 'dq')) && JSON.stringify(byId(edited.value, 'de')) === JSON.stringify(byId(nested, 'de')))
  check('nothing is removed', edited.removed.length === 0, JSON.stringify(edited.removed))

  const outdented = editBlockDocument(nested, printed.replace('  - checked as QA-1', '- checked as QA-1'))
  check('an item outdented in the text is outdented, under its id', byId(outdented.value, 'r2')?.attrs?.indent === undefined && byId(outdented.value, 'r2') !== undefined, JSON.stringify(byId(outdented.value, 'r2')))

  const reworded = editBlockDocument(nested, printed.replace('literally brackets', 'still brackets'))
  check('an escaped item edits as a plain item', byId(reworded.value, 'e1')?.attrs === undefined && (byId(reworded.value, 'e1')?.content as { text: string }[])[0].text === '[ ] still brackets', JSON.stringify(byId(reworded.value, 'e1')))

  const created = describe('', undefined, '- one\n    - one.one\n- two')
  check('a new description reads a four-space indent as one level', JSON.stringify((blocksOf(created.value)[0].content as Block[]).map((b) => b.attrs?.indent ?? 0)) === '[0,1,0]', created.value)
}

// LEAF-10: the shared reader in the edit path — a table written above an edited paragraph, and three backticks that never close.
{
  const plain = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', id: 'x1', content: [text('Intro.')] }, { type: 'paragraph', id: 'x2', content: [text('Details.')] }] })
  const edit = editBlockDocument(plain, 'Intro.\n\n| A |\n| --- |\n| 1 |\n\nDetails, edited.')
  check('a table written above an edited paragraph leaves that paragraph its id, so its comment stays', blocksOf(edit.value).map((b) => b.type).join() === 'paragraph,table,paragraph' && blocksOf(edit.value)[2].id === 'x2' && resolveBlockAnchor('x2', edit.value, 'blocks').state === 'resolved', edit.value)

  const unclosed = JSON.stringify({ type: 'doc', content: [{ type: 'codeBlock', id: 'k1', content: [text('```')] }, document.content[5], { type: 'paragraph', id: 'k3', content: [text('Last.')] }] })
  const shownUnclosed = descriptionText(unclosed, 'blocks')
  const lines = shownUnclosed.split('\n').filter((line) => line.startsWith('```')).length
  let result = ''
  try {
    result = editBlockDocument(unclosed, shownUnclosed.replace('Last.', 'Last, edited.')).value
  } catch (error) {
    result = String(error)
  }
  check('three backticks that never close fence nothing: a table after them is matched and kept', lines % 2 === 1 && JSON.stringify(byId(result.startsWith('{') ? result : '{"content":[]}', 't1')) === JSON.stringify(document.content[5]), `${lines} fence lines; ${result.slice(0, 200)}`)
}

// e0e3e907: a link on words is `[words](url)` in the text, and the link a person's editor saves.
{
  const link = { type: 'link', attrs: { href: 'https://leaf.estiva.app/document/plan-1' } }
  const created = describe('', undefined, 'See [the plan](https://leaf.estiva.app/document/plan-1) today.')
  const [run] = blocksOf(created.value)[0].content as { text: string; marks?: unknown[] }[]
  check('a new description writes `[words](url)` as the words marked with a link', JSON.stringify((blocksOf(created.value)[0].content as object[])[1]) === JSON.stringify({ type: 'text', text: 'the plan', marks: [link] }), created.value)
  check('…and the text before it stays plain words', run.text === 'See ' && !run.marks)

  const saved = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', id: 'l1', content: [text('Read '), { type: 'text', text: 'the plan', marks: [link] }, text('.')] }, { type: 'paragraph', id: 'l2', content: [text('Other.')] }] })
  const shownLink = descriptionText(saved, 'blocks')
  check('a link on words an editor saved prints as `[words](url)`', shownLink.startsWith('Read [the plan](https://leaf.estiva.app/document/plan-1).'), shownLink)
  let relinked = ''
  try {
    relinked = editBlockDocument(saved, shownLink.replace('the plan', 'the new plan')).value
  } catch (error) {
    relinked = String(error)
  }
  check('editing its words keeps the link and the block’s id', relinked.startsWith('{') && JSON.stringify(byId(relinked, 'l1')) === JSON.stringify({ type: 'paragraph', id: 'l1', content: [text('Read '), { type: 'text', text: 'the new plan', marks: [link] }, text('.')] }), relinked.slice(0, 300))

  const boldLink = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', id: 'm1', content: [{ type: 'text', text: 'plan', marks: [link, { type: 'bold' }] }] }, { type: 'paragraph', id: 'm2', content: [text('Other.')] }] })
  let boldEdited = ''
  try {
    boldEdited = editBlockDocument(boldLink, descriptionText(boldLink, 'blocks').replace('plan', 'new plan')).value
  } catch (error) {
    boldEdited = String(error)
  }
  check('a bold link an editor saved with its link mark first can be edited, its id kept', boldEdited.startsWith('{') && byId(boldEdited, 'm1') !== undefined && boldEdited.includes('new plan'), boldEdited.slice(0, 300))

  // What the agent wrote before protocol 0.43: the brackets and the URL as words, which readers draw as a link anyway.
  const old = JSON.stringify({ type: 'doc', content: [{ type: 'bulletList', id: 'b1', content: [item('i1', text('PR: [estiva-agent#91](https://github.com/estiva-app/estiva-agent/pull/91)')), item('i2', text('Kickoff done.'))] }] })
  const shownOld = descriptionText(old, 'blocks')
  let added = ''
  try {
    added = editBlockDocument(old, `${shownOld}\n- Merged.`).value
  } catch (error) {
    added = String(error)
  }
  check('a list holding a link written as words can still take a new item, its old items kept', added.startsWith('{') && JSON.stringify(blocksOf(added)[0].content).includes('"id":"i1"') && (blocksOf(added)[0].content as object[]).length === 3, added.slice(0, 300))

  // The same with one character after the link, the way a sentence ends.
  const oldStop = JSON.stringify({ type: 'doc', content: [{ type: 'bulletList', id: 'b2', content: [item('j1', text('PR: [estiva-agent#91](https://github.com/estiva-app/estiva-agent/pull/91).')), item('j2', text('Kickoff done.'))] }] })
  let addedStop = ''
  try {
    addedStop = editBlockDocument(oldStop, `${descriptionText(oldStop, 'blocks')}\n- Merged.`).value
  } catch (error) {
    addedStop = String(error)
  }
  check('…and when a full stop follows the link, that item is kept as it was', addedStop.startsWith('{') && JSON.stringify((blocksOf(addedStop)[0].content as object[])[0]) === JSON.stringify(item('j1', text('PR: [estiva-agent#91](https://github.com/estiva-app/estiva-agent/pull/91).'))), addedStop.slice(0, 300))
}

if (failures) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nall passed')
