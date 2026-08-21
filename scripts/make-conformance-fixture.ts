/**
 * Record a fold fixture from production, for both repos to agree on.
 *
 * Run when the fold's *inputs* need to cover something new — a shape of event
 * nobody had recorded before. Not run to make a failing check pass: if
 * `conformance.test.ts` fails, either this repo or Ship folded differently, and
 * regenerating the expected output would erase exactly the finding the fixture
 * exists to produce.
 *
 *   npx tsx scripts/make-conformance-fixture.ts
 *
 * Writes `conformance/fold-fixture.json`, which is then copied verbatim into
 * `estiva-ship`. Both repos run the same events through their own `foldFolder`
 * and must produce the same state.
 *
 * ## Real events, and then the ones production does not contain
 *
 * The first draft recorded production only, on the argument that real events
 * carry shapes nobody would think to invent. Half right, and the half that was
 * wrong mattered: **the fixture passed unchanged when the fold's `ts` trust
 * window was widened from one second to five.** Measured against the recording,
 * all 49 change events carried a `ts`, none of them outside the window, and only
 * two shared a `created_at` with another change on the same target.
 *
 * Which is obvious in hindsight. `orderingMs` exists to defend against "a buggy
 * app or a client trying to make its write always win", and a healthy workspace
 * contains no such write — so the rules the fold is most careful about are
 * exactly the ones production cannot demonstrate. A fixture recorded from a
 * well-behaved system tests a well-behaved system.
 *
 * So the fixture is production **plus** the adversarial cases, appended and
 * signed with a fixed throwaway key so the file is reproducible:
 *
 *  - a `ts` of `Number.MAX_SAFE_INTEGER`, which must be ignored rather than
 *    believed, or one client could pin its writes permanently last
 *  - a `ts` just inside the window, which must be honoured over an earlier one
 *  - three changes sharing one `created_at`, which must break by lowest id
 *  - a status set by somebody who did not author the issue, which must apply —
 *    the whole reason the model is event-sourced
 */
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { clientCredentialsToken, loadCredentials } from '../lib/agent/credentials'
import { Relay } from '../lib/nostr/relay'
import { estivaIdSigner } from '../lib/nostr/signer'
import { publicKeyFromSecret, signEvent } from '../lib/nostr/sign'
import type { SignedEvent } from '../lib/nostr/events'
import { Store } from '../src/store'
import { foldFolder } from '../src/fold'
import { KIND } from '../src/kinds'

const RELAY_URL = (process.env.RELAY_URL ?? 'https://estiva.estiva.app').replace(/\/+$/, '')

/**
 * A fixed key, so regenerating produces the same file.
 *
 * These events are never published — they exist only inside the fixture, to
 * exercise rules a healthy workspace cannot demonstrate. Signed properly anyway,
 * because an event that would not survive a relay is not evidence about
 * anything, and the day somebody replays this fixture through a real client is
 * not the day to discover the signatures were decorative.
 */
const FIXTURE_KEY = '1'.repeat(64)

/**
 * The cases production does not contain, anchored to a real issue so they fold
 * into real state rather than sitting in a corner of their own.
 */
function adversarial(state: { issues: { addr: string; author: string }[] }): SignedEvent[] {
  const issue = state.issues.find((candidate) => candidate.addr)
  if (!issue) return []

  const pubkey = publicKeyFromSecret(FIXTURE_KEY)
  const folder = 'fixture-folder'
  const base = 1_700_000_000

  const change = (
    createdAt: number,
    field: string,
    value: string,
    ts: number | undefined,
    note: string,
  ): SignedEvent => {
    const tags: string[][] = [
      ['h', folder],
      ['a', issue.addr],
      ['field', field],
      ['value', value],
    ]
    if (ts !== undefined) tags.push(['ts', String(ts)])
    return signEvent(
      { pubkey, created_at: createdAt, kind: KIND.CHANGE, tags, content: note },
      FIXTURE_KEY,
    )
  }

  return [
    // A ts far outside the window. Must be ignored; created_at decides.
    change(base, 'status', 'todo', Number.MAX_SAFE_INTEGER, 'hostile ts, must not win'),
    // A ts inside the window, ordering this after the one above within the same second.
    change(base, 'status', 'in_progress', base * 1000 + 500, 'trusted ts, finer than a second'),
    // Three sharing one created_at and carrying no ts: the id tie-break, alone.
    change(base + 1, 'assignee', pubkey, undefined, 'tie a'),
    change(base + 1, 'assignee', issue.author, undefined, 'tie b'),
    change(base + 1, 'assignee', '', undefined, 'tie c'),

    /*
      The boundary pair, and the reason the first draft of this fixture was not
      good enough: widening the trust window from 1s to 5s passed every check
      above, because nothing sat in the band that widening newly trusts.

      `drifted` claims a ts three seconds after its own created_at. Under the
      rule as written it is refused and orders at created_at, so `later` — two
      seconds afterwards with no ts of its own — wins. Loosen the window past
      three seconds and `drifted` is believed instead, so it wins and the folded
      status changes. One pair, and it pins the number rather than the idea.
    */
    change(base + 10, 'status', 'done', (base + 13) * 1000, 'drifted ts, refused at 1s of slack'),
    change(base + 12, 'status', 'cancelled', undefined, 'later by created_at, wins while the window is 1s'),
  ]
}

async function main() {
  const credentials = loadCredentials()
  const token = await clientCredentialsToken(credentials)
  const signer = estivaIdSigner({
    base: credentials.base,
    pubkey: token.pubkey,
    token: token.access_token,
  })
  const relay = new Relay(RELAY_URL, signer)
  const store = new Store(relay, signer)

  /*
    Discovered the same way the agent discovers, so the fixture contains what a
    real read actually returns — including the widening into re-linked Folders,
    which is where the interesting change events live.
  */
  const state = await store.loadAll()
  const folders = [...new Set(state.projects.map((project) => project.contentFolder))]
  const events = await store.rawFolders(folders)

  /*
    Sorted into a stable order before recording. The relay does not promise one,
    and a fixture whose event order changed between runs would produce diffs
    that say nothing.
  */
  const recorded = events
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const ordered = [...recorded, ...adversarial(state)].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )

  /*
    Folded with the *default* reference resolver, not the store's.

    The store injects a bech32 decoder so `nostr:naddr…` inside a message body
    resolves to an address. That is NIP-19's job and `nip19.test.ts` already
    covers it; pulling it in here would make the fixture depend on a private
    export and, worse, would mean a bech32 change could fail a check that is
    supposed to be about the fold. Both repos can reproduce this with
    `foldFolder(events)` and nothing else.
  */
  const expected = foldFolder(ordered)

  const kinds = new Map<number, number>()
  for (const event of ordered) kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1)

  const fixture = {
    note:
      'Recorded from production. Both estiva-agent and estiva-ship fold these events ' +
      'and must produce `expected`. Do not regenerate to make a failing check pass — ' +
      'a failure means the two repos disagree, which is the thing this catches.',
    generatedAt: new Date().toISOString(),
    relay: RELAY_URL,
    counts: {
      events: ordered.length,
      recorded: recorded.length,
      adversarial: ordered.length - recorded.length,
      projects: expected.projects.length,
      issues: expected.issues.length,
      changes: expected.activity.length,
      conversations: expected.conversations.length,
      byKind: Object.fromEntries([...kinds].sort((a, b) => a[0] - b[0])),
    },
    events: ordered,
    expected,
  }

  const json = `${JSON.stringify(fixture, null, 2)}\n`
  writeFileSync(new URL('../conformance/fold-fixture.json', import.meta.url), json)

  const digest = createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
  console.log(`wrote conformance/fold-fixture.json`)
  console.log(`  ${ordered.length} events → ${expected.projects.length} projects, ${expected.issues.length} issues, ${expected.activity.length} changes, ${expected.conversations.length} conversations`)
  console.log(`  kinds: ${JSON.stringify(fixture.counts.byKind)}`)
  console.log(`  events sha256: ${digest}`)
  console.log(`\nCopy this file into estiva-ship/conformance/ unchanged.`)
  console.log(`KIND.CHANGE is ${KIND.CHANGE}, so the change stream is the part most worth diffing.`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
