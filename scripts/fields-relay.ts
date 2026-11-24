/**
 * The in-memory relay the field tests write to (ALO-7 for projects, ISS-7 for
 * issues): it answers NIP-01 filters, the list read (`"fields": "newest"`,
 * with `"text"` beside `#d`) and its search over current words, and refuses a
 * change whose `prev` is not its field's current change, as buzz does. Folded
 * by interop's `filesOf`, so it is SPEC §6.2's
 * rule and not one restated here.
 */
import { createHash } from 'node:crypto'
import { fieldsSetBy, filesOf } from '@estiva-app/interop'
import type { SignedEvent } from '@estiva-app/protocol'
import type { AgentContext } from '../lib/agent/cli'
import { shipApp } from '../lib/agent/apps/ship'

export const tag = (event: { tags: string[][] } | undefined, name: string) => event?.tags.find((t) => t[0] === name)?.[1]
export const addressOf = (e: SignedEvent) => `${e.kind}:${e.pubkey}:${tag(e, 'd')}`
const id = (seed: string) => createHash('sha256').update(seed).digest('hex')

export const SELF = 'a'.repeat(64)
export const QA1 = 'b'.repeat(64)
export const FOLDER = '0f0f0f0f-0000-4000-8000-000000000001'
const FILE_KINDS = [30850, 30851]
let clock = Math.floor(Date.now() / 1000) - 3600

export const signed = (pubkey: string, kind: number, tags: string[][], content = ''): SignedEvent => {
  clock += 1
  return { id: id(`${pubkey}${kind}${JSON.stringify(tags)}${clock}`), pubkey, created_at: clock, kind, tags, content, sig: '' }
}
export const doc = (...blocks: [string, string][]) =>
  JSON.stringify({ type: 'doc', content: blocks.map(([block, text]) => ({ type: 'paragraph', id: block, content: [{ type: 'text', text }] })) })
export const textChange = (author: string, addr: string, value: string, prev: string) =>
  signed(author, 1851, [['a', addr], ['O', addr.split(':')[2]], ['field', 'description'], ['value', value], ['content-format', 'estiva-blocks-1'], ['h', FOLDER], ['ts', String((clock + 1) * 1000)], ['prev', prev]])
export const fieldChange = (author: string, addr: string, field: string, value: string, prev: string) =>
  signed(author, 1851, [['a', addr], ['O', addr.split(':')[2]], ['field', field], ['value', value], ['h', FOLDER], ['ts', String((clock + 1) * 1000)], ['prev', prev]])

/** The words of a saved block document's paragraphs, in order. */
export const wordsOfDoc = (value: string | undefined) =>
  value ? (JSON.parse(value) as { content: { content: { text: string }[] }[] }).content.map((b) => b.content[0].text) : []

export interface RelayOptions {
  /** Refuses a stale `prev` (a fenced team, or a switched relay). True unless said. */
  keepsOrder?: boolean
  /** The types `file_search` finds by their words. */
  search?: readonly string[]
  beforePublish?: (e: SignedEvent) => { ok: false; reason: string } | void
}

export function relay(events: SignedEvent[], options: RelayOptions = {}) {
  const asked: Record<string, unknown>[] = []
  const published: SignedEvent[] = []
  const searched = options.search ?? ['osnova.project']
  const values = (e: SignedEvent, name: string) => e.tags.filter((t) => t[0] === name).map((t) => t[1])
  const matches = (e: SignedEvent, filter: Record<string, unknown>) =>
    (!Array.isArray(filter.ids) || filter.ids.includes(e.id)) &&
    (!Array.isArray(filter.kinds) || filter.kinds.includes(e.kind)) &&
    (!Array.isArray(filter.authors) || filter.authors.includes(e.pubkey)) &&
    Object.entries(filter).every(([key, wanted]) => !key.startsWith('#') || (wanted as string[]).some((v) => values(e, key.slice(1)).includes(v)))
  const current = () => filesOf(events, { withText: true })
  const wordsOf = (file: ReturnType<typeof current>[number]) =>
    [tag(file.root, 'name'), tag(file.root, 'title'), file.fields.title?.value, file.fields.description?.value].join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u)
  const listRead = (filter: Record<string, unknown>) => {
    const { fields: _fields, text, search, ...rest } = filter as { fields: string; text?: boolean; search?: string }
    const files = current()
    const out: SignedEvent[] = []
    for (const root of events.filter((e) => FILE_KINDS.includes(e.kind) && matches(e, rest))) {
      const file = files.find((f) => f.address === addressOf(root))
      if (!file || file.fields.deleted?.value === 'true') continue
      if (search !== undefined && !wordsOf(file).some((word) => word.startsWith(search.toLowerCase()))) continue
      out.push(root)
      for (const [field, change] of Object.entries(file.fields)) {
        // A list never carries a change that sets only the text.
        if (field === 'description' && !text && fieldsSetBy(change.event).length === 1) continue
        if (!out.includes(change.event)) out.push(change.event)
      }
    }
    return out
  }
  const answer = (filters: Record<string, unknown>[]) => {
    asked.push(...filters)
    const out = new Map<string, SignedEvent>()
    for (const filter of filters) {
      if ('search' in filter && !('fields' in filter)) continue // §5.2's search: nothing here is found by it
      for (const e of 'fields' in filter ? listRead(filter) : events.filter((e) => matches(e, filter))) out.set(e.id, e)
    }
    return [...out.values()]
  }
  const head = (addr: string, field: string) => {
    const file = current().find((f) => f.address === addr)
    return file?.fields[field]?.id ?? file?.root.id
  }
  const publish = async (e: SignedEvent) => {
    const early = options.beforePublish?.(e)
    if (early) return early
    if (e.kind === 1851 && options.keepsOrder !== false) {
      for (const { field } of fieldsSetBy(e)) {
        const prev = tag(e, 'prev')
        if (prev && prev !== head(tag(e, 'a')!, field)) return { ok: false, reason: `conflict: ${field} follows ${head(tag(e, 'a')!, field)}` }
      }
    }
    published.push(e)
    events.push(e)
    return { ok: true, eventId: e.id }
  }
  let seq = 0
  const context = {
    relayUrl: 'https://estiva.example',
    relay: {
      info: async () => ({
        file_search: { types: searched },
      }),
      queryAll: async (f: Record<string, unknown>[]) => answer(f),
      query: async (f: Record<string, unknown>[]) => answer(f),
      queryWithMatches: async (f: Record<string, unknown>[]) => {
        const found = answer(f)
        return { events: found, matches: found.filter((e) => FILE_KINDS.includes(e.kind)).map((e) => ({ a: addressOf(e), match: { fields: ['text'] } })) }
      },
      publish,
    },
    signer: { pubkey: SELF, sign: async (e: SignedEvent) => ({ ...e, pubkey: SELF, id: id(JSON.stringify(e) + seq++), sig: '' }) },
  } as unknown as AgentContext
  return { context, asked, published, events }
}

export const run = async (context: AgentContext, name: string, positional: string[], flags: Record<string, string | true> = {}) => {
  try {
    return { ok: true as const, answer: (await shipApp.commands.find((command) => command.name === name)!.run(context, { positional, flags })) as Record<string, unknown> }
  } catch (error) {
    return { ok: false as const, message: (error as Error).message }
  }
}
export const mine = (published: SignedEvent[]) => published.filter((e) => e.pubkey === SELF)

let failures = 0
export function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}
export function finish(what: string) {
  if (failures) {
    console.error(`\n${failures} check(s) failed.`)
    process.exit(1)
  }
  console.log(`\nAll ${what} checks passed.`)
}
