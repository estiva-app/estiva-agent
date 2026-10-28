/**
 * `ship show` reads only the file it is asked about (APP-6), and answers
 * exactly what reading the whole workspace answers: for a ref, a short id, an
 * address, part of a title, a renamed title, a project and its issues (one
 * moved in among them), an issue moved out, an issue archived with its
 * project, and the same refusal for a reference that names two issues.
 * History lists who changed which field and when, a save of the text as a
 * numbered version with its length, and the old text only when asked for.
 *
 * Offline, over an in-memory relay holding the conformance fixture
 * (production events) and the manifest Ship published. The whole-workspace
 * answer is the same command over a relay whose search answers a full page,
 * which only a whole read can settle. Asserted on the printed answer and on
 * what the relay was asked.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-file-keeps-every-change-for-good.md
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

const tag = (event: SignedEvent | undefined, name: string) => event?.tags.find((t) => t[0] === name)?.[1]
const addressOf = (e: SignedEvent) => `${e.kind}:${e.pubkey}:${tag(e, 'd')}`

/**
 * A relay answering NIP-01 filters over `events`, and NIP-50 search as the
 * production relay does (SPEC §5.2): every typed word starts a word of a
 * change's title or ref value. `fullSearch` answers every search with a full
 * page, so `show` must read the whole workspace. `asked` records every filter.
 */
function relay(events: SignedEvent[], { fullSearch = false } = {}) {
  const asked: Record<string, unknown>[] = []
  const values = (e: SignedEvent, name: string) => e.tags.filter((t) => t[0] === name).map((t) => t[1])
  const matches = (e: SignedEvent, filter: Record<string, unknown>) =>
    (!Array.isArray(filter.ids) || filter.ids.includes(e.id)) &&
    (!Array.isArray(filter.kinds) || filter.kinds.includes(e.kind)) &&
    (!Array.isArray(filter.authors) || filter.authors.includes(e.pubkey)) &&
    Object.entries(filter).every(([key, wanted]) => !key.startsWith('#') || (wanted as string[]).some((v) => values(e, key.slice(1)).includes(v)))
  const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const found = (e: SignedEvent, search: string) =>
    ['title', 'ref'].includes(tag(e, 'field') ?? '') && words(search).every((w) => words(tag(e, 'value') ?? '').some((v) => v.startsWith(w)))
  const answer = (filters: Record<string, unknown>[]) => {
    asked.push(...filters)
    const out = new Map<string, SignedEvent>()
    for (const filter of filters) {
      const { search, ...rest } = filter as { search?: string }
      let hits = events.filter((e) => matches(e, rest) && (search === undefined || found(e, search)))
      if (search !== undefined && fullSearch) hits = events.filter((e) => e.kind === 1851)
      hits.sort((a, b) => b.created_at - a.created_at)
      for (const e of typeof filter.limit === 'number' ? hits.slice(0, filter.limit) : hits) out.set(e.id, e)
    }
    return [...out.values()]
  }
  const context = {
    relayUrl: 'https://estiva.example',
    relay: { queryAll: async (f: Record<string, unknown>[]) => answer(f), query: async (f: Record<string, unknown>[]) => answer(f) },
  } as unknown as AgentContext
  return { context, asked }
}

const show = async (context: AgentContext, ref: string, flags: Record<string, string | true> = {}) => {
  try {
    return JSON.stringify(await shipApp.commands.find((command) => command.name === 'show')!.run(context, { positional: [ref], flags } as never))
  } catch (error) {
    return `refused: ${(error as Error).message}`
  }
}

const fixture = JSON.parse(readFileSync(join(here, '..', 'conformance', 'fold-fixture.json'), 'utf8')) as { events: SignedEvent[] }
const manifest = JSON.parse(readFileSync(join(here, '..', 'conformance', 'ship-manifest.json'), 'utf8')) as { event: SignedEvent }

let clock = 2_000_000_000
const change = (target: string, author: string, folder: string, field: string, value: string, extra: string[][] = []): SignedEvent => {
  clock += 10
  return {
    id: createHash('sha256').update(`${target}${field}${clock}`).digest('hex'),
    pubkey: author,
    created_at: clock,
    kind: 1851,
    tags: [['a', target], ['field', field], ['value', value], ['h', folder], ['ts', String(clock * 1000)], ...extra],
    content: '',
    sig: '',
  }
}

const events = [...structuredClone(fixture.events), manifest.event]
const { context: reader } = relay(events)
const state = await loadWorkspace(reader)
const roots = new Map(events.filter((e) => e.kind === 30850 || e.kind === 30851).map((e) => [addressOf(e), e]))

/*
  An issue moved to another project, as Ship writes a move: the new parent in
  `value` and in `A` (SPEC §7.2). Every move on production carries it since
  28 Oct, the older ones re-posted with it (APP-6).
*/
const projectOf = (addr: string | undefined) => state.projects.find((project) => project.addr === addr)
const moved = state.issues.find((issue) => issue.projectAddr === tag(roots.get(issue.addr), 'a') && projectOf(issue.projectAddr))!
const movedFrom = moved.projectAddr!
const into = state.projects.find((project) => project.addr !== movedFrom && !project.archived)!
events.push(change(moved.addr, moved.author, moved.folder, 'project', into.addr, [['A', into.addr]]))

// An issue whose project is archived, so it is archived with it.
const inArchived = state.issues.find(
  (issue) => issue !== moved && !issue.archived && projectOf(issue.projectAddr) && issue.projectAddr !== into.addr && issue.projectAddr !== movedFrom,
)!
const archivedProject = state.projects.find((project) => project.addr === inArchived.projectAddr)!
events.push(change(archivedProject.addr, archivedProject.author, archivedProject.contentFolder, 'archived', 'true'))

// A renamed issue, named by its new title.
const renamed = state.issues.find((issue) => issue !== inArchived && issue.ref && state.issues.filter((each) => each.ref === issue.ref).length === 1)!
events.push(change(renamed.addr, renamed.author, renamed.folder, 'title', 'Quarterly zebra crossing audit'))

// An issue with more than one save of its text.
const saves = (addr: string) => state.activity.filter((c) => c.target === addr && c.field === 'description').length
const edited = state.issues.filter((issue) => saves(issue.addr) >= 2 && issue.ref).sort((a, b) => saves(b.addr) - saves(a.addr))[0]

const twice = [...new Set(state.issues.map((issue) => issue.ref).filter((ref) => ref && state.issues.filter((each) => each.ref === ref).length > 1))][0]!
const fragment = edited.title.split(' ').slice(1, 4).join(' ')

// A change whose `ts` is far past what a date can hold, planted on an issue.
const planted = state.issues.find((issue) => issue !== edited && issue !== moved && issue !== inArchived && issue !== renamed && issue.ref)!
events.push({ ...change(planted.addr, planted.author, planted.folder, 'status', 'todo'), tags: [['a', planted.addr], ['field', 'status'], ['value', 'todo'], ['h', planted.folder], ['ts', '9'.repeat(20)]] })

console.log('— show answers what the whole read answers —')
// A title matched as text — part of one, or an issue's, which is never an exact match — is read
// whole: whether another file's title holds it too, inside a word of a renamed title the search
// does not find, only every title as it is now can say (APP-6).
const PART = new Set(['part of a title', 'a renamed title', 'a renamed title, by some of its new words'])
const references: [string, string][] = [
  ['a ref', edited.ref!],
  ['a short id', edited.id.slice(0, 8)],
  ['an address', edited.addr],
  ['part of a title', fragment],
  ['a renamed title', 'Quarterly zebra crossing audit'],
  ['a renamed title, by some of its new words', 'zebra crossing'],
  ['an issue moved to another project', moved.id.slice(0, 8)],
  ['a project, with the issue moved into it', into.addr],
  ['the project that issue left', movedFrom],
  ['an issue archived with its project', inArchived.id.slice(0, 8)],
  ['a ref two issues share', twice],
  ['a reference naming nothing', 'no such thing anywhere'],
]
for (const [what, ref] of references) {
  const narrow = relay(events)
  const [one, whole] = await Promise.all([show(narrow.context, ref), show(relay(events, { fullSearch: true }).context, ref)])
  check(`${what}: the same answer`, one === whole, one === whole ? one.slice(0, 90) : `${one.slice(0, 200)} ‖ ${whole.slice(0, 200)}`)
  if (!one.startsWith('refused')) {
    const wholeRead = narrow.asked.some((f) => Array.isArray(f.kinds) && f.kinds.includes(1851) && Object.keys(f).every((k) => k === 'kinds' || k === 'limit'))
    check(PART.has(what) ? `${what}: …by reading every change` : `${what}: …without reading every change`, PART.has(what) ? wholeRead : !wholeRead)
  }
}
const project = JSON.parse(await show(relay(events).context, into.addr))
check('the project lists the issue moved into it', project.issues.some((issue: { addr: string }) => issue.addr === moved.addr))
const left = JSON.parse(await show(relay(events).context, movedFrom))
check('…and the project it left does not', !left.issues.some((issue: { addr: string }) => issue.addr === moved.addr))
const archived = JSON.parse(await show(relay(events).context, inArchived.id.slice(0, 8)))
check('an issue in an archived project says it is archived with it', archived.archived?.with === archivedProject.addr, JSON.stringify(archived.archived))

const dated = await show(relay(events).context, planted.addr)
check('a change with a planted ts still shows, dated when it was made', !dated.startsWith('refused') && JSON.parse(dated).history.at(-1)?.at === new Date(clock * 1000).toISOString(), dated.slice(0, 120))

console.log('\n— history —')
const shown = JSON.parse(await show(relay(events).context, edited.addr))
const texts = shown.history.filter((line: { field: string }) => line.field === 'description')
check('each save of the text is a numbered version with its length', texts.length === saves(edited.addr) && texts.every((line: { version: number; length: number }, i: number) => line.version === i + 1 && line.length > 0), JSON.stringify(texts.slice(0, 2)))
check('…and carries no old text', texts.every((line: object) => !('value' in line)))
check('other fields keep their value', shown.history.filter((line: { field: string }) => line.field !== 'description').every((line: object) => 'value' in line))
const withText = JSON.parse(await show(relay(events).context, edited.addr, { 'history-text': true }))
const versions = withText.history.filter((line: { field: string }) => line.field === 'description')
check('--history-text adds each version’s text, as long as it says', versions.every((line: { value: string; length: number }) => typeof line.value === 'string' && line.value.length === line.length))
check('…the last of them the description itself', versions.at(-1)?.value === withText.description)

console.log(failures ? `\n${failures} failed.` : '\nAll ship show checks passed.')
process.exit(failures ? 1 : 0)
