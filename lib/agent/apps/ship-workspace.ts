/**
 * Ship's workspace, read the way any other app reads it — PER-21.
 *
 * Until PER-21 the agent folded Ship's events with a copy of Ship's own code
 * (`src/`), held to Ship by `diff -r` and a conformance fixture. Now the only
 * Ship-specific knowledge here is the two kinds that hold its objects; what a
 * project or an issue *says* comes from Ship's published manifest, folded by
 * `@estiva-app/interop` exactly as Peek folds it, and conversations come from
 * `@estiva-app/conversation` and interop's conversation reads, as `peek topic`
 * reads them. If the agent and Ship disagree about an object now, Ship's
 * manifest is what is wrong — which is how PER-21 found that a renamed issue's
 * title was never declared as folded (ship#231).
 *
 * The cost is three paged reads for the workspace (roots, their changes, the
 * authors' handler recommendations) and two per kind for the manifest, then a
 * pure projection (`projectEvents`). `resolveForeignObjects` would be the same
 * answer at about a hundred POSTs per command.
 */
import {
  contentFormatOf,
  conversationsOf,
  createProjectionCache,
  folderOf,
  projectEvents,
  resolveManifest,
  threadsOf,
  type Archive,
  type FolderSummary,
  type ForeignObject,
  type ProjectionCache,
  type QueryFn,
  type ResolvedManifest,
} from '@estiva-app/interop'
import { byOrder, decorationsOf, KIND_CHANGE, trustedTs, type EditFold } from '@estiva-app/conversation'
import type { ContentFormat, SignedEvent } from '@estiva-app/protocol'
import type { AgentContext } from '../cli'
import { loadQuery, relayQuery } from '../act-on-file'

/** The kinds Ship's objects are — what `ship` lists. Everything else is the manifest's. */
export const KIND = { PROJECT: 30850, ISSUE: 30851 } as const
/** NIP-89's handler recommendation: "for this kind, I use that app". */
const KIND_HANDLER_RECOMMENDATION = 31989

const tagValue = (event: SignedEvent, name: string) => event.tags.find((tag) => tag[0] === name)?.[1]

export { relayQuery }

/** One status vocabulary, as the manifest declares it. */
export interface Vocabulary {
  entries: readonly { value: string; label: string }[]
  /** The slot's `default` — what an object that never had a status change is. */
  fallback: string
}

export interface Project {
  addr: string
  id: string
  author: string
  createdAt: number
  title: string
  /** Its one-line summary (SPEC §6.12); absent when it has none. */
  summary?: string
  description: string
  /** The model `description` is written in (§13.4): a block document from Ship's editor, or marker text. */
  descriptionFormat?: ContentFormat
  /** The raw vocabulary value, as `set-project-status` takes it. */
  status: string
  lead?: string
  /** The prefix of its issues' refs (SHI-4, SPEC §6.1), when it has one yet. */
  key?: string
  /** Archived itself or with its Folder — what the listings hide. */
  archived: boolean
  /** The archive in force: its own, or its Folder's with `with` naming the Folder. */
  archive?: Archive
  /** Its own archive only — what `archive --unarchive` can undo here. */
  ownArchive?: Archive
  /** The Folder the record names (`buzz-channel`, else `h`) — where changes to it are published. */
  contentFolder: string
}

export interface Issue {
  addr: string
  id: string
  author: string
  createdAt: number
  title: string
  /** Its one-line summary (SPEC §6.12); absent when it has none. */
  summary?: string
  description: string
  /** The model `description` is written in (§13.4): a block document from Ship's editor, or marker text. */
  descriptionFormat?: ContentFormat
  status: string
  assignee?: string
  /** Ship's display key — absent until Ship numbers an issue somebody else filed. */
  ref?: string
  /** The project it is listed under, after any move. */
  projectAddr?: string
  /** The issue's own `h`: where its changes and its conversation are published. */
  folder: string
  /** Archived itself or with its project — what `ship issues` hides. */
  archived: boolean
  /** The archive in force: its own, or its project's with `with` naming the project. */
  archive?: Archive
  /** Its own archive only — what `archive --unarchive` can undo here. */
  ownArchive?: Archive
  /** When the status change that won was made, epoch ms — absent if it never changed. */
  statusChangedAt?: number
}

/**
 * FOL-46's cascade, read and never written: an issue is archived with its
 * project, and a project with its Folder when every Folder that lists it is
 * archived — placed as Ship's sidebar places it, by the states that list it,
 * else by the Folder its record names. Ship's `archivesOf` reads the same.
 *
 * `folders` is `listFolders`' whole answer, archived ones included. Without
 * it only the project→issue half applies, which is what a read that never
 * listed Folders can honestly say.
 */
export function cascadeArchives(workspace: Pick<Workspace, 'projects' | 'issues'>, folders: readonly FolderSummary[] = []): void {
  for (const project of workspace.projects) {
    let archive = project.ownArchive
    if (!archive) {
      const listing = folders.filter((folder) => folder.addresses?.includes(project.addr))
      const placed = listing.length ? listing : folders.filter((folder) => folder.id === project.contentFolder)
      // A record channel is archived "with" its own record; that is the project's own archive, already read.
      const archivedFolder =
        placed.length && placed.every((folder) => folder.archived && folder.archived.with !== project.addr) ? placed[0] : undefined
      if (archivedFolder?.archived) archive = { ...archivedFolder.archived, with: archivedFolder.channel ?? archivedFolder.id }
    }
    project.archive = archive
    project.archived = Boolean(archive)
  }
  const byAddr = new Map(workspace.projects.map((project) => [project.addr, project]))
  for (const issue of workspace.issues) {
    const project = issue.projectAddr ? byAddr.get(issue.projectAddr) : undefined
    issue.archive = issue.ownArchive ?? (project?.archive ? { ...project.archive, with: project.addr } : undefined)
    issue.archived = Boolean(issue.archive)
  }
}

/** One `kind:1851`, as written — the change stream is the activity feed. */
export interface Change {
  id: string
  author: string
  createdAt: number
  /** The `ts` tag in epoch ms, when the change carried one. */
  ts?: number
  target: string
  field: string
  value: string
  note: string
  /** How `value` is written, when it is a text save — what prints it as text. */
  format: ContentFormat
}

export interface Workspace {
  projects: Project[]
  issues: Issue[]
  /** Every change to a Ship object, oldest first in SPEC §6.3's order. */
  activity: Change[]
  vocab: { project: Vocabulary; issue: Vocabulary }
  /** The manifest each object was read through, by its author — what a write acts with. */
  manifestFor(addr: string): ResolvedManifest | undefined
  /** The projected objects themselves, by address — for interop calls that want one. */
  objects: Map<string, ForeignObject>
  cache: ProjectionCache
}

const pointerOf = (address: string) => {
  const [kind, pubkey, ...rest] = address.split(':')
  return { kind: Number(kind), pubkey, identifier: rest.join(':'), relays: [] as string[] }
}

/**
 * The manifest for every root, per author, as `resolveManifest` answers it —
 * without asking it once per author.
 *
 * `resolveManifest` reads the author's own `kind:31989` first and falls back to
 * the newest manifest claiming the kind, so for an author who recommends
 * nothing the answer depends on the kind alone. Production has no
 * recommendation for Ship's kinds at all (2026-10-02). So: one resolution per
 * kind shared by everybody who has none, asked for a key that recommends
 * nothing before the roots are in (APP-6); one read for every author's
 * recommendations; and a resolution of their own for anybody who has one.
 */
async function manifestsFor(roots: Promise<readonly SignedEvent[]> | readonly SignedEvent[], query: QueryFn, cache: ProjectionCache) {
  const kinds: number[] = [KIND.PROJECT, KIND.ISSUE]
  // Resolved even when no root of the kind exists yet: an identity filing its first project acts with it.
  const sharing = Promise.all(kinds.map((kind) => resolveManifest(pointerOf(`${kind}:${NOBODY}:`), query, cache)))
  sharing.catch(() => {}) // a refusal is met where it is awaited
  const authors = [...new Set((await roots).map((root) => root.pubkey))]
  const recommendations = authors.length
    ? await query([{ kinds: [KIND_HANDLER_RECOMMENDATION], authors, '#d': kinds.map(String) }])
    : []
  const recommends = new Set(recommendations.map((event) => `${tagValue(event, 'd')}:${event.pubkey}`))

  const resolved = new Map<string, ResolvedManifest | undefined>()
  // Side by side: each is a few round trips, and in sequence they were a second of `show` (APP-6).
  await Promise.all(
    [...recommends].map(async (key) => {
      const [kind, author] = key.split(':')
      resolved.set(`${kind}:${author}`, (await resolveManifest(pointerOf(`${kind}:${author}:`), query, cache)) ?? undefined)
    }),
  )
  const shared = new Map((await sharing).map((manifest, i) => [kinds[i], manifest ?? undefined]))
  return {
    of: (pointer: { kind: number; pubkey: string }) =>
      recommends.has(`${pointer.kind}:${pointer.pubkey}`) ? resolved.get(`${pointer.kind}:${pointer.pubkey}`) : shared.get(pointer.kind),
    /** What an author who recommends nothing reads a kind with — the workspace's vocabulary. */
    shared: (kind: number) => shared.get(kind),
    all: () => [...shared.values(), ...resolved.values()].filter((m): m is ResolvedManifest => m !== undefined),
  }
}

/** A key nobody holds, so `resolveManifest` finds no recommendation and answers for the kind alone. */
const NOBODY = '0'.repeat(64)

/** NIP-01's rule between two versions of one addressable event: later `created_at`, then the lower id. */
const newer = (a: SignedEvent, b: SignedEvent) => a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id)

/** A status vocabulary off the manifest's status slot for a kind. */
function vocabularyOf(resolved: ResolvedManifest | undefined, kind: number): Vocabulary {
  const spec = resolved?.manifest.projections?.[String(kind)]?.slots?.status as { map?: string; default?: string } | undefined
  const entries = (spec?.map && resolved?.manifest.vocabularies?.[spec.map]) || []
  return { entries: entries.map(({ value, label }) => ({ value, label })), fallback: spec?.default ?? entries[0]?.value ?? '' }
}

/** A slot's label back to the value it came from — the slot carries the label, a write takes the value. */
function rawStatus(object: ForeignObject, vocab: Vocabulary): string {
  const shown = object.slots.status?.value
  if (shown === undefined || shown === '') return vocab.fallback
  return vocab.entries.find((entry) => entry.label === shown)?.value ?? shown
}

const metaValue = (object: ForeignObject, field: string) => object.meta.find((slot) => slot.field === field)?.value || undefined

/**
 * Every Ship project and issue, folded through Ship's manifest, with the change stream.
 * `query` is the load's, when the workspace is read beside other reads of the same load (APP-2).
 */
export async function loadWorkspace(context: AgentContext, query: QueryFn = loadQuery(context)): Promise<Workspace> {
  const cache = createProjectionCache()
  // SPEC's change kind, which holds every file's archive, is asked beside the
  // roots rather than after the manifests: a Folder listing in the same load
  // asks its files' changes about two seconds in, and is answered from this
  // read only if it has been asked by then (APP-6). The read below joins it.
  const early = query([{ kinds: [KIND_CHANGE] }])
  early.catch(() => {}) // a refusal is met by the read below
  const roots = await readRoots(query)
  const manifests = await manifestsFor(roots, query, cache)
  const changes = await query([{ kinds: changeKindsOf(manifests) }])
  return foldWorkspace(roots, changes, manifests, cache)
}

/** Every Ship project and issue root — 903 were 2.7 MB on 28 Oct, against 41 MB of changes. */
export function readRoots(query: QueryFn): Promise<SignedEvent[]> {
  return query([{ kinds: [KIND.PROJECT, KIND.ISSUE] }])
}

/**
 * A reader of some Ship files, each folded exactly as {@link loadWorkspace}
 * folds it, from its own changes alone (APP-6). `roots` is
 * {@link readRoots}' answer; the manifests that fold them are asked for at
 * once, before the caller knows which files it wants. A call's answer holds
 * only the files it names, so a project's issues are only those named with it.
 */
export function filesReader(query: QueryFn, roots: Promise<readonly SignedEvent[]>): (addresses: readonly string[]) => Promise<Workspace> {
  const cache = createProjectionCache()
  const manifests = manifestsFor(roots, query, cache)
  manifests.catch(() => {}) // a refusal is met by the read that awaits it
  return async (addresses) => {
    const wanted = new Set(addresses)
    const theirs = (await roots).filter((root) => wanted.has(addressOf(root)))
    const byTarget = (kinds: number[]) => (kinds.length && wanted.size ? query([{ kinds, '#a': [...wanted] }]) : Promise.resolve([]))
    // Each file's manifest as its own author resolves it, into the cache its conversation is read through next.
    const owners = [...new Set(theirs.map((root) => `${root.kind}:${root.pubkey}:`))]
    // The change kind is asked beside the manifests; one declaring another kind is read after.
    const [resolved, changes] = await Promise.all([
      manifests,
      byTarget([KIND_CHANGE]),
      ...owners.map((owner) => resolveManifest(pointerOf(owner), query, cache)),
    ])
    const more = await byTarget(changeKindsOf(resolved).filter((kind) => kind !== KIND_CHANGE))
    return foldWorkspace(theirs, [...changes, ...more], resolved, cache)
  }
}

const addressOf = (root: SignedEvent) => `${root.kind}:${root.pubkey}:${tagValue(root, 'd')}`

/** SPEC's change kind, and any other every manifest in play declares — Ship's is one kind for both. */
function changeKindsOf(manifests: Manifests): number[] {
  return [
    ...new Set([KIND_CHANGE, ...manifests.all().flatMap((resolved) => (resolved.manifest.records ? [resolved.manifest.records.changeKind] : []))]),
  ]
}

type Manifests = Awaited<ReturnType<typeof manifestsFor>>

function foldWorkspace(roots: readonly SignedEvent[], read: readonly SignedEvent[], manifests: Manifests, cache: ProjectionCache): Workspace {
  const manifestOf = manifests.of
  // Every change to a Ship object, including one whose record is gone — a
  // deleted project's history is still history, and `activity` lists it.
  const shipKind = (target: string | undefined) =>
    target !== undefined && (target.startsWith(`${KIND.PROJECT}:`) || target.startsWith(`${KIND.ISSUE}:`))
  const changes = read.filter((event) => shipKind(tagValue(event, 'a')))

  const objects = new Map(projectEvents([...roots, ...changes], manifestOf).map((object) => [object.address!, object]))
  // The version `projectEvents` folded, so the author, date and Folder printed are that version's.
  const rootOf = new Map<string, SignedEvent>()
  for (const root of roots) {
    const addr = `${root.kind}:${root.pubkey}:${tagValue(root, 'd')}`
    const held = rootOf.get(addr)
    if (!held || newer(root, held)) rootOf.set(addr, root)
  }
  const vocab = {
    project: vocabularyOf(manifests.shared(KIND.PROJECT), KIND.PROJECT),
    issue: vocabularyOf(manifests.shared(KIND.ISSUE), KIND.ISSUE),
  }
  // Each object's status label goes back to a value through its own manifest's vocabulary.
  const vocabOf = (root: SignedEvent) => {
    const resolved = manifestOf(root)
    return resolved === manifests.shared(root.kind) ? (root.kind === KIND.PROJECT ? vocab.project : vocab.issue) : vocabularyOf(resolved, root.kind)
  }

  const projects: Project[] = []
  const issues: Issue[] = []
  for (const [addr, object] of objects) {
    const root = rootOf.get(addr)!
    const base = {
      addr,
      id: pointerOf(addr).identifier,
      author: root.pubkey,
      createdAt: root.created_at,
      title: object.slots.title?.value ?? '',
      // Every file kind's `subtitle` is its summary, built into interop (SPEC
      // §7.2, §6.12), so Ship's manifest need not declare it.
      summary: object.slots.subtitle?.value,
      description: object.slots.body?.value ?? '',
      descriptionFormat: object.slots.body?.format,
    }
    if (object.kind === KIND.PROJECT) {
      projects.push({
        ...base,
        status: rawStatus(object, vocabOf(root)),
        lead: metaValue(object, 'lead'),
        key: metaValue(object, 'key'),
        archived: Boolean(object.archived),
        ownArchive: object.archived,
        contentFolder: folderOf(root) ?? '',
      })
    } else {
      issues.push({
        ...base,
        status: rawStatus(object, vocabOf(root)),
        assignee: metaValue(object, 'assignee'),
        ref: metaValue(object, 'ref'),
        projectAddr: object.parentRef || undefined,
        folder: tagValue(root, 'h') ?? '',
        archived: Boolean(object.archived),
        ownArchive: object.archived,
      })
    }
  }
  cascadeArchives({ projects, issues })

  const activity = [...changes].sort(byOrder).flatMap((event): Change[] => {
    const field = tagValue(event, 'field')
    const value = tagValue(event, 'value')
    if (!field || value === undefined) return []
    const ts = Number.parseInt(tagValue(event, 'ts') ?? '', 10)
    return [{
      id: event.id,
      author: event.pubkey,
      createdAt: event.created_at,
      ts: Number.isFinite(ts) ? ts : undefined,
      target: tagValue(event, 'a')!,
      field,
      value,
      note: event.content,
      format: contentFormatOf(event),
    }]
  })

  /*
    When each issue reached the status it is in: the last change, in the fold's
    order, that set the value the fold settled on — so a later change the fold
    did not apply cannot move it. `ts` only when SPEC §6.2 trusts it (inside
    the event's own second); a back-dated `ts` would otherwise make an issue
    closed today read as closed weeks ago, and `/sweep` archives by this date.
  */
  const statusAt = new Map<string, number>()
  const current = new Map(issues.map((issue) => [issue.addr, issue.status]))
  for (const change of activity) {
    if (change.field !== 'status' || change.value !== current.get(change.target)) continue
    statusAt.set(change.target, changedAt(change))
  }
  for (const issue of issues) issue.statusChangedAt = statusAt.get(issue.addr)

  return {
    projects,
    issues,
    activity,
    vocab,
    manifestFor: (addr) => manifestOf(pointerOf(addr)),
    objects,
    cache,
  }
}

/**
 * When a change was made, epoch ms: its `ts` only when SPEC §6.2 trusts it
 * (inside the event's own second, as the fold orders it), `created_at`
 * otherwise. A planted `ts` would back-date a change, or, past what a date
 * can hold, make the file unprintable.
 */
export const changedAt = (change: Pick<Change, 'ts' | 'createdAt'>): number =>
  change.ts !== undefined && Math.floor(change.ts / 1000) === change.createdAt ? change.ts : change.createdAt * 1000

/** One message of a conversation, as the agent prints it. */
export interface Message {
  id: string
  author: string
  body: string
  createdAt: number
  /** Epoch ms from the `ts` tag, when SPEC §6.2 lets a reader trust it. */
  ts?: number
  kind: number
  /** The event's own `h` — what a `kind:40003` naming it must carry. */
  folder?: string
}

export interface Conversation {
  id: string
  root: Message
  replies: Message[]
}

/** The most events one `#e` read of a chunk of conversations asks for. */
const THREAD_LIMIT = 1000

export const asMessage = (event: SignedEvent): Message => ({
  id: event.id,
  author: event.pubkey,
  body: event.content,
  createdAt: event.created_at,
  ts: trustedTs(event),
  kind: event.kind,
  folder: tagValue(event, 'h'),
})

/**
 * The conversations on some objects, as Peek's file page draws them — three
 * reads however many objects (`peek topic`'s read, for a set):
 *
 * 1. The roots: `conversationsOf`, the `#a` read, keeping only what SPEC §6.4
 *    calls a comment on the object — a message that merely names it is
 *    *Mentioned in*, not its discussion.
 * 2. Their events and direct replies by `#e` — `threadsOf`, because a reply's
 *    lowercase tags name its parent, not the object (NIP-22).
 * 3. What was done to each message — its edits (`decorationsOf`).
 */
export async function conversationsFor(
  context: AgentContext,
  workspace: Workspace,
  addresses: readonly string[],
): Promise<{ byObject: Map<string, Conversation[]>; edits: Record<string, EditFold> }> {
  const query = relayQuery(context)
  const objects = addresses.flatMap((addr) => {
    const object = workspace.objects.get(addr)
    return object ? [object] : []
  })
  const byObject = new Map<string, Conversation[]>()
  if (objects.length === 0) return { byObject, edits: {} }

  const rootsByObject = await conversationsOf(objects, query, workspace.cache)
  const allRoots = [...new Set(Object.values(rootsByObject).flat().map((message) => message.id))]
  // One `#e` read per chunk of roots; the reference only selects the manifest's comment kinds.
  const roots: Record<string, SignedEvent> = {}
  const replies: Record<string, SignedEvent[]> = {}
  // `threadsOf` does not say when its limit cut the answer, so a chunk that comes
  // back full is split and read again rather than trusted.
  const read = async (chunk: string[]): Promise<void> => {
    const threads = await threadsOf(objects[0].address!, chunk, query, workspace.cache, THREAD_LIMIT)
    const answered = Object.values(threads.replies).reduce((sum, list) => sum + list.length, 0)
    if (answered >= THREAD_LIMIT && chunk.length > 1) {
      const half = Math.ceil(chunk.length / 2)
      await read(chunk.slice(0, half))
      await read(chunk.slice(half))
      return
    }
    Object.assign(roots, threads.roots)
    for (const [id, list] of Object.entries(threads.replies)) replies[id] = list
  }
  for (let i = 0; i < allRoots.length; i += 100) await read(allRoots.slice(i, i + 100))

  for (const object of objects) {
    const ids = (rootsByObject[object.address!] ?? []).map((message) => message.id)
    byObject.set(
      object.address!,
      ids
        .filter((id) => roots[id])
        .map((id) => ({ id, root: asMessage(roots[id]), replies: (replies[id] ?? []).map(asMessage) }))
        // Newest conversation first, as `show` has always listed them.
        .sort((a, b) => (b.root.ts ?? b.root.createdAt * 1000) - (a.root.ts ?? a.root.createdAt * 1000)),
    )
  }

  const messages = [...byObject.values()].flat().flatMap((thread) => [thread.root, ...thread.replies])
  const decorations = messages.length
    ? await decorationsOf(messages.map((message) => ({ id: message.id, at: message.createdAt, body: message.body })), query)
    : { byId: {} as Record<string, { edit?: EditFold }> }
  const edits: Record<string, EditFold> = {}
  for (const [id, decoration] of Object.entries(decorations.byId)) if (decoration.edit) edits[id] = decoration.edit
  return { byObject, edits }
}
