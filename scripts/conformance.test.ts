/**
 * The agent reads Ship the way Ship does — checked against Ship's own fold.
 *
 *   npx tsx scripts/conformance.test.ts
 *
 * Until PER-21 this repository held a copy of Ship's fold and this test ran it,
 * byte for byte the same in both repos, over one recorded fixture. The copy is
 * gone: the agent now reads Ship through Ship's published manifest, folded by
 * `@estiva-app/interop` (`lib/agent/apps/ship-workspace.ts`). So the question
 * this answers changed from "do the two copies agree?" to the one that was
 * always underneath it: **does what Ship publishes about its objects say what
 * Ship's own fold does?**
 *
 * `conformance/fold-fixture.json` is the same file Ship's
 * `scripts/conformance.test.ts` folds with its own `foldFolder`; its `expected`
 * is Ship's recorded answer. Here the same events, plus the manifest Ship
 * published (`conformance/ship-manifest.json`), go through the agent's real read
 * path — `loadWorkspace` over an in-memory relay — and every field the CLI
 * prints is compared with Ship's.
 *
 * This found its first disagreement before it was written: Ship's manifest
 * folded a project's title but not an issue's, so every manifest reader showed
 * 30 renamed issues by their first titles (ship#231).
 *
 * ## When this fails
 *
 * Ship's fold and Ship's manifest disagree, or interop folds differently from
 * Ship. Find out which. **Do not edit `expected`**: it is Ship's, re-recorded
 * only in `estiva-ship` with `scripts/refresh-expected.ts` when Ship's fold
 * changes on purpose, and then copied here. When Ship republishes its manifest,
 * re-record it with `scripts/record-ship-manifest.ts`.
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { SignedEvent } from '@estiva-app/protocol'
import type { AgentContext } from '../lib/agent/cli'
import { loadWorkspace } from '../lib/agent/apps/ship-workspace'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The events both repositories hold. Pinned here, not read from the fixture,
 * because a checksum a file carries about itself proves nothing.
 */
const EVENTS_SHA256 = '64cd76f53c9ab7ab346c5dd352fd81b58cfedcece1bd9e944c22817368eac14e'

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

interface Recorded {
  addr: string
  author: string
  createdAt: number
  title: string
  description: string
  status: string
  archived?: boolean
  ref?: string
  assignee?: string
  lead?: string
  projectAddr?: string
  folder?: string
  contentFolder?: string
}

const fixture = JSON.parse(readFileSync(join(here, '..', 'conformance', 'fold-fixture.json'), 'utf8')) as {
  events: SignedEvent[]
  expected: { projects: Recorded[]; issues: Recorded[] }
}
const manifest = JSON.parse(readFileSync(join(here, '..', 'conformance', 'ship-manifest.json'), 'utf8')) as { event: SignedEvent }

const digest = createHash('sha256').update(JSON.stringify(fixture.events)).digest('hex')
check('the fixture holds the recorded events', digest === EVENTS_SHA256, digest.slice(0, 16))

/** A relay over the fixture and the manifest, answering NIP-01 filters. */
const events = [...fixture.events, manifest.event]
const tagValues = (event: SignedEvent, name: string) => event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1])
function matches(event: SignedEvent, filter: Record<string, unknown>): boolean {
  if (Array.isArray(filter.ids) && !filter.ids.includes(event.id)) return false
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) return false
  if (Array.isArray(filter.authors) && !filter.authors.includes(event.pubkey)) return false
  if (typeof filter.since === 'number' && event.created_at < filter.since) return false
  if (typeof filter.until === 'number' && event.created_at > filter.until) return false
  return Object.entries(filter).every(
    ([key, wanted]) => !key.startsWith('#') || (wanted as string[]).some((value) => tagValues(event, key.slice(1)).includes(value)),
  )
}
const queryAll = async (filters: Record<string, unknown>[]) => {
  const found = new Map<string, SignedEvent>()
  for (const filter of filters) {
    const hits = events.filter((event) => matches(event, filter)).sort((a, b) => b.created_at - a.created_at)
    for (const event of typeof filter.limit === 'number' ? hits.slice(0, filter.limit) : hits) found.set(event.id, event)
  }
  return [...found.values()]
}
const context = { relay: { queryAll } } as unknown as AgentContext

const workspace = await loadWorkspace(context)

/** The fields `ship` prints, as Ship's fold recorded them and as the agent read them. */
function compare(noun: string, recorded: Recorded[], read: Map<string, Record<string, unknown>>, fields: (keyof Recorded)[]) {
  check(`every recorded ${noun} is read`, recorded.every((object) => read.has(object.addr)), `${read.size} read, ${recorded.length} recorded`)
  const differ: string[] = []
  for (const object of recorded) {
    const got = read.get(object.addr)
    if (!got) continue
    for (const field of fields) {
      // A cleared field is `""` in Ship's fold and absent here; both print as nobody.
      const blank = (value: unknown) => (value === '' ? undefined : value)
      const want = blank(object[field]) ?? (field === 'archived' ? false : undefined)
      const have = blank(got[field])
      if (want !== have) differ.push(`${object.addr.slice(-36, -28)} ${field}: ${JSON.stringify(want)?.slice(0, 50)} ≠ ${JSON.stringify(have)?.slice(0, 50)}`)
    }
  }
  check(`every ${noun} field the agent prints matches Ship's fold`, differ.length === 0, differ.slice(0, 5).join('; '))
}

compare(
  'project',
  fixture.expected.projects,
  new Map(workspace.projects.map((project) => [project.addr, { ...project }])),
  ['author', 'createdAt', 'title', 'description', 'status', 'archived', 'lead', 'contentFolder'],
)
compare(
  'issue',
  fixture.expected.issues,
  new Map(workspace.issues.map((issue) => [issue.addr, { ...issue }])),
  ['author', 'createdAt', 'title', 'description', 'status', 'ref', 'assignee', 'projectAddr', 'folder'],
)
check('the change stream is every recorded change', workspace.activity.length === 451, String(workspace.activity.length))

console.log(failures === 0 ? '\nThe agent reads Ship as Ship folds it.' : `\n${failures} failed — the manifest and Ship's fold disagree.`)
process.exit(failures === 0 ? 0 : 1)
