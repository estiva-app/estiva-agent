/**
 * `file archive` (AGE-21): any file archived by its address the way its own
 * app's Archive does it — a Leaf page or a Peek topic, which `ship archive`
 * cannot reach. What goes on the wire, and what is refused with nothing
 * published.
 *
 * Offline, over an in-memory relay, with a manifest shaped like Leaf's: an
 * `archive` action emitting a change on `archived`, hidden when it is `true`.
 */
import { createHash } from 'node:crypto'
import type { SignedEvent } from '@estiva-app/protocol'
import type { AgentContext } from '../lib/agent/cli'
import { fileApp } from '../lib/agent/apps/file'

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const SELF = 'a'.repeat(64)
const LEAF_KEY = 'd'.repeat(64)
const FOLDER = '11111111-2222-3333-4444-555555555555'
const DOC = `30842:${SELF}:doc1`
const tag = (event: SignedEvent | undefined, name: string) => event?.tags.find((t) => t[0] === name)?.[1]

let seq = 0
const event = (kind: number, tags: string[][], content = '', pubkey = SELF, created_at = 1_760_000_000 + seq): SignedEvent =>
  ({ id: createHash('sha256').update(`${seq++}`).digest('hex'), pubkey, created_at, kind, tags, content, sig: '' }) as SignedEvent

/** A relay answering NIP-01 filters over `events`, recording what is published. */
function relay(events: SignedEvent[]) {
  const published: SignedEvent[] = []
  const values = (e: SignedEvent, name: string) => e.tags.filter((t) => t[0] === name).map((t) => t[1])
  const matches = (e: SignedEvent, filter: Record<string, unknown>) =>
    (!Array.isArray(filter.ids) || filter.ids.includes(e.id)) &&
    (!Array.isArray(filter.kinds) || filter.kinds.includes(e.kind)) &&
    (!Array.isArray(filter.authors) || filter.authors.includes(e.pubkey)) &&
    Object.entries(filter).every(([key, wanted]) => !key.startsWith('#') || (wanted as string[]).some((v) => values(e, key.slice(1)).includes(v)))
  const queryAll = async (filters: Record<string, unknown>[]) => {
    const found = new Map<string, SignedEvent>()
    for (const filter of filters) {
      const hits = events.filter((e) => matches(e, filter)).sort((a, b) => b.created_at - a.created_at)
      for (const e of typeof filter.limit === 'number' ? hits.slice(0, filter.limit) : hits) found.set(e.id, e)
    }
    return [...found.values()]
  }
  const context = {
    relay: { queryAll, publish: async (e: SignedEvent) => (published.push(e), { ok: true, eventId: e.id }) },
    signer: { pubkey: SELF, sign: async (e: SignedEvent) => ({ ...e, id: createHash('sha256').update(JSON.stringify(e)).digest('hex'), sig: '' }) },
  } as unknown as AgentContext
  return { context, published }
}

/** A Leaf-shaped app holding one document; `archiveKind` 0 leaves the action out. */
function leaf({ archiveKind = 1851, archived = false } = {}) {
  const manifest = {
    name: 'Leaf',
    records: {
      changeKind: 1851, targetTag: 'a', fieldTag: 'field', valueTag: 'value', order: ['ts', 'created_at', 'id'],
      rule: 'last-write-wins-per-field', hiddenWhen: { field: 'archived', equals: 'true' },
    },
    projections: { 30842: { widget: 'card', noun: 'document', slots: { title: { tag: 'title', fold: 'title' } } } },
    actions: [
      { id: 'rename', label: 'Rename', effect: 'writes', appliesTo: ['30842'], emits: { kind: 1851, field: 'title' }, input: { type: 'string' } },
      ...(archiveKind ? [{ id: 'archive', label: 'Archive', effect: 'writes', appliesTo: ['30842'], emits: { kind: archiveKind, field: 'archived' }, input: { type: 'string', enum: 'archived' } }] : []),
    ],
    vocabularies: { archived: [{ value: '', label: 'Active', colour: 'neutral' }, { value: 'true', label: 'Archived', colour: 'muted' }] },
  }
  return relay([
    event(31990, [['d', 'estiva-leaf'], ['k', '30842']], JSON.stringify(manifest), LEAF_KEY),
    event(30842, [['d', 'doc1'], ['title', 'Plan'], ['h', FOLDER]]),
    ...(archived ? [event(1851, [['a', DOC], ['field', 'archived'], ['value', 'true'], ['h', FOLDER]], 'Done with it.')] : []),
  ])
}

const run = (context: AgentContext, positional: string[], flags: Record<string, string | boolean>) =>
  fileApp.commands.find((command) => command.name === 'archive')!.run(context, { positional, flags } as never) as Promise<Record<string, unknown>>
const refusal = (promise: Promise<unknown>) => promise.then(() => '', (error: Error) => error.message)

{
  const { context, published } = leaf()
  const out = await run(context, [DOC], { resolution: 'A probe’s leftover.' })
  const change = published[0]
  check(
    'archive is one 1851 setting archived to true on that address, in the file’s Folder, the resolution as its content',
    published.length === 1 && change?.kind === 1851 && tag(change, 'a') === DOC && tag(change, 'field') === 'archived' &&
      tag(change, 'value') === 'true' && tag(change, 'h') === FOLDER && change?.content === 'A probe’s leftover.' && change?.pubkey === SELF,
    JSON.stringify(published.map((e) => [e.kind, e.tags, e.content])),
  )
  check('and answers with the file it archived', (out.changed as { file?: string })?.file === 'Plan' && out.archived === true, JSON.stringify(out))
}
{
  const { context, published } = leaf({ archived: true })
  await run(context, [DOC], { unarchive: true })
  check(
    'unarchive sets archived to the empty value, with no resolution',
    published.length === 1 && tag(published[0], 'field') === 'archived' && tag(published[0], 'value') === '' && published[0].content === '',
    JSON.stringify(published.map((e) => [e.tags, e.content])),
  )
}
{
  const { context, published } = leaf({ archived: true })
  const out = await run(context, [DOC], { resolution: 'Again.' })
  check('a file already archived is said so, with nothing published', published.length === 0 && /already archived/.test(String(out.note)), JSON.stringify(out))
}
{
  const { context, published } = leaf()
  const out = await run(context, [DOC], { unarchive: true })
  check('unarchiving a file that is not archived publishes nothing', published.length === 0 && /not archived/.test(String(out.note)), JSON.stringify(out))
}
{
  const { context, published } = leaf()
  const refused = await refusal(run(context, [DOC], { unarchive: true, resolution: 'x' }))
  check('--resolution with --unarchive is refused before anything is read', published.length === 0 && /--resolution goes with an archive/.test(refused), refused)
}
{
  const { context, published } = leaf({ archiveKind: 0 })
  const refused = await refusal(run(context, [DOC], { resolution: 'x' }))
  check('a file whose manifest declares no archive is refused with nothing published', published.length === 0 && /declares no action/.test(refused), refused || JSON.stringify(published))
}
{
  // A manifest is anybody's event: one declaring the archive as a deletion must not get one signed.
  const { context, published } = leaf({ archiveKind: 5 })
  const refused = await refusal(run(context, [DOC], { resolution: 'x' }))
  check('a manifest declaring the archive as another kind is refused with nothing published', published.length === 0 && /does not (write|take)/.test(refused), refused || JSON.stringify(published))
}
{
  const { context, published } = leaf()
  const refused = await refusal(run(context, [`30842:${SELF}:nobody`], { resolution: 'x' }))
  check('an address nothing answers for is refused with nothing published', published.length === 0 && /Nothing readable/.test(refused), refused || `${published.length} published`)
}

console.log(failures ? `\n${failures} failed.` : '\nAll file archive checks passed.')
process.exit(failures ? 1 : 0)
