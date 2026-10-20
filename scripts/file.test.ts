/**
 * A Leaf document through the agent (c1ba8058): `file create`, `show`,
 * `describe` and `comment`, asserted on the events that would reach the relay
 * and on what `show` reads back.
 *
 * Offline, over an in-memory relay that keeps what is published, so a write is
 * read back the way the next command would read it. Leaf's side runs on the
 * manifest Leaf published (`conformance/leaf-manifest.json`); nothing here
 * names Leaf to the code under test.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blockRunTag, calloutTone, listItemChecked, parseBlockDocument, type Block, type SignedEvent } from '@estiva-app/protocol'
import type { AgentContext } from '../lib/agent/cli'
import { fileApp } from '../lib/agent/apps/file'
import { describe as describeText } from '../lib/agent/descriptions'

const here = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const SELF = 'a'.repeat(64)
const RELAY_KEY = 'b'.repeat(64)
const QA2 = 'c'.repeat(64)
const FOLDER = '11111111-2222-3333-4444-555555555555'
const BARE = '99999999-2222-3333-4444-555555555555'
const tag = (event: SignedEvent | undefined, name: string) => event?.tags.find((t) => t[0] === name)?.[1]
const tags = (event: SignedEvent | undefined, name: string) => event?.tags.filter((t) => t[0] === name).map((t) => t[1]) ?? []

let seq = 0
const event = (kind: number, tagList: string[][], content = '', pubkey = SELF, created_at = 1_760_000_000 + seq): SignedEvent =>
  ({ id: createHash('sha256').update(`${seq++}`).digest('hex'), pubkey, created_at, kind, tags: tagList, content, sig: '' }) as SignedEvent

/** A relay answering NIP-01 filters over `events`, keeping and recording what is published. */
function relay(events: SignedEvent[], allowedKinds?: number[]) {
  const published: SignedEvent[] = []
  const values = (e: SignedEvent, name: string) => e.tags.filter((t) => t[0] === name).map((t) => t[1])
  const matches = (e: SignedEvent, filter: Record<string, unknown>) =>
    (!Array.isArray(filter.ids) || filter.ids.includes(e.id)) &&
    (!Array.isArray(filter.kinds) || filter.kinds.includes(e.kind)) &&
    (!Array.isArray(filter.authors) || filter.authors.includes(e.pubkey)) &&
    Object.entries(filter).every(([key, wanted]) => !key.startsWith('#') || (wanted as string[]).some((v) => values(e, key.slice(1)).includes(v)))
  const queryAll = async (filters: Record<string, unknown>[]) => {
    const found = new Map<string, SignedEvent>()
    for (const filter of filters) {
      const hits = events.filter((e) => matches(e, filter)).sort((a, b) => b.created_at - a.created_at)
      for (const e of typeof filter.limit === 'number' ? hits.slice(0, filter.limit) : hits) found.set(e.id, e)
    }
    return [...found.values()]
  }
  const context = {
    relayUrl: 'https://estiva.example',
    allowedKinds,
    relay: { queryAll, publish: async (e: SignedEvent) => (published.push(e), events.push(e), { ok: true, eventId: e.id }) },
    signer: { pubkey: SELF, sign: async (e: SignedEvent) => ({ ...e, id: createHash('sha256').update(JSON.stringify(e) + seq++).digest('hex'), sig: '' }) },
  } as unknown as AgentContext
  return { context, published, events }
}

const run = (name: string, context: AgentContext, positional: string[], flags: Record<string, string>) =>
  fileApp.commands.find((command) => command.name === name)!.run(context, { positional, flags } as never) as Promise<Record<string, any>>
const refusal = (promise: Promise<unknown>) => promise.then(() => '', (error: Error) => error.message)

const leafManifest = JSON.parse(readFileSync(join(here, '..', 'conformance', 'leaf-manifest.json'), 'utf8')).event as SignedEvent

/** A Folder with state (QA's shape) and a group without any, with Leaf's manifest published. */
function workspace(extra: SignedEvent[] = [], allowedKinds?: number[]) {
  return relay(
    [
      leafManifest,
      event(39000, [['d', FOLDER], ['name', 'QA']], '', RELAY_KEY),
      event(30890, [['d', FOLDER]], '', RELAY_KEY),
      event(39000, [['d', BARE], ['name', 'Chatter']], '', RELAY_KEY),
      ...extra,
    ],
    allowedKinds,
  )
}

const TEXT = [
  '# Shaping: the agent in Leaf',
  'Why we are doing this.',
  '## Questions',
  '- [ ] Who opens the page?',
  '> [!IMPORTANT]\n> Miky decides the grant.',
  '| Option | Cost |\n| --- | --- |\n| Grant | one row |',
].join('\n\n')

/** What each block is as a person sees it: a checklist item is a list item with `checked`, a callout a quote with a tone (§13.3). */
const typesOf = (blocks: readonly Block[]): string[] =>
  blocks.flatMap((block) => [
    listItemChecked(block) !== undefined ? 'checklist item' : calloutTone(block) ? 'callout' : block.type,
    ...typesOf(((block as { content?: Block[] }).content ?? []).filter((child) => typeof child === 'object' && 'type' in child && 'id' in child)),
  ])

console.log('— Creating a document —')
let created: { address: string; events: SignedEvent[] } | undefined
{
  const { context, published, events } = workspace()
  const out = await run('create', context, [], { folder: 'QA', type: 'document', title: 'Shaping: the agent in Leaf', summary: 'Where we shape it.', description: TEXT })
  const [root, listing, text] = published
  check(
    'file create --type document writes the type Leaf’s manifest names, titled, in the Folder, its summary seeded',
    root?.kind === 30842 && tag(root, 'title') === 'Shaping: the agent in Leaf' && tag(root, 'h') === FOLDER && tag(root, 'summary') === 'Where we shape it.',
    JSON.stringify(root?.tags),
  )
  const address = `30842:${SELF}:${tag(root, 'd')}`
  check('…then lists it in the Folder', listing?.kind === 1852 && tag(listing, 'h') === FOLDER && tags(listing, 'a').includes(address), JSON.stringify(listing?.tags))
  const value = tag(text, 'value') ?? ''
  let types: string[] = []
  try {
    types = typesOf(parseBlockDocument(value).content)
  } catch {}
  check(
    '…then writes its text as a block document, with heading, checklist, callout and table as blocks',
    text?.kind === 1851 && tag(text, 'field') === 'description' && tag(text, 'content-format') === 'estiva-blocks-1' && tag(text, 'a') === address &&
      tag(text, 'h') === FOLDER && ['heading', 'checklist item', 'callout', 'table'].every((type) => types.includes(type)),
    JSON.stringify(types),
  )
  check('and publishes nothing else, and answers with the address', published.length === 3 && out.created?.address === address, JSON.stringify(out.created))
  created = { address, events: [...events] }
}
{
  const { context, published } = workspace()
  const refused = await refusal(run('create', context, [], { folder: 'Chatter', type: 'document', title: 'Nowhere' }))
  check('a group with no Folder state is refused with nothing published', published.length === 0 && /Nothing was published/.test(refused), refused || `${published.length} published`)
}
{
  const { context, published } = workspace()
  const refused = await refusal(run('create', context, [], { folder: 'QA', type: 'spreadsheet', title: 'Sums' }))
  check('a type no app declares is refused, naming the types that can be started', published.length === 0 && /document/.test(refused), refused || `${published.length} published`)
}
{
  const { context, published } = workspace([], [1851, 1852, 1111])
  const refused = await refusal(run('create', context, [], { folder: 'QA', type: 'document', title: 'Not allowed' }))
  check('a credential that may not sign the new file’s kind is refused before anything is published', published.length === 0 && /may not sign kind 30842/.test(refused), refused || `${published.length} published`)
}

console.log('\n— Reading it, with a comment on one block —')
const fixture = () => {
  // QA-2's comment on the paragraph under the title (block B), and the agent's earlier read.
  const doc = parseBlockDocument(tag(created!.events.find((e) => e.kind === 1851 && tag(e, 'field') === 'description'), 'value')!)
  const [title, why, questions] = doc.content
  const comment = event(
    1111,
    [['A', created!.address], ['K', '30842'], ['P', SELF], ['a', created!.address], ['k', '30842'], ['p', SELF], ['h', FOLDER], blockRunTag([why.id])],
    'Why is the agent opening it?',
    QA2,
    1_900_000_000,
  )
  const profile = event(0, [], JSON.stringify({ name: 'QA-2' }), QA2)
  return { ...relay([...created!.events, comment, profile]), comment, title, why, questions }
}
{
  const { context, why } = fixture()
  const out = await run('show', context, [created!.address], {})
  check('file show prints the text one chunk per block, as describe takes it back', out.text === TEXT, JSON.stringify(out.text))
  const [thread] = out.comments ?? []
  check(
    '…and each comment with the block it is on, by id and words, and who wrote it',
    out.comments?.length === 1 && thread.on === 'blocks' && thread.blocks?.[0]?.id === why.id && thread.blocks?.[0]?.text === 'Why we are doing this.' &&
      thread.messages?.[0]?.by === 'QA-2',
    JSON.stringify(out.comments),
  )
  check('…and a version to pass back to describe', /^[0-9a-f]{12}$/.test(out.version ?? ''), String(out.version))
}

console.log('\n— Changing one section —')
{
  const { context, published, why } = fixture()
  const before = await run('show', context, [created!.address], {})
  const edited = TEXT.replace('- [ ] Who opens the page?', '- [x] Who opens the page?\n\n- [ ] Who reads the comments?')
  const out = await run('describe', context, [created!.address], { version: before.version, description: edited })
  const change = published[0]
  const after = parseBlockDocument(tag(change, 'value') ?? '{}')
  check(
    'file describe is one 1851 on field description, tagged estiva-blocks-1, in the file’s Folder',
    published.length === 1 && change?.kind === 1851 && tag(change, 'field') === 'description' && tag(change, 'content-format') === 'estiva-blocks-1' && tag(change, 'h') === FOLDER,
    JSON.stringify(change?.tags.map((t) => t[0])),
  )
  check('the block the comment is on keeps its id and text', after.content.some((block) => block.id === why.id), JSON.stringify(out.blocks))
  const reread = await run('show', context, [created!.address], {})
  check('…so show still finds the comment on that block', reread.comments?.[0]?.on === 'blocks' && reread.comments?.[0]?.blocks?.[0]?.id === why.id, JSON.stringify(reread.comments?.[0]))
  check('…and nothing is reported detached', out.detached === undefined, JSON.stringify(out.detached))
}
{
  const { context, published, events } = fixture()
  const before = await run('show', context, [created!.address], {})
  // Somebody saves an edit in Leaf after the agent read the text.
  const latest = describeText(tag(events.filter((e) => e.kind === 1851).at(-1), 'value')!, 'blocks', `${TEXT}\n\nKaterina's line.`)
  events.push(event(1851, [['a', created!.address], ['field', 'description'], ['value', latest.value], ['content-format', 'estiva-blocks-1'], ['h', FOLDER]], '', QA2, 1_900_000_100))
  const refused = await refusal(run('describe', context, [created!.address], { version: before.version, description: `${TEXT}\n\nThe agent's line.` }))
  check('a change saved after the agent read the text is refused, naming it, with nothing published', published.length === 0 && /changed since you read it/.test(refused), refused || `${published.length} published`)
  const reread = await run('show', context, [created!.address], {})
  check('…and the other person’s edit stays', reread.text.endsWith("Katerina's line."), reread.text.slice(-40))
}
{
  const { context, published, comment } = fixture()
  const before = await run('show', context, [created!.address], {})
  const out = await run('describe', context, [created!.address], { version: before.version, description: TEXT.replace('Why we are doing this.\n\n', '') })
  check(
    'removing the block a comment is on names that comment as detached',
    published.length === 1 && out.detached?.length === 1 && out.detached[0].id === comment.id,
    JSON.stringify(out.detached ?? out),
  )
  const reread = await run('show', context, [created!.address], {})
  check('…and show then says its blocks are gone, not that it is about the whole file', reread.comments?.[0]?.on === 'blocks no longer in the text', String(reread.comments?.[0]?.on))
}

console.log('\n— Replying —')
{
  const { context, published, comment, why } = fixture()
  const out = await run('comment', context, [created!.address], { body: 'So the shaping starts from a page.', reply: comment.id.slice(0, 12) })
  const reply = published[0]
  check(
    'file comment --reply answers the comment: NIP-22 parent, the document as root, in the file’s Folder',
    published.length === 1 && reply?.kind === 1111 && tag(reply, 'e') === comment.id && tag(reply, 'A') === created!.address && tag(reply, 'h') === FOLDER && tag(reply, 'p') === QA2,
    JSON.stringify(reply?.tags),
  )
  check('…and copies the comment’s place, so the reply sits at the same block', tag(reply, 'block') === why.id, JSON.stringify(reply?.tags))
  check('…and says which comment and where', out.repliedTo?.comment === comment.id && out.repliedTo?.on === 'blocks', JSON.stringify(out.repliedTo))
  const reread = await run('show', context, [created!.address], {})
  check('show lists the reply under that comment', reread.comments?.length === 1 && reread.comments[0].messages?.length === 2, JSON.stringify(reread.comments?.[0]?.messages))
}
{
  const { context, published } = fixture()
  await run('comment', context, [created!.address], { body: 'A new thread.' })
  const top = published[0]
  check('file comment without --reply starts a thread on the whole document', top?.kind === 1111 && tag(top, 'a') === created!.address && tag(top, 'block') === undefined && tag(top, 'e') === undefined, JSON.stringify(top?.tags))
}

console.log(failures ? `\n${failures} failed.` : '\nAll file checks passed.')
process.exit(failures ? 1 : 0)
