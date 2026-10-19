/**
 * A file's summary through the agent (SUM-2, SPEC §6.12): what each verb puts
 * on the wire, and what the listings read back.
 *
 * Offline, over an in-memory relay. Ship's side runs on the manifest Ship
 * published (`conformance/ship-manifest.json`), once as it is — with the two
 * writers SPEC §7.3 names: a `summary` property on `add-issue` and an action
 * emitting `field: summary` — and once with those taken out, where `--summary`
 * must be refused with nothing published. Peek's side runs on interop's
 * built-in Folder and bare-file actions.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SignedEvent } from '@estiva-app/protocol'
import type { AgentContext } from '../lib/agent/cli'
import { shipApp } from '../lib/agent/apps/ship'
import { peekApp } from '../lib/agent/apps/peek'
import { fileApp } from '../lib/agent/apps/file'

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

// Ship, as published (it declares the writers since ship#304), and the same
// manifest with them taken out — an app that has not declared a summary yet.
type Action = { id: string; emits?: { field?: string }; input?: { properties?: Record<string, unknown> } }
const withWriters = JSON.parse(JSON.parse(readFileSync(join(here, '..', 'conformance', 'ship-manifest.json'), 'utf8')).event.content)
const withoutWriters = structuredClone(withWriters)
withoutWriters.actions = withoutWriters.actions.filter((action: Action) => action.emits?.field !== 'summary')
for (const action of withoutWriters.actions as Action[]) delete action.input?.properties?.summary

function ship(manifest: unknown, extra: SignedEvent[] = []) {
  return relay([
    ...extra,
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
  // A moved project: another team's Folder lists it, its own Folder is still FOLDER (LTX-4).
  const TEAM = '99999999-8888-7777-6666-555555555555'
  const { context, published } = ship(withWriters, [
    event(39000, [['d', TEAM], ['name', 'Team']], '', RELAY_KEY),
    event(30890, [['d', TEAM], ['a', PROJECT]], '', RELAY_KEY),
  ])
  await run(shipApp, 'create-issue', context, [], { project: PROJECT, title: 'New' })
  check('create-issue files a moved project’s issue in the project’s own Folder, not the one listing it', tag(published[0], 'h') === FOLDER, JSON.stringify(published[0]?.tags))

  // The same with a summary written as a change after the issue: both in the project's Folder.
  const changeOnly = structuredClone(withWriters)
  delete (changeOnly.actions as Action[]).find((action) => action.id === 'add-issue')?.input?.properties?.summary
  const moved = ship(changeOnly, [
    event(39000, [['d', TEAM], ['name', 'Team']], '', RELAY_KEY),
    event(30890, [['d', TEAM], ['a', PROJECT]], '', RELAY_KEY),
  ])
  await run(shipApp, 'create-issue', moved.context, [], { project: PROJECT, title: 'New', summary: 'A line.' })
  check(
    '…and its summary, written after it as a 1851, goes to the same Folder',
    moved.published.length === 2 && moved.published.every((e) => tag(e, 'h') === FOLDER),
    JSON.stringify(moved.published.map((e) => [e.kind, tag(e, 'h')])),
  )
}
{
  // A project record naming no Folder: the Folder that lists it, else a refusal with nothing published.
  const BARE = `30850:${SELF}:p2`
  const TEAM = '99999999-8888-7777-6666-555555555555'
  const listed = ship(withWriters, [
    event(30850, [['d', 'p2'], ['name', 'No Folder']]),
    event(39000, [['d', TEAM], ['name', 'Team']], '', RELAY_KEY),
    event(30890, [['d', TEAM], ['a', BARE]], '', RELAY_KEY),
  ])
  await run(shipApp, 'create-issue', listed.context, [], { project: BARE, title: 'New' })
  check('create-issue on a project naming no Folder files it in the Folder that lists it', tag(listed.published[0], 'h') === TEAM, JSON.stringify(listed.published[0]?.tags))

  const unlisted = ship(withWriters, [event(30850, [['d', 'p2'], ['name', 'No Folder']])])
  const refused = await refusal(run(shipApp, 'create-issue', unlisted.context, [], { project: BARE, title: 'New' }))
  check('…and with no Folder listing it either, refuses with nothing published', unlisted.published.length === 0 && /nowhere to be filed/.test(refused), refused || `${unlisted.published.length} published`)
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
  const { context, published } = ship(withoutWriters)
  const refused = await refusal(run(shipApp, 'create-issue', context, [], { project: PROJECT, title: 'New', summary: 'A line.' }))
  check('a manifest with no summary writer refuses --summary before publishing anything', published.length === 0 && /declares no summary/.test(refused), refused || `${published.length} published`)
  const edit = await refusal(run(shipApp, 'edit-issue', context, ['i1'], { summary: 'A line.' }))
  check('…and so does edit-issue', published.length === 0 && /declares no action that sets summary/.test(edit), edit)
}
{
  // A create action that takes no summary, beside an action that changes one.
  const changeOnly = structuredClone(withWriters)
  delete (changeOnly.actions as Action[]).find((action) => action.id === 'add-issue')?.input?.properties?.summary
  const { context, published } = ship(changeOnly)
  await run(shipApp, 'create-issue', context, [], { project: PROJECT, title: 'New', summary: 'A line.' })
  const [root, change] = published
  check(
    'with no seed, create-issue writes the issue bare and then a 1851 on summary, in its Folder',
    root?.kind === 30851 && tag(root, 'summary') === undefined && change?.kind === 1851 && tag(change, 'field') === 'summary' &&
      tag(change, 'value') === 'A line.' && tag(change, 'a') === `30851:${SELF}:${tag(root, 'd')}` && tag(change, 'h') === FOLDER,
    JSON.stringify(published.map((e) => e.tags)),
  )
}

// Peek: a top-level Folder whose state lists one topic, and no app claiming
// Folders. A Folder is the protocol's (SPEC §3.2): since interop 0.58 its
// manifest is built in and answered before NIP-89, so `create-file` is there
// whether or not Peek's manifest still claims `k 39000` — which it is about to
// stop doing. `peek(true)` adds that claim as production has it until then.
const PEEK_KEY = 'c'.repeat(64)
const stalePeekClaim = {
  name: 'Peek',
  records: { changeKind: 1851, targetTag: 'a', fieldTag: 'field', valueTag: 'value', order: ['ts', 'created_at', 'id'], rule: 'last-write-wins-per-field' },
  projections: { 39000: { widget: 'card', slots: { title: { tag: 'name' } } } },
}
function peek(claimed = false) {
  return relay([
    ...(claimed ? [event(31990, [['d', 'peek'], ['k', '39000']], JSON.stringify(stalePeekClaim), PEEK_KEY)] : []),
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
for (const claimed of [false, true]) {
  const { context, published } = peek(claimed)
  const when = claimed ? ' (Peek’s old k 39000 claim still published)' : ''
  const refused = await refusal(run(peekApp, 'create-topic', context, [], { folder: 'HQ', title: 'Plans', summary: 'Where the plans live.' }))
  const file = published[0]
  check(
    `create-topic seeds the summary on the new topic, in its Folder${when}`,
    !refused &&
      file?.kind === 30840 && tag(file, 'title') === 'Plans' && tag(file, 'summary') === 'Where the plans live.' && tag(file, 'h') === FOLDER,
    refused || JSON.stringify(file?.tags),
  )
  const listing = published[1]
  check(
    `…then lists it in the Folder, as Peek’s launcher does${when}`,
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

// Any file by its address (SUM-8): a document of an app this repository has no
// module for, claimed by that app's own manifest, as Leaf claims 30842.
const LEAF_KEY = 'd'.repeat(64)
const DOC = `30842:${SELF}:doc1`
function leaf(withSummarize = true, summarizeKind = 1851, extra: SignedEvent[] = [], withDoc = true, targetTag = 'a') {
  const manifest = {
    name: 'Leaf',
    records: { changeKind: 1851, targetTag, fieldTag: 'field', valueTag: 'value', order: ['ts', 'created_at', 'id'], rule: 'last-write-wins-per-field' },
    projections: { 30842: { widget: 'card', noun: 'document', slots: { title: { tag: 'title', fold: 'title' } } } },
    actions: [
      { id: 'rename', label: 'Rename', effect: 'writes', appliesTo: ['30842'], emits: { kind: 1851, field: 'title' }, input: { type: 'string' } },
      ...(withSummarize ? [{ id: 'summarize', label: 'Edit summary', effect: 'writes', appliesTo: ['30842'], emits: { kind: summarizeKind, field: 'summary' }, input: { type: 'string' } }] : []),
    ],
  }
  return relay([
    event(31990, [['d', 'estiva-leaf'], ['k', '30842']], JSON.stringify(manifest), LEAF_KEY),
    ...extra,
    ...(withDoc ? [event(30842, [['d', 'doc1'], ['title', 'Plan'], ['h', FOLDER], ['summary', 'The old line.']])] : []),
  ])
}

console.log('\n— Any file, by its address —')
{
  const { context, published } = leaf()
  const out = await run(fileApp as never, 'summarize', context, [DOC], { summary: 'What the plan is\nfor.' })
  const change = published[0]
  check(
    'file summarize is a 1851 on field summary, on that address, in the file’s Folder, folded to one line',
    published.length === 1 && change?.kind === 1851 && tag(change, 'field') === 'summary' && tag(change, 'value') === 'What the plan is for.' &&
      tag(change, 'a') === DOC && tag(change, 'h') === FOLDER,
    JSON.stringify(published.map((e) => e.tags)),
  )
  const changed = (out as { changed?: { file?: string; from?: string } }).changed
  check('and says which file it changed and what its summary was', changed?.file === 'Plan' && changed?.from === 'The old line.', JSON.stringify(out))
}
{
  const { context, published } = leaf(false)
  const refused = await refusal(run(fileApp as never, 'summarize', context, [DOC], { summary: 'A line.' }))
  check('a file whose manifest declares no summary action is refused with nothing published', published.length === 0 && /declares no action/.test(refused), refused || `${published.length} published`)
}
{
  const { context, published } = leaf()
  const refused = await refusal(run(fileApp as never, 'summarize', context, [`30842:${SELF}:nobody`], { summary: 'A line.' }))
  check('an address nothing answers for is refused with nothing published', published.length === 0 && /Nothing readable/.test(refused), refused || `${published.length} published`)
}
{
  // A manifest is anybody's event: one declaring the summary as a deletion must not get one signed.
  const { context, published } = leaf(true, 5)
  const refused = await refusal(run(fileApp as never, 'summarize', context, [DOC], { summary: 'A line.' }))
  check('a manifest declaring the summary as another kind is refused with nothing published', published.length === 0 && /does not write/.test(refused), refused || JSON.stringify(published))
}
{
  // Any member can publish the newest claim on a kind: one naming the target in its own tag must not get it signed.
  const { context, published } = leaf(true, 1851, [], true, 'x')
  const refused = await refusal(run(fileApp as never, 'summarize', context, [DOC], { summary: 'A line.' }))
  check('a manifest that builds a summary change with tags of its own is refused with nothing published', published.length === 0 && /Nothing was published/.test(refused), refused || JSON.stringify(published.map((e) => e.tags)))
}
{
  // Another person's document with the same d, in another Folder, newer than the real one.
  const OTHER_FOLDER = '99999999-2222-3333-4444-555555555555'
  const impostor = event(30842, [['d', 'doc1'], ['title', 'Not it'], ['h', OTHER_FOLDER]], '', 'e'.repeat(64), 1_900_000_000)
  const { context, published } = leaf(true, 1851, [impostor])
  await run(fileApp as never, 'summarize', context, [DOC], { summary: 'A line.' })
  check('another author’s file with the same d never lends its Folder', published.length === 1 && tag(published[0], 'h') === FOLDER, JSON.stringify(published.map((e) => e.tags)))
  const alone = leaf(true, 1851, [impostor], false)
  const refused = await refusal(run(fileApp as never, 'summarize', alone.context, [DOC], { summary: 'A line.' }))
  check('…and with only that file on the relay, the address is refused with nothing published', alone.published.length === 0 && /Nothing readable/.test(refused), refused || JSON.stringify(alone.published.map((e) => e.tags)))
}

console.log(failures ? `\n${failures} failed.` : '\nAll summary checks passed.')
process.exit(failures ? 1 : 0)
