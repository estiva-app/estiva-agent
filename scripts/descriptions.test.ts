/**
 * AGE-8: a description saved from Ship's editor is a block document, and the
 * agent edits it as text without flattening it — every block it does not
 * change keeps its id, so a comment anchored to one (§13.6) still resolves.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildActionEvents } from '@estiva-app/interop'
import { resolveBlockAnchor, type Block } from '@estiva-app/protocol'
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
  check('a marker description stays untagged', plain.contentFormat === undefined && plain.value === 'new')
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

// describe(): marker stays marker, blocks get the tag, an unknown format is refused.
check('a marker description is written as given, untagged', JSON.stringify(describe('old', 'marker', 'new')) === JSON.stringify({ value: 'new' }))
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

if (failures) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nall passed')
