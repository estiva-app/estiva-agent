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
import type { EditFold } from '@estiva-app/conversation'
import { buildEdit } from '@estiva-app/protocol'
import { BadRequest, type AgentContext } from './cli'
import { resolveOne } from './resolve'

/**
 * Replace a message's text: SPEC §6.8's `kind:40003`, naming the target, in the
 * **target's** Folder — the channel-scoped kind is refused anywhere else, with
 * the kind granted and the signature fine (CON-4). Shared by `ship
 * edit-comment` and `peek edit`; the relay decides who may.
 */
export async function publishEdit(
  context: AgentContext,
  args: { folder: string | undefined; messageEventId: string; body: string },
): Promise<{ ok: boolean; reason?: string; eventId?: string }> {
  if (!args.folder) throw new BadRequest('That message names no Folder, so an edit of it has nowhere to be published.')
  const signed = await context.signer.sign(
    buildEdit(context.signer.pubkey, Date.now(), { channelUuid: args.folder, targetEventId: args.messageEventId, body: args.body }),
  )
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
