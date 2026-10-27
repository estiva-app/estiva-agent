/**
 * Ship, as an agent reads it.
 *
 * The per-app half of the seam in `../cli.ts`. Everything that knows Ship has
 * projects, issues and change events lives here; nothing generic knows any of
 * it. A second app is a sibling of this file, not a fork of the runner.
 *
 * It reads Ship the way Peek does — Ship's published manifest, folded by
 * `@estiva-app/interop`, conversations by `@estiva-app/conversation` — and
 * writes the events Ship's manifest declares, built by interop's runtime
 * (PER-21). Until then it carried a copy of Ship's code; now the fold's subtle
 * rules — change ordering, a status set by somebody who did not author the
 * issue, an issue moved between projects — live in one place, and if this CLI
 * and `ship.estiva.app` disagree, the manifest is what is wrong.
 */
import { describePlacing, placeFiles, uploadFiles, type PlacedFiles } from '../attachments'
import { BadRequest, flagValue, type AgentApp, type AgentContext, type ParsedArgs } from '../cli'
import { edited, findMessage, publishEdit } from '../conversation'
import { describe, descriptionText, formatName } from '../descriptions'
import { commentLinkTags, printedLinks } from '../links'
import { askedToMention, fileText, mentionAdds, mentionedKeys, NO_MENTIONS, publishMentionAdds, relayMembers, withMentions } from '../mentions'
import { profilesOf, type Directory } from '../profiles'
import { resolveMaybe, resolveOne, short } from '../resolve'
import { SUMMARY_LENGTH, summaryRoute, summaryText, summaryWarning } from '../summary'
import {
  KIND,
  cascadeArchives,
  conversationsFor,
  loadWorkspace,
  relayQuery,
  type Conversation,
  type Issue,
  type Project,
  type Vocabulary,
  type Workspace,
} from './ship-workspace'
import { randomUUID } from 'node:crypto'
import { KIND as PROTOCOL_KIND, imetaTag, type Imeta } from '@estiva-app/protocol'
import { KIND_CHANGE, KIND_COMMENT, KIND_DELETION, KIND_EDIT } from '@estiva-app/conversation'
import {
  KIND_CHANNEL_METADATA,
  buildActionEvents,
  createLoadQuery,
  createProjectionCache,
  listFolders,
  planArchiveFolder,
  planMoveFromFolders,
  resolveFolderContents,
  topLevelFolders,
  type Archive,
  type FolderRef,
  type FolderSummary,
  type MovableFile,
  type MoveRefusal,
  type ResolvedManifest,
} from '@estiva-app/interop'

/** A pubkey as something a person can read, falling back to a short hex. */
function who(directory: Directory, pubkey: string | undefined): string | undefined {
  if (!pubkey) return undefined
  const profile = directory.get(pubkey)
  return profile?.name ?? `${pubkey.slice(0, 8)}…`
}

/**
 * A change value that is a public key, rendered as a name.
 *
 * `assignee` changes carry a pubkey in `value`, so resolving only the actor
 * leaves "Claude set assignee to b38fd268…" — half a sentence. Matched on shape
 * rather than on field name so the next field carrying a key is covered without
 * anybody remembering to add it.
 *
 * A key nobody has a profile for stays as it is: an unnamed participant is
 * unnamed, and inventing something would be worse than the hex.
 */
export function resolvePubkeys(directory: Directory, value: string): string {
  if (!/^[0-9a-f]{64}$/i.test(value.trim())) return value
  const profile = directory.get(value.trim().toLowerCase())
  return profile?.name ?? value
}

/**
 * Everything a status value should say when printed — its label in the
 * vocabulary Ship's manifest declares.
 *
 * A value outside the vocabulary is shown as it is rather than swallowed:
 * another app may have written a status Ship has never heard of, and showing
 * `todo` instead would be inventing agreement that does not exist.
 */
const status = (vocab: Vocabulary, value: string) =>
  vocab.entries.find((entry) => entry.value === (value || vocab.fallback))?.label ?? value
/** The label back to its value — what `set-status` takes — for a text row. */
const statusValue = (vocab: Vocabulary, label: string) =>
  vocab.entries.find((entry) => entry.label === label)?.value ?? label

/** How much of a title a listing row shows; the whole thing is one `status` away. */
const ROW_TITLE = 68

/**
 * A listing as lines somebody greps (MAK-2): ref, status, short id, title.
 *
 *     FOL-19   todo         42d82497  A ?file= URL does not open…
 *
 * The status is the value rather than the label for the same reason the
 * state line uses it. The row is built from the JSON summary, not from the
 * issue, so `--json` and the text can never disagree about what was listed.
 */
export function issueRow(issue: ReturnType<typeof issueSummary>, vocab: Vocabulary): string {
  return [
    issue.ref.padEnd(8),
    statusValue(vocab, issue.status).padEnd(12),
    issue.short,
    clip(issue.title, ROW_TITLE) + (issue.archived ? ' (archived)' : ''),
  ].join(' ') + summaryLine(issue.summary)
}

/** How much of a summary a listing row shows: about the 240 it should be (SPEC §6.12). */
const ROW_SUMMARY = SUMMARY_LENGTH

/**
 * A file's summary, as the second line of its row — what it is about, read
 * before its whole description is (SUM-2). Absent when it has none, so a row
 * with no summary is one line as before.
 */
function summaryLine(summary: string | undefined): string {
  return summary ? `\n${' '.repeat(9)}${clip(summary, ROW_SUMMARY)}` : ''
}

export function projectRow(project: ReturnType<typeof projectSummary> & { issues: number }, vocab: Vocabulary): string {
  return [
    project.short,
    statusValue(vocab, project.status).padEnd(12),
    `${String(project.issues).padStart(3)} issues`,
    clip(project.title, ROW_TITLE) + (project.archived ? ' (archived)' : ''),
    project.lead ? `— ${project.lead}` : '',
  ].join(' ').trimEnd() + summaryLine(project.summary)
}

/** Enough to answer "what happened" without returning the workspace's whole history. */
const DEFAULT_ACTIVITY = 50

/** Long enough to tell one project from another, short enough to list 14. */
const BLURB = 200

function projectSummary(project: Project, directory: Directory, vocab: Vocabulary) {
  const text = descriptionText(project.description, project.descriptionFormat)
  return {
    ref: project.addr,
    short: short(project.id),
    title: project.title,
    summary: project.summary,
    key: project.key,
    status: status(vocab, project.status),
    lead: who(directory, project.lead),
    archived: archiveSummary(directory, project.archive),
    folder: project.contentFolder,
    /*
      Present even when empty, and that is the point of including it at all.

      This listing omitted the field entirely, so a project with an 8000-word
      brief and one with no description at all came back identical — and on
      2026-08-29 that read as "empty", and an `edit-project --description`
      overwrote a real brief that nothing else could have shown first. A field
      that is absent from every answer cannot be checked before it is
      overwritten.

      Truncated rather than whole because the full text belongs in `show`: 14
      projects of that size is not a listing anybody wants back. Empty and
      truncated are both visibly different from a value, which is the property
      that was missing.
    */
    description: text.length > BLURB ? `${text.slice(0, BLURB)}…` : text,
    descriptionTruncated: text.length > BLURB || undefined,
    issues: undefined as number | undefined,
  }
}

/**
 * What an issue's ref slot prints before Ship has numbered it. The agent files
 * issues with no ref (PER-21) and Ship numbers them when somebody opens the
 * project, so the short id beside it is the name meanwhile — not the address,
 * which would be 110 characters where every other row has eight.
 */
const NO_REF = 'no ref yet'
const refOf = (issue: { ref?: string }) => issue.ref ?? NO_REF

function issueSummary(issue: Issue, directory: Directory, vocab: Vocabulary) {
  return {
    ref: refOf(issue),
    // Printed in every listing so the next command can name the issue by it
    // rather than by a ref that collides (SHI-4) or an address typed from
    // memory. Every resolver here accepts it back.
    short: short(issue.id),
    addr: issue.addr,
    title: issue.title,
    summary: issue.summary,
    status: status(vocab, issue.status),
    assignee: who(directory, issue.assignee),
    author: who(directory, issue.author),
    project: issue.projectAddr,
    archived: archiveSummary(directory, issue.archive),
    // When it reached the status it is in, so `/sweep` can find what closed weeks ago without a `show` each.
    statusChangedAt: issue.statusChangedAt !== undefined ? new Date(issue.statusChangedAt).toISOString() : undefined,
  }
}

/** An archive as printed: who, when, the resolution, and the parent it came with. */
function archiveSummary(directory: Directory, archive: Archive | undefined) {
  if (!archive) return undefined
  return {
    by: who(directory, archive.by),
    at: new Date(archive.at * 1000).toISOString(),
    resolution: archive.resolution,
    with: archive.with,
  }
}

/** Everyone named anywhere in what we are about to print, resolved in one call. */
async function directoryFor(
  context: AgentContext,
  pubkeys: (string | undefined)[],
): Promise<Directory> {
  return profilesOf(relayQuery(context), pubkeys)
}

/**
 * How much of the workspace this read could actually see.
 *
 * `loadAll` discovers from projects and widens into their Folders, so an issue
 * whose project record no longer resolves is unreachable — 13 of 27 on prod
 * when this was written (PEEK-154). The app has the same blind spot, so this is
 * not a defect being papered over; it is a limit being **stated**.
 *
 * Stating it matters more for an agent than for a person. Somebody browsing
 * sees projects and never forms the belief that they are looking at everything.
 * An agent asked "what is still open?" answers from whatever came back, and an
 * array carries no hint that a third of the data was never in scope. A number
 * is enough to stop a confident wrong summary; silence is not.
 *
 * Counted by asking the relay for issue events directly, with no `h` scoping —
 * the same unscoped query shape `resolveObject` already relies on. One extra
 * round trip per listing, which is cheap next to answering for half a workspace.
 */
/**
 * Archived projects removed — the default view of `ship projects`.
 *
 * Extracted so the rule can be tested without a relay. `archived` is folded
 * from a `kind:1851` change and is never a tag on the project record, which is
 * what made AGE-7 look like a discovery bug rather than a filter.
 */
export function archivedRemoved<T extends { archived?: boolean }>(projects: T[]): T[] {
  return projects.filter((project) => !project.archived)
}

async function coverage(
  context: AgentContext,
  reachable: Issue[],
): Promise<{ reachable: number; unreachable: number; total: number; note?: string }> {
  const events = await context.relay.queryAll([{ kinds: [KIND.ISSUE] }])

  const everything = new Set<string>()
  for (const event of events) {
    const d = event.tags.find((tag) => tag[0] === 'd')?.[1]
    if (d) everything.add(`${KIND.ISSUE}:${event.pubkey}:${d}`)
  }
  for (const issue of reachable) everything.add(issue.addr)

  const unreachable = everything.size - reachable.length
  return {
    reachable: reachable.length,
    unreachable,
    total: everything.size,
    note:
      unreachable > 0
        ? `${unreachable} issue(s) exist that discovery cannot reach, because the project they belong to no longer resolves. They are invisible to ship.estiva.app too. Do not describe this list as complete.`
        : undefined,
  }
}

/**
 * Find one object from whatever the caller typed.
 *
 * An agent is handed a reference by a person — "the auth issue", `LL-12`, a
 * pasted `naddr` — and demanding a canonical address would push that guesswork
 * onto whoever is least able to do it.
 *
 * **An ambiguous reference is an error, never a guess.** Silently picking the
 * first of two matching issues is how an agent confidently reports on the wrong
 * ticket, and that mistake is invisible afterwards.
 */
/*
  The matching rules, named so `show` can ask them of both kinds without
  restating either. `resolve.ts` exists because this rule was reimplemented once
  and quietly got it wrong; a descriptor written twice is the same hazard one
  step further down.
*/
const ISSUE_BY = {
  noun: 'issue',
  exact: (issue: Issue) => [issue.addr, issue.id, issue.ref],
  prefix: (issue: Issue) => [issue.id],
  text: (issue: Issue) => issue.title,
  // The short id is in the label so a refusal hands back something that
  // cannot collide the way the ref it lists beside does.
  label: (issue: Issue) => `${issue.ref ?? issue.addr} ${short(issue.id)} — ${issue.title}`,
  hint: 'Pass a ref, an address, the first 8 characters of its id, or part of a title.',
}

const PROJECT_BY = {
  noun: 'project',
  exact: (project: Project) => [project.addr, project.id, project.title],
  prefix: (project: Project) => [project.id],
  text: (project: Project) => project.title,
  label: (project: Project) => `${short(project.id)} — ${project.title}`,
  hint: 'Pass a project name or part of one, or the first 8 characters of its id.',
}

export function findIssue(issues: Issue[], reference: string): Issue {
  return resolveOne(issues, reference, ISSUE_BY)
}

/**
 * The same rule, for projects.
 *
 * This did not exist. The `--project` filter used `.find()` and silently
 * returned the first of however many matched, which on prod meant
 * `--project "Feedback"` answering about Ship's project when three contain the
 * word (PEEK-162). Exact still wins, so `"Peek: Feedback"` — what a person
 * actually types — keeps working.
 */
export function findProject(projects: Project[], reference: string): Project {
  return resolveOne(projects, reference, PROJECT_BY)
}

/** One field of one object, and what it is being changed from. */
export interface FieldEdit {
  field: string
  from: string
  value: string
  /** The human note that makes the activity feed readable. */
  note: string
  /** The content model `value` is in, when it is not marker text — tagged on the change (§13.4). */
  contentFormat?: string
  /** What was asked for, when `value` is the block document made from it. */
  text?: string
  /** For a block document: what happened to its blocks. */
  blocks?: { kept: number; edited: number; added: number; removed: string[] }
  /** Said back with the edit, when what was written is not quite what it should be. */
  warning?: string
}

function summaryEdit(current: { summary?: string }, text: string): FieldEdit {
  const value = summaryText(text)
  return { field: 'summary', from: current.summary ?? '', value, note: value ? 'Summary' : 'Clear summary', warning: summaryWarning(value) }
}

/** The project planner's original name for the shape above. */
export type ProjectEdit = FieldEdit

/**
 * A new description, given as text (AGE-8). One saved from Ship's editor is a
 * block document whose blocks comments anchor to (§13.6), so the text is
 * applied to it — every block it does not change keeps its id — and the change
 * is tagged `estiva-blocks-1`. A marker description becomes a block document
 * read from the text, tables included (RIC-20). `lib/agent/descriptions.ts`
 * has the matching rule.
 */
function descriptionEdit(subject: Pick<Project, 'description' | 'descriptionFormat'>, text: string, files?: PlacedFiles): FieldEdit {
  const { value, contentFormat, blocks } = describe(subject.description, subject.descriptionFormat, text, files)
  return {
    field: 'description',
    from: descriptionText(subject.description, subject.descriptionFormat),
    value,
    note: 'Description',
    ...(contentFormat ? { contentFormat, text, blocks } : {}),
  }
}

/** The people `--mention` names for a `--description`, resolved before anything is read; refused without one. */
async function descriptionMentions(context: AgentContext, args: ParsedArgs): Promise<string[]> {
  const mention = flagValue(args, 'mention')
  if (mention !== undefined && flagValue(args, 'description') === undefined) {
    throw new BadRequest('--mention goes with --description: it names the people the new text mentions. Nothing was published.')
  }
  return askedToMention(context, mention)
}

/**
 * The Adds a description edit writes beside itself (SPEC §11.8, WBD-9): one
 * per person the new text names and the one it replaces did not. Built before
 * anything is published, so a mention `--mention` does not name is refused
 * with nothing written.
 */
function addsFor(
  context: AgentContext,
  target: { addr: string; folder: string },
  subject: Pick<Project, 'description' | 'descriptionFormat'> | undefined,
  edits: readonly FieldEdit[],
  asked: readonly string[],
) {
  const edit = edits.find((candidate) => candidate.field === 'description')
  if (!edit) return NO_MENTIONS
  return mentionAdds(context.signer.pubkey, {
    file: target.addr,
    folder: target.folder,
    saved: fileText(edit.value, edit.contentFormat),
    editedFrom: subject ? fileText(subject.description, subject.descriptionFormat) : null,
    asked,
  })
}

/**
 * The pictures a `--description` places (`![alt](/abs/path/shot.png)` on a
 * line of its own), uploaded before anything is written (d273d4f5), and only
 * once the text has been read against the subject's description without
 * refusal. Undefined when there is no description to place them in.
 */
async function filesIn(
  context: AgentContext,
  args: ParsedArgs,
  subject: Pick<Project, 'description' | 'descriptionFormat'>,
): Promise<PlacedFiles | undefined> {
  const description = flagValue(args, 'description')
  if (description === undefined) return undefined
  return placeFiles(context, description, {
    previous: descriptionText(subject.description, subject.descriptionFormat),
    check: (placeholders) => describe(subject.description, subject.descriptionFormat, description, placeholders),
  })
}

/** One landed edit as a write reports it: the text asked for, and for a block document what became of its blocks. */
function appliedEdit(edit: FieldEdit, eventId?: string) {
  return {
    field: edit.field,
    from: edit.from,
    to: edit.text ?? edit.value,
    eventId,
    ...(edit.contentFormat ? { format: edit.contentFormat, blocks: edit.blocks } : {}),
    ...(edit.blocks?.removed.length
      ? { note: `${edit.blocks.removed.length} block(s) are no longer in the description; a comment anchored to one now shows as detached (§13.6).` }
      : {}),
    ...(edit.warning ? { note: edit.warning } : {}),
  }
}

/**
 * What an `edit-project` call is asking to change, validated.
 *
 * Pure and exported for the same reason `findProject` is: the decisions here —
 * which vocabulary a project status comes from, what `me` and `none` mean, and
 * refusing a call that changes nothing — are exactly the ones an agent gets
 * quietly wrong, and none of them needs a relay to be wrong.
 *
 * The field names and notes are the ones `apps/ship/views/project.ts` writes
 * from the web UI. Matching them is not cosmetic: the activity feed is the
 * change stream itself, so an edit made here and one made in the app have to
 * read as the same act rather than as two dialects.
 */
export function projectEdits(project: Project, args: ParsedArgs, self: string, vocab: Vocabulary, files?: PlacedFiles): FieldEdit[] {
  const edits: FieldEdit[] = []

  const title = flagValue(args, 'title')
  if (title !== undefined) {
    if (!title.trim()) throw new BadRequest('--title cannot be empty. A project nobody can name is a project nobody finds.')
    edits.push({ field: 'title', from: project.title, value: title, note: 'Rename' })
  }

  const description = flagValue(args, 'description')
  if (description !== undefined) edits.push(descriptionEdit(project, description, files))

  const summary = flagValue(args, 'summary')
  if (summary !== undefined) edits.push(summaryEdit(project, summary))

  const status = flagValue(args, 'status')
  if (status !== undefined) {
    /*
      Projects have their own vocabulary — planned/completed where an issue has
      todo/done — so this cannot share `set-status`'s check, and reusing it
      would validate the wrong words while looking correct.

      Checked for the reason that one is checked: an unknown value is
      *displayed* rather than swallowed (`lookupStatus`), so a typo would become
      a visible bogus status on a real project instead of an error.
    */
    const wanted = status.toLowerCase()
    if (!vocab.entries.some((entry) => entry.value === wanted)) {
      throw new BadRequest(
        `Unknown project status "${status}". Try: ${vocab.entries.map((entry) => entry.value).join(', ')}`,
      )
    }
    edits.push({ field: 'status', from: project.status, value: wanted, note: `Status → ${wanted}` })
  }

  const lead = flagValue(args, 'lead')
  if (lead !== undefined) {
    /*
      `me` is the signing identity. Anybody else is named by pubkey rather than
      by display name, for the reason `assign` gives: names are self-set
      (docs/untrusted-content.md), so leading by one would let a person redirect
      who work lands on by renaming themselves.

      `none` clears it, and clearing writes an empty string rather than deleting
      the change — an append-only stream has no undo, and "set to nobody" is a
      fact like any other. It is the shape `archived` already uses to unarchive.
    */
    const cleared = lead === 'none' || lead === ''
    const wanted = cleared ? '' : lead === 'me' ? self : lead
    if (!cleared && !/^[0-9a-f]{64}$/i.test(wanted)) {
      throw new BadRequest('--lead takes a 64-character hex pubkey, "me", or "none". Names are not unique.')
    }
    edits.push({
      field: 'lead',
      from: project.lead ?? '',
      value: wanted.toLowerCase(),
      note: cleared ? 'Unassign project' : 'Assign project',
    })
  }

  if (edits.length === 0) {
    throw new BadRequest('edit-project needs at least one of --title, --summary, --description, --status or --lead.')
  }

  return edits
}

/**
 * What an `edit-issue` call is asking to change, validated.
 *
 * The issue counterpart of `projectEdits`, and pure for the same reason. It
 * takes the project list because `--project` is the one field whose value is
 * another object: a move is a `project` change carrying the target's *address*,
 * so the reference has to resolve before anything is published.
 *
 * Field names and notes are the ones `web/src/pages/IssuePage.tsx` writes, so a
 * move made here and one made in the app are the same act in the activity feed.
 */
/**
 * The key `assign` should write, or the empty string that clears it.
 *
 * Pure and exported for the same reason the other planners are. The rule it
 * carries is the one that made this command lopsided: it could set an assignee
 * and never clear one, so an assignment was the only irreversible write in the
 * CLI — while `edit-project --lead none` had cleared a lead all along.
 */
/**
 * `--since`, as an epoch in milliseconds.
 *
 * Two forms, because the question has two shapes. "What happened while I was
 * away" wants a duration — `2d`, `12h`, `30m` — and "what happened on the day
 * that broke" wants a date. Both are pure to parse, so the ambiguity is settled
 * here rather than in whichever caller guessed.
 *
 * Rejected rather than defaulted when it is neither. A `--since` that silently
 * meant "everything" would answer a narrow question with the whole workspace,
 * and the answer would look the same as a correct one.
 */
export function parseSince(value: string, now: number): number {
  const duration = /^(\d+)\s*([dhm])$/i.exec(value.trim())
  if (duration) {
    const scale = { d: 86_400_000, h: 3_600_000, m: 60_000 }[duration[2].toLowerCase() as 'd' | 'h' | 'm']
    return now - Number(duration[1]) * scale
  }

  /*
    Shape-checked before `Date.parse`, not after. `Date.parse` is far more
    willing than it looks: `Date.parse('7')` is not NaN, it is the year 2001 —
    so `--since 7`, which anybody would write meaning seven days, would silently
    become a cutoff twenty-five years ago and return the entire workspace. The
    answer would be indistinguishable from a correct one.

    A bare `YYYY-MM-DD` is then UTC midnight, which is what "since the 29th"
    means closely enough; a full timestamp is taken as written.
  */
  const looksLikeADate = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value.trim())
  if (looksLikeADate) {
    const parsed = Date.parse(value.trim())
    if (!Number.isNaN(parsed)) return parsed
  }

  throw new BadRequest(
    `--since "${value}" is neither a duration nor a date. Try 2d, 12h, 30m, or 2026-08-29.`,
  )
}

export function assigneeFor(who: string, self: string): string {
  /*
    `none` and the empty string clear it, written as an empty value rather than
    by removing anything: an append-only stream has no undo, and "assigned to
    nobody" is a fact like any other. The same shape `archived` uses to
    unarchive and `--lead` uses to unassign a project.
  */
  if (who === 'none' || who === '') return ''

  /*
    `me` is the signing identity. Anybody else is named by public key rather
    than by display name, because display names are self-set
    (docs/untrusted-content.md) — assigning by one would let a person redirect
    who work lands on by renaming themselves. `ship people` exists so that
    refusal is survivable.
  */
  const wanted = who === 'me' ? self : who
  if (!/^[0-9a-f]{64}$/i.test(wanted)) {
    throw new BadRequest('assign takes a 64-character hex pubkey, "me", or "none". Names are not unique.')
  }
  return wanted.toLowerCase()
}

export function issueEdits(issue: Issue, args: ParsedArgs, projects: Project[], files?: PlacedFiles): FieldEdit[] {
  const edits: FieldEdit[] = []

  const title = flagValue(args, 'title')
  if (title !== undefined) {
    if (!title.trim()) throw new BadRequest('--title cannot be empty. An issue nobody can name is an issue nobody finds.')
    edits.push({ field: 'title', from: issue.title, value: title, note: 'Rename' })
  }

  const description = flagValue(args, 'description')
  if (description !== undefined) edits.push(descriptionEdit(issue, description, files))

  const summary = flagValue(args, 'summary')
  if (summary !== undefined) edits.push(summaryEdit(issue, summary))

  const project = flagValue(args, 'project')
  if (project !== undefined) {
    /*
      An issue's parent *can* change. It was believed it could not — that a
      mis-filed issue had to be archived and refiled — and both folds have read
      `fields.project?.value ?? parent` the whole time, with Ship shipping a
      move control on top of it.

      `none` detaches the issue from every project, which the app calls
      “No project” and lists as an inbox. Written as an empty value rather than
      by removing anything, the way every other cleared field is.
    */
    const detached = project === 'none' || project === ''
    const target = detached ? undefined : findProject(projects, project)
    edits.push({
      field: 'project',
      from: issue.projectAddr ?? '',
      value: target?.addr ?? '',
      note: `Move to ${target?.title ?? 'No project'}`,
    })
  }

  if (edits.length === 0) {
    throw new BadRequest('edit-issue needs at least one of --title, --summary, --description or --project.')
  }

  return edits
}

/**
 * `open` is not a status the relay knows; it is what people mean.
 *
 * Asked "what issues are open", Desktop picked `todo` from the vocabulary and
 * left out everything In Progress — defensible from the enum, and not what was
 * asked. The vocabulary is the wire format's, and "open work" is the question,
 * so the mapping belongs here rather than in whoever is asking.
 */
const OPEN_STATUSES = ['todo', 'in_progress'] as const
const STATUS_ALIASES: Record<string, readonly string[]> = { open: OPEN_STATUSES }

export function statusesFor(requested: string, vocab: Vocabulary): readonly string[] {
  const alias = STATUS_ALIASES[requested]
  if (alias) return alias
  if (vocab.entries.some((entry) => entry.value === requested)) return [requested]

  // Refused rather than returned empty: "no issues" and "you asked for a status
  // that does not exist" look identical in an empty array, and only one of them
  // means the work is done.
  throw new BadRequest(
    `Unknown status "${requested}". Try: ${vocab.entries.map((s) => s.value).join(', ')}, ` +
      `or "open" for ${OPEN_STATUSES.join(' and ')}.`,
  )
}

/**
 * Every write goes through here, and the shape is the safety property.
 *
 * `docs/untrusted-content.md` argues that a write must trace back to something
 * a person asked for and never to an instruction found in fetched content, and
 * that **tool shape is the strongest place to enforce it** — because it removes
 * the capability rather than governing its use.
 *
 * So: one object, one change, per call. There is no command here that takes a
 * filter, a status, or a search term and acts on whatever matches. "Close every
 * issue mentioning X" is not a thing this CLI can express, which means it is
 * not a thing an agent can be talked into, whatever the credential permits.
 *
 * That matters more than it looks on this deployment. Every channel is open
 * (PEEK-145), so Folder membership bounds nothing and `allowedKinds` is the
 * only other control — and the credential is now permitted every kind Ship
 * writes. Tool shape is the containment.
 *
 * Each write returns **what it actually did**, resolved and read back, so an
 * answer built on it names the object rather than paraphrasing the request.
 */
async function resolveIssueFor(context: AgentContext, reference: string) {
  const state = await loadWorkspace(context)
  const issue = findIssue(state.issues, reference)
  return { state, issue }
}

/** What a write to an issue acts on: its address, its author, and the Folder its changes go to. */
const issueTarget = (issue: Issue) => {
  if (!issue.folder) throw new BadRequest(`${issue.ref ?? issue.addr} names no Folder, so a change to it has nowhere to be published.`)
  return { addr: issue.addr, author: issue.author, folder: issue.folder }
}

/** The conversations read for some objects, and the edits to their messages. */
type Talk = Awaited<ReturnType<typeof conversationsFor>>

/** How much of the last comment a one-line echo quotes, and `status` returns. */
const LINE_QUOTE = 80
const LAST_COMMENT = 200

/** One line of text, whitespace collapsed, cut with an ellipsis past `max`. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Every comment about one object, oldest first, each body as it stands now. */
function commentsOn(talk: Talk, addr: string) {
  return (talk.byObject.get(addr) ?? [])
    .flatMap((thread) => [thread.root, ...thread.replies])
    .map((message) => ({
      id: message.id,
      author: message.author,
      at: message.ts ?? message.createdAt * 1000,
      body: edited(talk.edits, message).body,
    }))
    .sort((a, b) => a.at - b.at)
}

/**
 * The most recent pull request named on an issue, from its comments (newest
 * first) and then its description. A URL is the only place Ship keeps one —
 * there is no link field — and "where is it now" is usually answered by it.
 */
export function pullRequestOn(texts: string[]): string | undefined {
  for (const text of texts) {
    const found = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)
    if (found) return found[found.length - 1]
  }
  return undefined
}

export interface IssueStateInput {
  ref: string
  id: string
  status: string
  assignee?: string
  comments: { body: string }[]
}

/**
 * One line that answers "where is it now" — what a write echoes so nothing
 * has to be read back (MAK-1: 79 of 155 issue reads in a week were a `show`
 * after a write, because the write printed only an eventId).
 *
 *     MAK-1 · a57c26e3 · in_progress · Claude · 4 comments · last: "…"
 *
 * The status is the value, not the label, because it is what `set-status`
 * takes back. The short id is there so the next command can name the issue
 * without the ref, which collides.
 */
export function issueLine(issue: IssueStateInput, assignee: string | undefined): string {
  const count = issue.comments.length
  const last = issue.comments[count - 1]
  return [
    issue.ref,
    short(issue.id),
    issue.status,
    assignee ?? 'unassigned',
    `${count} comment${count === 1 ? '' : 's'}`,
    ...(last ? [`last: "${clip(last.body, LINE_QUOTE)}"`] : []),
  ].join(' · ')
}

/**
 * The state a write just produced, without reading it back.
 *
 * The relay accepted the event — `published` threw otherwise — so the state
 * is what was loaded plus that one change, and `after` is the change. A
 * second `loadAll` would show the same thing a few hundred milliseconds
 * later, at the cost of the round trip this exists to remove.
 */
async function stateAfter(
  context: AgentContext,
  state: Workspace,
  issue: Issue,
  after: { status?: string; assignee?: string | null; comment?: string; commentId?: string },
) {
  const assignee = after.assignee === undefined ? issue.assignee : after.assignee || undefined
  const [directory, talk] = await Promise.all([directoryFor(context, [assignee]), conversationsFor(context, state, [issue.addr])])
  const comments = commentsOn(talk, issue.addr)
  // The relay may already answer with the comment just written; count it once.
  if (after.comment !== undefined && !comments.some((comment) => comment.id === after.commentId)) {
    comments.push({ id: after.commentId ?? '', author: context.signer.pubkey, at: Date.now(), body: after.comment })
  }
  return issueLine(
    {
      ref: refOf(issue),
      id: issue.id,
      status: after.status ?? issue.status,
      assignee,
      comments,
    },
    who(directory, assignee),
  )
}

/**
 * `Relay.publish` reports `ok: false` for a rejection that arrived as HTTP 200 —
 * the relay answers `200 {"accepted":false}` and the status code is not the
 * authority. Every write funnels through here so no caller can forget, since
 * the failure mode is an agent reporting an issue closed that the relay dropped.
 */
/**
 * Every Folder this credential can see, and whether each has state — the read
 * Ship's sidebar and its New project dialog make (`readFolders`), so the two
 * agree on what a team is and on `hasState`, which a `kind:1852` must never
 * guess: an `add` to a Folder without state emits state listing only that one
 * file, and everything already in it disappears.
 */
function readFolders(context: AgentContext): Promise<FolderSummary[]> {
  return listFolders(createLoadQuery(relayQuery(context)))
}

/**
 * A team by name or Folder id (FOL-47): the Folders with state that no other
 * Folder lists — `topLevelFolders` in Ship and Peek, the five a person sees.
 */
async function resolveTeam(context: AgentContext, reference: string): Promise<FolderSummary> {
  return resolveTeamIn(topLevelFolders(await readFolders(context)), reference)
}

/** {@link resolveTeam} over a listing already read, for a caller that needs the listing too. */
function resolveTeamIn(teams: FolderSummary[], reference: string): FolderSummary {
  return resolveOne(teams, reference, {
    noun: 'team',
    exact: (team) => [team.id],
    text: (team) => team.name ?? '',
    label: (team) => `${team.name ?? 'unnamed'} (${team.id.slice(0, 8)}…)`,
    hint: 'Pass a team name or its Folder id.',
  })
}

function published<T extends { ok: boolean; reason?: string; duplicate?: boolean }>(
  result: T,
  what: string,
): void {
  if (!result.ok) throw new BadRequest(`The relay refused ${what}: ${result.reason ?? 'no reason given'}`)
}

interface PublishOutcome {
  ok: boolean
  reason?: string
  eventId?: string
}

/**
 * One of Ship's declared actions on one object, as Ship's manifest says to
 * write it — built by interop's runtime (`buildActionEvents`), signed as the
 * agent, published in order (PER-21). Nothing here names a kind or a tag: the
 * manifest the object's author resolves to does.
 *
 * A refused first event — the record, the change, the deletion — stops there.
 * After it, every listing event is still tried, as Ship does: one Folder
 * refusing its remove is no reason to leave the deleted project in the others.
 * The answers come back in order so a caller can report a listing that failed
 * after its record landed.
 *
 * **`signs` is the command's own, and nothing outside it is signed.** A manifest
 * is anybody's event: an author's recommendation, or else the newest one
 * claiming the kind, picks it. One that declared `comment` as a `kind:5` would
 * otherwise have the agent delete its own issue when asked to comment on it.
 * So the first event must be the command's first kind and the rest must be
 * among its kinds, or nothing is published.
 */
async function act(
  context: AgentContext,
  workspace: Workspace,
  target: { addr: string; author: string; folder: string },
  actionId: string,
  value: string | Record<string, string>,
  signs: readonly number[],
  extra: {
    note?: string
    newId?: string
    folderHasState?: boolean
    listedIn?: { id: string; hasState: boolean }[]
    /** NIP-09's optional reason, the deletion's own `content`. */
    reason?: string
    /** The manifest to act with, when the target is not one of its objects (a creation on a Folder record). */
    manifest?: ResolvedManifest
    /** The value's content model, when it is not marker text — only one the action declares is accepted. */
    contentFormat?: string
    /** Files already on the relay, named by the first event's `imeta` — a comment's attachments, as every comment box sends them. */
    files?: readonly Imeta[]
  } = {},
): Promise<PublishOutcome[]> {
  const resolved = extra.manifest ?? workspace.manifestFor(target.addr)
  if (!resolved) throw new BadRequest(`No app's manifest claims ${target.addr}, so there is no declared way to change it.`)
  const [kind] = target.addr.split(':')
  const built = buildActionEvents({
    manifest: resolved.manifest,
    kind: Number(kind),
    address: target.addr,
    objectAuthor: target.author,
    folder: target.folder,
    actionId,
    value,
    note: extra.note,
    newId: extra.newId,
    folderHasState: extra.folderHasState,
    listedIn: extra.listedIn,
    contentFormat: extra.contentFormat,
    // What a comment's body links, as Ship's comment box tags it (§13.1, PEEKM-7).
    linkTags: actionId === 'comment' && typeof value === 'string' ? await commentLinkTags(context, value, { file: target.addr }) : undefined,
    pubkey: context.signer.pubkey,
    createdAtMs: Date.now(),
  })
  if (typeof built === 'string') throw new BadRequest(built)
  const stray = built.find((event, i) => (i === 0 ? event.kind !== signs[0] : !signs.includes(event.kind)))
  if (stray) {
    throw new BadRequest(
      `The manifest read for ${target.addr} declares "${actionId}" as a kind:${stray.kind}, which this command does not write (it writes ${signs.join(', ')}). Nothing was published.`,
    )
  }
  const outcomes: PublishOutcome[] = []
  for (const [i, unsigned] of built.entries()) {
    const withReason = i === 0 && extra.reason && unsigned.kind === KIND_DELETION ? { ...unsigned, content: extra.reason } : unsigned
    const event = i === 0 && extra.files?.length ? { ...withReason, tags: [...withReason.tags, ...extra.files.map(imetaTag)] } : withReason
    const signed = await context.signer.sign(event)
    const result = await context.relay.publish(signed)
    outcomes.push({ ok: result.ok, reason: result.reason, eventId: result.eventId ?? signed.id })
    if (!result.ok && i === 0) break
  }
  return outcomes
}

async function publishUnsigned(context: AgentContext, unsigned: Parameters<AgentContext['signer']['sign']>[0]): Promise<PublishOutcome> {
  const signed = await context.signer.sign(unsigned)
  const result = await context.relay.publish(signed)
  return { ok: result.ok, reason: result.reason, eventId: result.eventId ?? signed.id }
}

/**
 * What each source Folder lists, read at the moment of a move, archived files
 * included: what is archived beneath the file moves with it (SHI-37). Ship's
 * `writes.moveProject` (MAN-17): no profiles, and `unread` when any one cannot
 * be read, because a move planned without a listing leaves whatever is beneath
 * the file behind.
 */
async function readListings(context: AgentContext, sources: readonly FolderRef[]): Promise<Map<string, MovableFile[]> | { unread: string }> {
  const cache = createProjectionCache()
  const query = createLoadQuery(relayQuery(context))
  const read = await Promise.all(
    sources.map((folder) =>
      resolveFolderContents(folder.id, query, noPeople, cache, { includeArchived: true }).then(
        (content) => content.files as MovableFile[],
        (error: unknown) => ({ unread: error instanceof Error ? error.message : String(error) }),
      ),
    ),
  )
  const failed = read.find((files): files is { unread: string } => !Array.isArray(files))
  if (failed) return failed
  return new Map(sources.map((folder, i) => [folder.id, read[i] as MovableFile[]]))
}

const noPeople = async () => ({})

/**
 * Ship's "Move to Folder…" (FOL-7), as interop's `planMoveFromFolders` plans
 * it (SPEC §3.3), the planner Ship and Peek move by too: one `kind:1852 add` to
 * the new Folder naming the file and everything any source lists beneath it,
 * then a `remove` from each one that lists it now. The add goes first and
 * lands whole or not at all — refused, nothing is removed and the files are
 * where they were (SHI-37). Refused before anything is sent when either side
 * has no state (a command against it empties it) or the target is private (a
 * listing never changes who can read a file).
 */
export async function moveFile(
  context: AgentContext,
  args: {
    address: string
    /** The Folders that list it now, with `addresses` — the file leaves one that names it even when its row did not resolve. */
    from: readonly FolderRef[]
    to: FolderRef
    /** Each source Folder's files, by Folder id ({@link readListings}). A source with none moves the file alone. */
    listings: ReadonlyMap<string, readonly MovableFile[]>
  },
): Promise<{ refused?: MoveRefusal; added?: PublishOutcome; moved: string[]; removed: { folder: string; result: PublishOutcome }[] }> {
  const plan = planMoveFromFolders(context.signer.pubkey, Date.now(), {
    file: { ref: args.address, address: args.address },
    from: args.from,
    to: args.to,
    listings: args.listings,
  })
  if (!plan.ok) return { refused: plan.reason, moved: [], removed: [] }
  if (!plan.add) return { moved: [], removed: [] }
  const added = await publishUnsigned(context, plan.add)
  if (!added.ok) return { added, moved: [], removed: [] }
  const removed: { folder: string; result: PublishOutcome }[] = []
  for (const { folder, event } of plan.removes) removed.push({ folder, result: await publishUnsigned(context, event) })
  return { added, moved: plan.moved, removed }
}

/** A change to one field, as Ship's own UI writes it — the action that declares the field. */
async function setField(
  context: AgentContext,
  workspace: Workspace,
  target: { addr: string; author: string; folder: string },
  field: string,
  value: string,
  note: string,
  contentFormat?: string,
): Promise<PublishOutcome> {
  const resolved = workspace.manifestFor(target.addr)
  const kind = target.addr.split(':')[0]
  const action = (resolved?.manifest.actions ?? []).find(
    (candidate) =>
      candidate.emits?.field === field &&
      (Array.isArray(candidate.appliesTo) ? candidate.appliesTo.includes(kind) : candidate.appliesTo === kind),
  )
  if (!action) throw new BadRequest(`Ship's manifest declares no action that sets ${field} on this object.`)
  const [outcome] = await act(context, workspace, target, action.id, value, [KIND_CHANGE], { note, contentFormat })
  return outcome
}

/**
 * The activity and conversation on one object, rendered the way `show` renders
 * them for an issue.
 *
 * Shared rather than written twice, because the two would drift and the drift
 * would be invisible: a project's history rendering a pubkey where an issue's
 * renders a name is exactly the half-fixed line PEEK-165 was, and nothing fails
 * when it happens.
 */
async function timelineFor(
  context: AgentContext,
  state: Workspace,
  addr: string,
  extraPubkeys: (string | undefined)[],
) {
  const talk = await conversationsFor(context, state, [addr])
  const conversations = talk.byObject.get(addr) ?? []
  const history = state.activity.filter((change) => change.target === addr)

  const directory = await directoryFor(context, [
    ...extraPubkeys,
    ...history.map((change) => change.author),
    // The values too, not just the actors — a `lead` or `assignee` change names
    // somebody in `value`, and asking for the actors alone leaves half the line
    // unresolved.
    ...history.map((change) => change.value),
    ...conversations.flatMap((thread) => [
      thread.root.author,
      ...thread.replies.map((reply) => reply.author),
    ]),
  ])

  return {
    directory,
    history: history.map((change) => ({
      field: change.field,
      // Resolved by shape rather than by field name: any 64-character hex value
      // is a key somebody may have a name for, and matching on the field name
      // would silently miss the next field that carries one.
      value: resolvePubkeys(directory, change.value),
      by: who(directory, change.author),
      // `ts` when the change carried one, `created_at` otherwise — the same
      // precedence the fold uses, because second-resolution timestamps tie for
      // changes made in one burst.
      at: new Date(change.ts ?? change.createdAt * 1000).toISOString(),
    })),
    conversation: conversations.map((thread) => ({
      id: thread.id,
      messages: [thread.root, ...thread.replies].map((message) => ({
        /*
          The id is what `edit-comment --message` takes. Without it printed
          here the flag would be unsatisfiable from inside the tool — the same
          shape of gap AGE-13 fixed for `reply --to` and AGE-15 for assignees.
        */
        id: message.id,
        by: who(directory, message.author),
        at: new Date(message.ts ?? message.createdAt * 1000).toISOString(),
        ...edited(talk.edits, message),
      })),
    })),
  }
}

/**
 * One project, folded.
 *
 * The description is returned whole here — this is the read that AGE-11 was
 * filed for, and a truncated one would not let anybody check a description
 * before replacing it.
 */
/**
 * The workspace with the Folder half of the archive cascade applied — the
 * Folder listing read beside the workspace scan, not after it, through one
 * load's query so a read both make is asked once (APP-2).
 */
async function loadWithFolders(context: AgentContext) {
  const query = createLoadQuery(relayQuery(context))
  const [state, folders] = await Promise.all([loadWorkspace(context, query), listFolders(query)])
  cascadeArchives(state, folders)
  return { state, folders }
}

const FOLDER_BY = {
  noun: 'Folder',
  exact: (folder: FolderSummary) => [folder.id, folder.channel, folder.name],
  prefix: (folder: FolderSummary) => [folder.id],
  text: (folder: FolderSummary) => folder.name ?? '',
  label: (folder: FolderSummary) => `${short(folder.id)} — ${folder.name ?? 'Untitled Folder'}`,
  hint: 'Pass a Folder name or part of one, or the first 8 characters of its id.',
}

type Archivable =
  | { kind: 'issue'; file: Issue }
  | { kind: 'project'; file: Project }
  | { kind: 'Folder'; file: FolderSummary }

/**
 * Which file an `archive` reference names, across the three kinds a person can
 * archive in Ship — asked of each, then decided, for the reason `show` gives:
 * a reference naming two kinds is a question, not whichever was tried first.
 * A Folder is matched among the ones with state (what Ship and Peek draw), by
 * name, id or channel address.
 */
export function archivable(state: Pick<Workspace, 'issues' | 'projects'>, folders: FolderSummary[], reference: string, projectsOnly: boolean): Archivable {
  const attempts = [
    ...(projectsOnly ? [] : [{ kind: 'issue' as const, result: resolveMaybe(state.issues, reference, ISSUE_BY) }]),
    { kind: 'project' as const, result: resolveMaybe(state.projects, reference, PROJECT_BY) },
    ...(projectsOnly
      ? []
      : [{
          kind: 'Folder' as const,
          // Only Folders with state: a record channel is nobody's Folder, and often shares its record's uuid.
          result: resolveMaybe(folders.filter((folder) => folder.hasState), reference, FOLDER_BY),
        }]),
  ]
  const found = attempts.flatMap(({ kind, result }) => ('found' in result ? [{ kind, file: result.found } as Archivable] : []))
  if (found.length > 1) {
    throw new BadRequest(
      `"${reference}" names more than one file:\n` +
        found.map(({ kind, file }) => `  ${kind.padEnd(7)} ${'title' in file ? file.title : file.name ?? file.id}`).join('\n') +
        '\nPass an address or a short id to say which.',
    )
  }
  /*
    One kind found while another is ambiguous is still a question: this is a
    write, and a second issue filed with a similar title must not turn a
    reference that meant an issue into one that archives a whole project. Only
    an exact address or id overrides it, because that cannot mean anything else.
  */
  const ambiguity = attempts.find(({ result }) => 'ambiguous' in result)?.result as { ambiguous: string } | undefined
  if (found.length === 1) {
    const file = found[0].file
    const exact = 'addr' in file ? [file.addr, file.id] : [file.id, file.channel]
    if (!ambiguity || exact.includes(reference.trim())) return found[0]
  }
  if (ambiguity) throw new BadRequest(ambiguity.ambiguous)
  throw new BadRequest(`No ${projectsOnly ? 'project' : 'issue, project or Folder'} matches "${reference}".`)
}

/**
 * Archive one file, or bring it back — FOL-46, written as Ship writes it: a
 * `kind:1851` setting `archived` on the file's address, the resolution as the
 * change's note, which Ship shows first when the file is opened. A project or
 * an issue goes through its manifest's action; a Folder through interop's
 * `planArchiveFolder`, into its own `h`.
 *
 * Nothing is written to what is beneath it. An issue is archived with its
 * project, and a project with its Folder, when they are read (`cascadeArchives`)
 * — so unarchiving the parent restores exactly what was there.
 *
 * One file per call, like every write here (`docs/untrusted-content.md`).
 */
async function archiveFile(context: AgentContext, args: ParsedArgs, command: 'archive' | 'archive-project') {
  const reference = args.positional[0]
  if (!reference) throw new BadRequest(`${command} needs a reference — a project, an issue or a Folder.`)
  const archived = !args.flags.unarchive
  const resolution = args.flags.resolution
  if (resolution === true) throw new BadRequest('--resolution takes the text to show, in quotes.')
  if (!archived && resolution !== undefined) throw new BadRequest('--resolution goes with an archive; bringing a file back takes none.')

  const { state, folders } = await loadWithFolders(context)
  const target = archivable(state, folders, reference, command === 'archive-project')

  const name = target.kind === 'Folder' ? target.file.name ?? target.file.id : target.file.title
  const addr = target.kind === 'Folder' ? target.file.channel : target.file.addr
  const own = target.kind === 'Folder' ? target.file.archived && !target.file.archived.with : target.file.ownArchive
  const parent = target.kind === 'Folder' ? undefined : target.file.archive?.with
  // The parent by the name a person knows it by: its project's title, or its Folder's name.
  const parentProject = parent ? state.projects.find((project) => project.addr === parent) : undefined
  const parentFolder = parent ? folders.find((folder) => folder.channel === parent) : undefined
  const inherited = parentProject
    ? `the project “${parentProject.title}”`
    : parentFolder
      ? `the Folder “${parentFolder.name ?? parentFolder.id}”`
      : parent
  const unchanged = { kind: target.kind, title: name, addr }

  /*
    Said rather than silently done. The reverse is what somebody needs the
    moment they realise they archived the wrong file, and the listings hide
    the result, so the file they look for has just gone from where they look.
  */
  if (archived && own) {
    return { unchanged, note: `That ${target.kind} is already archived. Pass --unarchive to bring it back.` }
  }
  if (!archived && !own) {
    return {
      unchanged,
      note: inherited
        ? `That ${target.kind} is not archived itself; it is hidden with ${inherited}, and is listed again only when that is unarchived. Nothing was published.`
        : `That ${target.kind} is not archived, so there is nothing to bring back.`,
    }
  }

  let result: PublishOutcome
  let hides: string
  if (target.kind === 'Folder') {
    const folder = target.file
    if (!folder.channel) throw new BadRequest(`The Folder “${name}” has no channel address on the relay, so there is nothing to set archived on.`)
    // The relay accepts this from any member; readers count it only from an owner or admin (SPEC §3.2), so from anybody else it would be accepted and ignored.
    if (folder.admins && !folder.admins.includes(context.signer.pubkey)) {
      throw new BadRequest(`Only the owners and admins of “${name}” can archive it — readers ignore an archive from anybody else, and this identity is neither. Nothing was published.`)
    }
    const [change] = planArchiveFolder(context.signer.pubkey, Date.now(), {
      folder: folder.id,
      channel: folder.channel,
      archived,
      ...(typeof resolution === 'string' ? { resolution } : {}),
    })
    result = await publishUnsigned(context, change)
    const projects = state.projects.filter((project) => folder.addresses?.includes(project.addr)).length
    hides = `the Folder, and what it alone lists (it lists ${projects} project(s))`
  } else {
    // The record's own Folder, for the reason `edit-project` gives: a change published elsewhere is accepted and then unseen.
    const folder = target.kind === 'project' ? target.file.contentFolder : target.file.folder
    if (!folder) throw new BadRequest(`“${name}” names no Folder, so a change to it has nowhere to be published.`)
    const action = target.kind === 'project' ? 'archive-project' : 'archive-issue'
    ;[result] = await act(context, state, { addr: target.file.addr, author: target.file.author, folder }, action, archived ? 'true' : '', [KIND_CHANGE], {
      note: typeof resolution === 'string' ? resolution : '',
    })
    if (target.kind === 'project') {
      const project = target.file
      const issues = state.issues.filter((issue) => issue.projectAddr === project.addr).length
      hides = `the project and its ${issues} issue(s)`
    } else {
      hides = 'the issue; its project stays where it is'
    }
  }
  published(result, `${archived ? 'archiving' : 'unarchiving'} “${name}”`)

  return {
    changed: unchanged,
    archived,
    resolution: typeof resolution === 'string' ? resolution : undefined,
    eventId: result.eventId,
    note: archived
      ? `Hidden from Ship's lists and from \`ship issues\` / \`ship projects\` unless --archived: ${hides}. A link still opens it, with the resolution first. Reverse with --unarchive; nothing is deleted.`
      : 'Back in the lists, with what was hidden with it.',
  }
}

/**
 * How each link in a description draws, beside the text `show` prints (WBD-9):
 * the text gives a card no spelling, so it prints as a row does.
 * Titled from the workspace already read.
 */
function descriptionLinks(context: AgentContext, state: Workspace, subject: Pick<Project, 'description' | 'descriptionFormat'>) {
  const titles = new Map<string, string>([...state.issues, ...state.projects].map((file) => [file.addr, file.title]))
  return printedLinks(context, subject.description, subject.descriptionFormat, (value) => titles.get(value))
}

async function showProject(context: AgentContext, state: Workspace, project: Project) {
  const issues = state.issues.filter((issue) => issue.projectAddr === project.addr)
  const { directory, history, conversation } = await timelineFor(context, state, project.addr, [
    project.author,
    project.lead,
    project.archive?.by,
    ...issues.map((issue) => issue.assignee),
    ...issues.map((issue) => issue.author),
  ])

  return {
    kind: 'project' as const,
    addr: project.addr,
    title: project.title,
    summary: project.summary,
    key: project.key,
    status: status(state.vocab.project, project.status),
    lead: who(directory, project.lead),
    author: who(directory, project.author),
    archived: archiveSummary(directory, project.archive),
    description: descriptionText(project.description, project.descriptionFormat),
    descriptionFormat: formatName(project.descriptionFormat),
    links: await descriptionLinks(context, state, project),
    createdAt: new Date(project.createdAt * 1000).toISOString(),
    folder: project.contentFolder,
    issues: issues.map((issue) => issueSummary(issue, directory, state.vocab.issue)),
    history,
    conversation,
  }
}


/** What one key has been seen doing, which is the only evidence this list has. */
export interface Participant {
  pubkey: string
  filed: number
  assigned: number
  leads: number
  /** Changes and messages authored — acting without necessarily owning anything. */
  acted: number
}

/**
 * Every key the workspace has seen, and what it was seen doing.
 *
 * Pure, and exported so the counting is testable without a relay. It is the
 * inverse of the lookup `show` already does: that turns keys into names for
 * display, this lists the keys so somebody can find the one they need.
 *
 * **The set is everyone who has touched a Ship object, plus every relay member**
 * (`members`). Somebody you want to assign so they take a look may never have
 * done anything here yet (Miky, 2026-10-02, PER-21); they come last, with
 * nothing counted.
 */
export function participants(
  state: Pick<Workspace, 'issues' | 'projects' | 'activity'> & { conversations: readonly Conversation[] },
  members: readonly string[] = [],
): Participant[] {
  const seen = new Map<string, Participant>()
  const touch = (key: string | undefined, field: keyof Omit<Participant, 'pubkey'>) => {
    if (!key || !/^[0-9a-f]{64}$/i.test(key)) return
    const at = key.toLowerCase()
    const entry = seen.get(at) ?? { pubkey: at, filed: 0, assigned: 0, leads: 0, acted: 0 }
    entry[field] += 1
    seen.set(at, entry)
  }

  for (const issue of state.issues) {
    touch(issue.author, 'filed')
    touch(issue.assignee, 'assigned')
  }
  for (const project of state.projects) {
    touch(project.author, 'acted')
    touch(project.lead, 'leads')
  }
  for (const change of state.activity) {
    touch(change.author, 'acted')
    /*
      A change's *value* can be a key — `assignee` and `lead` both are — so a
      person who has only ever been assigned something by somebody else still
      appears. Matched by shape rather than by field name, the same rule `show`
      uses, so the next field carrying a key is not silently missed.
    */
    touch(change.value, 'assigned')
  }
  for (const conversation of state.conversations) {
    touch(conversation.root.author, 'acted')
    for (const reply of conversation.replies) touch(reply.author, 'acted')
  }
  for (const key of members) {
    if (!/^[0-9a-f]{64}$/i.test(key)) continue
    const at = key.toLowerCase()
    if (!seen.has(at)) seen.set(at, { pubkey: at, filed: 0, assigned: 0, leads: 0, acted: 0 })
  }

  // Busiest first: the person somebody is looking for is usually the person
  // doing things, and a stable order beats map insertion order.
  return [...seen.values()].sort(
    (a, b) =>
      b.filed + b.assigned + b.leads + b.acted - (a.filed + a.assigned + a.leads + a.acted) ||
      a.pubkey.localeCompare(b.pubkey),
  )
}

/**
 * The vocabulary a listing was read with, carried to its `lines` beside the
 * result. A symbol key, so `--json` — which is `JSON.stringify` of the same
 * object — prints exactly what it printed before the vocabulary came from the
 * manifest.
 */
const VOCAB = Symbol('vocabulary')
type WithVocab = { [VOCAB]?: Vocabulary }
const noVocab: Vocabulary = { entries: [], fallback: '' }

export const shipApp: AgentApp = {
  name: 'ship',
  summary: 'projects and issues in Estiva Ship',
  /*
    The cheapest read that proves relay access, for `connectionStatus`.

    One project, because a workspace always has at least the ability to be asked
    for one and the answer is tiny. An empty result is still a success: it
    proves the identity was admitted and the query was served, which is the
    thing being tested. "Admitted but empty" and "refused" are exactly the two
    states a connection check exists to tell apart, so this must not treat a
    count of zero as a failure.
  */
  probe: [{ kinds: [KIND.PROJECT], limit: 1 }],
  commands: [
    {
      name: 'projects',
      summary: 'every project, with status and lead',
      usage: 'projects [--archived] [--json]',
      lines(result: { projects: Parameters<typeof projectRow>[0][]; hidden: { note?: string } } & WithVocab) {
        // The hidden-archived note survives the text form: a listing that
        // drops it is exactly the "every project" claim the note exists to stop.
        const vocab = result[VOCAB] ?? noVocab
        return [...result.projects.map((project) => projectRow(project, vocab)), ...(result.hidden.note ? [result.hidden.note] : [])]
      },
      async run(context, args) {
        // A project in an archived Folder is hidden with it, as Ship hides it.
        const { state } = await loadWithFolders(context)
        const directory = await directoryFor(context, state.projects.flatMap((p) => [p.lead, p.archive?.by]))

        const archived = state.projects.filter((project) => project.archived)
        const wanted = args.flags.archived ? state.projects : archivedRemoved(state.projects)

        return {
          [VOCAB]: state.vocab.project,
          projects: wanted.map((project) => ({
            ...projectSummary(project, directory, state.vocab.project),
            // Counted here rather than in the summary so the shape stays the same
            // whether or not issues were loaded alongside.
            issues: state.issues.filter((issue) => issue.projectAddr === project.addr).length,
          })),
          /*
            The same argument `coverage` makes for issues, for the same reason.

            This listing hides archived projects, and an array carries no hint
            that it did. A person browsing sees a list and never forms the
            belief that it is everything; an agent asked "what projects are
            there?" answers from whatever came back. AGE-7 is that failure
            happening: `ship projects` returned 11 and then 9 an hour later,
            because two tracks finished and were archived in between, and the
            list said nothing.

            It cost a filed ticket and a diagnosis to find out nothing was
            wrong. The trap that made it expensive is worth stating: a project
            is archived by a `kind:1851` change, not by a tag on its record —
            so reading the record event, which is the obvious check, shows no
            `archived` tag on a project that is archived.
          */
          hidden: {
            archived: args.flags.archived ? 0 : archived.length,
            note:
              !args.flags.archived && archived.length > 0
                ? `${archived.length} archived project(s) are not listed — pass --archived to include them. Do not describe this list as every project.`
                : undefined,
          },
        }
      },
    },
    {
      name: 'issues',
      summary: 'issues, newest first',
      usage: 'issues [--project <ref>] [--status <value>] [--archived] [--json]',
      lines(
        result: { issues: Parameters<typeof issueRow>[0][]; hidden: { note?: string }; coverage: { unreachable: number; note?: string } } & WithVocab,
      ) {
        const vocab = result[VOCAB] ?? noVocab
        return [
          ...result.issues.map((issue) => issueRow(issue, vocab)),
          `${result.issues.length} listed`,
          ...(result.hidden.note ? [result.hidden.note] : []),
          ...(result.coverage.note ? [result.coverage.note] : []),
        ]
      },
      async run(context, args) {
        // An issue of a project in an archived Folder is hidden with both, as Ship hides it.
        const { state } = await loadWithFolders(context)
        const wantedProject = flagValue(args, 'project')
        const wantedStatus = flagValue(args, 'status')?.toLowerCase()

        const wantedStatuses = wantedStatus ? statusesFor(wantedStatus, state.vocab.issue) : null

        let issues = state.issues
        if (wantedProject) {
          const project = findProject(state.projects, wantedProject)
          issues = issues.filter((issue) => issue.projectAddr === project.addr)
        }
        if (wantedStatuses) {
          issues = issues.filter((issue) =>
            wantedStatuses.includes(issue.status),
          )
        }
        // After the other filters, so the count says how many of *these* were left out.
        const archived = issues.filter((issue) => issue.archived).length
        if (!args.flags.archived) issues = issues.filter((issue) => !issue.archived)

        const directory = await directoryFor(
          context,
          issues.flatMap((issue) => [issue.assignee, issue.author, issue.archive?.by]),
        )

        return {
          [VOCAB]: state.vocab.issue,
          issues: issues
            .slice()
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((issue) => issueSummary(issue, directory, state.vocab.issue)),
          // The same honesty `projects` owes (AGE-7): a shorter list is not a smaller workspace.
          hidden: {
            archived: args.flags.archived ? 0 : archived,
            note:
              !args.flags.archived && archived > 0
                ? `${archived} archived issue(s) are not listed — pass --archived to include them.`
                : undefined,
          },
          /*
            Reported against the whole workspace rather than the filtered slice,
            deliberately. An unreachable issue has no project and no status this
            read can see, so it cannot be attributed to a filter — and quietly
            dropping the count when `--project` is passed would hide the gap in
            exactly the narrow queries somebody trusts most.
          */
          coverage: await coverage(context, state.issues),
        }
      },
    },
    {
      name: 'activity',
      summary: 'what changed, newest first',
      usage: 'activity [--since <2d|2026-08-29>] [--project <ref>] [--by <pubkey|me>] [--limit <n>]',
      async run(context, args) {
        const state = await loadWorkspace(context)

        const since = flagValue(args, 'since')
        const cutoff = since ? parseSince(since, Date.now()) : undefined
        const limit = Number(flagValue(args, 'limit') ?? DEFAULT_ACTIVITY)
        if (!Number.isFinite(limit) || limit < 1) throw new BadRequest('--limit must be a positive number.')

        /*
          What each change was *to*. A change carries only an address, and an
          address is not something anybody can read — an activity line naming
          `30851:b38fd268…:53182d00…` says nothing that a person could act on.
          Resolved against what this read already folded, so no extra query.
        */
        const labels = new Map<string, { label: string; project?: string }>()
        for (const project of state.projects) labels.set(project.addr, { label: project.title })
        for (const issue of state.issues) {
          labels.set(issue.addr, {
            label: `${issue.ref ? `${issue.ref} — ` : ''}${issue.title}`,
            project: issue.projectAddr,
          })
        }

        const wantedProject = flagValue(args, 'project')
        const project = wantedProject ? findProject(state.projects, wantedProject) : undefined

        const by = flagValue(args, 'by')
        const author = by === 'me' ? context.signer.pubkey : by

        let changes = state.activity
        if (cutoff !== undefined) {
          changes = changes.filter((change) => (change.ts ?? change.createdAt * 1000) >= cutoff)
        }
        if (project) {
          // The project's own record, and everything filed under it — "what
          // happened on this project" means both, and either alone is a
          // half-answer.
          changes = changes.filter(
            (change) =>
              change.target === project.addr || labels.get(change.target)?.project === project.addr,
          )
        }
        if (author) {
          if (!/^[0-9a-f]{64}$/i.test(author)) {
            throw new BadRequest('--by takes a 64-character hex pubkey, or "me". Try `ship people`.')
          }
          changes = changes.filter((change) => change.author.toLowerCase() === author.toLowerCase())
        }

        /*
          Newest first, which is the opposite of the order the fold replays. The
          fold needs oldest-first to be correct; a person asking what happened
          wants the last thing first, and reversing here leaves the fold's own
          ordering untouched.
        */
        const matched = changes.length
        const shown = changes.slice(-limit).reverse()

        const directory = await directoryFor(context, [
          ...shown.map((change) => change.author),
          ...shown.map((change) => change.value),
        ])

        return {
          activity: shown.map((change) => ({
            at: new Date(change.ts ?? change.createdAt * 1000).toISOString(),
            by: who(directory, change.author),
            field: change.field,
            // Resolved by shape, the same rule `show` uses: any 64-character
            // hex value is a key somebody may have a name for.
            value: resolvePubkeys(directory, change.value),
            /*
              The human note, which is what makes a feed readable rather than a
              list of field names. Empty for changes written before the note was
              being set — `assign` and `set-status` omitted it until AGE-16, so
              older lines are genuinely blank rather than rendered wrong.
            */
            note: change.note || undefined,
            on: labels.get(change.target)?.label ?? change.target,
            target: change.target,
          })),
          shown: shown.length,
          matched,
          /*
            The same honesty `issues` owes about discovery, for the same reason.
            A change to an object this read cannot reach is not in `activity` at
            all, and a feed is exactly where somebody concludes "nothing
            happened" from a short list.
          */
          note:
            matched > shown.length
              ? `${matched} changes matched; showing the ${shown.length} most recent. Pass --limit for more.`
              : undefined,
        }
      },
    },
    {
      name: 'status',
      summary: 'where one issue is now, in a few lines — not its description or conversation',
      usage: 'status <ref>',
      async run(context, args) {
        const reference = args.positional[0]
        if (!reference) throw new BadRequest('status needs a reference — try `ship issues` first.')

        /*
          The "where is it now" read. Most `show` calls were this question
          (MAK-1), answered with the whole description and conversation every
          time — a median of 1.6K characters, and up to 24K. This returns the
          state, the PR if one is named, and the last comment clipped; `show`
          is still there for the rest.
        */
        const { state, issue } = await resolveIssueFor(context, reference)
        const comments = commentsOn(await conversationsFor(context, state, [issue.addr]), issue.addr)
        const last = comments[comments.length - 1]
        const directory = await directoryFor(context, [issue.assignee, last?.author])

        return {
          state: issueLine({ ...issue, ref: refOf(issue), comments }, who(directory, issue.assignee)),
          ref: refOf(issue),
          short: short(issue.id),
          addr: issue.addr,
          title: issue.title,
          summary: issue.summary,
          status: issue.status,
          assignee: who(directory, issue.assignee),
          pullRequest: pullRequestOn([...comments.map((c) => c.body).reverse(), descriptionText(issue.description, issue.descriptionFormat)]),
          comments: comments.length,
          lastComment: last && {
            id: last.id,
            by: who(directory, last.author),
            at: new Date(last.at).toISOString(),
            body: clip(last.body, LAST_COMMENT),
          },
        }
      },
    },
    {
      name: 'show',
      summary: 'one issue or project, folded, with its conversation and history',
      usage: 'show <ref>',
      async run(context, args) {
        const reference = args.positional[0]
        if (!reference) throw new BadRequest('show needs a reference — try `ship issues` first.')

        // With the Folders, so `archived` agrees with what the listings hide.
        const { state } = await loadWithFolders(context)

        /*
          Asked of both kinds, then decided — rather than issues first with
          projects as a fallback. A fallback would resolve a reference that
          names both to whichever kind was tried first, silently, and the whole
          argument of `resolve.ts` is that a reference matching two things is a
          question rather than an answer.
        */
        const asIssue = resolveMaybe(state.issues, reference, ISSUE_BY)
        const asProject = resolveMaybe(state.projects, reference, PROJECT_BY)

        if ('found' in asIssue && 'found' in asProject) {
          throw new BadRequest(
            `"${reference}" names both an issue and a project:\n` +
              `  issue   ${asIssue.found.ref ?? asIssue.found.addr} — ${asIssue.found.title}\n` +
              `  project ${asProject.found.title}\n` +
              'Pass an address to say which.',
          )
        }

        if ('found' in asProject) return showProject(context, state, asProject.found)

        if (!('found' in asIssue)) {
          // Whichever attempt had something to say says it. An ambiguity is a
          // real finding — "three issues match" — where a miss is just a miss.
          if ('ambiguous' in asIssue) throw new BadRequest(asIssue.ambiguous)
          if ('ambiguous' in asProject) throw new BadRequest(asProject.ambiguous)
          throw new BadRequest(`No issue or project matches "${reference}".`)
        }

        const issue = asIssue.found
        const { directory, history, conversation } = await timelineFor(context, state, issue.addr, [
          issue.author,
          issue.assignee,
          issue.archive?.by,
        ])

        return {
          kind: 'issue' as const,
          ...issueSummary(issue, directory, state.vocab.issue),
          /*
            A block document from Ship's editor is printed as text, one chunk
            per block, because that is what `edit-issue --description` takes
            back — and it keeps every block whose chunk comes back unchanged
            (AGE-8). `descriptionFormat` says which it was.
          */
          description: descriptionText(issue.description, issue.descriptionFormat),
          descriptionFormat: formatName(issue.descriptionFormat),
          // How each link in it draws — chip, row, card or a link on words — which the text cannot say (WBD-9).
          links: await descriptionLinks(context, state, issue),
          createdAt: new Date(issue.createdAt * 1000).toISOString(),
          folder: issue.folder,
          /*
            The change stream, not a derived summary. Who moved an issue and
            when is the part a person asks about, and it is also the evidence
            that somebody other than the author acted — which is the whole
            reason the model is event-sourced rather than a mutable row.
          */
          history,
          conversation,
        }
      },
    },
    {
      name: 'people',
      summary: 'every key the workspace has seen, with the name it publishes',
      usage: 'people [--named]',
      async run(context, args) {
        const state = await loadWorkspace(context)
        // Every object's conversations, so a person who has only ever commented still appears.
        const [talk, members] = await Promise.all([conversationsFor(context, state, [...state.objects.keys()]), relayMembers(context)])
        const found = participants({ ...state, conversations: [...talk.byObject.values()].flat() }, members)
        const directory = await directoryFor(context, found.map((person) => person.pubkey))

        const listed = found
          .map((person) => {
            const profile = directory.get(person.pubkey)
            return {
              /*
                The key first and unabbreviated, because it is the identity and
                the thing a caller has to copy. `assign` and `edit-project
                --lead` take this and refuse a name, deliberately: names are
                self-set (docs/untrusted-content.md), so assigning by one would
                let a person redirect work by renaming themselves.

                This command exists to make that refusal survivable, not to
                route around it. Nothing here should be passed to a write as a
                name.
              */
              pubkey: person.pubkey,
              name: profile?.name,
              nip05: profile?.nip05,
              filed: person.filed || undefined,
              assigned: person.assigned || undefined,
              leads: person.leads || undefined,
              acted: person.acted || undefined,
            }
          })
          .filter((person) => (args.flags.named ? Boolean(person.name) : true))

        const anonymous = listed.filter((person) => !person.name).length

        return {
          people: listed,
          /*
            A key with no `kind:0` stays a key. Estiva ID is the only writer
            of profiles (PEEK-48), so an unnamed participant is un-named rather
            than un-real — still a valid target for `assign`.
          */
          note:
            'Everyone who has touched a Ship object, busiest first, then every other relay member. ' +
            (members.length === 0 ? 'The relay published no member list, so somebody who has done nothing here yet is missing. ' : '') +
            (anonymous > 0
              ? `${anonymous} of these publish no profile and stay a key; they can still be assigned.`
              : 'Every one of them publishes a profile.'),
        }
      },
    },
    {
      name: 'comment',
      signs: [KIND_COMMENT],
      summary: 'add a comment to one issue',
      usage: 'comment <ref> --body "..." [--mention <key|npub|handle>[,…]] [--attach <path>[,…]]',
      async run(context, args) {
        const reference = args.positional[0]
        if (!reference) throw new BadRequest('comment needs an issue reference.')
        const text = flagValue(args, 'body')
        if (!text) throw new BadRequest('comment needs --body.')
        // Resolved before anything else is read, so a wrong name costs no workspace scan.
        const mention = flagValue(args, 'mention')
        const mentioned = mention === undefined ? [] : await mentionedKeys(mention, { relayUrl: context.relayUrl, members: () => relayMembers(context) })
        const body = withMentions(text, mentioned)

        const { state, issue } = await resolveIssueFor(context, reference)
        // Uploaded before the comment names them: the relay refuses a comment naming a file it does not hold.
        const attach = flagValue(args, 'attach')
        const files = attach === undefined ? [] : await uploadFiles(context, attach)
        /*
          Ship's declared `comment` action: a NIP-22 comment on the issue's
          address, in the issue's own Folder, so it lands where Ship and Peek
          both show the conversation. Each `nostr:npub…` in the body earns its
          `p` in interop, which is what makes it a mention in Peek (§11.8).
        */
        const [result] = await act(context, state, issueTarget(issue), 'comment', body, [KIND_COMMENT], { files })
        published(result, `a comment on ${issue.ref ?? issue.addr}`)

        // The eventId is kept because it is what `edit-comment --message` takes.
        return {
          state: await stateAfter(context, state, issue, { comment: body, commentId: result.eventId }),
          eventId: result.eventId,
          ...(mentioned.length > 0 && { mentioned }),
          ...(files.length > 0 && { attached: files.map((file) => ({ filename: file.filename, url: file.url, x: file.x })) }),
        }
      },
    },
    {
      name: 'edit-comment',
      signs: [KIND_EDIT],
      summary: 'replace the text of one comment on an issue or project',
      usage: 'edit-comment <ref> --message <id|phrase> --body "..."',
      async run(context, args) {
        const reference = args.positional[0]
        if (!reference) throw new BadRequest('edit-comment needs an issue or project reference.')
        const target = flagValue(args, 'message')
        if (!target) {
          throw new BadRequest(
            'edit-comment needs --message naming the comment to replace. `ship show <ref>` prints an id for every message.',
          )
        }
        const body = flagValue(args, 'body')
        if (!body) throw new BadRequest('edit-comment needs --body — the whole new text, not a patch.')

        const state = await loadWorkspace(context)

        /*
          Both kinds, asked and then decided, exactly as `show` does — and for
          the same reason. A comment on a project is the same `kind:9` as a
          comment on an issue, so resolving issues first with projects as a
          fallback would silently pick one for a reference naming both.
        */
        const asIssue = resolveMaybe(state.issues, reference, ISSUE_BY)
        const asProject = resolveMaybe(state.projects, reference, PROJECT_BY)

        if ('found' in asIssue && 'found' in asProject) {
          throw new BadRequest(
            `"${reference}" names both an issue and a project:\n` +
              `  issue   ${asIssue.found.ref ?? asIssue.found.addr} — ${asIssue.found.title}\n` +
              `  project ${asProject.found.title}\n` +
              'Pass an address to say which.',
          )
        }
        const object = 'found' in asIssue
          ? { addr: asIssue.found.addr, label: asIssue.found.ref ?? asIssue.found.addr }
          : 'found' in asProject
            ? { addr: asProject.found.addr, label: asProject.found.title }
            : undefined

        if (!object) {
          // Whichever attempt had something to say says it, as `show` does: an
          // ambiguity is a finding — "three issues match" — where a miss is a miss.
          if ('ambiguous' in asIssue) throw new BadRequest(asIssue.ambiguous)
          if ('ambiguous' in asProject) throw new BadRequest(asProject.ambiguous)
          throw new BadRequest(`No issue or project matches "${reference}".`)
        }

        /*
          The candidate set is this one object's conversations and nothing
          wider. `--message` takes a phrase as well as an id, and a phrase
          matched across the workspace is how the wrong comment gets rewritten
          — the failure `resolve.ts` exists for, and one that leaves no trace
          afterwards because the text it replaced is not shown again.
        */
        const talk = await conversationsFor(context, state, [object.addr])
        const messages = (talk.byObject.get(object.addr) ?? []).flatMap((thread) =>
          [thread.root, ...thread.replies].map((message) => ({
            id: message.id,
            body: edited(talk.edits, message).body,
            folder: message.folder,
          })),
        )
        const message = findMessage(messages, target)

        /*
          The target's own Folder, not the object's — the trap CON-4 named.
          A conversation stays in the Folder it was posted in, which need not be
          its project's, and 40003 is channel-scoped, so
          an `h` copied from the page would be refused with `accepted: false`
          while the kind is granted and the signature is fine.
        */
        const result = await publishEdit(context, { folder: message.folder, messageEventId: message.id, body })
        published(result, `an edit of a comment on ${object.label}`)

        return {
          edited: {
            ref: object.label,
            addr: object.addr,
            messageId: message.id,
            folder: message.folder,
            /*
              What was there before, said back rather than assumed. `--message`
              matches a phrase, and "it replaced the comment I meant" is the one
              thing the caller cannot check afterwards — the original body is
              still on the relay but nothing prints it once an edit has won.
            */
            replaced: message.body.slice(0, 120),
          },
          eventId: result.eventId,
          /*
            An edit that this identity did not author is the relay's to refuse,
            not this command's — `validate_edit_ownership` also accepts the
            NIP-OA owner of an authoring agent, and no client can evaluate that
            half. So the note is about what the wire keeps, which nobody can
            infer from a success.
          */
          note:
            'The original event is untouched on the relay — an edit is a new kind:40003 naming it, and readers fold the pair. ' +
            'A reader that does not implement the fold still shows the old text.',
        }
      },
    },
    {
      name: 'set-status',
      signs: [KIND_CHANGE],
      summary: 'set one issue\'s status',
      usage: 'set-status <ref> <status>',
      async run(context, args) {
        const [reference, status] = args.positional
        if (!reference || !status) throw new BadRequest('set-status needs a reference and a status.')

        // Validated against the vocabulary before publishing: a value outside it
        // is displayed rather than swallowed, so a typo becomes a visible bogus
        // status on a real issue instead of an error.
        // The vocabulary is the one Ship's manifest declares, so it is read first.
        const wanted = status.toLowerCase()
        const { state, issue } = await resolveIssueFor(context, reference)
        if (!state.vocab.issue.entries.some((entry) => entry.value === wanted)) {
          throw new BadRequest(
            `Unknown status "${status}". Try: ${state.vocab.issue.entries.map((s) => s.value).join(', ')}`,
          )
        }

        // Same omission as `assign` had, and the same fix: 115 status changes
        // by this identity carried no note. The vocabulary is the app's.
        const result = await setField(context, state, issueTarget(issue), 'status', wanted, `Status → ${wanted}`)
        published(result, `a status change on ${issue.ref ?? issue.addr}`)

        return {
          state: await stateAfter(context, state, issue, { status: wanted }),
          from: issue.status,
          eventId: result.eventId,
        }
      },
    },
    {
      name: 'assign',
      signs: [KIND_CHANGE],
      summary: 'assign one issue to somebody, or clear it',
      usage: 'assign <ref> <pubkey|me|none>',
      async run(context, args) {
        const [reference, who] = args.positional
        if (!reference || !who) throw new BadRequest('assign needs a reference and a pubkey, "me", or "none".')

        // `me` is the signing identity — the agent itself. Anyone else has to be
        // named by pubkey rather than by display name, because display names are
        // self-set (docs/untrusted-content.md) and assigning by one would let a
        // person choose who work lands on by renaming themselves.
        const assignee = assigneeFor(who, context.signer.pubkey)

        const { state, issue } = await resolveIssueFor(context, reference)
        /*
          The note the web UI writes for the same act. Without one the change
          carries an empty `.content`, and the activity feed — which is not
          derived from the state, it *is* the change stream — renders the
          agent's assignments as a blank line where a person's read "Assign".

          Measured on production before this: 66 assignee changes by this
          identity, 0 with a note.
        */
        const result = await setField(context, state, issueTarget(issue), 'assignee', assignee, assignee ? 'Assign' : 'Unassign')
        published(result, `an assignment on ${issue.ref ?? issue.addr}`)

        return {
          state: await stateAfter(context, state, issue, { assignee: assignee.toLowerCase() }),
          from: issue.assignee,
          eventId: result.eventId,
        }
      },
    },
    {
      name: 'edit-issue',
      signs: [KIND_CHANGE],
      summary: 'change an issue’s title, summary, description, or which project it is in',
      usage: 'edit-issue <ref> [--title "..."] [--summary "..."] [--description "..."] [--mention <key|npub|handle>[,…]] [--project <ref|none>]',
      async run(context, args) {
        const reference = args.positional[0]
        if (!reference) throw new BadRequest('edit-issue needs an issue reference.')
        const asked = await descriptionMentions(context, args)

        const state = await loadWorkspace(context)
        const issue = findIssue(state.issues, reference)
        const edits = issueEdits(issue, args, state.projects, await filesIn(context, args, issue))

        /*
          An issue's changes carry the issue's own Folder — not its project's,
          and deliberately not the rule `edit-project` follows. Issues filed
          while a project was re-pointed by the retired `folder` field (MAN-5)
          still carry that Folder's `h`, so “the project's Folder” is the wrong
          answer for them. Ship's `src/api/writes.ts` states the same split.
        */
        const folder = issue.folder
        if (!folder) {
          throw new BadRequest(
            `${issue.ref ?? issue.addr} names no Folder, so a change to it has nowhere to be published.`,
          )
        }

        const plan = addsFor(context, { addr: issue.addr, folder }, issue, edits, asked)

        const applied: ReturnType<typeof appliedEdit>[] = []
        let mentioned = {}
        for (const edit of edits) {
          const result = await setField(context, state, { addr: issue.addr, author: issue.author, folder }, edit.field, edit.value, edit.note, edit.contentFormat)
          if (!result.ok) {
            throw new BadRequest(
              `The relay refused ${edit.field} on ${issue.ref ?? issue.addr}: ${result.reason ?? 'no reason given'}. ` +
                `Already published and standing: ${applied.map((entry) => entry.field).join(', ') || 'nothing'}.`,
            )
          }
          applied.push(appliedEdit(edit, result.eventId))
          // Straight after the save it goes with, so a later field's refusal cannot leave a mention without its Add.
          if (edit.field === 'description') mentioned = await publishMentionAdds(context, plan, `The description of ${issue.ref ?? issue.addr}`)
        }

        /*
          A move re-parents the issue and moves nothing else. The issue event's
          `h` is immutable, so its conversation stays in the Folder it was filed
          in — which is the Folder somebody reading the *new* project in Peek is
          not looking at. Said out loud rather than left for them to notice,
          because nothing else reports it.
        */
        const moved = applied.find((entry) => entry.field === 'project' && entry.to)
        const destination = moved && state.projects.find((candidate) => candidate.addr === moved.to)
        const conversationStaysBehind =
          destination && destination.contentFolder !== folder
            ? `The issue's conversation stays in Folder ${folder}, which is not ${destination.title}'s (${destination.contentFolder}). Moving an issue cannot move its messages: an event's Folder is immutable.`
            : undefined

        return {
          changed: { ref: issue.ref, addr: issue.addr, title: issue.title, folder },
          applied,
          ...mentioned,
          ...(conversationStaysBehind ? { note: conversationStaysBehind } : {}),
        }
      },
    },
    {
      name: 'edit-project',
      signs: [KIND_CHANGE],
      summary: 'change a project’s title, summary, description, status or lead',
      usage: 'edit-project <ref> [--title "..."] [--summary "..."] [--description "..."] [--mention <key|npub|handle>[,…]] [--status <s>] [--lead <key|me|none>]',
      async run(context, args) {
        const reference = args.positional[0]
        if (!reference) throw new BadRequest('edit-project needs a project reference.')
        const asked = await descriptionMentions(context, args)

        const state = await loadWorkspace(context)
        const project = findProject(state.projects, reference)
        const edits = projectEdits(project, args, context.signer.pubkey, state.vocab.project, await filesIn(context, args, project))

        /*
          A change to the project *record* carries the Folder that record
          names, not the Folder any one of its issues is in — they differ for
          the projects a retired `folder` field once re-pointed (MAN-5).

          `apps/ship/views/project.ts` says the wrong Folder is “rejected at
          ingest”. **Measured against production, it is not.** The relay accepts
          a project change published against another Folder: ok:true, no
          reason given. What actually happens is quieter than a rejection and
          worse than one. The fold keys changes by target address, so `loadAll`
          applies it and everything looks correct — but `loadFolder` and
          `loadFolders` filter by `#h`, so a reader scoped to the record's own
          Folder never sees it. The edit lands for whoever reads the whole
          workspace and silently does not exist for whoever reads the project.

          So the rule holds and the stated reason does not. Use the record's
          Folder because that is where readers of this project look, not because
          anything would stop you writing elsewhere.
        */
        const folder = project.contentFolder
        if (!folder) {
          throw new BadRequest(
            `“${project.title}” names no Folder for its record, so a change to it has nowhere to be published.`,
          )
        }

        /*
          One event per field, because `buildChange` carries a single
          `field`/`value` pair — that is what makes the stream replayable and
          the activity feed readable, and it is not worth breaking so four edits
          can share a publish. Still one *object* per call, which is the rule
          that actually bounds this CLI (CLAUDE.md: no verb selects by matching
          text).

          A refusal stops the rest. There is no transaction on a relay, so a
          later field failing cannot roll the earlier ones back; the honest
          answer names the ones that landed rather than reporting the whole call
          as failed and leaving a person guessing about half of it.
        */
        const plan = addsFor(context, { addr: project.addr, folder }, project, edits, asked)
        const applied: ReturnType<typeof appliedEdit>[] = []
        let mentioned = {}
        for (const edit of edits) {
          const result = await setField(context, state, { addr: project.addr, author: project.author, folder }, edit.field, edit.value, edit.note, edit.contentFormat)
          if (!result.ok) {
            throw new BadRequest(
              `The relay refused ${edit.field} on “${project.title}”: ${result.reason ?? 'no reason given'}. ` +
                `Already published and standing: ${applied.map((entry) => entry.field).join(', ') || 'nothing'}.`,
            )
          }
          applied.push(appliedEdit(edit, result.eventId))
          // Straight after the save it goes with, so a later field's refusal cannot leave a mention without its Add.
          if (edit.field === 'description') mentioned = await publishMentionAdds(context, plan, `The description of “${project.title}”`)
        }

        return { changed: { title: project.title, addr: project.addr, folder }, applied, ...mentioned }
      },
    },
    {
      name: 'move-project',
      /*
        Ship's "Move to Folder…" (FOL-7): a `kind:1852 add` to the new
        top-level Folder, then a `remove` from each one that lists it now,
        through interop's `planMoveFromFolders`, as `Store.moveProject` does —
        one add naming the project and every file listed beneath it, archived
        ones included (MAN-17, SHI-37). No
        `kind:1851` — the record, its issues and its conversation keep their
        Folder, so a comment's `h` still names the channel both apps read.
      */
      signs: [PROTOCOL_KIND.FOLDER_COMMAND],
      summary: 'move a project, with what is filed under it, to another top-level Folder — its issues and conversation stay where they are',
      usage: 'move-project <ref> --folder <name|id>',
      async run(context, args) {
        const reference = args.positional[0]
        const target = flagValue(args, 'folder')
        if (!reference) throw new BadRequest('move-project needs a project reference.')
        if (!target) throw new BadRequest('move-project needs --folder: a top-level Folder name or id.')

        const state = await loadWorkspace(context)
        const project = findProject(state.projects, reference)
        const teams = topLevelFolders(await readFolders(context))
        const to = resolveTeamIn(teams, target)

        // Where it is now, by Ship's sidebar rule (`placedIn`): the Folders whose state lists it, else its own Folder if that is one.
        const listing = teams.filter((team) => team.addresses?.includes(project.addr))
        const from = listing.length > 0 ? listing : teams.filter((team) => team.id === project.contentFolder)
        const name = (team: FolderSummary) => team.name ?? team.id
        if (from.length === 1 && from[0].id === to.id) {
          throw new BadRequest(`“${project.title}” is already in ${name(to)}, and only there. Nothing was published.`)
        }

        // What each source lists beneath the project moves with it (SPEC §3.3), read now; unread, nothing is sent.
        const sources = from.filter((team) => team.id !== to.id && team.hasState).map((team) => ({ id: team.id, hasState: team.hasState }))
        const listings = await readListings(context, sources)
        if (!(listings instanceof Map)) throw new BadRequest(`A Folder “${project.title}” is in could not be read (${listings.unread}), so what is under it would be left behind. Nothing was published; run the same command again.`)

        const moved = await moveFile(context, {
          address: project.addr,
          // Each names the project — it is what is being moved, out of its own Folder too, which may hold it by containment
          // while a topic under it is listed — so the planner moves the two together.
          from: from.map((team) => ({ id: team.id, hasState: team.hasState, addresses: [project.addr] })),
          to: { id: to.id, hasState: to.hasState, ...(to.private ? { private: true } : {}) },
          listings,
        })
        if (moved.refused === 'target-has-no-state') throw new BadRequest(`${name(to)} has no list of its own, so adding to it would hide what is already there. Nothing was published.`)
        if (moved.refused === 'source-has-no-state') throw new BadRequest(`A Folder “${project.title}” is in has no list of its own, so taking it out would empty that Folder. Nothing was published.`)
        if (moved.refused === 'target-is-private') throw new BadRequest(`${name(to)} is private, and “${project.title}” would stay readable by the whole workspace. Nothing was published.`)
        if (moved.added) published(moved.added, `adding “${project.title}” to ${name(to)} (nothing else was sent; it is where it was)`)

        const stillIn = moved.removed
          .filter(({ result }) => !result.ok)
          .map(({ folder, result }) => ({ folder, name: teams.find((team) => team.id === folder)?.name, refused: result.reason ?? 'no reason given' }))
        return {
          moved: { title: project.title, addr: project.addr },
          from: from.map((team) => ({ id: team.id, name: team.name })),
          to: { id: to.id, name: to.name },
          added: moved.added?.eventId,
          // What was listed beneath it in the source — a topic started under it — and went with it.
          with: moved.moved
            .filter((address) => address !== project.addr)
            .map((address) => {
              // A listing's rows are interop's `ForeignObject`s: the title is a slot, the type its `noun`.
              const row = [...listings.values()].flat().find((file) => file.address === address) as
                | { noun?: string; slots?: Record<string, { value?: string } | undefined> }
                | undefined
              return { title: row?.slots?.title?.value, type: row?.noun, address }
            }),
          removed: moved.removed.filter(({ result }) => result.ok).map(({ folder, result }) => ({ folder, eventId: result.eventId })),
          // A refused remove is still a move: it is in the new Folder and in these too. Run the same command again to retry.
          stillIn: stillIn.length > 0 ? stillIn : undefined,
          note: `Only the Folder listings changed. Its issues and conversation stay in ${project.contentFolder}.`,
        }
      },
    },
    {
      name: 'archive',
      signs: [KIND_CHANGE],
      summary: 'archive a project, an issue or a Folder with a resolution, or bring it back',
      usage: 'archive <ref> [--resolution <text>] [--unarchive]',
      run: (context, args) => archiveFile(context, args, 'archive'),
    },
    {
      // The name it had before any file could be archived; kept so existing prompts and skills still work.
      name: 'archive-project',
      signs: [KIND_CHANGE],
      summary: 'archive a project with a resolution, or bring it back — `archive` for any file',
      usage: 'archive-project <ref> [--resolution <text>] [--unarchive]',
      run: (context, args) => archiveFile(context, args, 'archive-project'),
    },
    /*
      The two irreversible commands, and the only ones that ask twice.

      `--yes` is not ceremony here. Every other write in this app is a change
      event a later change supersedes, or an archive that `--unarchive` undoes.
      A NIP-09 deletion is a *request* the relay honours by dropping the event,
      and republishing does not undo it: the address would be the same but the
      signature and `created_at` are not, and REW-11 established the relay will
      not backdate one. So a first call describes what goes and what stays and
      publishes nothing, which is the same question Ship's confirm dialog asks
      (SHI-3) in the shape a terminal has.

      Note what authorises these, because it is not what authorises the rest.
      A deletion carrying an `a` tag — which is what an addressable target is —
      leaves the relay with no channel to check, since it derives a deletion's
      channel from an `e` tag only. So membership in the object's Folder is
      *not* consulted, and validation reduces to author, or the owner of an
      authoring agent. That is why deleting is possible for an object whose
      Folder will not take an archive, which is the case these were written
      for: an empty project pointed at a channel with no members could not be
      archived, renamed or re-paired, and a `kind:5` was the only way out.
    */
    {
      name: 'delete-issue',
      signs: [KIND_DELETION],
      summary: 'ask the relay to drop an issue record — irreversible',
      usage: 'delete-issue <ref> [--yes] [--reason "…"]',
      async run(context, args) {
        const reference = args.positional[0]
        if (!reference) throw new BadRequest('delete-issue needs an issue reference.')

        const { state, issue } = await resolveIssueFor(context, reference)
        const conversations = ((await conversationsFor(context, state, [issue.addr])).byObject.get(issue.addr) ?? []).length
        const survives = `Its ${conversations} conversation(s) are separate events with their own authors and are NOT deleted — they stay in the Folder and stop being reachable from the issue.`

        if (!args.flags.yes) {
          return {
            wouldDelete: { ref: issue.ref, addr: issue.addr, title: issue.title, folder: issue.folder },
            survives,
            note: 'Nothing was published. Pass --yes to send the deletion request.',
          }
        }

        const [result] = await act(context, state, issueTarget(issue), 'delete-issue', '', [KIND_DELETION], { reason: flagValue(args, 'reason') })
        published(result, `deleting ${issue.ref ?? issue.addr}`)

        return {
          deleted: { ref: issue.ref, addr: issue.addr, title: issue.title },
          eventId: result.eventId,
          survives,
          note: 'NIP-09 is a request. The relay may decline it, and copies held elsewhere are untouched.',
        }
      },
    },
    {
      name: 'delete-project',
      signs: [KIND_DELETION, PROTOCOL_KIND.FOLDER_COMMAND],
      summary: 'ask the relay to drop a project record — irreversible; prefer archive-project',
      usage: 'delete-project <ref> [--yes] [--reason "…"]',
      async run(context, args) {
        const reference = args.positional[0]
        if (!reference) throw new BadRequest('delete-project needs a project reference.')

        const state = await loadWorkspace(context)
        const project = findProject(state.projects, reference)
        const issues = state.issues.filter((issue) => issue.projectAddr === project.addr).length

        /*
          `archive-project` refuses without an origin Folder because a change
          event published to the wrong one is accepted and then invisible. A
          deletion has no such failure: its `h` is not what the relay reads, so
          either Folder does — and refusing here would strand exactly the
          object this command exists to remove.
        */
        const folder = project.contentFolder
        if (!folder) throw new BadRequest(`“${project.title}” names no Folder at all, so a deletion cannot be addressed to one.`)

        const survives = `Its ${issues} issue(s) are separate events and are NOT deleted. Since SHI-7 they stay reachable in \`ship issues\`, listed with no project.`

        if (!args.flags.yes) {
          return {
            wouldDelete: { title: project.title, addr: project.addr, folder },
            survives,
            note: 'Nothing was published. Archiving is reversible and usually what is wanted — see `archive-project`. Pass --yes to send the deletion request.',
          }
        }

        /*
          Then unlisted from its team (FOL-48): a Folder with state lists what
          its 30890 names, deleted or not. Whether it has state is read, never
          assumed; a Folder this credential cannot see has none to change.

          The team is every Folder that lists it (FOL-7): after `move-project`
          that is not its content Folder, which keeps its conversation. Only a
          project no Folder lists is unlisted from its content Folder.
        */
        const all = await readFolders(context)
        const listing = all.filter((f) => f.addresses?.includes(project.addr)).map((f) => ({ folder: f.id, hasState: f.hasState }))
        const folders = listing.length > 0 ? listing : [{ folder: project.contentFolder, hasState: all.find((f) => f.id === project.contentFolder)?.hasState ?? false }]
        const from = folders.map((f) => f.folder).join(', ')
        // Ship's `delete-project` action: the `kind:5`, then a remove from each listing (`listed: true`).
        const [result, ...unlists] = await act(context, state, { addr: project.addr, author: project.author, folder }, 'delete-project', '', [KIND_DELETION, PROTOCOL_KIND.FOLDER_COMMAND], {
          reason: flagValue(args, 'reason'),
          listedIn: folders.map((f) => ({ id: f.folder, hasState: f.hasState })),
        })
        published(result, `deleting “${project.title}”`)
        const unlisted = unlists.find((answer) => !answer.ok) ?? unlists.at(-1)

        return {
          deleted: { title: project.title, addr: project.addr },
          eventId: result.eventId,
          // Apart from the delete, as Ship reports it: a refused unlist is a
          // deleted project its team still shows a row for.
          unlisted: unlisted ? (unlisted.ok ? { from, eventId: unlisted.eventId } : { from, refused: unlisted.reason ?? 'no reason given' }) : undefined,
          survives,
          note: 'NIP-09 is a request. The relay may decline it, and copies held elsewhere are untouched.',
        }
      },
    },
    {
      name: 'create-project',
      /*
        The record, then its listing in the team (FOL-2, FOL-47). No `kind:9007`
        any more: a project has no Folder of its own, its record's
        `buzz-channel` names the team and its issues carry the team's `h`.

        Both kinds are declared, so a credential that cannot list in a team is
        told before the record is written rather than after (PEEK-172).

        A description follows as a `describe-project` change (RIC-20): it is a
        block document, and Ship's `add-project` declares no format for its
        description, so the record cannot carry one.
      */
      signs: [KIND.PROJECT, PROTOCOL_KIND.FOLDER_COMMAND, KIND_CHANGE],
      summary: 'start a new project in a team',
      usage: 'create-project --team <name|folder> --title "..." [--summary "..."] [--description "..."] [--mention <key|npub|handle>[,…]] [--key ABC]',
      async run(context, args) {
        const title = flagValue(args, 'title')
        if (!title) throw new BadRequest('create-project needs --title.')
        const reference = flagValue(args, 'team')
        if (!reference) throw new BadRequest('create-project needs --team: the team the project is filed into.')
        const key = flagValue(args, 'key')
        if (key !== undefined && !/^[A-Z]{3,6}$/.test(key)) throw new BadRequest('--key is 3–6 capital letters A to Z, the prefix of the project\'s refs.')
        const asked = await descriptionMentions(context, args)

        // Resolved against the Folders that have state, so `hasState` is the read's answer.
        const team = await resolveTeam(context, reference)
        /*
          Ship's `add-project`, declared on the Folder's own record (`kind:39000`)
          because a project hangs under nothing else. The manifest is Ship's — the
          one a project this identity authored resolves to.
        */
        const state = await loadWorkspace(context)
        /*
          SPEC §6.1 (SHI-4): a key no project this identity can see holds, and
          no ref it can see starts with. Left out, Ship gives the project one
          the first time it numbers an issue in it — the agent does not derive
          keys, so it cannot disagree with Ship about one.
        */
        if (key) {
          const holder = state.projects.find((project) => project.key === key)
          if (holder) throw new BadRequest(`--key ${key} is used by "${holder.title}". Pick another.`)
          if (state.issues.some((issue) => issue.ref?.startsWith(`${key}-`))) throw new BadRequest(`--key ${key} is already used by older issues' refs. Pick another.`)
        }
        const id = randomUUID()
        const description = flagValue(args, 'description')
        const body = description ? await describePlacing(context, '', undefined, description) : undefined
        const adds = body
          ? mentionAdds(context.signer.pubkey, { file: `${KIND.PROJECT}:${context.signer.pubkey}:${id}`, folder: team.id, saved: fileText(body.value, body.contentFormat), editedFrom: null, asked })
          : NO_MENTIONS
        const manifest = state.manifestFor(`${KIND.PROJECT}:${context.signer.pubkey}:${id}`)
        // Seeded on the record when the manifest takes it, and then readable by
        // the whole workspace as the project's name is (SPEC §6.12; Miky, 2026-10-15).
        const summary = summaryText(flagValue(args, 'summary') ?? '')
        const route = summary ? summaryRoute(manifest?.manifest, 'add-project', KIND.PROJECT) : undefined
        if (summary && !route) throw new BadRequest(`Ship's manifest declares no summary for a project yet, so --summary has nowhere to go. Nothing was published.`)
        const [result, placed] = await act(
          context,
          state,
          { addr: team.channel ?? `${KIND_CHANNEL_METADATA}::${team.id}`, author: '', folder: team.id },
          'add-project',
          {
            name: title,
            ...(body && !body.contentFormat ? { description: body.value } : {}),
            ...(key ? { key } : {}),
            ...(route === 'seed' ? { summary } : {}),
          },
          [KIND.PROJECT, PROTOCOL_KIND.FOLDER_COMMAND],
          { newId: id, folderHasState: team.hasState, manifest },
        )
        const created = { result, placed, addr: `${KIND.PROJECT}:${context.signer.pubkey}:${id}` }
        published(created.result, `a new project "${title}"`)
        const described = body?.contentFormat
          ? await setField(context, state, { addr: created.addr, author: context.signer.pubkey, folder: team.id }, 'description', body.value, 'Description', body.contentFormat)
          : undefined
        if (described) published(described, `the description of "${title}" — the project itself was created, ${created.addr}, without one`)
        const summarized =
          route === 'change'
            ? await setField(context, state, { addr: created.addr, author: context.signer.pubkey, folder: team.id }, 'summary', summary, 'Summary')
            : undefined
        if (summarized) published(summarized, `the summary of "${title}" — the project itself was created, ${created.addr}, without one`)
        const mentioned = await publishMentionAdds(context, adds, `The project "${title}" (${created.addr})`)

        return {
          created: { title, ...(summary ? { summary } : {}), ...(key ? { key } : {}), addr: created.addr, team: { id: team.id, name: team.name } },
          eventId: created.result.eventId,
          ...mentioned,
          ...(summaryWarning(summary) ? { note: summaryWarning(summary) } : {}),
          /*
            Apart from the record, as Ship reports it: a refused listing is a
            project Ship shows under its team and Peek does not place.
          */
          placed: created.placed
            ? created.placed.ok
              ? { in: team.id, eventId: created.placed.eventId }
              : { in: team.id, refused: created.placed.reason ?? 'no reason given' }
            : undefined,
        }
      },
    },
    {
      name: 'create-issue',
      // The change only when a manifest takes no summary on the record (`summaryRoute`).
      signs: [KIND.ISSUE, KIND_CHANGE],
      summary: 'file one new issue in a project',
      usage: 'create-issue --project <ref> --title "..." [--summary "..."] [--description "..."] [--mention <key|npub|handle>[,…]]',
      async run(context, args) {
        const projectRef = flagValue(args, 'project')
        const title = flagValue(args, 'title')
        if (!projectRef) throw new BadRequest('create-issue needs --project.')
        if (!title) throw new BadRequest('create-issue needs --title.')
        const asked = await descriptionMentions(context, args)

        const state = await loadWorkspace(context)
        const project = findProject(state.projects, projectRef)

        /*
          No ref (Miky, 2026-10-02, PER-21). A display key is derived from the
          project's title and a count of its issues, which only Ship can work
          out, so its manifest never offers it; Ship numbers the issue the next
          time somebody opens the project (`assignMissingRefs`). Until then the
          short id printed below is how to name it.
        */

        // Filed in the project's own Folder, never one that lists it, so the
        // issue has the project's readers — as Ship's `workFolder` does. A
        // record naming no Folder is refused (0 of 76 projects, 19 Oct).
        // why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/what-belongs-to-a-file-is-stored-with-it.md
        const folder = project.contentFolder
        if (!folder) throw new BadRequest(`“${project.title}” names no Folder of its own, so a new issue has nowhere to be filed. Nothing was published.`)
        const id = randomUUID()
        // A block document (RIC-20), which Ship's `add-issue` declares for its description.
        const description = flagValue(args, 'description')
        const body = description ? await describePlacing(context, '', undefined, description) : undefined
        const addr =`${KIND.ISSUE}:${context.signer.pubkey}:${id}`
        // A mention in the new text adds the person beside it (§11.8); built now, so a refusal publishes nothing.
        const adds = body ? mentionAdds(context.signer.pubkey, { file: addr, folder, saved: fileText(body.value, body.contentFormat), editedFrom: null, asked }) : NO_MENTIONS
        const summary = summaryText(flagValue(args, 'summary') ?? '')
        const route = summary ? summaryRoute(state.manifestFor(project.addr)?.manifest, 'add-issue', KIND.ISSUE) : undefined
        if (summary && !route) throw new BadRequest(`Ship's manifest declares no summary for an issue yet, so --summary has nowhere to go. Nothing was published.`)
        const [result] = await act(
          context,
          state,
          { addr: project.addr, author: project.author, folder },
          'add-issue',
          { title, ...(body ? { description: body.value } : {}), ...(route === 'seed' ? { summary } : {}) },
          [KIND.ISSUE],
          { newId: id, contentFormat: body?.contentFormat },
        )
        const created = { result, id, addr }
        published(created.result, `a new issue in ${project.title}`)
        const summarized =
          route === 'change'
            ? await setField(context, state, { addr, author: context.signer.pubkey, folder }, 'summary', summary, 'Summary')
            : undefined
        if (summarized) published(summarized, `the summary of "${title}" — the issue itself was created, ${addr}, without one`)
        const mentioned = await publishMentionAdds(context, adds, `The issue "${title}" (${addr})`)

        // The same line every other write echoes, so the short id the next
        // command needs is on screen without a `show` (MAK-2).
        return {
          state: issueLine({ ref: NO_REF, id: created.id, status: state.vocab.issue.fallback, comments: [] }, undefined),
          created: { short: short(created.id), addr: created.addr, title, ...(summary ? { summary } : {}), project: project.title },
          eventId: created.result.eventId,
          ...mentioned,
          ...(summaryWarning(summary) ? { note: summaryWarning(summary) } : {}),
        }
      },
    },
  ],
}
