/**
 * `peek topic` finds the topic without walking Peek's tree (APP-6), and
 * answers exactly what the walk answers: for a title, an id, a topic in a
 * nested Folder, a renamed title, a topic two Folders list (shown in the one
 * the walk reaches first), an archived topic, one only an archived Folder
 * lists, a word two topics share, and a miss. Only the Folder that lists the
 * topic has its contents read.
 *
 * Offline, over an in-memory relay. The walk's answer is the same command over
 * a relay whose search answers a full page, which only the walk can settle.
 * Asserted on the printed answer and on what the relay was asked.
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
const HQ = '11111111-2222-4333-8444-000000000001'
const INNER = '11111111-2222-4333-8444-000000000002'
const OLD = '11111111-2222-4333-8444-000000000003'
const topicAt = (n: number) => `30840:${SELF}:22222222-2222-4333-8444-00000000000${n}`
const PLANNING = topicAt(1)
const LEAF = topicAt(2)
const WEEKLY = topicAt(3)
const RENAMED = topicAt(4)
const SHARED = topicAt(5)
const SHELVED = topicAt(6)
const BURIED = topicAt(7)
const RESEQUENCED = topicAt(8)

let seq = 0
const event = (kind: number, tagList: string[][], content = '', pubkey = SELF, created_at = 1_760_000_000 + seq): SignedEvent =>
  ({ id: createHash('sha256').update(`${seq++}`).digest('hex'), pubkey, created_at, kind, tags: tagList, content, sig: '' }) as SignedEvent
const d = (address: string) => address.split(':')[2]
const topic = (address: string, title: string, folder: string) => event(30840, [['d', d(address)], ['title', title], ['h', folder]])
const change = (address: string, field: string, value: string, folder: string, at: number) =>
  event(1851, [['a', address], ['field', field], ['value', value], ['h', folder], ['ts', String(at * 1000)]], '', SELF, at)

const opening = event(1111, [['A', PLANNING], ['K', '30840'], ['P', SELF], ['a', PLANNING], ['k', '30840'], ['p', SELF], ['h', HQ]], 'Which goes first?', QA2)
const reply = event(1111, [['A', PLANNING], ['K', '30840'], ['P', SELF], ['e', opening.id], ['k', '1111'], ['p', QA2], ['h', HQ]], 'Leaf, then Ship.')

const EVENTS = [
  // The nested Folder comes first by name and by age, so only the tree's order puts a topic both list in HQ.
  event(39000, [['d', INNER], ['name', 'Aside']], '', RELAY_KEY, 1_700_000_000),
  event(30890, [['d', INNER], ['a', WEEKLY], ['a', SHARED]], '', RELAY_KEY, 1_700_000_000),
  event(39000, [['d', HQ], ['name', 'Estiva HQ']], '', RELAY_KEY),
  // HQ lists its topics and two nested Folders; the first lists one of its own and one HQ lists too.
  event(30890, [['d', HQ], ...[PLANNING, LEAF, RENAMED, SHARED, SHELVED, RESEQUENCED, `39000:${RELAY_KEY}:${INNER}`, `39000:${RELAY_KEY}:${OLD}`].map((a) => ['a', a])], '', RELAY_KEY),
  // Renamed to a title that holds "sequencing" only inside a word, which the search does not find.
  topic(RESEQUENCED, 'Draft', HQ),
  change(RESEQUENCED, 'title', 'Resequencing', HQ, 1_800_000_300),
  // The second is archived by its owner, so the tree never reaches the one topic it lists.
  event(39000, [['d', OLD], ['name', 'Old']], '', RELAY_KEY),
  event(39001, [['d', OLD], ['p', SELF, 'owner']], '', RELAY_KEY),
  event(30890, [['d', OLD], ['a', BURIED]], '', RELAY_KEY),
  change(`39000:${RELAY_KEY}:${OLD}`, 'archived', 'true', OLD, 1_800_000_200),
  topic(BURIED, 'Buried plans', OLD),
  topic(PLANNING, 'Planning and sequencing', HQ),
  topic(LEAF, 'Leaf planning', HQ),
  topic(WEEKLY, 'Weekly sync', INNER),
  topic(RENAMED, 'Old name', HQ),
  change(RENAMED, 'title', 'Roadmap review', HQ, 1_800_000_000),
  topic(SHARED, 'Shared notes', HQ),
  topic(SHELVED, 'Shelved idea', HQ),
  change(SHELVED, 'archived', 'true', HQ, 1_800_000_100),
  opening,
  reply,
]

/**
 * A relay answering NIP-01 filters, and NIP-50 search as production's does
 * (SPEC §5.2): every typed word starts a word of a title change's value.
 * `fullSearch` answers every search with a full page. `asked` records every filter.
 */
function relay({ fullSearch = false } = {}) {
  const events = [...EVENTS]
  const asked: Record<string, unknown>[] = []
  const values = (e: SignedEvent, name: string) => e.tags.filter((t) => t[0] === name).map((t) => t[1])
  const matches = (e: SignedEvent, filter: Record<string, unknown>) =>
    (!Array.isArray(filter.ids) || filter.ids.includes(e.id)) &&
    (!Array.isArray(filter.kinds) || filter.kinds.includes(e.kind)) &&
    (!Array.isArray(filter.authors) || filter.authors.includes(e.pubkey)) &&
    Object.entries(filter).every(([key, wanted]) => !key.startsWith('#') || (wanted as string[]).some((v) => values(e, key.slice(1)).includes(v)))
  const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const found = (e: SignedEvent, search: string) =>
    values(e, 'field')[0] === 'title' && words(search).every((w) => words(values(e, 'value')[0] ?? '').some((v) => v.startsWith(w)))
  const answer = (filters: Record<string, unknown>[]) => {
    asked.push(...filters)
    const out = new Map<string, SignedEvent>()
    for (const filter of filters) {
      const { search, ...rest } = filter as { search?: string; limit?: number }
      if (search !== undefined && fullSearch) {
        for (let i = 0; i < (rest.limit ?? 32); i++) {
          const filler = event(1851, [['a', `30840:${SELF}:filler-${i}`], ['field', 'title'], ['value', search]])
          out.set(filler.id, filler)
        }
        continue
      }
      const hits = events.filter((e) => matches(e, rest) && (search === undefined || found(e, search))).sort((a, b) => b.created_at - a.created_at)
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

const topicCommand = async (context: AgentContext, reference: string) => {
  try {
    return JSON.stringify(await peekApp.commands.find((command) => command.name === 'topic')!.run(context, { positional: [reference], flags: {} } as never))
  } catch (error) {
    return `refused: ${(error as Error).message}`
  }
}
/** The Folders whose contents a read resolved: each is asked for by its `d`, alone. */
const foldersRead = (asked: Record<string, unknown>[]) =>
  [...new Set(asked.flatMap((filter) => ((filter.kinds as number[] | undefined)?.includes(30890) && Array.isArray(filter['#d']) ? (filter['#d'] as string[]) : [])))]

const cases: [string, string][] = [
  ['a title', 'Planning and sequencing'],
  ['an id', d(PLANNING)],
  ['a topic in a nested Folder', 'Weekly sync'],
  ['a renamed title, by a word of its new one', 'Roadmap'],
  ['a topic two Folders list', 'Shared notes'],
  ['an archived topic', 'Shelved idea'],
  ['a topic only an archived Folder lists', 'Buried plans'],
  ['a word two topics share', 'planning'],
  ['a word another topic holds inside its new title', 'sequencing'],
  ['a reference naming nothing', 'no such topic'],
]
for (const [what, reference] of cases) {
  const narrowed = relay()
  const whole = relay({ fullSearch: true })
  const [answer, walked] = await Promise.all([topicCommand(narrowed.context, reference), topicCommand(whole.context, reference)])
  check(`${what}: the same answer as the walk`, answer === walked, answer.slice(0, 160))
}

{
  const { context, asked } = relay()
  const answer = JSON.parse(await topicCommand(context, 'Planning and sequencing'))
  check('the topic is shown with its conversation', answer.conversations?.[0]?.messages?.length === 2, JSON.stringify(answer.conversations))
  check('…and only the Folder that lists it is read', JSON.stringify(foldersRead(asked)) === JSON.stringify([HQ]), JSON.stringify(foldersRead(asked)))
}
{
  const { context, asked } = relay()
  const answer = JSON.parse(await topicCommand(context, 'Weekly sync'))
  check('a topic in a nested Folder is shown in it', answer.folder === 'Aside', answer.folder)
  check('…and only that Folder is read', JSON.stringify(foldersRead(asked)) === JSON.stringify([INNER]), JSON.stringify(foldersRead(asked)))
}
{
  const answer = JSON.parse(await topicCommand(relay().context, 'Shared notes'))
  check('a topic two Folders list is shown in the one the tree reaches first', answer.folder === 'Estiva HQ', answer.folder)
}

console.log(failures ? `\n${failures} failed.` : '\nAll peek topic checks passed.')
process.exit(failures ? 1 : 0)
