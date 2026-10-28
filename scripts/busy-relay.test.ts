/**
 * A relay that stays busy is said as busy (APP-9): the protocol has already
 * asked it again, so a read or a write that still meets it prints "Failed: the
 * relay is busy, try again in a moment", never "The relay refused …", which
 * reads as the relay turning the change down.
 *
 * Offline, over an in-memory relay holding the conformance fixture (production
 * events) and the manifest Ship published; asserted on the line the CLI prints.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-busy-relay-says-it-is-busy.md
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELAY_BUSY_MESSAGE, RelayBusyError, type SignedEvent } from '@estiva-app/protocol'
import { failureLine, type AgentContext } from '../lib/agent/cli'
import { shipApp } from '../lib/agent/apps/ship'
import { loadWorkspace } from '../lib/agent/apps/ship-workspace'

const here = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const SELF = 'a'.repeat(64)
const fixture = JSON.parse(readFileSync(join(here, '..', 'conformance', 'fold-fixture.json'), 'utf8')) as { events: SignedEvent[] }
const manifest = JSON.parse(readFileSync(join(here, '..', 'conformance', 'ship-manifest.json'), 'utf8')) as { event: SignedEvent }

/** A relay answering NIP-01 filters over the fixture; `busy` makes reads throw and writes answer as a relay that stayed busy does. */
function relay(busy: { reads?: boolean; writes?: boolean }) {
  const events = [...structuredClone(fixture.events), manifest.event]
  const published: SignedEvent[] = []
  const values = (e: SignedEvent, name: string) => e.tags.filter((t) => t[0] === name).map((t) => t[1])
  const matches = (e: SignedEvent, filter: Record<string, unknown>) =>
    (!Array.isArray(filter.ids) || filter.ids.includes(e.id)) &&
    (!Array.isArray(filter.kinds) || filter.kinds.includes(e.kind)) &&
    (!Array.isArray(filter.authors) || filter.authors.includes(e.pubkey)) &&
    Object.entries(filter).every(([key, wanted]) => !key.startsWith('#') || (wanted as string[]).some((v) => values(e, key.slice(1)).includes(v)))
  const queryAll = async (filters: Record<string, unknown>[]) => {
    if (busy.reads) throw new RelayBusyError(503)
    const found = new Map<string, SignedEvent>()
    for (const filter of filters) {
      const hits = events.filter((e) => matches(e, filter)).sort((a, b) => b.created_at - a.created_at)
      for (const e of typeof filter.limit === 'number' ? hits.slice(0, filter.limit) : hits) found.set(e.id, e)
    }
    return [...found.values()]
  }
  let seq = 0
  const publish = async (e: SignedEvent) =>
    busy.writes ? { ok: false, reason: RELAY_BUSY_MESSAGE } : (published.push(e), events.push(e), { ok: true, eventId: e.id })
  const context = {
    relayUrl: 'https://estiva.example',
    relay: { queryAll, query: queryAll, publish },
    signer: { pubkey: SELF, sign: async (e: SignedEvent) => ({ ...e, id: createHash('sha256').update(JSON.stringify(e) + seq++).digest('hex'), sig: '' }) },
  } as unknown as AgentContext
  return { context, published }
}

const run = (name: string, context: AgentContext, positional: string[], flags: Record<string, string>) =>
  shipApp.commands.find((command) => command.name === name)!.run(context, { positional, flags } as never) as Promise<Record<string, any>>
const printed = (promise: Promise<unknown>) => promise.then(() => '', (error: unknown) => failureLine(error))

const state = await loadWorkspace(relay({}).context)
const issue = state.issues.find((candidate) => !candidate.archived && candidate.folder)!

console.log('— A read the relay stays busy for —')
{
  const said = await printed(run('show', relay({ reads: true }).context, [issue.addr], {}))
  check('ship show prints the busy sentence as a failure', said === `Failed: ${RELAY_BUSY_MESSAGE}`, said)
}

console.log('\n— A write the relay stays busy for —')
{
  const comment = await printed(run('comment', relay({ writes: true }).context, [issue.addr], { body: 'Still on it.' }))
  check('ship comment prints the busy sentence, not a refusal', comment.startsWith(`Failed: ${RELAY_BUSY_MESSAGE}`) && !comment.includes('refused'), comment)

  const status = await printed(run('set-status', relay({ writes: true }).context, [issue.addr, issue.status === 'done' ? 'todo' : 'done'], {}))
  check('ship set-status prints the busy sentence, not a refusal', status.startsWith(`Failed: ${RELAY_BUSY_MESSAGE}`) && !status.includes('refused'), status)

  const edit = await printed(run('edit-issue', relay({ writes: true }).context, [issue.addr], { title: `${issue.title} (renamed)` }))
  check('ship edit-issue prints the busy sentence and what did save before it', edit.startsWith(`Failed: ${RELAY_BUSY_MESSAGE}`) && edit.includes('Already published and standing: nothing.') && !edit.includes('refused'), edit)
}

console.log('\n— A write the relay turns down —')
{
  const { context } = relay({})
  ;(context.relay as { publish: unknown }).publish = async () => ({ ok: false, reason: 'blocked: not a member' })
  const said = await printed(run('comment', context, [issue.addr], { body: 'Still on it.' }))
  check('a real refusal is still said in the relay’s own words', said.startsWith('The relay refused') && said.includes('blocked: not a member'), said)
}

if (failures) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nAll passed')
