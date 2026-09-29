/**
 * Ship, as an agent reads it.
 *
 * The per-app half of the seam in `../cli.ts`. Everything that knows Ship has
 * projects, issues and change events lives here; nothing generic knows any of
 * it. A second app is a sibling of this file, not a fork of the runner.
 *
 * It reads through `Store` and `foldFolder` rather than querying the relay
 * directly, deliberately. The fold is the part with the subtle rules in it —
 * change ordering, re-linked Folders, a status set by somebody who did not
 * author the issue — and an agent that reimplemented any of that would drift
 * from what the app shows a person. The whole value of this CLI is that it and
 * `ship.estiva.app` agree.
 */
import { Store, nextRef, refPrefix, type WorkspaceState } from '../../../src/store'
import type { FolderState, Issue, Project } from '../../../src/fold'
import { conversationsAbout } from '../../../src/fold'
import {
  DEFAULT_ISSUE_STATUS,
  ISSUE_STATUSES,
  KIND,
  PROJECT_STATUSES,
  lookupStatus,
} from '../../../src/kinds'
import type { Directory } from '../../../src/profiles'
import { BadRequest, flagValue, type AgentApp, type AgentContext, type ParsedArgs } from '../cli'
import { edited, findMessage } from '../conversation'
import { resolveMaybe, resolveOne, short } from '../resolve'
import { KIND as PROTOCOL_KIND } from '@estiva-app/protocol'
import { listFolders, type FolderSummary } from '@estiva-app/interop'

const store = (context: AgentContext) => new Store(context.relay, context.signer)

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
 * Everything a status value should say when printed.
 *
 * `lookupStatus` returns the raw value for anything outside the vocabulary
 * rather than swallowing it, and that is preserved here: another app may have
 * written a status Ship has never heard of, and showing `todo` instead would be
 * inventing agreement that does not exist.
 */
const status = (vocab: typeof ISSUE_STATUSES, value: string) => lookupStatus(vocab, value).label
/** The label back to its value — what `set-status` takes — for a text row. */
const statusValue = (vocab: typeof ISSUE_STATUSES, label: string) =>
  vocab.find((entry) => entry.label === label)?.value ?? label

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
export function issueRow(issue: ReturnType<typeof issueSummary>): string {
  return [
    issue.ref.padEnd(8),
    statusValue(ISSUE_STATUSES, issue.status).padEnd(12),
    issue.short,
    clip(issue.title, ROW_TITLE),
  ].join(' ')
}

export function projectRow(project: ReturnType<typeof projectSummary> & { issues: number }): string {
  return [
    project.short,
    statusValue(PROJECT_STATUSES, project.status).padEnd(12),
    `${String(project.issues).padStart(3)} issues`,
    clip(project.title, ROW_TITLE) + (project.archived ? ' (archived)' : ''),
    project.lead ? `— ${project.lead}` : '',
  ].join(' ').trimEnd()
}

/** Enough to answer "what happened" without returning the workspace's whole history. */
const DEFAULT_ACTIVITY = 50

/** Long enough to tell one project from another, short enough to list 14. */
const BLURB = 200

function projectSummary(project: Project, directory: Directory) {
  return {
    ref: project.addr,
    short: short(project.id),
    title: project.title,
    status: status(PROJECT_STATUSES, project.status),
    lead: who(directory, project.lead),
    archived: project.archived || undefined,
    folder: project.contentFolder,
    /*
      Said in the listing, not only in `show` (FOL-20). `folder` is where the
      project's *work* is, and after a re-link that is not where its record
      is — the record keeps the `h` it was filed with, and a change published
      anywhere else is accepted by the relay and then invisible to a reader of
      the record's own Folder. Fourteen projects linked to five team Folders is
      fourteen chances to get that wrong, and this is what makes the move
      checkable from the one command everybody runs first.
    */
    relinked: project.contentFolder !== project.originFolder || undefined,
    recordFolder: project.contentFolder !== project.originFolder ? project.originFolder : undefined,
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
    description:
      project.description.length > BLURB ? `${project.description.slice(0, BLURB)}…` : project.description,
    descriptionTruncated: project.description.length > BLURB || undefined,
    issues: undefined as number | undefined,
  }
}

function issueSummary(issue: Issue, directory: Directory) {
  return {
    ref: issue.ref ?? issue.addr,
    // Printed in every listing so the next command can name the issue by it
    // rather than by a ref that collides (SHI-4) or an address typed from
    // memory. Every resolver here accepts it back.
    short: short(issue.id),
    addr: issue.addr,
    title: issue.title,
    status: status(ISSUE_STATUSES, issue.status),
    assignee: who(directory, issue.assignee),
    author: who(directory, issue.author),
    project: issue.projectAddr,
  }
}

/** Everyone named anywhere in what we are about to print, resolved in one call. */
async function directoryFor(
  context: AgentContext,
  pubkeys: (string | undefined)[],
): Promise<Directory> {
  const wanted = [...new Set(pubkeys.filter((key): key is string => Boolean(key)))]
  return wanted.length ? store(context).profiles(wanted) : new Map()
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
}

/** The project planner's original name for the shape above. */
export type ProjectEdit = FieldEdit

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
export function projectEdits(project: Project, args: ParsedArgs, self: string): FieldEdit[] {
  const edits: FieldEdit[] = []

  const title = flagValue(args, 'title')
  if (title !== undefined) {
    if (!title.trim()) throw new BadRequest('--title cannot be empty. A project nobody can name is a project nobody finds.')
    edits.push({ field: 'title', from: project.title, value: title, note: 'Rename' })
  }

  const description = flagValue(args, 'description')
  if (description !== undefined) {
    edits.push({ field: 'description', from: project.description, value: description, note: 'Description' })
  }

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
    if (!PROJECT_STATUSES.some((entry) => entry.value === wanted)) {
      throw new BadRequest(
        `Unknown project status "${status}". Try: ${PROJECT_STATUSES.map((entry) => entry.value).join(', ')}`,
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
    throw new BadRequest('edit-project needs at least one of --title, --description, --status or --lead.')
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

export function issueEdits(issue: Issue, args: ParsedArgs, projects: Project[]): FieldEdit[] {
  const edits: FieldEdit[] = []

  const title = flagValue(args, 'title')
  if (title !== undefined) {
    if (!title.trim()) throw new BadRequest('--title cannot be empty. An issue nobody can name is an issue nobody finds.')
    edits.push({ field: 'title', from: issue.title, value: title, note: 'Rename' })
  }

  const description = flagValue(args, 'description')
  if (description !== undefined) {
    edits.push({ field: 'description', from: issue.description, value: description, note: 'Description' })
  }

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
    throw new BadRequest('edit-issue needs at least one of --title, --description or --project.')
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

export function statusesFor(requested: string): readonly string[] {
  const alias = STATUS_ALIASES[requested]
  if (alias) return alias
  if (ISSUE_STATUSES.some((entry) => entry.value === requested)) return [requested]

  // Refused rather than returned empty: "no issues" and "you asked for a status
  // that does not exist" look identical in an empty array, and only one of them
  // means the work is done.
  throw new BadRequest(
    `Unknown status "${requested}". Try: ${ISSUE_STATUSES.map((s) => s.value).join(', ')}, ` +
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
  const state = await store(context).loadAll()
  const issue = findIssue(state.issues, reference)
  return { state, issue }
}

/** How much of the last comment a one-line echo quotes, and `status` returns. */
const LINE_QUOTE = 80
const LAST_COMMENT = 200

/** One line of text, whitespace collapsed, cut with an ellipsis past `max`. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Every comment about one object, oldest first, each body as it stands now. */
function commentsOn(state: WorkspaceState, addr: string) {
  return conversationsAbout(state.conversations, addr)
    .flatMap((thread) => [thread.root, ...thread.replies])
    .map((message) => ({
      id: message.id,
      author: message.author,
      at: message.ts ?? message.createdAt * 1000,
      body: edited(state.edits, message).body,
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
    issue.status || DEFAULT_ISSUE_STATUS,
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
  state: WorkspaceState,
  issue: Issue,
  after: { status?: string; assignee?: string | null; comment?: string },
) {
  const assignee = after.assignee === undefined ? issue.assignee : after.assignee || undefined
  const directory = await directoryFor(context, [assignee])
  const comments = commentsOn(state, issue.addr)
  if (after.comment !== undefined) {
    comments.push({ id: '', author: context.signer.pubkey, at: Date.now(), body: after.comment })
  }
  return issueLine(
    {
      ref: issue.ref ?? issue.addr,
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
 * A Folder by name or id, from the create events on the relay.
 *
 * `link-project --folder`'s lookup, through `resolveOne` like every other
 * reference (CLAUDE.md): an ambiguous name is refused with the candidates,
 * never guessed.
 */
async function resolveFolder(context: AgentContext, reference: string): Promise<{ folder: string; name: string }> {
  const events = await context.relay.queryAll([{ kinds: [KIND.FOLDER] }])
  const channels = events.map((event) => ({
    folder: event.tags.find((tag) => tag[0] === 'h')?.[1] ?? '',
    name: event.tags.find((tag) => tag[0] === 'name')?.[1] ?? '',
  }))
  return resolveOne(
    channels.filter((channel) => channel.folder),
    reference,
    {
      noun: 'folder',
      exact: (channel) => [channel.folder],
      text: (channel) => channel.name,
      label: (channel) => `${channel.name} (${channel.folder.slice(0, 8)}…)`,
      hint: 'Pass a Folder name or id.',
    },
  )
}

/**
 * Every Folder this credential can see, and whether each has state — the read
 * Ship's sidebar and its New project dialog make (`readFolders`), so the two
 * agree on what a team is and on `hasState`, which a `kind:1852` must never
 * guess: an `add` to a Folder without state emits state listing only that one
 * file, and everything already in it disappears.
 */
function readFolders(context: AgentContext): Promise<FolderSummary[]> {
  return listFolders((filters) => context.relay.queryAll(filters as never))
}

/**
 * A team by name or Folder id (FOL-47): the Folders with state that no other
 * Folder lists — `topLevelFolders` in Ship and Peek, the five a person sees.
 */
async function resolveTeam(context: AgentContext, reference: string): Promise<FolderSummary> {
  const teams = (await readFolders(context)).filter((folder) => folder.hasState && !folder.listedIn?.length)
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
  state: WorkspaceState,
  addr: string,
  extraPubkeys: (string | undefined)[],
) {
  const conversations = conversationsAbout(state.conversations, addr)
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
        ...edited(state.edits, message),
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
 *
 * Both Folders are named, not just the content one. They differ for every
 * project that was re-linked to a Peek topic, and which of the two an event
 * carries decides whether anyone reading the project ever sees it.
 */
async function showProject(context: AgentContext, state: WorkspaceState, project: Project) {
  const issues = state.issues.filter((issue) => issue.projectAddr === project.addr)
  const { directory, history, conversation } = await timelineFor(context, state, project.addr, [
    project.author,
    project.lead,
    ...issues.map((issue) => issue.assignee),
    ...issues.map((issue) => issue.author),
  ])

  return {
    kind: 'project' as const,
    addr: project.addr,
    title: project.title,
    status: status(PROJECT_STATUSES, project.status),
    lead: who(directory, project.lead),
    author: who(directory, project.author),
    archived: project.archived || undefined,
    description: project.description,
    createdAt: new Date(project.createdAt * 1000).toISOString(),
    folders: {
      content: project.contentFolder,
      record: project.originFolder,
      // Worth saying out loud rather than leaving to be compared: a change to
      // the record published into the content Folder is accepted by the relay
      // and then invisible to anything reading the record's own Folder.
      relinked: project.contentFolder !== project.originFolder || undefined,
    },
    issues: issues.map((issue) => issueSummary(issue, directory)),
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
 * **The set is "everyone who has touched something readable", not "the team".**
 * There is no roster on the relay to ask — membership is an Estiva ID concern
 * and this identity cannot read it — so a person who has never filed, been
 * assigned, led or commented does not appear here at all. The command says so
 * rather than letting an empty-looking answer read as "they are not on the
 * team".
 */
export function participants(state: FolderState): Participant[] {
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

  // Busiest first: the person somebody is looking for is usually the person
  // doing things, and a stable order beats map insertion order.
  return [...seen.values()].sort(
    (a, b) =>
      b.filed + b.assigned + b.leads + b.acted - (a.filed + a.assigned + a.leads + a.acted) ||
      a.pubkey.localeCompare(b.pubkey),
  )
}

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
      lines(result: { projects: Parameters<typeof projectRow>[0][]; hidden: { note?: string } }) {
        // The hidden-archived note survives the text form: a listing that
        // drops it is exactly the "every project" claim the note exists to stop.
        return [...result.projects.map(projectRow), ...(result.hidden.note ? [result.hidden.note] : [])]
      },
      async run(context, args) {
        const state = await store(context).loadAll()
        const directory = await directoryFor(context, state.projects.map((p) => p.lead))

        const archived = state.projects.filter((project) => project.archived)
        const wanted = args.flags.archived ? state.projects : archivedRemoved(state.projects)

        return {
          projects: wanted.map((project) => ({
            ...projectSummary(project, directory),
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
      usage: 'issues [--project <ref>] [--status <value>] [--json]',
      lines(result: { issues: Parameters<typeof issueRow>[0][]; coverage: { unreachable: number; note?: string } }) {
        return [
          ...result.issues.map(issueRow),
          `${result.issues.length} listed`,
          ...(result.coverage.note ? [result.coverage.note] : []),
        ]
      },
      async run(context, args) {
        const state = await store(context).loadAll()
        const wantedProject = flagValue(args, 'project')
        const wantedStatus = flagValue(args, 'status')?.toLowerCase()

        const wantedStatuses = wantedStatus ? statusesFor(wantedStatus) : null

        let issues = state.issues
        if (wantedProject) {
          const project = findProject(state.projects, wantedProject)
          issues = issues.filter((issue) => issue.projectAddr === project.addr)
        }
        if (wantedStatuses) {
          issues = issues.filter((issue) =>
            wantedStatuses.includes(issue.status || DEFAULT_ISSUE_STATUS),
          )
        }

        const directory = await directoryFor(
          context,
          issues.flatMap((issue) => [issue.assignee, issue.author]),
        )

        return {
          issues: issues
            .slice()
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((issue) => issueSummary(issue, directory)),
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
        const state = await store(context).loadAll()

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
        const comments = commentsOn(state, issue.addr)
        const last = comments[comments.length - 1]
        const directory = await directoryFor(context, [issue.assignee, last?.author])

        return {
          state: issueLine({ ...issue, ref: issue.ref ?? issue.addr, comments }, who(directory, issue.assignee)),
          ref: issue.ref ?? issue.addr,
          short: short(issue.id),
          addr: issue.addr,
          title: issue.title,
          status: issue.status || DEFAULT_ISSUE_STATUS,
          assignee: who(directory, issue.assignee),
          pullRequest: pullRequestOn([...comments.map((c) => c.body).reverse(), issue.description]),
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

        const state = await store(context).loadAll()

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
        ])

        return {
          kind: 'issue' as const,
          ...issueSummary(issue, directory),
          description: issue.description,
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
        const state = await store(context).loadAll()
        const found = participants(state)
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
            Two limits, both of which make a short list look like a complete
            one.

            There is no roster to read: relay membership is an Estiva ID
            concern this identity cannot query, so somebody who has never filed,
            been assigned, led or commented does not appear at all. Absence here
            is not evidence they are not on the team.

            And a key with no `kind:0` stays a key. Estiva ID is the only writer
            of profiles (PEEK-48), so an unnamed participant is un-named rather
            than un-real — still a valid target for `assign`.
          */
          note:
            'Everyone who has touched something this identity can read — not a roster. ' +
            'A person who has never filed, been assigned, led or commented does not appear. ' +
            (anonymous > 0
              ? `${anonymous} of these publish no profile and stay a key; they can still be assigned.`
              : 'Every one of them publishes a profile.'),
        }
      },
    },
    {
      name: 'comment',
      signs: [KIND.MESSAGE],
      summary: 'add a comment to one issue',
      usage: 'comment <ref> --body "..."',
      async run(context, args) {
        const reference = args.positional[0]
        if (!reference) throw new BadRequest('comment needs an issue reference.')
        const body = flagValue(args, 'body')
        if (!body) throw new BadRequest('comment needs --body.')

        const { state, issue } = await resolveIssueFor(context, reference)
        /*
          Posted into the issue's own Folder and tagged `about` its address, so
          it lands where Peek shows the conversation rather than as a loose
          message. `aboutRef` appends the naddr, which is what makes Peek render
          the issue widget above it.
        */
        const result = await store(context).postMessage({
          folder: issue.folder,
          body,
          about: issue.addr,
        })
        published(result, `a comment on ${issue.ref ?? issue.addr}`)

        // The eventId is kept because it is what `edit-comment --message` takes.
        return { state: await stateAfter(context, state, issue, { comment: body }), eventId: result.eventId }
      },
    },
    {
      name: 'edit-comment',
      signs: [KIND.MESSAGE_EDIT],
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

        const state = await store(context).loadAll()

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
        const messages = conversationsAbout(state.conversations, object.addr).flatMap((thread) =>
          [thread.root, ...thread.replies].map((message) => ({
            id: message.id,
            body: edited(state.edits, message).body,
            folder: message.folder,
          })),
        )
        const message = findMessage(messages, target)

        /*
          The target's own Folder, not the object's — the trap CON-4 named.
          A conversation stays in the Folder it was posted in even after the
          project is re-linked to a Peek topic, and 40003 is channel-scoped, so
          an `h` copied from the page would be refused with `accepted: false`
          while the kind is granted and the signature is fine.
        */
        const result = await store(context).editMessage({
          folder: message.folder,
          messageEventId: message.id,
          body,
        })
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
      signs: [KIND.CHANGE],
      summary: 'set one issue\'s status',
      usage: 'set-status <ref> <status>',
      async run(context, args) {
        const [reference, status] = args.positional
        if (!reference || !status) throw new BadRequest('set-status needs a reference and a status.')

        // Validated against the vocabulary before publishing: a value outside it
        // is displayed rather than swallowed, so a typo becomes a visible bogus
        // status on a real issue instead of an error.
        const wanted = status.toLowerCase()
        if (!ISSUE_STATUSES.some((entry) => entry.value === wanted)) {
          throw new BadRequest(
            `Unknown status "${status}". Try: ${ISSUE_STATUSES.map((s) => s.value).join(', ')}`,
          )
        }

        const { state, issue } = await resolveIssueFor(context, reference)
        const result = await store(context).setField({
          folder: issue.folder,
          target: issue.addr,
          field: 'status',
          value: wanted,
          // Same omission as `assign` had, and the same fix: 115 status changes
          // by this identity carried no note. The vocabulary is the app's.
          note: `Status → ${wanted}`,
        })
        published(result, `a status change on ${issue.ref ?? issue.addr}`)

        return {
          state: await stateAfter(context, state, issue, { status: wanted }),
          from: issue.status || DEFAULT_ISSUE_STATUS,
          eventId: result.eventId,
        }
      },
    },
    {
      name: 'assign',
      signs: [KIND.CHANGE],
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
        const result = await store(context).setField({
          folder: issue.folder,
          target: issue.addr,
          field: 'assignee',
          value: assignee,
          /*
            The note the web UI writes for the same act. Without one the change
            carries an empty `.content`, and the activity feed — which is not
            derived from the state, it *is* the change stream — renders the
            agent's assignments as a blank line where a person's read
            "Assign".

            Measured on production before this: 66 assignee changes by this
            identity, 0 with a note.
          */
          note: assignee ? 'Assign' : 'Unassign',
        })
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
      signs: [KIND.CHANGE],
      summary: 'change an issue’s title, description, or which project it is in',
      usage: 'edit-issue <ref> [--title "..."] [--description "..."] [--project <ref|none>]',
      async run(context, args) {
        const reference = args.positional[0]
        if (!reference) throw new BadRequest('edit-issue needs an issue reference.')

        const state = await store(context).loadAll()
        const issue = findIssue(state.issues, reference)
        const edits = issueEdits(issue, args, state.projects)

        /*
          An issue's changes carry the issue's own Folder — not its project's,
          and deliberately not the rule `edit-project` follows. After a project
          is re-linked, the issues filed before the move still carry the old
          `h`, so “the project's Folder” is the wrong answer for any issue
          older than the re-link. `web/src/api/writes.ts` states the same split.
        */
        const folder = issue.folder
        if (!folder) {
          throw new BadRequest(
            `${issue.ref ?? issue.addr} names no Folder, so a change to it has nowhere to be published.`,
          )
        }

        const applied: { field: string; from: string; to: string; eventId?: string }[] = []
        for (const edit of edits) {
          const result = await store(context).setField({
            folder,
            target: issue.addr,
            field: edit.field,
            value: edit.value,
            note: edit.note,
          })
          if (!result.ok) {
            throw new BadRequest(
              `The relay refused ${edit.field} on ${issue.ref ?? issue.addr}: ${result.reason ?? 'no reason given'}. ` +
                `Already published and standing: ${applied.map((entry) => entry.field).join(', ') || 'nothing'}.`,
            )
          }
          applied.push({ field: edit.field, from: edit.from, to: edit.value, eventId: result.eventId })
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
          ...(conversationStaysBehind ? { note: conversationStaysBehind } : {}),
        }
      },
    },
    {
      name: 'edit-project',
      signs: [KIND.CHANGE],
      summary: 'change a project’s title, description, status or lead',
      usage: 'edit-project <ref> [--title "..."] [--description "..."] [--status <s>] [--lead <key|me|none>]',
      async run(context, args) {
        const reference = args.positional[0]
        if (!reference) throw new BadRequest('edit-project needs a project reference.')

        const state = await store(context).loadAll()
        const project = findProject(state.projects, reference)
        const edits = projectEdits(project, args, context.signer.pubkey)

        /*
          A change to the project *record* carries the Folder that record is in,
          not the Folder its issues are in. The two are the same until somebody
          re-links a project to an existing Peek topic — 3 of the 14 projects on
          production — and `--project` reports the *content* Folder, so the
          reachable-looking choice is the wrong one.

          `apps/ship/views/project.ts` says the wrong Folder is “rejected at
          ingest”. **Measured against production, it is not.** The relay accepts
          a project change published against the content Folder: ok:true, no
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
        const folder = project.originFolder
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
        const applied: { field: string; from: string; to: string; eventId?: string }[] = []
        for (const edit of edits) {
          const result = await store(context).setField({
            folder,
            target: project.addr,
            field: edit.field,
            value: edit.value,
            note: edit.note,
          })
          if (!result.ok) {
            throw new BadRequest(
              `The relay refused ${edit.field} on “${project.title}”: ${result.reason ?? 'no reason given'}. ` +
                `Already published and standing: ${applied.map((entry) => entry.field).join(', ') || 'nothing'}.`,
            )
          }
          applied.push({ field: edit.field, from: edit.from, to: edit.value, eventId: result.eventId })
        }

        return { changed: { title: project.title, addr: project.addr, folder }, applied }
      },
    },
    {
      name: 'link-project',
      signs: [KIND.CHANGE],
      /*
        A record-repair tool, not how a project changes Folder (FOL-3). A
        project is filed into a top-level Folder and placed by that Folder's
        state; this re-points only the record's content Folder and touches no
        Folder's state, so a project a state lists stays drawn under it in
        both apps. (One no state lists is placed by Ship from its content
        Folder, so there it does follow the link; Peek draws it nowhere
        either way.) Moving a project between Folders is FOL-7 (a 1852
        remove and add), not this.
      */
      summary: 'repair a project record whose content Folder is wrong — not how a project moves between Folders',
      usage: 'link-project <ref> --folder <name|id>',
      async run(context, args) {
        const reference = args.positional[0]
        const target = flagValue(args, 'folder')
        if (!reference) throw new BadRequest('link-project needs a project reference.')
        if (!target) throw new BadRequest('link-project needs --folder: a Folder name or id.')

        const state = await store(context).loadAll()
        const project = findProject(state.projects, reference)
        const folder = await resolveFolder(context, target)

        /*
          Nothing is re-created and nothing moves. The record keeps the `h` it
          was filed with, the issues already in the old Folder keep theirs, and
          the change is published twice — into the record's Folder, where every
          reader of this project looks, and into the Folder being linked, so an
          app reading *that* Folder finds the project named from inside it
          (`Store.linkProjectFolder` says why both). Without the second write a
          team Folder linked before any issue is filed in it lists nothing.

          Refused rather than repeated when the project already points there: a
          repeated value folds to the same state, but it is one more activity
          line on the project for no change, and the answer would read as if
          something had moved.
        */
        if (project.contentFolder === folder.folder) {
          throw new BadRequest(
            `“${project.title}” is already linked to ${folder.name || 'that Folder'} (${folder.folder}). Nothing was published.`,
          )
        }
        if (!project.originFolder) {
          throw new BadRequest(
            `“${project.title}” names no Folder for its record, so the link has nowhere to be published.`,
          )
        }

        const result = await store(context).linkProjectFolder({
          recordFolder: project.originFolder,
          project: project.addr,
          folder: folder.folder,
        })
        published(result, `linking “${project.title}” to ${folder.name || folder.folder}`)

        return {
          linked: { title: project.title, addr: project.addr },
          from: project.contentFolder,
          to: { folder: folder.folder, name: folder.name || undefined },
          recordFolder: project.originFolder,
          eventId: result.eventId,
          // The second write is the one a reader of the team Folder depends on,
          // and it can be refused on its own — a restricted Folder would.
          announced: result.announced,
          announceReason: result.announceReason,
          note: `Issues already filed keep their Folder; new ones land in ${folder.name || folder.folder}. \`ship projects\` now reports this project as relinked.`,
        }
      },
    },
    {
      name: 'archive-project',
      signs: [KIND.CHANGE],
      summary: 'hide a project from the lists, or bring it back',
      usage: 'archive-project <ref> [--unarchive]',
      async run(context, args) {
        const reference = args.positional[0]
        if (!reference) throw new BadRequest('archive-project needs a project reference.')

        const state = await store(context).loadAll()
        const project = findProject(state.projects, reference)
        const archived = !args.flags.unarchive

        /*
          The record's Folder, for the reason `edit-project` gives at length:
          publishing against the content Folder is *accepted* by the relay and
          then invisible to anything reading the record's own Folder. An archive
          that half of the readers cannot see is worse than no archive.
        */
        const folder = project.originFolder
        if (!folder) {
          throw new BadRequest(
            `“${project.title}” names no Folder for its record, so a change to it has nowhere to be published.`,
          )
        }

        /*
          Said rather than silently done. Archiving is reversible and this
          command reports how, because the reverse is the thing somebody needs
          at the moment they realise they archived the wrong one — and
          `ship projects` hides the result, so the project they are looking for
          has just disappeared from the listing they would check.
        */
        if (archived && project.archived) {
          return {
            unchanged: { title: project.title, addr: project.addr },
            note: 'That project is already archived. Pass --unarchive to bring it back.',
          }
        }
        if (!archived && !project.archived) {
          return {
            unchanged: { title: project.title, addr: project.addr },
            note: 'That project is not archived, so there is nothing to bring back.',
          }
        }

        const result = await store(context).archiveProject({
          recordFolder: folder,
          project: project.addr,
          archived,
        })
        published(result, `${archived ? 'archiving' : 'unarchiving'} “${project.title}”`)

        const issues = state.issues.filter((issue) => issue.projectAddr === project.addr).length

        return {
          changed: { title: project.title, addr: project.addr, folder },
          archived,
          eventId: result.eventId,
          /*
            Exactly what archiving does, because the obvious guess is wrong and
            it is wrong in the direction that matters.

            Archiving hides the project from `ship projects`. It does **not**
            hide the project's issues: `ship issues` lists `state.issues` with
            no archived filter at all, so all of them keep appearing in the
            default listing, attributed to a project that listing no longer
            shows. Measured on production — 12 issues of an archived project,
            all still listed.

            So this is not a way to tidy issues away, and saying so here is
            cheaper than somebody archiving a project for that purpose and only
            later noticing it did nothing.
          */
          note: archived
            ? `Hidden from \`ship projects\` unless --archived. Its ${issues} issue(s) are NOT hidden — \`ship issues\` has no archived filter and keeps listing them. Reverse with --unarchive; nothing is deleted.`
            : 'Back in the default project listing.',
        }
      },
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
      signs: [KIND.DELETION],
      summary: 'ask the relay to drop an issue record — irreversible',
      usage: 'delete-issue <ref> [--yes] [--reason "…"]',
      async run(context, args) {
        const reference = args.positional[0]
        if (!reference) throw new BadRequest('delete-issue needs an issue reference.')

        const { state, issue } = await resolveIssueFor(context, reference)
        const conversations = conversationsAbout(state.conversations, issue.addr).length
        const survives = `Its ${conversations} conversation(s) are separate events with their own authors and are NOT deleted — they stay in the Folder and stop being reachable from the issue.`

        if (!args.flags.yes) {
          return {
            wouldDelete: { ref: issue.ref, addr: issue.addr, title: issue.title, folder: issue.folder },
            survives,
            note: 'Nothing was published. Pass --yes to send the deletion request.',
          }
        }

        const result = await store(context).deleteIssue({
          folder: issue.folder,
          issue: issue.addr,
          reason: flagValue(args, 'reason'),
        })
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
      signs: [KIND.DELETION, PROTOCOL_KIND.FOLDER_COMMAND],
      summary: 'ask the relay to drop a project record — irreversible; prefer archive-project',
      usage: 'delete-project <ref> [--yes] [--reason "…"]',
      async run(context, args) {
        const reference = args.positional[0]
        if (!reference) throw new BadRequest('delete-project needs a project reference.')

        const state = await store(context).loadAll()
        const project = findProject(state.projects, reference)
        const issues = state.issues.filter((issue) => issue.projectAddr === project.addr).length

        /*
          `archive-project` refuses without an origin Folder because a change
          event published to the wrong one is accepted and then invisible. A
          deletion has no such failure: its `h` is not what the relay reads, so
          either Folder does — and refusing here would strand exactly the
          object this command exists to remove.
        */
        const folder = project.originFolder ?? project.contentFolder
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
        */
        const team = project.contentFolder
        const hasState = (await readFolders(context)).find((f) => f.id === team)?.hasState ?? false
        const { result, unlisted } = await store(context).deleteProject({
          recordFolder: folder,
          project: project.addr,
          reason: flagValue(args, 'reason'),
          team: { folder: team, hasState },
        })
        published(result, `deleting “${project.title}”`)

        return {
          deleted: { title: project.title, addr: project.addr },
          eventId: result.eventId,
          // Apart from the delete, as Ship reports it: a refused unlist is a
          // deleted project its team still shows a row for.
          unlisted: unlisted ? (unlisted.ok ? { from: team, eventId: unlisted.eventId } : { from: team, refused: unlisted.reason ?? 'no reason given' }) : undefined,
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
      */
      signs: [KIND.PROJECT, PROTOCOL_KIND.FOLDER_COMMAND],
      summary: 'start a new project in a team',
      usage: 'create-project --team <name|folder> --title "..." [--description "..."]',
      async run(context, args) {
        const title = flagValue(args, 'title')
        if (!title) throw new BadRequest('create-project needs --title.')
        const reference = flagValue(args, 'team')
        if (!reference) throw new BadRequest('create-project needs --team: the team the project is filed into.')

        // Resolved against the Folders that have state, so `hasState` is the read's answer.
        const team = await resolveTeam(context, reference)
        const created = await new Store(context.relay, context.signer).createProject({
          title,
          description: flagValue(args, 'description'),
          team: { folder: team.id, hasState: team.hasState },
        })
        published(created.result, `a new project "${title}"`)

        return {
          created: { title, addr: created.addr, team: { id: team.id, name: team.name } },
          eventId: created.result.eventId,
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
      signs: [KIND.ISSUE],
      summary: 'file one new issue in a project',
      usage: 'create-issue --project <ref> --title "..." [--description "..."]',
      async run(context, args) {
        const projectRef = flagValue(args, 'project')
        const title = flagValue(args, 'title')
        if (!projectRef) throw new BadRequest('create-issue needs --project.')
        if (!title) throw new BadRequest('create-issue needs --title.')

        const state = await store(context).loadAll()
        const project = findProject(state.projects, projectRef)

        // The display key is derived from what is currently visible, so it can
        // collide — the address is the identity and this is decoration. Derived
        // here rather than left blank so the issue looks like its siblings.
        const siblings = state.issues.filter((issue) => issue.projectAddr === project.addr)
        const ref = nextRef(refPrefix(project.title), siblings.map((issue) => issue.ref))

        const created = await store(context).createIssue({
          folder: project.contentFolder,
          title,
          description: flagValue(args, 'description'),
          projectAddr: project.addr,
          ref,
        })
        published(created.result, `a new issue in ${project.title}`)

        // The same line every other write echoes, so the short id the next
        // command needs is on screen without a `show` (MAK-2).
        return {
          state: issueLine({ ref, id: created.id, status: DEFAULT_ISSUE_STATUS, comments: [] }, undefined),
          created: { ref, short: short(created.id), addr: created.addr, title, project: project.title },
          eventId: created.result.eventId,
        }
      },
    },
  ],
}
