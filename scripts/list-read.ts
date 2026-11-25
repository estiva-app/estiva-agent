/**
 * The relay's list and open read (SPEC §6.13, `"fields": "newest"`) over an
 * in-memory relay's events, for the tests' fakes: each file the filter names,
 * as its first record and each field's current change, the text's only when
 * `"text"` is asked, and never a deleted file. Folded by interop's `filesOf`,
 * so it is SPEC §6.2's order and not one restated here.
 */
import { fieldsSetBy, filesOf } from '@estiva-app/interop'
import type { FileTimes, SignedEvent } from '@estiva-app/protocol'

type Filter = Record<string, unknown>

const values = (e: SignedEvent, name: string) => e.tags.filter((t) => t[0] === name).map((t) => t[1])
const first = (e: SignedEvent, name: string) => e.tags.find((t) => t[0] === name)?.[1]

/** NIP-01's match of one event against one filter (no `search`, no `limit`). */
export const matches = (e: SignedEvent, filter: Filter) =>
  (!Array.isArray(filter.ids) || filter.ids.includes(e.id)) &&
  (!Array.isArray(filter.kinds) || filter.kinds.includes(e.kind)) &&
  (!Array.isArray(filter.authors) || filter.authors.includes(e.pubkey)) &&
  Object.entries(filter).every(([key, wanted]) => !key.startsWith('#') || (wanted as string[]).some((v) => values(e, key.slice(1)).includes(v)))

/** The list read's answer to one `fields` filter over `events`. */
export function listRead(events: readonly SignedEvent[], filter: Filter): SignedEvent[] {
  const { fields: _fields, text, search, ...rest } = filter as { fields: string; text?: boolean; search?: string }
  const files = filesOf([...events], { withText: true })
  const out: SignedEvent[] = []
  for (const file of files) {
    if (!matches(file.root, rest) || file.fields.deleted?.value === 'true') continue
    if (search !== undefined) {
      const words = [first(file.root, 'name'), first(file.root, 'title'), file.fields.title?.value, file.fields.description?.value]
        .join(' ')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
      if (!words.some((word) => word.startsWith(search.toLowerCase()))) continue
    }
    out.push(file.root)
    for (const [field, change] of Object.entries(file.fields)) {
      // A list never carries a change that sets only the text.
      if (field === 'description' && !text && fieldsSetBy(change.event).length === 1) continue
      if (!out.includes(change.event)) out.push(change.event)
    }
  }
  return out
}

/**
 * The relay's refusal of a change whose `prev` is not its field's current
 * change (SPEC §6.2), in buzz's words; undefined when it is in order.
 */
export function staleRefusal(events: readonly SignedEvent[], e: SignedEvent): { ok: false; reason: string } | undefined {
  if (e.kind !== 1851) return undefined
  const prev = first(e, 'prev')
  const address = first(e, 'a')
  if (!prev || !address) return undefined
  const file = filesOf([...events], { withText: true }).find((each) => each.address === address)
  for (const { field } of fieldsSetBy(e)) {
    const head = file?.fields[field]?.id ?? file?.root.id
    if (head && prev !== head) return { ok: false, reason: `conflict: ${field} follows ${head}` }
  }
  return undefined
}

/**
 * A fake's query, answering a `fields` filter by the list read over `events()`
 * and every other filter by `nip01`, merged by id as one REQ is.
 */
export function withListRead(
  events: () => readonly SignedEvent[],
  nip01: (filters: Filter[]) => SignedEvent[] | Promise<SignedEvent[]>,
): (filters: Filter[]) => Promise<SignedEvent[]> {
  return async (filters) => {
    const listed = filters.filter((f) => 'fields' in f)
    const plain = filters.filter((f) => !('fields' in f))
    const out = new Map<string, SignedEvent>()
    for (const e of plain.length ? await nip01(plain) : []) out.set(e.id, e)
    for (const f of listed) for (const e of listRead(events(), f)) out.set(e.id, e)
    return [...out.values()]
  }
}

/**
 * The relay's times read over `events` (SPEC §6.13, `"fields": "times"`): each file a filter picks, deleted ones
 * included, with each field's current change by id and the field it set, never its value (§6.5).
 */
export function timesRead(events: () => readonly SignedEvent[]): (filters: Filter[]) => Promise<FileTimes[]> {
  return async (filters) => {
    const out = new Map<string, FileTimes>()
    for (const filter of filters) {
      const { fields: _fields, limit: _limit, ...rest } = filter
      for (const file of filesOf([...events()], { withText: true })) {
        if (!matches(file.root, rest)) continue
        const changes = Object.entries(file.fields)
          .filter(([field, change]) => !field.startsWith('member:') && change.event.kind === 1851)
          .map(([field, change]) => ({ id: change.event.id, created_at: change.event.created_at, fields: [field] }))
        const under = first(file.root, 'a')
        out.set(file.address, { a: file.address, created_at: file.root.created_at, h: first(file.root, 'h') ?? null, ...(under ? { under } : {}), changes })
      }
    }
    return [...out.values()]
  }
}
