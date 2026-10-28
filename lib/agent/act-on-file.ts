/**
 * One of a file's declared actions, built by interop's runtime and signed as
 * the agent — Peek's `applyActionAsViewer`, restated once for every app that
 * writes a file through its manifest rather than through a workspace of its own.
 *
 * The kind, whether the action may be taken at all, and the Folder all come off
 * the manifest and the file itself; nothing here names a kind or a tag. `pick`
 * chooses the action from the manifest — by id for `comment`, by what it emits
 * for a summary (§7.3). `replyTo` makes a comment NIP-22's reply to another,
 * built by the runtime too (PRO-20), in its comment's place on the page. `signs` is the one kind the command writes:
 * a manifest is anybody's event, so one declaring the action as anything else is
 * refused, as `ship`'s `act` refuses one.
 */
import { archivedLine } from '@estiva-app/conversation'
import {
  buildActionEvent,
  createLoadQuery,
  folderOf,
  KIND_CHANNEL_METADATA,
  resolveForeignObject,
  resolveManifest,
  type Archive,
  type ProjectionCache,
  type QueryFn,
  type ResolvedManifest,
} from '@estiva-app/interop'
import { addrToNaddr, imetaTag, KIND, RELAY_BUSY_MESSAGE, type Imeta } from '@estiva-app/protocol'
import { BadRequest, type AgentContext } from './cli'
import { commentLinkTags } from './links'

/** A `d` may itself hold a colon, so everything after the pubkey is the identifier. */
export function pointerOf(address: string) {
  const [kind, pubkey, ...rest] = address.split(':')
  return { kind: Number(kind), pubkey, identifier: rest.join(':'), relays: [] as string[] }
}

/** A publish the relay refused, said in its own words. */
export function published(result: { ok: boolean; reason?: string }, what: string): void {
  if (!result.ok) throw refused(what, result.reason)
}

/**
 * A refused publish as the error to throw. A busy relay has not refused
 * anything — the protocol already asked it again — so it is not the caller's
 * mistake and is said as the busy sentence, not "the relay refused …".
 * `after` is what the caller adds about what did save before it.
 */
export function refused(what: string, reason: string | undefined, after?: string): Error {
  if (reason === RELAY_BUSY_MESSAGE) return new Error(`${RELAY_BUSY_MESSAGE}; ${what} was not saved.${after ? ` ${after}` : ''}`)
  return new BadRequest(`The relay refused ${what}: ${reason ?? 'no reason given'}${after ? `. ${after}` : ''}`)
}

export function relayQuery(context: AgentContext): QueryFn {
  return (filters) => context.relay.queryAll(filters as never)
}

/**
 * One load's query (APP-2): each change read once between the reads it makes.
 * `queryAll` pages every filter to its end, so every read it answers counts,
 * the workspace's whole change kind included (APP-6). Make one per load.
 */
export function loadQuery(context: AgentContext): QueryFn {
  return createLoadQuery(relayQuery(context), { paged: true })
}

/** The Folder a file's root names — where a change to it is published — or undefined when there is none or it is unreadable. */
export async function folderOfFile(context: AgentContext, address: string): Promise<string | undefined> {
  const pointer = pointerOf(address)
  const [root] = await relayQuery(context)([{ kinds: [pointer.kind], authors: [pointer.pubkey], '#d': [pointer.identifier], limit: 1 }])
  return (root && folderOf(root)) || undefined
}

/**
 * The refusal on an archived file (PEEKM-8): nothing is written on one, comments
 * and edits of comments included, and the agent says why in the words the
 * file's app shows in its comment box's place — `archivedLine`, one sentence
 * for every app. A file archived itself says so ("Archived. Unarchive it to
 * comment."), and a Leaf page "in Peek", since Leaf has no Unarchive; one
 * archived with a file above it names that file by its app's noun ("Unarchive
 * the project to comment."). Undefined when the file is not archived.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-file-is-archived-with-the-closest-archived-file-above-it.md
 */
export async function archivedRefusal(context: AgentContext, address: string, archive: Archive | undefined, cache?: ProjectionCache): Promise<string | undefined> {
  if (!archive) return undefined
  if (!archive.with) return archivedLine(archive, undefined, pointerOf(address).kind === KIND.DOCUMENT ? { in: 'Peek' } : {})
  return archivedLine(archive, await nounOf(context, archive.with, cache))
}

/** What a file's app calls it — its manifest's projection noun — and a Folder a Folder, whether named by address or by id. */
async function nounOf(context: AgentContext, address: string, cache?: ProjectionCache): Promise<string | undefined> {
  const pointer = pointerOf(address)
  if (!pointer.pubkey || pointer.kind === KIND_CHANNEL_METADATA) return 'folder'
  const resolved = await resolveManifest(pointer, relayQuery(context), cache).catch(() => null)
  const noun = resolved?.manifest.projections?.[String(pointer.kind)]?.noun?.trim()
  // A manifest is anybody's event, and this noun becomes the agent's own error
  // text: a word, never a sentence somebody planted (docs/untrusted-content.md).
  return noun && NOUN.test(noun) ? noun : undefined
}

const NOUN = /^[a-z][a-z -]{0,23}$/

/** Refuses a write on a file that is archived, itself or with a file above it, before anything is signed. */
export async function refuseIfArchived(context: AgentContext, address: string, archive: Archive | undefined, cache?: ProjectionCache): Promise<void> {
  const line = await archivedRefusal(context, address, archive, cache)
  if (line) throw new BadRequest(`${line} Nothing was published.`)
}

/** A file's archive as every app reads it, its parents' included (`archivedWith`) — undefined when it is not archived or not readable. */
export async function archiveOfFile(context: AgentContext, address: string, cache?: ProjectionCache): Promise<Archive | undefined> {
  const file = await resolveForeignObject(addrToNaddr(address), relayQuery(context), async () => ({}), undefined, cache, { archivedWith: true })
  return file?.archived
}

export async function actOnFile(
  context: AgentContext,
  file: { address: string; title: string },
  pick: (manifest: ResolvedManifest['manifest'], kind: number) => string | undefined,
  value: string,
  signs: number,
  /** The comment answered; its `place` (block and quote tags) is copied onto the reply (§13.6). */
  replyTo?: { id: string; kind: number; author: string; place?: readonly string[][] },
  /** Refuses a built event whose tags are not the ones the caller means to sign, naming why. */
  shape?: (tags: string[][], folder: string) => string | undefined,
  /** The value's content model when it is not marker text; only one the action declares is accepted. */
  contentFormat?: string,
  /** Files already on the relay, named in `imeta` — a comment's attachments, as every comment box sends them. */
  files: readonly Imeta[] = [],
): Promise<{ ok: boolean; reason?: string; eventId?: string }> {
  const query = relayQuery(context)
  const pointer = pointerOf(file.address)
  const resolved = await resolveManifest(pointer, query)
  if (!resolved) throw new BadRequest(`No app claims ${file.title}'s kind, so there is no declared way to change it.`)
  const actionId = pick(resolved.manifest, pointer.kind)
  if (!actionId) throw new BadRequest(`${file.title}'s manifest declares no action for that. Nothing was published.`)
  const [root] = await query([{ kinds: [pointer.kind], authors: [pointer.pubkey], '#d': [pointer.identifier], limit: 1 }])
  // An empty answer is a file that does not exist or one this key cannot read; the relay does not say which.
  if (!root) throw new BadRequest(`Nothing readable at ${file.address}: no such file, or one in a Folder this key cannot read. Nothing was published.`)
  const folder = folderOf(root)
  if (!folder) throw new BadRequest(`${file.title} has no Folder on the relay, so there is nowhere to write.`)

  const built = buildActionEvent({
    manifest: resolved.manifest,
    kind: pointer.kind,
    address: file.address,
    objectAuthor: pointer.pubkey,
    folder,
    actionId,
    value,
    replyTo,
    contentFormat,
    linkTags: actionId === 'comment' ? await commentLinkTags(context, value, { file: file.address, parent: replyTo?.id }) : undefined,
    pubkey: context.signer.pubkey,
    createdAtMs: Date.now(),
  })
  if (typeof built === 'string') throw new BadRequest(`${file.title} does not take ${actionId}: ${built}`)
  if (built.kind !== signs) {
    throw new BadRequest(`The manifest read for ${file.title} declares "${actionId}" as a kind:${built.kind}, which this command does not write (it writes ${signs}). Nothing was published.`)
  }
  const wrong = shape?.(built.tags, folder)
  if (wrong) throw new BadRequest(`The manifest read for ${file.title} builds "${actionId}" ${wrong}. Nothing was published.`)
  const signed = await context.signer.sign(files.length ? { ...built, tags: [...built.tags, ...files.map(imetaTag)] } : built)
  const result = await context.relay.publish(signed)
  return { ...result, eventId: result.eventId ?? signed.id }
}
