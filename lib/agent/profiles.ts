/**
 * Names for the keys a command is about to print — NIP-01 `kind:0`, read once.
 *
 * Generic rather than per-app: Ship and Peek both name people, and a profile is
 * the protocol's, not either app's. Not interop's `peopleViaRelay`, because that
 * keeps a name and an avatar and `ship people` also prints `nip05` — the one
 * field that tells two people who chose the same display name apart.
 *
 * Until PER-21 this was a copy of Ship's `src/nostr/profiles.ts`; the rule is
 * the same: a profile's `display_name`, else its `name`; the newest `kind:0`
 * per key, a tie going to the lower id (NIP-01's rule for replaceable events).
 */
import type { SignedEvent } from '@estiva-app/protocol'
import type { QueryFn } from '@estiva-app/interop'

export interface Profile {
  pubkey: string
  name?: string
  nip05?: string
}

export type Directory = Map<string, Profile>

/** The fields a profile sets, or null for content that is not a JSON object. */
export function parseProfile(event: SignedEvent): Profile | null {
  if (event.kind !== 0) return null
  let meta: Record<string, unknown>
  try {
    const parsed = JSON.parse(event.content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    meta = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const text = (key: string) => {
    const value = meta[key]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }
  return { pubkey: event.pubkey, name: text('display_name') ?? text('name'), nip05: text('nip05') }
}

/**
 * One profile per key from a pile of `kind:0` events: the newest that parses,
 * then the lower id — so a broken newer profile does not erase a name.
 */
export function directoryFrom(events: readonly SignedEvent[]): Directory {
  const newest = new Map<string, { event: SignedEvent; profile: Profile }>()
  for (const event of events) {
    const profile = parseProfile(event)
    if (!profile) continue
    const held = newest.get(event.pubkey)?.event
    if (!held || event.created_at > held.created_at || (event.created_at === held.created_at && event.id < held.id)) {
      newest.set(event.pubkey, { event, profile })
    }
  }
  return new Map([...newest].map(([pubkey, { profile }]) => [pubkey, profile]))
}

/** Everyone in `pubkeys`, in one request per 500 keys. A key with no profile is simply absent. */
export async function profilesOf(query: QueryFn, pubkeys: readonly (string | undefined)[]): Promise<Directory> {
  const wanted = [...new Set(pubkeys.filter((key): key is string => Boolean(key) && /^[0-9a-f]{64}$/i.test(key!)))]
  if (wanted.length === 0) return new Map()
  const events: SignedEvent[] = []
  for (let i = 0; i < wanted.length; i += 500) {
    events.push(...(await query([{ kinds: [0], authors: wanted.slice(i, i + 500) }])))
  }
  return directoryFrom(events)
}
