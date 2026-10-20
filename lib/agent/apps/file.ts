/**
 * Any file, by its address — whichever app it belongs to (SUM-8, c1ba8058).
 *
 * Ship's issues and projects and Peek's topics have verbs of their own, found
 * by title. A file of an app with no module here — a Leaf document — had no way
 * to be written at all, so these take the address and ask the file's own
 * manifest how (§7.3), the way Peek's `applyActionAsViewer` does for any kind.
 * They name no kind and no app: a new app's files take a summary, a text and
 * comments with nothing added here, and `create` finds the type by the noun its
 * own app's manifest gives it ("document").
 *
 * The text is the same block round-trip as `ship edit-*` (AGE-8,
 * `descriptions.ts`): `show` prints it one chunk per block, and `describe`
 * applies the text it is given back so every unchanged block keeps its id and
 * the comments anchored to it stay attached (§13.6). The comments are the
 * file's conversation, read and answered as Peek's are (`conversation.ts`).
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/claude-learns-each-app-from-its-manifest.md
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  buildActionEvents,
  createProjectionCache,
  KIND_CHANNEL_METADATA,
  listFolders,
  resolveActingManifest,
  resolveForeignObject,
  resolveManifest,
  type FolderSummary,
  type ForeignObject,
  type ProjectionCache,
  type ResolvedManifest,
} from '@estiva-app/interop'
import {
  addrToNaddr,
  CONTENT_FORMAT_TAG,
  attachmentsInDocument,
  imetaTag,
  inlineTextOf,
  KIND,
  resolveCommentAnchor,
  type Block,
  type ContentFormat,
} from '@estiva-app/protocol'
import { KIND_CHANGE } from '@estiva-app/conversation'
import { actOnFile, pointerOf, published, relayQuery } from '../act-on-file'
import { placeFiles, uploadFiles } from '../attachments'
import { BadRequest, flagValue, refuseUnsignable, type AgentApp, type AgentContext } from '../cli'
import { edited, findThread, readConversation, replyToOf, type Conversation } from '../conversation'
import { describe, descriptionText, formatName } from '../descriptions'
import { mentionedKeys, relayMembers, withMentions } from '../mentions'
import { profilesOf } from '../profiles'
import { resolveOne } from '../resolve'
import { summaryAction, summaryRoute, summaryText, summaryWarning } from '../summary'

/** `kind:pubkey:d`, the one handle every app's file has. A title would be one app's lookup. */
const ADDRESS = /^\d+:[0-9a-f]{64}:[^\s]+$/

type Manifest = ResolvedManifest['manifest']
type Action = NonNullable<Manifest['actions']>[number]

const appliesTo = (action: Action, kind: number | string) =>
  (Array.isArray(action.appliesTo) ? action.appliesTo : [action.appliesTo]).includes(String(kind))

/** The action that sets a file's text (`field: description`) on this kind, if its manifest declares one. */
const describeAction = (manifest: Manifest, kind: number) =>
  manifest.actions?.find((action) => action.emits?.field === 'description' && appliesTo(action, kind))?.id

/** The action that comments on this kind: the one emitting a comment on its address (§6.4). */
const commentAction = (manifest: Manifest, kind: number) =>
  manifest.actions?.find((action) => action.emits?.kind === KIND.COMMENT && appliesTo(action, kind))?.id

function addressArg(args: { positional: string[] }, command: string): string {
  const address = args.positional[0]
  if (!address || !ADDRESS.test(address)) {
    throw new BadRequest(`${command} needs a file's address, kind:pubkey:d, as \`file create\`, \`ship show\` and \`peek topics\` print it.`)
  }
  return address
}

/**
 * The SPEC §6.12 change a manifest built, checked tag by tag: this file's `a`, the `field`, the value
 * asked for, the file's own Folder as `h`, an optional `ts`, and `extra` (a content format). A manifest
 * is found by the newest claim on the kind until the workspace's list of apps exists, so any member can
 * publish one; pinning the tags means such a manifest can make this refuse, never make the agent sign
 * something else.
 */
function changeShape(address: string, field: string, value: string, extra: Record<string, string> = {}) {
  return (tags: string[][], folder: string): string | undefined => {
    const expected: Record<string, string> = { a: address, field, value, h: folder, ...extra }
    const names = tags.map((tag) => tag[0])
    for (const [name, wanted] of Object.entries(expected)) {
      const found = tags.filter((tag) => tag[0] === name)
      if (found.length !== 1 || found[0][1] !== wanted) return `with ${name} not "${wanted.slice(0, 60)}"`
    }
    // A block document names each file it places in `imeta`, as the relay requires (§13.3) — those, and no others.
    const files = JSON.stringify(attachmentsInDocument(value, extra[CONTENT_FORMAT_TAG]).map(imetaTag))
    if (JSON.stringify(tags.filter((tag) => tag[0] === 'imeta')) !== files) return `with imeta tags that are not the files its text places`
    const stray = names.find((name) => !(name in expected) && name !== 'ts' && name !== 'imeta')
    return stray ? `with a "${stray}" tag a ${field} change does not carry` : undefined
  }
}

/** The content-format tag a text change carries when it is not marker text (§13.4). */
const formatTag = (format: string | undefined): Record<string, string> => (format ? { [CONTENT_FORMAT_TAG]: format } : {})

/** A file as any app reads it, or a refusal naming the address. */
async function readFile(context: AgentContext, address: string, cache?: ProjectionCache): Promise<ForeignObject> {
  const file = await resolveForeignObject(addrToNaddr(address), relayQuery(context), async () => ({}), undefined, cache)
  // The relay answers an unreadable file and a missing one the same way.
  if (!file) throw new BadRequest(`Nothing readable at ${address}: no such file, or one in a Folder this key cannot read.`)
  return file
}

/** The file's text as it stands — the folded `description` (§6.10) — and its content model. */
function textOf(file: ForeignObject): { value: string; format: ContentFormat | undefined } {
  const body = file.slots.body
  return { value: body?.value ?? '', format: body?.format }
}

/**
 * What the agent read, as a short fingerprint: `describe` takes it back and refuses when the text
 * changed since, so a person's edit saved in between is never overwritten unseen.
 */
const versionOf = (text: { value: string; format: ContentFormat | undefined }) =>
  createHash('sha256').update(`${text.format ?? ''}\n${text.value}`).digest('hex').slice(0, 12)

/** A block as one line of words, for saying where a comment is. */
function blockLine(block: Block): string {
  const words = inlineTextOf(block).replace(/\s+/g, ' ').trim()
  const line = words || `[${block.type}]`
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

/**
 * Where on the file a thread is, against the text as it is now (§13.6's states): the blocks it is on,
 * the words it quotes, or that the blocks are gone. `resolveCommentAnchor` keeps "about the whole file"
 * and "its blocks were deleted" apart, which a reader must never merge.
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-comment-points-at-blocks-and-the-words-quoted.md
 */
function placeOn(event: { kind: number; tags: string[][] }, text: { value: string; format: ContentFormat | undefined }) {
  const anchor = resolveCommentAnchor(event, text.value, text.format ?? 'marker')
  const quote = event.tags.find((tag) => tag[0] === 'quote')?.[1]
  switch (anchor.state) {
    case 'unanchored':
      return { on: 'the whole file' }
    case 'resolved':
      return { on: 'blocks', blocks: anchor.blocks.map((block) => ({ id: block.id, text: blockLine(block) })), ...(quote ? { quote } : {}) }
    case 'reworded':
      return { on: 'blocks, reworded since', blocks: anchor.blocks.map((block) => ({ id: block.id, text: blockLine(block) })), quoted: anchor.quote.start }
    case 'detached':
      return { on: 'blocks no longer in the text', blocks: anchor.ids.map((id) => ({ id })) }
    case 'unaddressable':
      return { on: 'blocks of a text with none', blocks: anchor.ids.map((id) => ({ id })) }
  }
}

/** The threads whose blocks this new text removes: on blocks now, detached after. */
function detachedBy(conversations: Conversation[], before: { value: string; format: ContentFormat | undefined }, after: string) {
  const now = { value: after, format: 'blocks' as ContentFormat }
  return conversations.filter((thread) => {
    const was = resolveCommentAnchor(thread.root, before.value, before.format ?? 'marker').state
    return (was === 'resolved' || was === 'reworded') && resolveCommentAnchor(thread.root, now.value, now.format).state === 'detached'
  })
}

/** A Folder by name or id, among every Folder this key can read, as Leaf's tree lists them. */
function findFolder(folders: FolderSummary[], reference: string): FolderSummary {
  return resolveOne(folders, reference, {
    noun: 'Folder',
    exact: (folder) => [folder.id, folder.name ?? ''],
    text: (folder) => folder.name ?? '',
    label: (folder) => `${folder.name ?? 'unnamed'} (${folder.id.slice(0, 8)}…)`,
    hint: 'Pass a Folder name or id.',
  })
}

/**
 * The app action that starts a file of this type in a Folder: a creation the Folder offers, as Leaf's
 * and Peek's "New" menus read it — interop resolves the Folder and sweeps the manifests declaring a
 * creation on it, with whatever filter on their signer it applies, and `resolveActingManifest` hands
 * back only a manifest that sweep found. The type is the noun that manifest's projection gives the
 * emitted kind (§7.2), so a new app's type is creatable with nothing added here.
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/claude-learns-each-app-from-its-manifest.md
 */
async function creatorOf(context: AgentContext, channel: string, type: string, cache: ProjectionCache) {
  const query = relayQuery(context)
  const pointer = pointerOf(channel)
  const folder = await resolveForeignObject(addrToNaddr(channel), query, async () => ({}), undefined, cache)
  const nouns = new Set<string>()
  const found = new Map<number, { actionId: string; manifest: Manifest }>()
  for (const offered of folder?.actions ?? []) {
    if (offered.control !== 'form' || !offered.declaredBy) continue
    const acting = await resolveActingManifest(pointer, offered.declaredBy.address, query, cache)
    const action = acting?.manifest.actions?.find((candidate) => candidate.id === offered.id)
    const kind = action?.emits?.kind
    if (!acting || kind === undefined || !action?.emits?.listed) continue
    const noun = (acting.manifest.projections as Record<string, { noun?: string }> | undefined)?.[kind]?.noun
    if (!noun) continue
    nouns.add(noun)
    if (noun.toLowerCase() === type.toLowerCase() && !found.has(kind)) found.set(kind, { actionId: offered.id, manifest: acting.manifest })
  }
  if (found.size === 0) {
    throw new BadRequest(`No app offers a way to start a "${type}" in this Folder. The types that can be: ${[...nouns].sort().join(', ') || 'none'}. Nothing was published.`)
  }
  if (found.size > 1) throw new BadRequest(`More than one kind of file is called "${type}" (${[...found.keys()].join(', ')}), so which one is meant is unclear. Nothing was published.`)
  const [[kind, creator]] = [...found]
  return { kind, ...creator }
}

/** A file's conversation, printed as Leaf's comments column draws it: by thread, each with its place. */
async function printedComments(context: AgentContext, file: ForeignObject, address: string, cache: ProjectionCache, text: ReturnType<typeof textOf>) {
  const { conversations, edits, resolved } = await readConversation(context, { object: file, address }, cache)
  const directory = await profilesOf(
    relayQuery(context),
    conversations.flatMap((thread) => [thread.root, ...thread.replies].map((message) => message.author)),
  )
  const who = (pubkey: string) => directory.get(pubkey)?.name ?? `${pubkey.slice(0, 8)}…`
  return conversations.map((thread) => ({
    // What `comment --reply` takes.
    id: thread.root.id,
    ...placeOn(thread.root, text),
    resolved: resolved.has(thread.root.id) || undefined,
    messages: [thread.root, ...thread.replies].map((message) => ({
      id: message.id,
      by: who(message.author),
      at: new Date(message.createdAt * 1000).toISOString(),
      ...edited(edits, message),
    })),
  }))
}

export const fileApp: AgentApp = {
  name: 'file',
  summary: 'any file by its address, through its own app’s manifest',
  commands: [
    {
      name: 'create',
      // The file's own kind is the manifest's, so it is checked once the action is built.
      signs: [KIND.FOLDER_COMMAND],
      summary: 'start a file of any app’s type in a Folder — a Leaf document included',
      usage: 'create --folder <name|id> --type <noun> --title "..." [--summary "..."] [--description "..."]',
      async run(context, args) {
        const folderRef = flagValue(args, 'folder')
        if (!folderRef) throw new BadRequest('create needs --folder: the Folder the file goes in.')
        const type = flagValue(args, 'type')
        if (!type) throw new BadRequest('create needs --type, what the file\'s app calls it: "document" for a Leaf page.')
        const title = flagValue(args, 'title')
        if (!title) throw new BadRequest('create needs --title.')
        const summary = summaryText(flagValue(args, 'summary') ?? '')
        const description = flagValue(args, 'description')

        const query = relayQuery(context)
        const folder = findFolder(await listFolders(query), folderRef)
        // A group with no relay-signed state is a conversation space; an `add` there would publish state listing nothing (peek#192).
        if (!folder.hasState) throw new BadRequest(`${folder.name ?? folder.id} is not a Folder that lists files, so nothing can be started in it. Nothing was published.`)

        const channel = folder.channel ?? `${KIND_CHANNEL_METADATA}::${folder.id}`
        const { kind, actionId, manifest: creator } = await creatorOf(context, channel, type, createProjectionCache())
        const id = randomUUID()
        const address = `${kind}:${context.signer.pubkey}:${id}`
        // The manifest that will fold the new file — the one its address resolves to, as `ship create-project` acts with.
        const resolved = await resolveManifest(pointerOf(address), query)
        if (!resolved?.manifest.actions?.some((action) => action.id === actionId)) {
          throw new BadRequest(`The app that owns a ${type} declares no "${actionId}" for this key's files. Nothing was published.`)
        }
        const route = summary ? summaryRoute(resolved.manifest, actionId, kind) : undefined
        if (summary && !route) throw new BadRequest(`A ${type} takes no summary yet, so --summary has nowhere to go. Nothing was published.`)
        const body = description ? describe('', undefined, description, await placeFiles(context, description)) : undefined
        if (body && !describeAction(resolved.manifest, kind)) throw new BadRequest(`A ${type} takes no text, so --description has nowhere to go. Nothing was published.`)

        const built = buildActionEvents({
          manifest: creator,
          kind: KIND_CHANNEL_METADATA,
          address: channel,
          objectAuthor: pointerOf(channel).pubkey,
          folder: folder.id,
          actionId,
          value: { title, ...(route === 'seed' ? { summary } : {}) },
          newId: id,
          folderHasState: folder.hasState,
          pubkey: context.signer.pubkey,
          createdAtMs: Date.now(),
        })
        if (typeof built === 'string') throw new BadRequest(built)
        if (built[0]?.kind !== kind) throw new BadRequest(`Starting a ${type} here would not write one. Nothing was published.`)
        const stray = built.find((event, i) => i > 0 && event.kind !== KIND.FOLDER_COMMAND)
        if (stray) throw new BadRequest(`Starting a ${type} here would write a kind:${stray.kind}, which create does not write. Nothing was published.`)
        const unsignable = refuseUnsignable(
          { name: 'create', summary: '', run: async () => undefined, signs: [kind, ...(body || route === 'change' ? [KIND_CHANGE] : [])] },
          context.allowedKinds,
        )
        if (unsignable) throw new BadRequest(`${unsignable} Nothing was published.`)

        // The file first, so a refused listing leaves a file reachable by its address rather than a listing pointing at nothing.
        const [unsignedFile, ...placement] = built
        const signed = await context.signer.sign(unsignedFile)
        published(await context.relay.publish(signed), `a new ${type} "${title}"`)
        for (const unsigned of placement) {
          const result = await context.relay.publish(await context.signer.sign(unsigned))
          if (!result.ok) {
            throw new BadRequest(`Created "${title}" (${address}) but ${folder.name ?? folder.id} refused to list it: ${result.reason ?? 'no reason given'}`)
          }
        }
        const named = { address, title }
        if (route === 'change') {
          published(await actOnFile(context, named, summaryAction, summary, KIND_CHANGE, undefined, changeShape(address, 'summary', summary)), `the summary of "${title}" — the file itself was created, ${address}, without one`)
        }
        if (body) {
          const result = await actOnFile(context, named, describeAction, body.value, KIND_CHANGE, undefined, changeShape(address, 'description', body.value, formatTag(body.contentFormat)), body.contentFormat)
          published(result, `the text of "${title}" — the file itself was created, ${address}, without it`)
        }

        const file = await resolveForeignObject(addrToNaddr(address), query, async () => ({}))
        return {
          created: { title, type, address, folder: folder.name ?? folder.id, ...(summary ? { summary } : {}), url: file?.openUrl },
          eventId: signed.id,
          ...(body?.blocks ? { blocks: body.blocks.added } : {}),
          ...(summaryWarning(summary) ? { note: summaryWarning(summary) } : {}),
        }
      },
    },
    {
      name: 'show',
      summary: 'one file by its address: its text, one chunk per block, and its comments with the block each is on',
      usage: 'show <kind:pubkey:d>',
      async run(context, args) {
        const address = addressArg(args, 'show')
        const cache = createProjectionCache()
        const file = await readFile(context, address, cache)
        const text = textOf(file)
        return {
          title: file.slots.title?.value ?? address,
          summary: file.slots.subtitle?.value,
          address,
          url: file.openUrl,
          /*
            The text as `describe` takes it back: one chunk per block, a blank
            line apart. `version` is what was read; pass it to `describe` so a
            change saved in between is refused rather than overwritten.
          */
          format: formatName(text.format),
          version: versionOf(text),
          text: descriptionText(text.value, text.format),
          comments: await printedComments(context, file, address, cache, text),
        }
      },
    },
    {
      name: 'describe',
      signs: [KIND_CHANGE],
      summary: 'change a file’s text by its address, keeping every block the new text leaves unchanged',
      usage: 'describe <kind:pubkey:d> --version <from show> --description "..."',
      async run(context, args) {
        const address = addressArg(args, 'describe')
        const version = flagValue(args, 'version')
        if (!version) throw new BadRequest('describe needs --version, as `file show` printed it, so a change saved since you read the text is not overwritten.')
        const text = flagValue(args, 'description')
        if (text === undefined) throw new BadRequest('describe needs --description: the whole text, as `file show` printed it, with your change.')

        // Read again now, just before writing: the version is checked against the text as it stands.
        const cache = createProjectionCache()
        const file = await readFile(context, address, cache)
        const title = file.slots.title?.value ?? address
        const before = textOf(file)
        if (versionOf(before) !== version) {
          throw new BadRequest(
            `The text of ${title} changed since you read it (version ${version}, now ${versionOf(before)}): somebody saved an edit in between. ` +
              'Read it again with `file show` and make your change on what it says now. Nothing was published.',
          )
        }
        const next = describe(before.value, before.format, text, await placeFiles(context, text))
        const result = await actOnFile(context, { address, title }, describeAction, next.value, KIND_CHANGE, undefined, changeShape(address, 'description', next.value, formatTag(next.contentFormat)), next.contentFormat)
        published(result, `the text of ${title}`)

        // Which comments now sit on blocks that are gone, so whoever wrote them can be told (§13.6).
        const detached = next.blocks?.removed.length
          ? detachedBy((await readConversation(context, { object: file, address }, cache)).conversations, before, next.value)
          : []
        return {
          changed: { file: title, address, url: file.openUrl, version: versionOf({ value: next.value, format: next.contentFormat ? 'blocks' : before.format }) },
          ...(next.blocks ? { blocks: next.blocks } : {}),
          eventId: result.eventId,
          ...(detached.length
            ? {
                detached: detached.map((thread) => ({ id: thread.root.id, opening: thread.root.body.slice(0, 80) })),
                note: `${detached.length} comment(s) were on blocks this text removed; they now show as detached.`,
              }
            : {}),
        }
      },
    },
    {
      name: 'comment',
      signs: [KIND.COMMENT],
      summary: 'comment on any file by its address, or reply in one of its threads, in that thread’s place',
      usage: 'comment <kind:pubkey:d> --body "..." [--reply <comment id|phrase>] [--mention <key|npub|handle>[,…]] [--attach <path>[,…]]',
      async run(context, args) {
        const address = addressArg(args, 'comment')
        const text = flagValue(args, 'body')
        if (!text) throw new BadRequest('comment needs --body.')
        const mention = flagValue(args, 'mention')
        const mentioned = mention === undefined ? [] : await mentionedKeys(mention, { relayUrl: context.relayUrl, members: () => relayMembers(context) })
        const body = withMentions(text, mentioned)

        const cache = createProjectionCache()
        const file = await readFile(context, address, cache)
        const title = file.slots.title?.value ?? address
        const replyRef = flagValue(args, 'reply')
        let thread: Conversation | undefined
        if (replyRef !== undefined) {
          const { conversations, edits } = await readConversation(context, { object: file, address }, cache)
          if (!conversations.length) throw new BadRequest(`${title} has no comments to reply to. Nothing was published.`)
          thread = findThread(
            conversations.map((conversation) => ({ id: conversation.root.id, opening: edited(edits, conversation.root).body, conversation })),
            replyRef,
          ).conversation
        }

        /*
          A reply always answers the thread's opening comment, and copies its
          place — its blocks and quoted words — so the thread keeps its place on
          the page if that comment is deleted. Leaf's and Peek's panes read one
          level, so a reply to a reply would be on no page.
        */
        // Uploaded before the comment names them: the relay refuses a comment naming a file it does not hold.
        const attach = flagValue(args, 'attach')
        const files = attach === undefined ? [] : await uploadFiles(context, attach)
        const result = await actOnFile(context, { address, title }, commentAction, body, KIND.COMMENT, thread ? replyToOf(thread.root) : undefined, undefined, undefined, files)
        published(result, thread ? `a reply on ${title}` : `a comment on ${title}`)
        return {
          [thread ? 'repliedTo' : 'commented']: {
            file: title,
            url: file.openUrl,
            ...(thread ? { comment: thread.root.id, opening: thread.root.body.slice(0, 80), ...placeOn(thread.root, textOf(file)) } : {}),
          },
          eventId: result.eventId,
          ...(mentioned.length ? { mentioned } : {}),
          ...(files.length ? { attached: files.map((file) => ({ filename: file.filename, url: file.url, x: file.x })) } : {}),
        }
      },
    },
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

        const result = await actOnFile(context, { address, title }, summaryAction, summary, KIND_CHANGE, undefined, changeShape(address, 'summary', summary))
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
