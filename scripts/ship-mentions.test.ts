/**
 * Ship's descriptions as the agent reads and writes them (WBD-9): `show` lists
 * how each link draws, and a description that names somebody anew adds them,
 * as anyone's edit in Ship does (SPEC §11.8).
 *
 * Offline, over an in-memory relay holding the conformance fixture (production
 * events) and the manifest Ship published, keeping what is published so `show`
 * reads a write back as the next command would.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addrToNaddr, encodeNpub, type SignedEvent } from '@estiva-app/protocol'
import type { AgentContext } from '../lib/agent/cli'
import { shipApp } from '../lib/agent/apps/ship'

const here = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const SELF = 'a'.repeat(64)
const QA2 = 'c'.repeat(64)
const QA2_NPUB = encodeNpub(QA2)
const tag = (event: SignedEvent | undefined, name: string) => event?.tags.find((t) => t[0] === name)?.[1]
const tags = (event: SignedEvent | undefined, name: string) => event?.tags.filter((t) => t[0] === name).map((t) => t[1]) ?? []

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
const addressOf = (e: SignedEvent) => `${e.kind}:${e.pubkey}:${tag(e, 'd')}`
const [issue, other] = fixture.events.filter((e) => e.kind === 30851)
const ISSUE = addressOf(issue)
const workspace = () => relay([...structuredClone(fixture.events), manifest.event])
/** The membership change that adds `person` to `file`, as Ship's Add button writes it (§11.8). */
const addOf = (published: SignedEvent[], person: string) =>
  published.find((e) => e.kind === 1851 && tag(e, 'field') === `member:${person}` && tag(e, 'value') === 'true')

console.log('— A mention in a description adds the person —')
{
  const { context, published } = workspace()
  const out = await run('edit-issue', context, [ISSUE], { description: `Ask nostr:${QA2_NPUB} about it.`, mention: QA2_NPUB })
  const save = published.find((e) => tag(e, 'field') === 'description')
  const add = addOf(published, QA2)
  check(
    'ship edit-issue naming QA-2 anew writes the description, then the Add for QA-2 in the issue’s Folder',
    published.length === 2 && published[0] === save && tag(add, 'a') === ISSUE && tag(add, 'h') === tag(issue, 'h') && tag(add, 'p') === QA2,
    JSON.stringify(published.map((e) => e.tags.slice(0, 3))),
  )
  check('…the description change tags nobody it names', !tags(save, 'p').includes(QA2), JSON.stringify(save?.tags))
  check('…and says who was added', out.mentioned?.[0]?.added === `nostr:${QA2_NPUB}`, JSON.stringify(out.mentioned))

  published.length = 0
  await run('edit-issue', context, [ISSUE], { description: `Ask nostr:${QA2_NPUB} about it, please.` })
  check('a second edit that keeps the mention writes no Add', published.length === 1 && !addOf(published, QA2), `${published.length} published`)
}
{
  const { context, published } = workspace()
  const refused = await refusal(run('edit-issue', context, [ISSUE], { description: `Ask nostr:${QA2_NPUB}.` }))
  check('a mention --mention does not name is refused with nothing published', published.length === 0 && /--mention does not name/.test(refused), refused || `${published.length} published`)
  const alone = await refusal(run('edit-issue', context, [ISSUE], { title: 'Renamed', mention: QA2_NPUB }))
  check('--mention without --description is refused', published.length === 0 && /goes with --description/.test(alone), alone || `${published.length} published`)
}
{
  const { context, published } = workspace()
  const project = fixture.events.find((e) => e.kind === 30850)!
  const out = await run('create-issue', context, [], { project: addressOf(project), title: 'Mentioning', description: `For nostr:${QA2_NPUB}.`, mention: QA2_NPUB })
  const add = addOf(published, QA2)
  check('ship create-issue whose description names QA-2 adds QA-2 to the new issue', tag(add, 'a') === out.created?.addr && tag(add, 'p') === QA2, JSON.stringify(published.map((e) => e.kind)))
}

console.log('\n— How each link draws —')
{
  const { context } = workspace()
  const naddr = `nostr:${addrToNaddr(addressOf(other))}`
  const reference = (embed?: string) => ({ type: 'text', text: naddr, marks: [{ type: 'reference', attrs: { uri: naddr, ...(embed ? { embed } : {}) } }] })
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', id: 'p1', content: [{ type: 'text', text: 'Blocked by ' }, reference(), { type: 'text', text: '.' }] },
      { type: 'paragraph', id: 'p2', content: [reference()] },
      { type: 'paragraph', id: 'p3', content: [reference('detailed')] },
    ],
  }
  await context.relay.publish({
    id: 'f'.repeat(64), pubkey: issue.pubkey, created_at: 1_900_000_000, kind: 1851, content: '', sig: '',
    tags: [['a', ISSUE], ['field', 'description'], ['value', JSON.stringify(doc)], ['content-format', 'estiva-blocks-1'], ['h', tag(issue, 'h')!], ['ts', '1900000000000']],
  } as SignedEvent)
  const out = await run('show', context, [ISSUE], {})
  const drawn = (out.links ?? []).map((link: Record<string, string>) => `${link.draws}:${link.to === addressOf(other) ? 'other' : link.to}`)
  check('ship show lists a chip in a sentence, a row alone and a card chosen', JSON.stringify(drawn) === JSON.stringify(['chip:other', 'row:other', 'card:other']), JSON.stringify(drawn))
  check('…each titled from the workspace', out.links?.every((link: Record<string, string>) => link.title === tag(other, 'title')), JSON.stringify(out.links?.[0]))
}

console.log(failures ? `\n${failures} failed.` : '\nAll Ship description checks passed.')
process.exit(failures ? 1 : 0)
