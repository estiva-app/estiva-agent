/**
 * Nothing is written on an archived topic (PEEKM-8): `peek reply`, `peek say`
 * and `peek edit` on a topic archived in Peek are refused with the sentence
 * Peek shows in its comment box's place, and nothing reaches the relay; once
 * it is unarchived the reply goes out again.
 *
 * Offline, over an in-memory relay holding one Folder that lists one topic,
 * with QA-2's comment on it. Asserted on what would reach the relay.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-file-is-archived-with-the-closest-archived-file-above-it.md
 */
import { createHash } from 'node:crypto'
import type { SignedEvent } from '@estiva-app/protocol'
import type { AgentContext } from '../lib/agent/cli'
import { peekApp } from '../lib/agent/apps/peek'

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const SELF = 'a'.repeat(64)
const RELAY_KEY = 'b'.repeat(64)
const QA2 = 'c'.repeat(64)
const FOLDER = '11111111-2222-4333-8444-555555555555'
const TOPIC = `30840:${SELF}:22222222-2222-4333-8444-555555555555`

let seq = 0
const event = (kind: number, tagList: string[][], content = '', pubkey = SELF, created_at = 1_760_000_000 + seq): SignedEvent =>
  ({ id: createHash('sha256').update(`${seq++}`).digest('hex'), pubkey, created_at, kind, tags: tagList, content, sig: '' }) as SignedEvent

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
  const context = {
    relayUrl: 'https://estiva.example',
    relay: { queryAll, publish: async (e: SignedEvent) => (published.push(e), events.push(e), { ok: true, eventId: e.id }) },
    signer: { pubkey: SELF, sign: async (e: SignedEvent) => ({ ...e, id: createHash('sha256').update(JSON.stringify(e) + seq++).digest('hex'), sig: '' }) },
  } as unknown as AgentContext
  return { context, published, events }
}

const run = (name: string, context: AgentContext, positional: string[], flags: Record<string, string>) =>
  peekApp.commands.find((command) => command.name === name)!.run(context, { positional, flags } as never) as Promise<Record<string, any>>
const refusal = (promise: Promise<unknown>) => promise.then(() => '', (error: Error) => error.message)

const opening = event(1111, [['A', TOPIC], ['K', '30840'], ['P', SELF], ['a', TOPIC], ['k', '30840'], ['p', SELF], ['h', FOLDER]], 'Who opens the page?', QA2)
const mine = event(1111, [['A', TOPIC], ['K', '30840'], ['P', SELF], ['e', opening.id], ['k', '1111'], ['p', QA2], ['h', FOLDER]], 'The agent does.')
const archived = (on: boolean, at: number) =>
  event(1851, [['a', TOPIC], ['field', 'archived'], ['value', on ? 'true' : ''], ['h', FOLDER], ['ts', String(at * 1000)]], '', SELF, at)
const workspace = (...extra: SignedEvent[]) =>
  relay([
    event(39000, [['d', FOLDER], ['name', 'QA']], '', RELAY_KEY),
    event(30890, [['d', FOLDER], ['a', TOPIC]], '', RELAY_KEY),
    event(30840, [['d', TOPIC.split(':')[2]], ['title', 'Planning'], ['h', FOLDER]]),
    opening,
    mine,
    ...extra,
  ])

const SENTENCE = 'Archived. Unarchive it to comment. Nothing was published.'
{
  const { context, published, events } = workspace(archived(true, 1_900_000_000))
  const reply = await refusal(run('reply', context, ['Planning', opening.id], { body: 'Still on it.' }))
  check('peek reply on an archived topic is refused with Peek’s sentence', reply === SENTENCE, reply)
  const stray = await refusal(run('reply', context, ['Planning', 'f'.repeat(64)], { body: 'Still on it.' }))
  check('peek reply naming no conversation there still says the topic is archived', stray === SENTENCE, stray)
  const say = await refusal(run('say', context, ['Planning'], { body: 'Still on it.' }))
  check('peek say there is refused with the same sentence', say === SENTENCE, say)
  const edit = await refusal(run('edit', context, ['Planning', opening.id], { message: mine.id, body: 'Rewritten.' }))
  check('peek edit of your own message there is refused with the same sentence', edit === SENTENCE, edit)
  check('…and nothing is published', published.length === 0, JSON.stringify(published.map((e) => e.kind)))

  events.push(archived(false, 1_900_000_100))
  await run('reply', context, ['Planning', opening.id], { body: 'Back on it.' })
  check('once unarchived, peek reply publishes the reply', published.length === 1 && published[0].kind === 1111, JSON.stringify(published.map((e) => e.kind)))
}

{
  // A live topic and an archived one, both "Planning": the live one takes the write.
  const LIVE = `30840:${SELF}:33333333-2222-4333-8444-555555555555`
  const { context, published, events } = workspace(archived(true, 1_900_000_000))
  events.push(event(30840, [['d', LIVE.split(':')[2]], ['title', 'Planning'], ['h', FOLDER]]))
  events.find((e) => e.kind === 30890)!.tags.push(['a', LIVE])
  const said = await refusal(run('say', context, ['Planning'], { body: 'On the live one.' }))
  check('peek say by a title an archived topic shares goes to the live topic', said === '' && published.length === 1 && published[0].tags.some((t) => t[0] === 'A' && t[1] === LIVE), said || JSON.stringify(published.map((e) => e.tags.find((t) => t[0] === 'A'))))
}

console.log(failures ? `\n${failures} failed.` : '\nAll peek archived checks passed.')
process.exit(failures ? 1 : 0)
