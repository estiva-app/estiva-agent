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
import { BLOCK_DOCUMENT_FORMAT, decodeNpub, encodeNpub, type UnsignedEvent } from '@estiva-app/protocol'
import { mentionAddsFor, mentionTagsFor, newlyNamedPeople, peopleNamedInText, type FileText } from '@estiva-app/conversation'
import { BadRequest, type AgentContext } from './cli'

/**
 * Every relay member's key, from the relay's own member list (NIP-43
 * `kind:13534`, one `["member", <pubkey>, <role>]` per member). Only the relay
 * can publish that kind (buzz `is_relay_only_kind`), so the newest one is the
 * roster. Empty when the relay publishes none.
 */
export async function relayMembers(context: AgentContext): Promise<string[]> {
  const [list] = await context.relay.queryAll([{ kinds: [KIND_RELAY_MEMBERS], limit: 1 }] as never)
  return list ? list.tags.filter((tag) => tag[0] === 'member' && tag[1]).map((tag) => tag[1]) : []
}
const KIND_RELAY_MEMBERS = 13534

const HEX_KEY = /^[0-9a-f]{64}$/i
/** NIP-05's local part: `a-z0-9-_.`, case-insensitive. */
const HANDLE = /^[a-z0-9._-]+$/i

/** A NIP-05 answer for one name on one domain: the key, or undefined when it names nobody. */
export type HandleLookup = (domain: string, name: string) => Promise<string | undefined>

export const nip05Lookup: HandleLookup = async (domain, name) => {
  // NIP-05 is https on the bare domain; a relay URL's port (a local relay) is not the domain's.
  const response = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(10_000) })
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

  const domain = new URL(workspace.relayUrl).hostname
  const lookup = workspace.lookup ?? nip05Lookup
  // Each key with the name it was asked by, for a refusal that quotes it.
  const keys = new Map<string, string>()
  for (const name of names) {
    const key = await keyOf(name, domain, lookup)
    if (!keys.has(key)) keys.set(key, name)
  }

  // An empty roster is a relay that publishes none, not a workspace of nobody:
  // the keys stand as named, as `assign` takes them.
  const members = await workspace.members()
  const outsider = [...keys].find(([key]) => members.length > 0 && !members.includes(key))
  if (outsider) throw new BadRequest(`${outsider[1]} is not a member of this workspace. Nothing was published.`)
  return [...keys.keys()]
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
  if (missing.length === 0) return body
  // A body that opens with block markup keeps it: the mentions get a line of their own.
  return `${missing.join(' ')}${/^(#|>|[-*+] |\d+\. |```)/.test(body) ? '\n\n' : ' '}${body}`
}

/** One version of a file's text as `mentionAddsFor` reads it: a block document, or marker text. */
export const fileText = (content: string, format: string | undefined): FileText =>
  format === 'blocks' || format === BLOCK_DOCUMENT_FORMAT ? { content, format: BLOCK_DOCUMENT_FORMAT } : { content }

/**
 * The Adds a save of a file's text writes beside itself (SPEC §11.8, WBD-9):
 * one for each person `saved` names by `nostr:npub…` and `editedFrom` did not,
 * built by conversation's `mentionAddsFor` as Leaf's, Ship's and Peek's saves
 * build them. The save itself carries no `p`, and a save that still names the
 * same people writes none, so somebody who left stays out.
 *
 * **Every person named anew must be among `asked`** (`--mention`), and every
 * one asked must be named, for the reason {@link withMentions} gives: an npub
 * copied out of somebody else's text would add a person nobody asked to reach.
 * Refused, so nothing is published.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-mention-in-a-files-text-adds-the-person-with-no-unread.md
 */
export function mentionAdds(
  writer: string,
  args: { file: string; folder: string; saved: FileText; editedFrom: FileText | null; asked: readonly string[] },
): UnsignedEvent[] {
  const named = peopleNamedInText(args.saved)
  const anew = newlyNamedPeople(args.saved, args.editedFrom).filter((person) => person !== writer)
  const unasked = anew.find((person) => !args.asked.includes(person))
  if (unasked) {
    throw new BadRequest(
      `The text mentions nostr:${encodeNpub(unasked)}, whom --mention does not name. A mention in a file's text adds the person to the file, so add them to --mention, or take the mention out. Nothing was published.`,
    )
  }
  const absent = args.asked.find((person) => !named.has(person))
  if (absent) {
    throw new BadRequest(`--mention names nostr:${encodeNpub(absent)}, whom the text does not mention. Write nostr:${encodeNpub(absent)} where they belong in it. Nothing was published.`)
  }
  return mentionAddsFor(writer, Date.now(), { file: args.file, folder: args.folder, saved: args.saved, editedFrom: args.editedFrom })
}

/**
 * Publishes the Adds {@link mentionAdds} built, once the save they go with has
 * landed, and says who was added. A refused Add is that person not being told
 * (§11.8, C9), so it fails the command, naming the save that stands.
 */
export async function publishMentionAdds(context: AgentContext, adds: readonly UnsignedEvent[], saved: string): Promise<{ added: string; eventId: string }[]> {
  const out: { added: string; eventId: string }[] = []
  for (const add of adds) {
    const person = add.tags.find((tag) => tag[0] === 'p')?.[1] ?? ''
    const signed = await context.signer.sign(add)
    const result = await context.relay.publish(signed)
    if (!result.ok) {
      throw new BadRequest(
        `${saved} was saved, but the relay refused adding nostr:${encodeNpub(person)}: ${result.reason ?? 'no reason given'}. ` +
          `Added before it: ${out.map((entry) => entry.added).join(', ') || 'nobody'}.`,
      )
    }
    out.push({ added: `nostr:${encodeNpub(person)}`, eventId: result.eventId ?? signed.id })
  }
  return out
}

/** The keys a `--mention` flag names, resolved as `comment --mention` resolves them; none when it is absent. */
export async function askedToMention(context: AgentContext, value: string | undefined): Promise<string[]> {
  return value === undefined ? [] : mentionedKeys(value, { relayUrl: context.relayUrl, members: () => relayMembers(context) })
}
