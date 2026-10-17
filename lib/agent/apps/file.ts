/**
 * Any file, by its address — whichever app it belongs to (SUM-8).
 *
 * Ship's issues and projects and Peek's topics have verbs of their own, found
 * by title. A file of an app with no module here — a Leaf page — had no way to
 * be written at all, so this takes the address and asks the file's own
 * manifest how (§7.3), the way Peek's `applyActionAsViewer` does for any kind.
 * It names no kind and no app: a new app's files take a summary with nothing
 * added here.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/claude-learns-each-app-from-its-manifest.md
 */
import { resolveForeignObject } from '@estiva-app/interop'
import { addrToNaddr } from '@estiva-app/protocol'
import { KIND_CHANGE } from '@estiva-app/conversation'
import { actOnFile, published, relayQuery } from '../act-on-file'
import { BadRequest, flagValue, type AgentApp } from '../cli'
import { summaryAction, summaryText, summaryWarning } from '../summary'

/** `kind:pubkey:d`, the one handle every app's file has. A title would be one app's lookup. */
const ADDRESS = /^\d+:[0-9a-f]{64}:[^\s]+$/

export const fileApp: AgentApp = {
  name: 'file',
  summary: 'any file by its address, through its own app’s manifest',
  commands: [
    {
      name: 'summarize',
      signs: [KIND_CHANGE],
      summary: "change any file's summary — a Leaf page's included — by its address",
      usage: 'summarize <kind:pubkey:d> --summary "..."',
      async run(context, args) {
        const address = args.positional[0]
        if (!address || !ADDRESS.test(address)) {
          throw new BadRequest('summarize needs a file\'s address, kind:pubkey:d, as `ship show` and `peek topics` print it.')
        }
        const text = flagValue(args, 'summary')
        if (text === undefined) throw new BadRequest('summarize needs --summary. An empty one clears it.')
        const summary = summaryText(text)

        // Read as any app reads it, so the answer names the file and what its summary was. A file this key
        // cannot read is refused by `actOnFile`, which reads the root before building anything.
        const file = await resolveForeignObject(addrToNaddr(address), relayQuery(context), async () => ({}))
        const title = file?.slots.title?.value ?? address

        const result = await actOnFile(context, { address, title }, summaryAction, summary, KIND_CHANGE)
        published(result, `the summary of ${title}`)

        return {
          changed: { file: title, address, from: file?.slots.subtitle?.value ?? '', to: summary },
          eventId: result.eventId,
          ...(summaryWarning(summary) ? { note: summaryWarning(summary) } : {}),
        }
      },
    },
  ],
}
