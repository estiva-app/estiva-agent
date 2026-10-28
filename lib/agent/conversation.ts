/**
 * The parts of a conversation both app modules render the same way.
 *
 * Ship and Peek do not resemble each other here — they read **the same
 * events**. A `kind:9` in a Peek topic and a `kind:9` on a Ship project are one
 * event read twice, which is why `apps/peek.ts` already folds with Ship's
 * `foldFolder` rather than parsing threads again. An edit over one of those
 * messages is the same story one layer up: `kind:40003` is folded by the
 * vendored `src/edits.ts`, and what is left is deciding what to *print*.
 *
 * That decision is duplicated in two places or shared in one. Two copies of
 * "which body won, and say it was edited" would drift, and the drift shows up
 * as the two commands disagreeing about what somebody said — the same failure
 * the fold is vendored to prevent.
 *
 * This is not the generic half. `lib/agent/cli.ts` may not name a kind, a tag
 * or an object type and does not; this file names a message, which both app
 * modules have and no third one is obliged to.
 */
import { anchorsOf, decorationsOf, editTargetOf, foldAttachments, KIND_EDIT, placeOf, type EditFold } from '@estiva-app/conversation'
import { conversationsOf, threadsOf, type ForeignObject, type ProjectionCache } from '@estiva-app/interop'
import { buildEdit, imetaTag, type SignedEvent } from '@estiva-app/protocol'
import { relayQuery } from './act-on-file'
import { BadRequest, type AgentContext } from './cli'
import { commentLinkTags } from './links'
import { resolveOne } from './resolve'

/**
 * Replace a message's text: SPEC §6.8's `kind:40003`, naming the target, in the
 * **target's** Folder — the channel-scoped kind is refused anywhere else, with
 * the kind granted and the signature fine (CON-4). Shared by `ship
 * edit-comment` and `peek edit`; the relay decides who may.
 *
 * The edit lists the message's files as they stand, read from the relay just
 * before: an edit is the whole new message, and one with no `imeta` takes
 * every file off (SPEC §6.8). It also says what the new words link
 * (PEEKM-7): the `a` and `q` they earn, as a send's.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/an-edit-is-the-whole-new-message.md
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/an-edit-says-what-the-message-links-now.md
 */
export async function publishEdit(
  context: AgentContext,
  args: { folder: string | undefined; messageEventId: string; body: string },
): Promise<{ ok: boolean; reason?: string; eventId?: string }> {
  if (!args.folder) throw new BadRequest('That message names no Folder, so an edit of it has nowhere to be published.')
  const id = args.messageEventId.toLowerCase()
  const events = await relayQuery(context)([{ ids: [id] }, { kinds: [KIND_EDIT], '#e': [id] }])
  // Unread, its files are unknown, and an edit listing none would take them off.
  if (!events.some((event) => event.id === id)) throw new BadRequest('That message could not be read back, so it was not edited. Try again.')
  const files = foldAttachments(events)[id] ?? []
  const target = events.find((event) => event.id === id)!
  // What the new words link, the whole `a`/`q` set (never `p`, `urgent` or `part`), minus the
  // comment's own file and the message it answers, so a file it now links lists it under Mentioned in.
  // A `kind:1111` names its file in `A`; an older `kind:9` comment on a file, in its `a` (§7.3).
  const own = anchorsOf(target)[0] ?? target.tags.find((t) => t[0] === 'a')?.[1]
  const linkTags = await commentLinkTags(context, args.body, { file: own, parent: editTargetOf(target) }, { edit: true })
  const edit = buildEdit(context.signer.pubkey, Date.now(), {
    channelUuid: args.folder,
    targetEventId: args.messageEventId,
    body: args.body,
    mediaTags: files.map(imetaTag),
  })
  const signed = await context.signer.sign({ ...edit, tags: [...edit.tags, ...linkTags] })
  const result = await context.relay.publish(signed)
  return { ok: result.ok, reason: result.reason, eventId: result.eventId ?? signed.id }
}

/** The shape both folds hand back: an event id and the text that came with it. */
export interface EditableMessage {
  id: string
  body: string
}

/**
 * A message's body as it stands now, and whether an edit is why.
 *
 * **The marker is not decoration.** RFC 0.4 §7.2.1 has a reader mark an edited
 * message, and here it is load-bearing in a way it is not in a UI: an agent
 * quoting a comment back to somebody is the only thing standing between them
 * and a body that was rewritten after they were told about it. `editedAt` is
 * the millisecond precision `ts` buys, so two edits in one second are still
 * ordered when reported.
 *
 * Spread into the caller's object so an unedited message carries neither key
 * rather than `edited: false` — absent means nobody has touched it, which is
 * the common case and should cost nothing to read.
 */
export function edited(
  edits: Record<string, EditFold>,
  message: EditableMessage,
): { body: string; edited?: true; editedAt?: string } {
  const edit = edits[message.id]
  if (!edit) return { body: message.body }
  // An edit byte-identical to the body changed attachments only, and is not marked (SPEC §6.8).
  if (edit.editedAt === undefined) return { body: edit.body }
  return { body: edit.body, edited: true, editedAt: new Date(edit.editedAt).toISOString() }
}

/**
 * One message from an id or a distinctive phrase, within an already-narrowed set.
 *
 * `resolveOne` refuses ambiguity with the candidates listed rather than picking
 * one, and that matters more here than anywhere else these commands resolve
 * something: replying to the wrong message is a non-sequitur somebody can read
 * and answer, whereas **editing the wrong message silently replaces text that
 * was already true**, and the version that was there is not shown again.
 *
 * The caller narrows first — to one conversation, or to one object's
 * conversations — for the reason `replyTarget` does: matching a phrase against
 * every message in a busy topic is how the wrong one gets picked, and a refusal
 * only helps when the near-misses are in the candidate set to collide with.
 *
 * **No author filter.** The relay decides who may edit — `validate_edit_ownership`
 * takes the target's effective author *or* the NIP-OA owner of an authoring
 * agent, and no client can evaluate the second half (SPEC §6.5). Hiding
 * somebody else's message from the resolver would turn the relay's clear
 * refusal into "no message matches", which is the same wrong answer for two
 * very different reasons.
 */
export function findMessage<T extends EditableMessage>(messages: T[], reference: string): T {
  if (!messages.length) {
    throw new BadRequest('There are no messages here to edit.')
  }
  return resolveOne(messages, reference, {
    noun: 'message',
    exact: (message) => [message.id],
    text: (message) => `${message.id} ${message.body}`,
    label: (message) => `${message.id.slice(0, 12)}… — ${message.body.slice(0, 60)}`,
    hint: 'Pass a message id, or a distinctive phrase from it.',
  })
}

/** One message of a file's conversation, as both the topic and the document reads print it. */
export interface Message {
  id: string
  author: string
  body: string
  createdAt: number
  kind: number
  /** The event's own `h` — what a `kind:40003` naming it must carry. */
  folder?: string
  /** Its tags, for where on the page it is (`block`, `quote`). */
  tags: string[][]
}

export interface Conversation {
  root: Message
  replies: Message[]
}

const asMessage = (event: SignedEvent): Message => ({
  id: event.id,
  author: event.pubkey,
  body: event.content,
  createdAt: event.created_at,
  kind: event.kind,
  folder: event.tags.find((tag) => tag[0] === 'h')?.[1],
  tags: event.tags,
})

/**
 * A file's conversation as Peek's file page draws it — three reads, each for a
 * reason that is NIP-22's. A Peek topic's and a Leaf document's are the same
 * read: comments on an address, whichever app owns it.
 *
 * 1. The roots: `conversationsOf`, the `#a` read, which keeps only what SPEC
 *    §6.4 calls a comment on this file (CON-15) — a message that merely names
 *    it is *Mentioned in*, not its discussion.
 * 2. The roots' events and their direct replies by `#e`, in one request —
 *    interop's `threadsOf`, the read Peek's thread pane makes: a reply's
 *    lowercase tags name its parent, not the file, so it never arrives on the
 *    `#a` read. One level only, because that is what Peek's pane reads.
 * 3. What was done to each — edits and resolutions — which names the comment,
 *    so it is a third read (`decorationsOf`, `@estiva-app/conversation`).
 *
 * Only the file's address is needed, so a caller can start this before the
 * file itself is resolved (APP-6). `beside` is a read that needs only the
 * threads — the speakers' names — asked at the same time as the third.
 */
export async function readConversation<T = undefined>(
  context: AgentContext,
  file: { address: string },
  cache: ProjectionCache,
  beside: (conversations: Conversation[]) => Promise<T> = async () => undefined as T,
) {
  const query = relayQuery(context)
  // `conversationsOf` reads a file's identity and address only, and an address is the identity of a file that has one.
  const object = { ref: file.address, address: file.address } as ForeignObject
  const rootIds = ((await conversationsOf([object], query, cache))[file.address] ?? []).map((message) => message.id)
  if (!rootIds.length) {
    return { conversations: [] as Conversation[], edits: {} as Record<string, EditFold>, resolved: new Set<string>(), besides: await beside([]) }
  }

  // 1000, not Peek's 200: an agent answering from a file needs its oldest replies too.
  const threads = await threadsOf(file.address, rootIds, query, cache, 1000)
  const conversations = rootIds
    .filter((id) => threads.roots[id])
    .map((id) => ({ root: asMessage(threads.roots[id]), replies: (threads.replies[id] ?? []).map(asMessage) }))

  // `@estiva-app/conversation`'s read (CON-5), the one Peek and Ship make:
  // edits fold against each message's own body, so an attachments-only edit
  // does not mark it edited.
  const all = conversations.flatMap((thread) => [thread.root, ...thread.replies])
  const [decorations, besides] = await Promise.all([
    decorationsOf(
      all.map((message) => ({ id: message.id, at: message.createdAt, body: message.body })),
      query,
    ),
    beside(conversations),
  ])
  const isResolved = (id: string) => decorations.byId[id]?.resolutions.at(-1)?.action === 'resolved'
  const edits: Record<string, EditFold> = {}
  for (const [id, decoration] of Object.entries(decorations.byId)) if (decoration.edit) edits[id] = decoration.edit

  return {
    conversations,
    edits,
    resolved: new Set(conversations.map((thread) => thread.root.id).filter(isResolved)),
    besides,
  }
}

/**
 * What `buildActionEvent`'s `replyTo` needs of the comment answered: its id, its own kind, its author,
 * and its place on the page, which the reply copies so its thread keeps that place (§13.6).
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-reply-on-a-page-keeps-its-threads-place.md
 */
export const replyToOf = (message: Message) => {
  const place = placeOf(message)
  return { id: message.id, kind: message.kind, author: message.author, ...(place.length ? { place } : {}) }
}

/**
 * One conversation from whatever the caller typed — an id, a prefix, or a
 * phrase from its opening comment.
 *
 * Ambiguity is refused with the candidates listed, never resolved to a guess.
 * Replying to the wrong conversation is worse here than in a tracker: it lands
 * a non-sequitur in front of everyone who was reading the other one.
 */
export function findThread<T extends { id: string; opening: string }>(threads: T[], reference: string): T {
  return resolveOne(threads, reference, {
    noun: 'conversation',
    exact: (thread) => [thread.id],
    text: (thread) => `${thread.id} ${thread.opening}`,
    label: (thread) => `${thread.id.slice(0, 12)}… — ${thread.opening.slice(0, 60)}`,
    hint: 'Pass a conversation id from `peek topic` or `file show`, or a distinctive phrase from its first message.',
  })
}
