/**
 * What a text save says when somebody saved the same text since it was read
 * (§13.3): whose change it was merged onto, or why nothing was saved — one
 * wording for every file the agent writes a text to, a Ship project's and
 * issue's and any app's file by its address (ALL-6).
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/merging-two-changes-to-one-text-never-loses-words.md
 */
import { changedAt, type WriteChangeResult } from '@estiva-app/interop'
import type { MergeAsk, SignedEvent } from '@estiva-app/protocol'
import { relayQuery } from './act-on-file'
import { BadRequest, type AgentContext } from './cli'
import { profilesOf } from './profiles'

/** A person's change as an answer names it: who, and when. */
async function changeBy(context: AgentContext, change: SignedEvent) {
  const directory = await profilesOf(relayQuery(context), [change.pubkey])
  return { by: directory.get(change.pubkey)?.name ?? `${change.pubkey.slice(0, 8)}…`, at: new Date(changedAt(change)).toISOString() }
}

/** What a text save merged onto somebody's newer change says: whose words it kept. */
export async function mergedLine(context: AgentContext, result: WriteChangeResult) {
  if (!result.ok || !result.mergedOnto) return undefined
  const { by, at } = await changeBy(context, result.mergedOnto)
  return 'unchanged' in result
    ? `Nothing to save: ${by}'s change at ${at} already has everything yours did.`
    : `Merged: the text had been changed by ${by} at ${at}, after the version you read. Their change is kept as it is, with yours where it touched nothing of theirs.`
}

const askedBlock = (text: string | undefined) => (text === undefined ? '(deleted)' : JSON.stringify(text))

/**
 * Why a text save wrote nothing (Miky, 2026-11-02): somebody changed the same
 * block since the version read, or edited a block one side deleted. Names who
 * and when, shows both versions of each block, and says to keep their words.
 */
export async function textAsks(context: AgentContext, title: string, asks: readonly MergeAsk[], theirs: SignedEvent, alsoNotSaved: readonly string[], noun = 'project'): Promise<BadRequest> {
  const { by, at } = await changeBy(context, theirs)
  const blocks = asks.map((ask) =>
    [
      `- ${ask.block === null ? 'The text' : `Block ${ask.block}`}: ${ask.why === 'changed-by-both' ? 'changed by both of you' : 'edited by one of you and deleted by the other'}.`,
      `  theirs: ${askedBlock(ask.theirs)}`,
      `  yours:  ${askedBlock(ask.mine)}`,
    ].join('\n'),
  )
  return new BadRequest(
    [
      `Nothing was saved${alsoNotSaved.length ? `, ${alsoNotSaved.join(', ')} included` : ''}: the text of “${title}” is now as ${by} left it at ${at}, and your change and theirs meet in ${asks.length === 1 ? 'one place' : `${asks.length} places`}.`,
      ...blocks,
      `Keep ${by}'s words: read the ${noun} again, rewrite your change on top of the text as it is now, and save it with the new version. Ask the person you are working with before dropping any of their words.`,
      // A block they deleted holds no words of theirs to keep: whether it stays deleted is the person's call.
      ...(asks.some((ask) => ask.theirs === undefined)
        ? [`${by} deleted a block you changed: ask the person you are working with whether it stays deleted or comes back with your change.`]
        : []),
    ].join('\n'),
  )
}
