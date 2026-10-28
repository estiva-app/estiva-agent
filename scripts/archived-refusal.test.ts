/**
 * Nothing is written on an archived file (PEEKM-8): `ship comment` and `ship
 * edit-comment` on an issue archived itself, or with its project, are refused
 * with the sentence Ship shows in its comment box's place, and nothing reaches
 * the relay; once it is unarchived the comment goes out again.
 *
 * Offline, over an in-memory relay holding the conformance fixture (production
 * events) and the manifest Ship published. Asserted on what would reach the relay.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-file-is-archived-with-the-closest-archived-file-above-it.md
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SignedEvent } from '@estiva-app/protocol'
import type { AgentContext } from '../lib/agent/cli'
import { shipApp } from '../lib/agent/apps/ship'
import { loadWorkspace } from '../lib/agent/apps/ship-workspace'

const here = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const SELF = 'a'.repeat(64)
const tag = (event: SignedEvent | undefined, name: string) => event?.tags.find((t) => t[0] === name)?.[1]

/** A relay answering NIP-01 filters over `events`, keeping and recording what is published. */
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
  let seq = 0
  const context = {
    relayUrl: 'https://estiva.example',
    relay: { queryAll, publish: async (e: SignedEvent) => (published.push(e), events.push(e), { ok: true, eventId: e.id }) },
    signer: { pubkey: SELF, sign: async (e: SignedEvent) => ({ ...e, id: createHash('sha256').update(JSON.stringify(e) + seq++).digest('hex'), sig: '' }) },
  } as unknown as AgentContext
  return { context, published }
}

const run = (name: string, context: AgentContext, positional: string[], flags: Record<string, string>) =>
  shipApp.commands.find((command) => command.name === name)!.run(context, { positional, flags } as never) as Promise<Record<string, any>>
const refusal = (promise: Promise<unknown>) => promise.then(() => '', (error: Error) => error.message)

const fixture = JSON.parse(readFileSync(join(here, '..', 'conformance', 'fold-fixture.json'), 'utf8')) as { events: SignedEvent[] }
const manifest = JSON.parse(readFileSync(join(here, '..', 'conformance', 'ship-manifest.json'), 'utf8')) as { event: SignedEvent }
const workspace = () => {
  const events = [...structuredClone(fixture.events), manifest.event]
  return { ...relay(events), events }
}

// An issue in a project, neither archived, with a comment to edit.
const { context: reader } = workspace()
const state = await loadWorkspace(reader)
const projects = new Map(state.projects.map((project) => [project.addr, project]))
const commentOn = (addr: string) => fixture.events.find((e) => e.kind === 1111 && tag(e, 'A') === addr && tag(e, 'a') === addr)
const issue = state.issues.find((candidate) => !candidate.archived && candidate.projectAddr && projects.get(candidate.projectAddr)?.archived === false && commentOn(candidate.addr))!
const project = projects.get(issue.projectAddr!)!
const comment = commentOn(issue.addr)!

let clock = 2_000_000_000
/** The `archived` change Ship's Archive writes, by the file's author, newer than anything in the fixture. */
const archive = (addr: string, author: string, folder: string, on: boolean): SignedEvent => {
  clock += 10
  return {
    id: createHash('sha256').update(`${addr}${clock}`).digest('hex'),
    pubkey: author,
    created_at: clock,
    kind: 1851,
    tags: [['a', addr], ['field', 'archived'], ['value', on ? 'true' : ''], ['h', folder], ['ts', String(clock * 1000)]],
    content: '',
    sig: '',
  }
}

console.log('— An issue archived itself —')
{
  const { context, published, events } = workspace()
  events.push(archive(issue.addr, issue.author, issue.folder, true))
  const said = await refusal(run('comment', context, [issue.addr], { body: 'Still on it.' }))
  check('ship comment on an archived issue is refused with Ship’s sentence', said === 'Archived. Unarchive it to comment. Nothing was published.', said)
  check('…and nothing is published', published.length === 0, JSON.stringify(published.map((e) => e.kind)))
  const edit = await refusal(run('edit-comment', context, [issue.addr], { message: comment.id, body: 'Rewritten.' }))
  check('ship edit-comment of a comment on it is refused with the same sentence', edit === 'Archived. Unarchive it to comment. Nothing was published.', edit)
  check('…and nothing is published', published.length === 0, JSON.stringify(published.map((e) => e.kind)))

  events.push(archive(issue.addr, issue.author, issue.folder, false))
  await run('comment', context, [issue.addr], { body: 'Back on it.' })
  check('once unarchived, ship comment publishes the comment', published.length === 1 && published[0].kind === 1111 && tag(published[0], 'A') === issue.addr, JSON.stringify(published.map((e) => e.kind)))
}

console.log('\n— An issue archived with its project —')
{
  const { context, published, events } = workspace()
  events.push(archive(project.addr, project.author, project.contentFolder, true))
  const said = await refusal(run('comment', context, [issue.addr], { body: 'Still on it.' }))
  check('ship comment on an issue whose project is archived names the project', said === 'Unarchive the project to comment. Nothing was published.', said)
  const edit = await refusal(run('edit-comment', context, [issue.addr], { message: comment.id, body: 'Rewritten.' }))
  check('ship edit-comment there says the same', edit === 'Unarchive the project to comment. Nothing was published.', edit)
  check('…and nothing is published', published.length === 0, JSON.stringify(published.map((e) => e.kind)))
}

console.log(failures ? `\n${failures} failed.` : '\nAll archived-refusal checks passed.')
process.exit(failures ? 1 : 0)
