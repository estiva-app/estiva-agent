/**
 * The agent reads and writes projects field by field (ALO-7).
 *
 * Over a relay that advertises the list read (SPEC §6.13): opening a project
 * reads its fields and its current text and none of its older changes, and
 * prints the text's `version`; `edit-project --description` takes that version
 * back, is merged onto a change saved since and says whose, or — the same
 * block changed by both — saves nothing, no other field either, names them and
 * shows both versions; a field set again from an older copy keeps the later; a
 * delete is a `deleted` change where projects are kept in order, and a restore
 * the empty one; a project is found by a word of its current text, never of an
 * old one; a project's first changes follow its record.
 *
 * Offline, over an in-memory relay that folds as SPEC §6.2 says (interop's
 * `filesOf`) and refuses a stale `prev` as buzz does, holding the manifest Ship
 * published. Asserted on the signed events that reach it and on the answers.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-file-is-its-fields-each-kept-in-order-by-the-relay.md
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/merging-two-changes-to-one-text-never-loses-words.md
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fieldsSetBy, filesOf } from '@estiva-app/interop'
import type { SignedEvent } from '@estiva-app/protocol'
import type { AgentContext } from '../lib/agent/cli'
import { shipApp } from '../lib/agent/apps/ship'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, '..', 'conformance', 'ship-manifest.json'), 'utf8')) as { event: SignedEvent }

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const tag = (event: { tags: string[][] } | undefined, name: string) => event?.tags.find((t) => t[0] === name)?.[1]
const addressOf = (e: SignedEvent) => `${e.kind}:${e.pubkey}:${tag(e, 'd')}`
const id = (seed: string) => createHash('sha256').update(seed).digest('hex')

const SELF = 'a'.repeat(64)
const QA1 = 'b'.repeat(64)
const FOLDER = '0f0f0f0f-0000-4000-8000-000000000001'
const FILE_KINDS = [30850, 30851]
let clock = Math.floor(Date.now() / 1000) - 3600

const signed = (pubkey: string, kind: number, tags: string[][], content = ''): SignedEvent => {
  clock += 1
  return { id: id(`${pubkey}${kind}${JSON.stringify(tags)}${clock}`), pubkey, created_at: clock, kind, tags, content, sig: '' }
}
const doc = (...blocks: [string, string][]) =>
  JSON.stringify({ type: 'doc', content: blocks.map(([block, text]) => ({ type: 'paragraph', id: block, content: [{ type: 'text', text }] })) })
const textChange = (author: string, addr: string, value: string, prev: string) =>
  signed(author, 1851, [['a', addr], ['O', addr.split(':')[2]], ['field', 'description'], ['value', value], ['content-format', 'estiva-blocks-1'], ['h', FOLDER], ['ts', String((clock + 1) * 1000)], ['prev', prev]])
const fieldChange = (author: string, addr: string, field: string, value: string, prev: string) =>
  signed(author, 1851, [['a', addr], ['O', addr.split(':')[2]], ['field', field], ['value', value], ['h', FOLDER], ['ts', String((clock + 1) * 1000)], ['prev', prev]])

/**
 * A relay answering NIP-01 filters, the list read (`"fields": "newest"`, with
 * `"text"` beside `#d`) and its search over current words, and refusing a
 * change whose `prev` is not its field's current change, as buzz does.
 */
function relay(events: SignedEvent[], options: { inOrder?: boolean; refuseKind5?: boolean; beforePublish?: (e: SignedEvent) => void } = {}) {
  const asked: Record<string, unknown>[] = []
  const published: SignedEvent[] = []
  const values = (e: SignedEvent, name: string) => e.tags.filter((t) => t[0] === name).map((t) => t[1])
  const matches = (e: SignedEvent, filter: Record<string, unknown>) =>
    (!Array.isArray(filter.ids) || filter.ids.includes(e.id)) &&
    (!Array.isArray(filter.kinds) || filter.kinds.includes(e.kind)) &&
    (!Array.isArray(filter.authors) || filter.authors.includes(e.pubkey)) &&
    Object.entries(filter).every(([key, wanted]) => !key.startsWith('#') || (wanted as string[]).some((v) => values(e, key.slice(1)).includes(v)))
  const current = () => filesOf(events, { withText: true })
  const listRead = (filter: Record<string, unknown>) => {
    const { fields: _fields, text, search, ...rest } = filter as { fields: string; text?: boolean; search?: string }
    const files = current()
    const out: SignedEvent[] = []
    for (const root of events.filter((e) => FILE_KINDS.includes(e.kind) && matches(e, rest))) {
      const file = files.find((f) => f.address === addressOf(root))
      if (!file || file.fields.deleted?.value === 'true') continue
      if (search !== undefined && !wordsOf(file).some((word) => word.startsWith(search.toLowerCase()))) continue
      out.push(root)
      for (const [field, change] of Object.entries(file.fields)) {
        // A list never carries a change that sets only the text.
        if (field === 'description' && !text && fieldsSetBy(change.event).length === 1) continue
        if (!out.includes(change.event)) out.push(change.event)
      }
    }
    return out
  }
  const wordsOf = (file: ReturnType<typeof current>[number]) =>
    [tag(file.root, 'name'), file.fields.title?.value, file.fields.description?.value].join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u)
  const answer = (filters: Record<string, unknown>[]) => {
    asked.push(...filters)
    const out = new Map<string, SignedEvent>()
    for (const filter of filters) {
      if ('search' in filter && !('fields' in filter)) continue // §5.2's search: nothing here is found by it
      for (const e of 'fields' in filter ? listRead(filter) : events.filter((e) => matches(e, filter))) out.set(e.id, e)
    }
    return [...out.values()]
  }
  const head = (addr: string, field: string) => {
    const file = current().find((f) => f.address === addr)
    return file?.fields[field]?.id ?? file?.root.id
  }
  const publish = async (e: SignedEvent) => {
    options.beforePublish?.(e)
    if (e.kind === 5 && options.refuseKind5) return { ok: false, reason: 'invalid: a project is deleted by its deleted field, not kind 5' }
    if (e.kind === 1851) {
      for (const { field } of fieldsSetBy(e)) {
        const prev = tag(e, 'prev')
        if (prev && prev !== head(tag(e, 'a')!, field)) return { ok: false, reason: `conflict: ${field} follows ${head(tag(e, 'a')!, field)}` }
      }
    }
    published.push(e)
    events.push(e)
    return { ok: true, eventId: e.id }
  }
  let seq = 0
  const context = {
    relayUrl: 'https://estiva.example',
    relay: {
      info: async () => ({
        file_list: { newest: true, text: true },
        file_search: { types: ['osnova.project'] },
        ...(options.inOrder ? { files: { newest: true, requires_prev: ['osnova.project'] } } : {}),
      }),
      queryAll: async (f: Record<string, unknown>[]) => answer(f),
      query: async (f: Record<string, unknown>[]) => answer(f),
      queryWithMatches: async (f: Record<string, unknown>[]) => {
        const found = answer(f)
        return { events: found, matches: found.filter((e) => e.kind === 30850).map((e) => ({ a: addressOf(e), match: { fields: ['text'] } })) }
      },
      publish,
    },
    signer: { pubkey: SELF, sign: async (e: SignedEvent) => ({ ...e, pubkey: SELF, id: id(JSON.stringify(e) + seq++), sig: '' }) },
  } as unknown as AgentContext
  return { context, asked, published, events }
}

/** A project by QA-1 in the QA Folder, its text saved twice: the second save is the version the agent reads. */
function workspace(options: Parameters<typeof relay>[1] = {}) {
  const root = signed(QA1, 30850, [['d', 'c0ffee00-0000-4000-8000-000000000001'], ['name', 'Launch plan'], ['buzz-channel', FOLDER]])
  const addr = addressOf(root)
  const first = textChange(QA1, addr, doc(['b1', 'One.'], ['b2', 'Two.']), root.id)
  const read = textChange(QA1, addr, doc(['b1', 'One, with the rollout in it.'], ['b2', 'Two.']), first.id)
  const status = fieldChange(QA1, addr, 'status', 'planned', root.id)
  const profile = signed(QA1, 0, [], JSON.stringify({ name: 'QA-1' }))
  return { ...relay([manifest.event, root, first, read, status, profile], options), root, addr, first, read, status }
}

const run = async (context: AgentContext, name: string, positional: string[], flags: Record<string, string | true> = {}) => {
  try {
    return { ok: true as const, answer: (await shipApp.commands.find((command) => command.name === name)!.run(context, { positional, flags })) as Record<string, unknown> }
  } catch (error) {
    return { ok: false as const, message: (error as Error).message }
  }
}
const mine = (published: SignedEvent[]) => published.filter((e) => e.pubkey === SELF)

// — Opening a project —
{
  const { context, asked, addr, read } = workspace()
  const shown = await run(context, 'show', [addr])
  check('show prints the text and its version: the current text change', shown.ok && shown.answer.version === read.id && String(shown.answer.description).includes('rollout'), JSON.stringify(shown.ok ? shown.answer.version : shown.message))
  // A read of its changes: by its address, or of the whole change kind. A rename search or a move's `A` read is neither.
  const everyChange = asked.some(
    (f) =>
      Array.isArray(f.kinds) && f.kinds.includes(1851) && !('fields' in f) && !('search' in f) && !('ids' in f) &&
      (Array.isArray(f['#a']) ? (f['#a'] as string[]).includes(addr) : !Object.keys(f).some((key) => key.startsWith('#'))),
  )
  check('opening it reads none of its older changes', !everyChange, JSON.stringify(asked.filter((f) => Array.isArray(f.kinds) && f.kinds.includes(1851))))
  const history = shown.ok ? (shown.answer.history as { field: string }[]) : []
  check('its history is each field\'s current change, and says so', history.filter((h) => h.field === 'description').length === 1 && typeof shown.answer?.historyNote === 'string')
  asked.length = 0
  const all = await run(context, 'show', [addr], { history: true })
  check('--history reads every change: both saves of the text', all.ok && (all.answer.history as { field: string }[]).filter((h) => h.field === 'description').length === 2)
}

// — edit-project --description needs a version that is this project's —
{
  const { context, published, addr } = workspace()
  const bare = await run(context, 'edit-project', [addr], { description: 'b1 text' })
  check('a description without --version is refused, nothing published', !bare.ok && /needs --version/.test(bare.message) && published.length === 0, bare.ok ? 'it saved' : bare.message)
  const other = signed(QA1, 1851, [['a', '30850:x:y'], ['field', 'description'], ['value', 'x']])
  const { context: c2, published: p2, addr: a2, events } = workspace()
  events.push(other)
  const wrong = await run(c2, 'edit-project', [a2], { description: 'x', version: other.id })
  check('a --version that is another file\'s change is refused, nothing published', !wrong.ok && /not a saved version/.test(wrong.message) && p2.length === 0, wrong.ok ? 'it saved' : wrong.message)
  void addr
}

// — A different block: merged, and the answer names whose change it kept —
{
  const { context, published, addr, read, events } = workspace()
  const theirs = textChange(QA1, addr, doc(['b1', 'One, with the rollout in it.'], ['b2', 'Two, by QA-1.']), read.id)
  events.push(theirs)
  const answer = await run(context, 'edit-project', [addr], { description: 'One, with the rollout in it, by Claude.\n\nTwo.', version: read.id })
  const saved = mine(published).find((e) => tag(e, 'field') === 'description')
  const words = saved ? (JSON.parse(tag(saved, 'value')!) as { content: { content: { text: string }[] }[] }).content.map((b) => b.content[0].text) : []
  check('the save follows QA-1\'s change', tag(saved, 'prev') === theirs.id, tag(saved, 'prev'))
  check('it keeps both people\'s words', JSON.stringify(words) === JSON.stringify(['One, with the rollout in it, by Claude.', 'Two, by QA-1.']), JSON.stringify(words))
  const applied = answer.ok ? (answer.answer.applied as { merged?: string }[]) : []
  check('the answer says whose change it kept', /QA-1/.test(applied[0]?.merged ?? ''), answer.ok ? applied[0]?.merged : answer.message)
}

// — The same block: nothing saved, no other field either; names them, shows both —
{
  const { context, published, addr, read, events } = workspace()
  const theirs = textChange(QA1, addr, doc(['b1', 'One, rewritten by QA-1.'], ['b2', 'Two.']), read.id)
  events.push(theirs)
  const answer = await run(context, 'edit-project', [addr], { description: 'One, rewritten by Claude.\n\nTwo.', version: read.id, status: 'in_progress' })
  check('nothing of the agent\'s is saved, the status included', mine(published).length === 0, JSON.stringify(mine(published).map((e) => tag(e, 'field'))))
  const message = answer.ok ? '' : answer.message
  check('the answer names QA-1 and when', /as QA-1 left it at \d{4}-/.test(message), message.split('\n')[0])
  check('it shows both versions of the block', message.includes('One, rewritten by QA-1.') && message.includes('One, rewritten by Claude.'))
  check('it says to keep their words and ask before dropping any', /Keep QA-1's words/.test(message) && /Ask the person you are working with/.test(message))
  check('QA-1\'s text is still the current one', tag(events.filter((e) => tag(e, 'field') === 'description').at(-1), 'value')?.includes('rewritten by QA-1') === true)
}

// — A status set from an older copy: the later stands, both are in its history —
{
  let crossed: SignedEvent | undefined
  const setup = workspace({
    beforePublish: (e) => {
      // QA-1 sets the status between the agent's read and its write.
      if (!crossed && e.pubkey === SELF && tag(e, 'field') === 'status') {
        crossed = fieldChange(QA1, setup.addr, 'status', 'completed', setup.status.id)
        setup.events.push(crossed)
      }
    },
  })
  const answer = await run(setup.context, 'edit-project', [setup.addr], { status: 'in_progress' })
  const saved = mine(setup.published).find((e) => tag(e, 'field') === 'status')
  check('the agent\'s status is written after QA-1\'s and stands', answer.ok && tag(saved, 'prev') === crossed?.id && tag(saved, 'value') === 'in_progress', answer.ok ? tag(saved, 'prev') : answer.message)
  check('both status changes are kept', setup.events.filter((e) => tag(e, 'field') === 'status').length === 3)
}

// — Delete and restore, where projects are kept in order —
for (const how of [{ inOrder: true }, { refuseKind5: true }] as const) {
  const { context, published, addr, root } = workspace(how)
  const label = 'inOrder' in how ? 'advertised in order' : 'refusing kind:5'
  await run(context, 'delete-project', [addr], { yes: true })
  const deleted = mine(published).find((e) => tag(e, 'field') === 'deleted')
  check(`${label}: a delete is a deleted change after the record, no kind:5 stored`, tag(deleted, 'value') === 'true' && tag(deleted, 'prev') === root.id && !mine(published).some((e) => e.kind === 5))
  const listed = await run(context, 'projects', [])
  check(`${label}: it leaves the list`, listed.ok && !(listed.answer.projects as { ref: string }[]).some((p) => p.ref === addr))
  const shown = await run(context, 'show', [addr])
  check(`${label}: it still opens by its id, as deleted`, shown.ok && typeof (shown.answer.deleted as { at?: string } | undefined)?.at === 'string', shown.ok ? '' : shown.message)
  await run(context, 'delete-project', [addr], { restore: true })
  const restored = mine(published).filter((e) => tag(e, 'field') === 'deleted').at(-1)
  check(`${label}: a restore is the empty value after the delete`, tag(restored, 'value') === '' && tag(restored, 'prev') === deleted?.id)
  const back = await run(context, 'projects', [])
  check(`${label}: it is back in the list`, back.ok && (back.answer.projects as { ref: string }[]).some((p) => p.ref === addr))
}

// — Found by a word of its current text, not of an old one —
{
  const { context } = workspace()
  const now = await run(context, 'show', ['rollout'])
  check('a word in its current text finds it', now.ok && now.answer.title === 'Launch plan', now.ok ? String(now.answer.title) : now.message)
  const { context: c2, events, addr, read } = workspace()
  events.push(textChange(QA1, addr, doc(['b1', 'One.'], ['b2', 'Two.']), read.id))
  const old = await run(c2, 'show', ['rollout'])
  check('a word only in an old text finds nothing', !old.ok, old.ok ? String(old.answer.title) : old.message)
}

// — create-project: its first changes follow the record —
{
  const { context, published, events } = workspace()
  // The team, with state: its record and the list it keeps.
  events.push(signed(QA1, 39000, [['d', FOLDER], ['name', 'QA']]), signed(QA1, 30890, [['d', FOLDER]]))
  const created = await run(context, 'create-project', [], { team: FOLDER, title: 'Probe', description: 'Its text.' })
  if (!created.ok) console.log(created.message)
  const record = mine(published).find((e) => e.kind === 30850)
  const described = mine(published).find((e) => tag(e, 'field') === 'description')
  check('the description change follows the record', record !== undefined && tag(described, 'prev') === record.id, JSON.stringify({ record: record?.id, prev: tag(described, 'prev') }))
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll field checks passed.')
