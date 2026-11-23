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
  filesOf,
  openFile,
  prevsAfterSwitch,
  writeChange,
  resolveForeignObject,
  resolveManifest,
  type Archive,
  type ProjectionCache,
  type QueryFn,
  type ResolvedManifest,
  type WriteChangeResult,
} from '@estiva-app/interop'
import { addrToNaddr, imetaTag, KIND, RELAY_BUSY_MESSAGE, type Imeta, type MergeText } from '@estiva-app/protocol'
import { BadRequest, type AgentContext } from './cli'
import { commentLinkTags } from './links'
import { fileReadsFor } from './apps/ship-workspace'

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

/** What a file's app calls it — its manifest's projection noun — and a Folder what interop's built-in calls it ("team"), whether named by address or by id. */
async function nounOf(context: AgentContext, address: string, cache?: ProjectionCache): Promise<string | undefined> {
  const named = pointerOf(address)
  const pointer = named.pubkey ? named : { ...named, kind: KIND_CHANNEL_METADATA }
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
  /** Refuses a built event whose tags are not the ones the caller means to sign, naming why; `written` is the value it was built with. */
  shape?: (tags: string[][], folder: string, written: string) => string | undefined,
  /** The value's content model when it is not marker text; only one the action declares is accepted. */
  contentFormat?: string,
  /** Files already on the relay, named in `imeta` — a comment's attachments, as every comment box sends them. */
  files: readonly Imeta[] = [],
  /** What the person said about a change, as its content — an archive's resolution (FOL-46). */
  note?: string,
  /** The field this change sets, to write it after the change it follows (§6.2); omitted, it is published as built. */
  ordered?: string,
  /**
   * With `ordered`: the change it follows, as the caller read it, instead of the field's current change read now; and
   * for a text, the version the caller's words were made on, merged onto what was saved since (§13.3, ALL-6).
   */
  after?: { prev: string; base?: MergeText },
): Promise<{ ok: boolean; reason?: string; eventId?: string; written?: WriteChangeResult }> {
  const query = relayQuery(context)
  const pointer = pointerOf(file.address)
  const resolved = await resolveManifest(pointer, query)
  if (!resolved) throw new BadRequest(`No app claims ${file.title}'s kind, so there is no declared way to change it.`)
  const actionId = pick(resolved.manifest, pointer.kind)
  if (!actionId) throw new BadRequest(`${file.title}'s manifest declares no action for that. Nothing was published.`)
  const [root] = await query([{ kinds: [pointer.kind], authors: [pointer.pubkey], '#d': [pointer.identifier], limit: 1 }])
  // An empty answer is a file that does not exist or one this key cannot read; the relay does not say which.
  if (!root) throw new BadRequest(`Nothing readable at ${file.address}: no such file, or one in a team this key cannot read. Nothing was published.`)
  const folder = folderOf(root)
  if (!folder) throw new BadRequest(`${file.title} has no team on the relay, so there is nowhere to write.`)

  const linkTags = actionId === 'comment' ? await commentLinkTags(context, value, { file: file.address, parent: replyTo?.id }) : undefined
  /** The event for this value, checked: built by the manifest, the kind this command signs, the tags the caller means. */
  const build = (input: { value: string; prev?: string; createdAtMs: number }) => {
    const built = buildActionEvent({
      manifest: resolved.manifest,
      kind: pointer.kind,
      address: file.address,
      objectAuthor: pointer.pubkey,
      folder,
      actionId,
      value: input.value,
      replyTo,
      contentFormat,
      ...(note ? { note } : {}),
      ...(input.prev ? { prev: input.prev } : {}),
      linkTags,
      pubkey: context.signer.pubkey,
      createdAtMs: input.createdAtMs,
    })
    if (typeof built === 'string') throw new BadRequest(`${file.title} does not take ${actionId}: ${built}`)
    if (built.kind !== signs) {
      throw new BadRequest(`The manifest read for ${file.title} declares "${actionId}" as a kind:${built.kind}, which this command does not write (it writes ${signs}). Nothing was published.`)
    }
    const wrong = shape?.(built.tags.filter((tag) => tag[0] !== 'prev'), folder, input.value)
    if (wrong) throw new BadRequest(`The manifest read for ${file.title} builds "${actionId}" ${wrong}. Nothing was published.`)
    return built
  }

  if (ordered) {
    /*
      A field's change names the one it follows (SPEC §6.2), as `ship archive`
      writes it: a relay that keeps the type in order refuses one that names
      none, and answers a stale one with `conflict:`, which `writeChange` takes.
      The field's current change, or the file's first record when it never changed.
    */
    const handle = { kind: pointer.kind, pubkey: pointer.pubkey, d: pointer.identifier }
    // The relay's list read where its NIP-11 offers one; elsewhere the file's changes, folded as every reader folds them.
    const listed = after ? undefined : (await fileReadsFor(context)).list ? (await prevsAfterSwitch(query, handle, [ordered]).catch(() => undefined))?.[ordered] : undefined
    const prev =
      after?.prev ??
      listed ??
      filesOf([root, ...(await query([{ kinds: [signs], '#a': [file.address] }]))], { withText: true }).find((one) => one.address === file.address)?.fields[ordered]?.id ??
      root.id
    const written = await writeChange({
      field: ordered,
      value,
      prev,
      ...(contentFormat ? { format: contentFormat } : {}),
      ...(after?.base ? { base: after.base } : {}),
      build,
      sign: (event) => context.signer.sign(event),
      publish: (event) => context.relay.publish(event),
      query,
      current: async (field) => (await openFile(query, handle, { text: false }).catch(() => undefined))?.fields[field]?.event,
    })
    return written.ok ? { ok: true, eventId: written.id, written } : { ok: false, reason: 'refused' in written ? written.refused : 'a change crossed it', written }
  }

  const built = build({ value, createdAtMs: Date.now() })
  const signed = await context.signer.sign(files.length ? { ...built, tags: [...built.tags, ...files.map(imetaTag)] } : built)
  const result = await context.relay.publish(signed)
  return { ...result, eventId: result.eventId ?? signed.id }
}
