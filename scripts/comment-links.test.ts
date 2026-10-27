/**
 * What a comment and an edit say they link (PEEKM-7, SPEC §13.1): the agent's
 * comment with a link to an issue carries that issue's `a`, so the issue lists
 * it under Mentioned in, as a comment written in Ship, Peek or Leaf does; a URL
 * in code links nothing; and an edit carries the whole `a`/`q` set its new
 * words earn, never a `p` or a `part`.
 *
 * Offline, over an in-memory relay holding the conformance fixture (production
 * events) and the manifest Ship published, whose `urls` say what a Ship link
 * names. Asserted on the events that would reach the relay.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/an-edit-says-what-the-message-links-now.md
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeNevent, encodeNpub, type SignedEvent } from '@estiva-app/protocol'
import type { AgentContext } from '../lib/agent/cli'
import { shipApp } from '../lib/agent/apps/ship'
import { publishEdit } from '../lib/agent/conversation'

const here = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const SELF = 'a'.repeat(64)
const QA2 = 'c'.repeat(64)
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

const fixture = JSON.parse(readFileSync(join(here, '..', 'conformance', 'fold-fixture.json'), 'utf8')) as { events: SignedEvent[] }
const manifest = JSON.parse(readFileSync(join(here, '..', 'conformance', 'ship-manifest.json'), 'utf8')) as { event: SignedEvent }
const addressOf = (e: SignedEvent) => `${e.kind}:${e.pubkey}:${tag(e, 'd')}`
const [issue, other, third] = fixture.events.filter((e) => e.kind === 30851)
const ISSUE = addressOf(issue)
/** A Ship issue's link, as a person copies it from Ship's address bar (Ship's manifest `urls`). */
const linkTo = (e: SignedEvent) => `https://ship.estiva.app/issue/some-title-${tag(e, 'd')}`
const workspace = () => relay([...structuredClone(fixture.events), manifest.event])
/** Somebody's message elsewhere, which the edit quotes by `nostr:nevent…`. */
const quoted = fixture.events.find((e) => e.kind === 1111 && tag(e, 'A') !== ISSUE)!

console.log('— A comment says what it links —')
{
  const { context, published } = workspace()
  await run('comment', context, [ISSUE], { body: `Blocked by ${linkTo(other)} for now, see ${linkTo(third)}#block-b1.` })
  const [sent] = published
  check(
    'ship comment with links to two other issues carries each issue’s a, after its own',
    sent?.kind === 1111 && JSON.stringify(tags(sent, 'a')) === JSON.stringify([ISSUE, addressOf(other), addressOf(third)]),
    JSON.stringify(sent?.tags),
  )
  check('…and the part a link to one block names, on a send', JSON.stringify(sent?.tags.filter((t) => t[0] === 'part')) === JSON.stringify([['part', addressOf(third), 'b1']]), JSON.stringify(sent?.tags))
}
{
  const { context, published } = workspace()
  await run('comment', context, [ISSUE], { body: `Paste \`${linkTo(other)}\` into the box.` })
  const [sent] = published
  check('ship comment with the link only in a code span links nothing: no a but its own issue', JSON.stringify(tags(sent, 'a')) === JSON.stringify([ISSUE]), JSON.stringify(sent?.tags))
}
{
  const { context, published } = workspace()
  await run('comment', context, [ISSUE], { body: `This one: ${linkTo(issue)}` })
  const [sent] = published
  check('ship comment linking its own issue names it once, as the issue it is on', JSON.stringify(tags(sent, 'a')) === JSON.stringify([ISSUE]), JSON.stringify(sent?.tags))
}

console.log('\n— An edit says what the message links now —')
{
  const { context, published } = workspace()
  const QA2_NPUB = encodeNpub(QA2)
  const first = await run('comment', context, [ISSUE], { body: `Ask nostr:${QA2_NPUB} about ${linkTo(other)}.`, mention: QA2_NPUB })
  published.length = 0
  const nevent = `nostr:${encodeNevent({ id: quoted.id, relays: [] })}`
  await run('edit-comment', context, [ISSUE], {
    message: first.eventId,
    body: `Ask nostr:${QA2_NPUB} about ${linkTo(other)} and ${linkTo(third)}#block-b1, as ${nevent} says, here on ${linkTo(issue)}.`,
  })
  const [edit] = published
  check(
    'ship edit-comment adding a second issue link carries the whole a set its new words earn, both issues',
    edit?.kind === 40003 && JSON.stringify(tags(edit, 'a')) === JSON.stringify([addressOf(other), addressOf(third)]),
    JSON.stringify(edit?.tags),
  )
  check('…and a q for the message it quotes', JSON.stringify(tags(edit, 'q')) === JSON.stringify([quoted.id]), JSON.stringify(edit?.tags))
  check('…but no a for the comment’s own issue', !tags(edit, 'a').includes(ISSUE), JSON.stringify(edit?.tags))
  check('…and no p, urgent or part: the person it names was told by the send', ['p', 'urgent', 'part'].every((name) => tags(edit, name).length === 0), JSON.stringify(edit?.tags))
  check('…naming the comment it edits, in its Folder', tag(edit, 'e') === first.eventId && tag(edit, 'h') === tag(issue, 'h'), JSON.stringify(edit?.tags))
}

{
  // `peek edit` and `edit-comment` share the edit: a reply's, quoting the comment it answers, earns no q for it.
  const { context, published } = workspace()
  const first = await run('comment', context, [ISSUE], { body: 'Should this wait?' })
  // A reply to it, as NIP-22 writes one: the issue as root, the comment as parent.
  const reply = { id: 'd'.repeat(64), pubkey: SELF, created_at: 1_900_000_000, kind: 1111, content: 'Yes.', sig: '', tags: [['A', ISSUE], ['K', '30851'], ['P', issue.pubkey], ['e', first.eventId], ['k', '1111'], ['p', SELF], ['h', tag(issue, 'h')!]] } as SignedEvent
  await context.relay.publish(reply)
  published.length = 0
  const parent = `nostr:${encodeNevent({ id: first.eventId, relays: [] })}`
  await publishEdit(context, { folder: tag(reply, 'h'), messageEventId: reply.id, body: `Agreed with ${parent}, see ${linkTo(other)}.` })
  const [edit] = published
  check(
    'an edit of a reply quoting its parent carries the link’s a and no q for the parent',
    JSON.stringify(tags(edit, 'a')) === JSON.stringify([addressOf(other)]) && tags(edit, 'q').length === 0,
    JSON.stringify(edit?.tags),
  )
}

console.log(failures ? `\n${failures} failed.` : '\nAll comment link checks passed.')
process.exit(failures ? 1 : 0)
