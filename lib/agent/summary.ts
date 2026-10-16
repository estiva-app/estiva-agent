/**
 * A file's summary, as the agent writes it (SPEC §6.12): one or two sentences
 * of plain text beside the title, its own field, changed like the title.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-files-summary-is-its-own-field.md
 *
 * Nothing here names a kind or a tag. Which action writes a summary is read off
 * the file's manifest — the one whose `emits.field` is `summary` (§7.3) — so a
 * new app's files take one with nothing added here.
 */
import type { ResolvedManifest } from '@estiva-app/interop'

type Manifest = ResolvedManifest['manifest']

/** About how long a summary should be (SPEC §6.12). Longer is written, and said. */
export const SUMMARY_LENGTH = 240

/**
 * A summary as it goes on the wire: one line of plain text. Line breaks fold to
 * spaces here, as every reader folds them, and blank means none — an empty
 * value is how a summary is cleared, the one it was created with included.
 */
export function summaryText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** What to say about a summary past about 240 characters: nothing refuses it (Miky, 2026-10-15). */
export function summaryWarning(value: string): string | undefined {
  return value.length > SUMMARY_LENGTH
    ? `The summary is ${value.length} characters, past the ~${SUMMARY_LENGTH} it should be. It was written whole; cards and lists cut it.`
    : undefined
}

const appliesTo = (action: { appliesTo?: string | string[] }, kind: number) =>
  (Array.isArray(action.appliesTo) ? action.appliesTo : [action.appliesTo]).includes(String(kind))

/** The id of the action that changes a summary on this kind, if the manifest declares one (§7.3). */
export function summaryAction(manifest: Manifest | undefined, kind: number): string | undefined {
  return manifest?.actions?.find((action) => action.emits?.field === 'summary' && appliesTo(action, kind))?.id
}

/**
 * How a create action takes a summary: as a property of its input, which seeds
 * the root's `summary` tag; else as a change right after the record, from the
 * action that emits `field: summary` on the new kind; else not at all. Asked
 * before anything is published, so an app that declares neither yet is told
 * instead of getting a file with no summary.
 */
export function summaryRoute(manifest: Manifest | undefined, createAction: string, kind: number): 'seed' | 'change' | undefined {
  const create = manifest?.actions?.find((action) => action.id === createAction)
  if (create?.input?.properties?.summary) return 'seed'
  return summaryAction(manifest, kind) ? 'change' : undefined
}
