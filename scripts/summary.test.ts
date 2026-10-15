/**
 * A file's summary through the agent (SUM-2, SPEC §6.12): what each verb puts
 * on the wire, and what the listings read back.
 *
 * Offline, over an in-memory relay. Ship's side runs on the manifest Ship
 * published (`conformance/ship-manifest.json`), once as it is — it declares no
 * summary yet, so `--summary` must be refused with nothing published — and
 * once with the two writers SPEC §7.3 says it gains: a `summary` property on
 * `add-issue` and an action emitting `field: summary`. Peek's side runs on
 * interop's built-in Folder and bare-file actions.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SignedEvent } from '@estiva-app/protocol'
import type { AgentContext } from '../lib/agent/cli'
import { shipApp } from '../lib/agent/apps/ship'
import { peekApp } from '../lib/agent/apps/peek'

const here = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const SELF = 'a'.repeat(64)
const RELAY_KEY = 'b'.repeat(64)
const FOLDER = '11111111-2222-3333-4444-555555555555'
const PROJECT = `30850:${SELF}:p1`
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

const run = (app: typeof shipApp, name: string, context: AgentContext, positional: string[], flags: Record<string, string>) =>
  app.commands.find((command) => command.name === name)!.run(context, { positional, flags } as never) as Promise<Record<string, unknown>>
const refusal = (promise: Promise<unknown>) => promise.then(() => '', (error: Error) => error.message)

// Ship, as published today, and as SPEC §7.3 has it once Ship declares the writers.
const recorded = JSON.parse(JSON.parse(readFileSync(join(here, '..', 'conformance', 'ship-manifest.json'), 'utf8')).event.content)
const withWriters = structuredClone(recorded)
const addIssue = withWriters.actions.find((action: { id: string }) => action.id === 'add-issue')
addIssue.input.properties.summary = { type: 'string' }
withWriters.actions.push(
  { id: 'summarize-issue', label: 'Summary', effect: 'writes', appliesTo: '30851', emits: { kind: 1851, field: 'summary' }, input: { type: 'string' } },
  { id: 'summarize-project', label: 'Summary', effect: 'writes', appliesTo: '30850', emits: { kind: 1851, field: 'summary' }, input: { type: 'string' } },
)

function ship(manifest: unknown) {
  return relay([
    event(31990, [['d', 'ship'], ['k', '30850'], ['k', '30851']], JSON.stringify(manifest)),
    event(31989, [['d', '30850'], ['a', `31990:${SELF}:ship`]]),
    event(31989, [['d', '30851'], ['a', `31990:${SELF}:ship`]]),
    event(30850, [['d', 'p1'], ['name', 'Summaries'], ['buzz-channel', FOLDER]]),
    // Seeded at creation and never changed.
    event(30851, [['d', 'i1'], ['title', 'Seeded'], ['a', PROJECT], ['h', FOLDER], ['summary', 'What the seed says.']]),
    // Seeded, then changed by a 1851 in its own Folder…
    event(30851, [['d', 'i2'], ['title', 'Changed'], ['a', PROJECT], ['h', FOLDER], ['summary', 'The old line.']]),
    event(1851, [['h', FOLDER], ['a', `30851:${SELF}:i2`], ['field', 'summary'], ['value', 'The new line.']]),
    // …and one with none.
    event(30851, [['d', 'i3'], ['title', 'Bare'], ['a', PROJECT], ['h', FOLDER]]),
  ])
}

console.log('— Ship: reading —')
{
  const { context } = ship(withWriters)
  const listed = (await run(shipApp, 'issues', context, [], { project: PROJECT, json: 'true' })) as { issues: { short: string; summary?: string }[] }
  const by = (short: string) => listed.issues.find((issue) => issue.short.startsWith(short.slice(0, 2)))
  check('a summary seeded at creation is listed', by('i1')?.summary === 'What the seed says.', JSON.stringify(by('i1')))
  check('a summary changed since is listed as changed', by('i2')?.summary === 'The new line.', JSON.stringify(by('i2')))
  check('an issue with none lists no summary', by('i3') !== undefined && by('i3')!.summary === undefined, JSON.stringify(by('i3')))
}

console.log('\n— Ship: writing —')
{
  const { context, published } = ship(withWriters)
  await run(shipApp, 'create-issue', context, [], { project: PROJECT, title: 'New', summary: 'One line\nabout it.' })
  check('create-issue seeds the summary on the issue root, folded to one line', published[0]?.kind === 30851 && tag(published[0], 'summary') === 'One line about it.', JSON.stringify(published[0]?.tags))
  check('and publishes nothing else', published.length === 1, String(published.length))
}
{
  const { context, published } = ship(withWriters)
  const out = await run(shipApp, 'edit-issue', context, ['i2'], { summary: 'x'.repeat(300) })
  const change = published[0]
  check(
    'edit-issue --summary is a 1851 on field summary, in the issue’s Folder',
    change?.kind === 1851 && tag(change, 'field') === 'summary' && tag(change, 'h') === FOLDER && tag(change, 'a') === `30851:${SELF}:i2`,
    JSON.stringify(change?.tags),
  )
  check('past ~240 characters it is written whole, and said', tag(change, 'value')?.length === 300 && JSON.stringify(out).includes('300 characters'), JSON.stringify(out).slice(0, 200))
}
{
  const { context, published } = ship(withWriters)
  await run(shipApp, 'edit-issue', context, ['i1'], { summary: '' })
  check('edit-issue --summary "" clears it with an empty value', tag(published[0], 'field') === 'summary' && tag(published[0], 'value') === '', JSON.stringify(published[0]?.tags))
}
{
  const { context, published } = ship(recorded)
  const refused = await refusal(run(shipApp, 'create-issue', context, [], { project: PROJECT, title: 'New', summary: 'A line.' }))
  check('a manifest with no summary writer refuses --summary before publishing anything', published.length === 0 && /declares no summary/.test(refused), refused || `${published.length} published`)
  const edit = await refusal(run(shipApp, 'edit-issue', context, ['i1'], { summary: 'A line.' }))
  check('…and so does edit-issue', published.length === 0 && /declares no action that sets summary/.test(edit), edit)
}

// Peek: a top-level Folder whose state lists one topic, and an app claiming
// Folders as Peek's manifest does on production — `resolveActingManifest`
// hands back the Folder's built-ins only when some app owns the kind.
const PEEK_KEY = 'c'.repeat(64)
const folderApp = {
  name: 'Peek',
  records: { changeKind: 1851, targetTag: 'a', fieldTag: 'field', valueTag: 'value', order: ['ts', 'created_at', 'id'], rule: 'last-write-wins-per-field' },
  projections: { 39000: { widget: 'card', slots: { title: { tag: 'name' } } } },
}
function peek() {
  return relay([
    event(31990, [['d', 'peek'], ['k', '39000']], JSON.stringify(folderApp), PEEK_KEY),
    event(39000, [['d', FOLDER], ['name', 'HQ']], '', RELAY_KEY),
    event(30890, [['d', FOLDER], ['a', `30840:${SELF}:t1`]], '', RELAY_KEY),
    event(30840, [['d', 't1'], ['title', 'Launch'], ['h', FOLDER], ['summary', 'What we call the launch.']]),
  ])
}

console.log('\n— Peek —')
{
  const { context } = peek()
  const listed = (await run(peekApp, 'topics', context, [], {})) as { topics: { title: string; summary?: string }[] }
  check('peek topics lists a topic’s summary', listed.topics[0]?.summary === 'What we call the launch.', JSON.stringify(listed.topics[0]))
}
{
  const { context, published } = peek()
  await run(peekApp, 'create-topic', context, [], { folder: 'HQ', title: 'Plans', summary: 'Where the plans live.' })
  const file = published[0]
  check(
    'create-topic seeds the summary on the new topic, in its Folder',
    file?.kind === 30840 && tag(file, 'title') === 'Plans' && tag(file, 'summary') === 'Where the plans live.' && tag(file, 'h') === FOLDER,
    JSON.stringify(file?.tags),
  )
  const listing = published[1]
  check(
    '…then lists it in the Folder, as Peek’s launcher does',
    published.length === 2 && tag(listing, 'h') === FOLDER && listing!.tags.some((t) => t[0] === 'a' && t[1] === `30840:${SELF}:${tag(file, 'd')}`),
    JSON.stringify(listing),
  )
}
{
  const { context, published } = peek()
  await run(peekApp, 'edit-topic', context, ['Launch'], { summary: 'The launch, renamed.' })
  const change = published[0]
  check(
    'edit-topic --summary is a 1851 on field summary, in the topic’s Folder',
    change?.kind === 1851 && tag(change, 'field') === 'summary' && tag(change, 'value') === 'The launch, renamed.' && tag(change, 'h') === FOLDER && tag(change, 'a') === `30840:${SELF}:t1`,
    JSON.stringify(change?.tags),
  )
}

console.log(failures ? `\n${failures} failed.` : '\nAll summary checks passed.')
process.exit(failures ? 1 : 0)
