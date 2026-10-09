/**
 * The people a message mentions, as the person steering the agent named them
 * (8e8d4b68). A mention is SPEC §13.1's: `nostr:npub…` in the body, and a `p`
 * per person — the `p` is interop's, earned from the body (interop 0.53), so
 * this only has to put the right key in the text.
 *
 * **A name is never a display name.** Display names are self-set
 * (docs/untrusted-content.md), so mentioning by one would let somebody choose
 * whose questions reach them by renaming themselves — the reason `assign`
 * refuses names. A handle is different: `miky` is NIP-05, answered by the
 * workspace's own domain (`/.well-known/nostr.json`), which Estiva ID issues
 * and nobody sets for themselves. So a mention is a hex key, an npub, or a
 * handle on the workspace's domain, and each must be a relay member.
 *
 * Generic rather than per-app: a person is the protocol's, not Ship's or
 * Peek's, and `peek say --mention` will want the same answer.
 */
import { decodeNpub, encodeNpub } from '@estiva-app/protocol'
import { mentionTagsFor } from '@estiva-app/conversation'
import { BadRequest } from './cli'

const HEX_KEY = /^[0-9a-f]{64}$/i
/** NIP-05's local part: `a-z0-9-_.`, case-insensitive. */
const HANDLE = /^[a-z0-9._-]+$/i

/** A NIP-05 answer for one name on one domain: the key, or undefined when it names nobody. */
export type HandleLookup = (domain: string, name: string) => Promise<string | undefined>

export const nip05Lookup: HandleLookup = async (domain, name) => {
  const response = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`)
  if (!response.ok) throw new Error(`${domain} answered ${response.status} for the handle "${name}".`)
  const body = (await response.json()) as { names?: Record<string, unknown> }
  const key = body.names?.[name]
  return typeof key === 'string' && HEX_KEY.test(key) ? key.toLowerCase() : undefined
}

/**
 * Each person a `--mention` value names, as a key, once each, in the order named.
 * The value is one or more of them, comma-separated. Refused whole — nothing is
 * published — when any one does not resolve to a relay member.
 */
export async function mentionedKeys(
  value: string,
  workspace: { relayUrl: string; members: () => Promise<string[]>; lookup?: HandleLookup },
): Promise<string[]> {
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (names.length === 0) throw new BadRequest('--mention needs a key, an npub, or a handle.')

  const domain = new URL(workspace.relayUrl).host
  const lookup = workspace.lookup ?? nip05Lookup
  const keys: string[] = []
  for (const name of names) {
    const key = await keyOf(name, domain, lookup)
    if (!keys.includes(key)) keys.push(key)
  }

  // An empty roster is a relay that publishes none, not a workspace of nobody:
  // the keys stand as named, as `assign` takes them.
  const members = await workspace.members()
  const outsider = keys.find((key) => members.length > 0 && !members.includes(key))
  if (outsider) throw new BadRequest(`${names[keys.indexOf(outsider)]} is not a member of this workspace. Nothing was published.`)
  return keys
}

async function keyOf(name: string, domain: string, lookup: HandleLookup): Promise<string> {
  if (HEX_KEY.test(name)) return name.toLowerCase()
  if (/^(nostr:)?npub1/i.test(name)) {
    try {
      return decodeNpub(name.replace(/^nostr:/i, ''))
    } catch {
      throw new BadRequest(`${name} is not a valid npub.`)
    }
  }
  const [local, at] = name.toLowerCase().split('@') as [string, string | undefined]
  if (at !== undefined && at !== domain) {
    throw new BadRequest(`A handle is looked up only on this workspace's domain, ${domain}; ${name} is not on it. Pass the key instead.`)
  }
  if (!HANDLE.test(local)) {
    throw new BadRequest(`${name} is not a key, an npub, or a handle. A display name is never matched, because anyone can set one.`)
  }
  const key = await lookup(domain, local)
  if (!key) throw new BadRequest(`No one has the handle ${local}@${domain}. Nothing was published.`)
  return key
}

/**
 * The body with each person mentioned in it: as it was when it already names
 * them by `nostr:npub…`, otherwise opening with the mention — the "@Miky …"
 * a person types first.
 *
 * **Every person the body names must be among `keys`.** Interop tags each
 * `nostr:npub…` in a comment's body, so one the agent copied out of workspace
 * text would notify somebody nobody asked it to — and skip the roster check
 * above (docs/untrusted-content.md). Refused, so nothing is published.
 */
export function withMentions(body: string, keys: readonly string[]): string {
  const named = new Set(mentionTagsFor(body).map((tag) => tag[1]))
  const unasked = [...named].find((key) => !keys.includes(key))
  if (unasked) {
    throw new BadRequest(`The body mentions nostr:${encodeNpub(unasked)}, whom --mention does not name. Add them to --mention, or take the mention out. Nothing was published.`)
  }
  const missing = keys.filter((key) => !named.has(key)).map((key) => `nostr:${encodeNpub(key)}`)
  return missing.length === 0 ? body : `${missing.join(' ')} ${body}`
}
