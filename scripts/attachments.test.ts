/**
 * d273d4f5: the agent puts a picture into a description and a file into a
 * comment, the way a person's upload does — the bytes go to the relay's
 * `/upload` first, then the description carries an `attachment` block whose
 * attributes are the relay's answers and an `imeta` tag naming it, and a
 * comment carries the `imeta`. Offline: an in-memory relay keeps what is
 * published, and `fetch` answers `/upload` as Buzz does, recording each PUT.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import type { Block, SignedEvent } from '@estiva-app/protocol'
import type { AgentContext } from '../lib/agent/cli'
import { descriptionText } from '../lib/agent/descriptions'
import { fileApp } from '../lib/agent/apps/file'
import { shipApp } from '../lib/agent/apps/ship'

const here = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

/** A 2×2 PNG, with a `tEXt` chunk a capture tool writes and the relay refuses when `withText`. */
function png(withText: boolean): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2, 0)
  header.writeUInt32BE(2, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // truecolour
  const rows = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...(withText ? [chunk('tEXt', Buffer.from('Software\0Screenshot tool', 'latin1'))] : []),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const dir = mkdtempSync(join(tmpdir(), 'agent-attachments-'))
const SHOT = join(dir, 'shot.png')
writeFileSync(SHOT, png(true))
const OTHER = join(dir, 'other.png')
writeFileSync(OTHER, png(false))

const sha = (bytes: ArrayBuffer | Uint8Array) => createHash('sha256').update(new Uint8Array(bytes)).digest('hex')

/** Everything in order: each `/upload` PUT and each publish, so "uploaded before it is named" can be checked. */
type Step = { upload: { sha: string; bytes: Uint8Array; header: string } } | { publish: SignedEvent }
let steps: Step[] = []
let refuseUploads: string | undefined
globalThis.fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body: ArrayBuffer }) => {
  if (!String(url).endsWith('/upload') || init.method !== 'PUT') throw new Error(`unexpected request ${url}`)
  if (refuseUploads) return { status: 413, text: async () => refuseUploads! }
  const bytes = new Uint8Array(init.body)
  const digest = sha(bytes)
  steps.push({ upload: { sha: digest, bytes, header: init.headers['x-sha-256'] } })
  const descriptor = { url: `https://estiva.example/media/${digest}.png`, sha256: digest, size: bytes.byteLength, type: 'image/png', dim: '2x2' }
  return { status: 200, text: async () => JSON.stringify(descriptor) }
}) as never

const uploads = () => steps.flatMap((step) => ('upload' in step ? [step.upload] : []))
const published = () => steps.flatMap((step) => ('publish' in step ? [step.publish] : []))
const imetas = (event: SignedEvent | undefined) => event?.tags.filter((tag) => tag[0] === 'imeta') ?? []
const imetaField = (tag: string[] | undefined, key: string) => tag?.slice(1).find((part) => part.startsWith(`${key} `))?.slice(key.length + 1)
const blocksOf = (value: string) => (JSON.parse(value) as { content: Block[] }).content

const SELF = 'a'.repeat(64)
const RELAY_KEY = 'b'.repeat(64)
const FOLDER = '11111111-2222-3333-4444-555555555555'
let seq = 0
const event = (kind: number, tags: string[][], content = '', pubkey = SELF): SignedEvent =>
  ({ id: createHash('sha256').update(`seed${seq++}`).digest('hex'), pubkey, created_at: 1_760_000_000 + seq, kind, tags, content, sig: '' }) as SignedEvent

/** A relay answering NIP-01 filters over `events`, recording each publish as a step. */
function relay(events: SignedEvent[]): AgentContext {
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
  return {
    relayUrl: 'https://estiva.example',
    relay: { queryAll, publish: async (e: SignedEvent) => (steps.push({ publish: e }), events.push(e), { ok: true, eventId: e.id }) },
    signer: { pubkey: SELF, sign: async (e: SignedEvent) => ({ ...e, created_at: e.created_at + seq, id: createHash('sha256').update(JSON.stringify(e) + seq++).digest('hex'), sig: '' }) },
  } as unknown as AgentContext
}

const leafManifest = JSON.parse(readFileSync(join(here, '..', 'conformance', 'leaf-manifest.json'), 'utf8')).event as SignedEvent
const leaf = () => relay([leafManifest, event(39000, [['d', FOLDER], ['name', 'QA']], '', RELAY_KEY), event(30890, [['d', FOLDER]], '', RELAY_KEY)])
const run = (app: typeof fileApp, name: string, context: AgentContext, positional: string[], flags: Record<string, string>) =>
  app.commands.find((command) => command.name === name)!.run(context, { positional, flags } as never) as Promise<Record<string, any>>
const refusal = (promise: Promise<unknown>) => promise.then(() => '', (error: Error) => error.message)
/** The newest description change on the relay, as its value's blocks and the event. */
const lastDescription = () => published().filter((e) => e.kind === 1851 && e.tags.some((t) => t[0] === 'field' && t[1] === 'description')).at(-1)

console.log('— A picture in a new document’s text —')
const context = leaf()
let address = ''
{
  steps = []
  const out = await run(fileApp, 'create', context, [], {
    folder: 'QA',
    type: 'document',
    title: 'Pictures',
    description: `Before the picture.\n\n![The board, after](${SHOT})\n\nAfter the picture.`,
  })
  address = out.created?.address
  const [upload] = uploads()
  const change = lastDescription()
  const blocks = change ? blocksOf(change.tags.find((t) => t[0] === 'value')![1]) : []
  const picture = blocks.find((block) => block.type === 'attachment')
  check(
    'the picture line becomes an attachment block where it stood, between the two paragraphs',
    blocks.map((block) => block.type).join() === 'paragraph,attachment,paragraph',
    blocks.map((block) => block.type).join(),
  )
  check(
    'the block’s attributes are the relay’s answers: its url, type, sha, size and dimensions, the file name and the alt text',
    picture?.attrs?.x === upload?.sha && picture?.attrs?.url === `https://estiva.example/media/${upload?.sha}.png` && picture?.attrs?.m === 'image/png' &&
      picture?.attrs?.dim === '2x2' && picture?.attrs?.filename === 'shot.png' && picture?.attrs?.alt === 'The board, after',
    JSON.stringify(picture?.attrs),
  )
  check('the description change names the file in one imeta tag, as the relay requires', imetas(change).length === 1 && imetaField(imetas(change)[0], 'x') === upload?.sha, JSON.stringify(imetas(change)))
  check(
    'the bytes sent are the picture without its tEXt chunk, and the sha sent with them is theirs',
    !!upload && !Buffer.from(upload.bytes).includes(Buffer.from('tEXt')) && upload.header === upload.sha && upload.bytes.byteLength < readFileSync(SHOT).byteLength,
    upload ? `${upload.bytes.byteLength} of ${readFileSync(SHOT).byteLength} bytes` : 'no upload',
  )
  const firstUpload = steps.findIndex((step) => 'upload' in step)
  const firstPublish = steps.findIndex((step) => 'publish' in step)
  check('the file is uploaded before anything is published', firstUpload >= 0 && firstUpload < firstPublish, `upload at ${firstUpload}, first publish at ${firstPublish}`)
}

console.log('— Adding a picture to text that already has blocks, and editing around it —')
{
  const before = await run(fileApp, 'show', context, [address], {})
  const priorIds = blocksOf(lastDescription()!.tags.find((t) => t[0] === 'value')![1]).map((block) => block.id)
  steps = []
  const added = `${before.text}\n\n![](${OTHER})`
  await run(fileApp, 'describe', context, [address], { version: before.version, description: added })
  const after = blocksOf(lastDescription()!.tags.find((t) => t[0] === 'value')![1])
  check(
    'a second picture is appended and every block that was there keeps its id',
    after.length === 4 && after.slice(0, 3).map((block) => block.id).join() === priorIds.join() && after[3].type === 'attachment' && after[3].attrs?.filename === 'other.png' && after[3].attrs?.alt === undefined,
    after.map((block) => `${block.type}:${block.id}`).join(' '),
  )
  check('both files are named in imeta', imetas(lastDescription()).length === 2, JSON.stringify(imetas(lastDescription()).map((tag) => imetaField(tag, 'filename'))))

  const reread = await run(fileApp, 'show', context, [address], {})
  check('show prints each picture as an [attachment: …] line', /\[attachment: shot\.png\]/.test(reread.text) && /\[attachment: other\.png\]/.test(reread.text), reread.text)
  steps = []
  await run(fileApp, 'describe', context, [address], { version: reread.version, description: reread.text.replace('After the picture.', 'After the picture, edited.') })
  const edited = blocksOf(lastDescription()!.tags.find((t) => t[0] === 'value')![1])
  check(
    'an edit that leaves the [attachment: …] lines as printed keeps both blocks, ids and attributes alike, and uploads nothing',
    edited.filter((block) => block.type === 'attachment').length === 2 &&
      JSON.stringify(edited.filter((block) => block.type === 'attachment')) === JSON.stringify(after.filter((block) => block.type === 'attachment')) &&
      uploads().length === 0,
    edited.map((block) => `${block.type}:${block.id}`).join(' '),
  )
  check('and the change still names both files in imeta', imetas(lastDescription()).length === 2)
}

console.log('— What is refused, with nothing published —')
for (const [label, line, wanted] of [
  ['a picture line naming a file that does not exist', `![](${join(dir, 'missing.png')})`, /There is no file at/],
  ['a picture line naming a URL', '![](https://example.com/shot.png)', /names a URL/],
  ['a picture inside a sentence', `See ![this](${SHOT}) here.`, /on a line of its own/],
] as const) {
  const reread = await run(fileApp, 'show', context, [address], {})
  steps = []
  const refused = await refusal(run(fileApp, 'describe', context, [address], { version: reread.version, description: `${reread.text}\n\n${line}` }))
  check(`${label} is refused, nothing uploaded and nothing published`, wanted.test(refused) && /Nothing was published/.test(refused) && steps.length === 0, refused || `${steps.length} steps`)
}

console.log('— A file attached to a comment —')
{
  steps = []
  const out = await run(fileApp, 'comment', context, [address], { body: 'The board as it looks now.', attach: SHOT })
  const [comment] = published()
  const [upload] = uploads()
  check(
    'file comment --attach names the uploaded file in the comment’s imeta, uploaded first',
    comment?.kind === 1111 && imetas(comment).length === 1 && imetaField(imetas(comment)[0], 'x') === upload?.sha && imetaField(imetas(comment)[0], 'filename') === 'shot.png' && 'upload' in steps[0],
    JSON.stringify(comment?.tags),
  )
  check('and says what it attached', !!upload && out.attached?.[0]?.x === upload.sha, JSON.stringify(out.attached))

  steps = []
  await run(fileApp, 'comment', context, [address], { body: 'Two of them.', attach: `${SHOT}, ${OTHER}` })
  check('a comma list attaches each file, in order', imetas(published()[0]).map((tag) => imetaField(tag, 'filename')).join() === 'shot.png,other.png', JSON.stringify(imetas(published()[0])))

  steps = []
  refuseUploads = 'blob too large'
  const refused = await refusal(run(fileApp, 'comment', context, [address], { body: 'Too big.', attach: SHOT }))
  refuseUploads = undefined
  check('an upload the relay refuses publishes no comment, and says so in the relay’s words', published().length === 0 && /blob too large/.test(refused) && /Nothing was published/.test(refused), refused)
}

console.log('— Ship: a comment on an issue, and an issue’s description —')
{
  const fixture = JSON.parse(readFileSync(join(here, '..', 'conformance', 'fold-fixture.json'), 'utf8')) as { events: SignedEvent[] }
  const manifest = JSON.parse(readFileSync(join(here, '..', 'conformance', 'ship-manifest.json'), 'utf8')) as { event: SignedEvent }
  const ship = relay([...fixture.events, manifest.event])
  const issue = fixture.events.find((e) => e.kind === 30851)!
  const issueAddress = `30851:${issue.pubkey}:${issue.tags.find((t) => t[0] === 'd')![1]}`
  steps = []
  await run(shipApp as typeof fileApp, 'comment', ship, [issueAddress], { body: 'Here is how it looks.', attach: SHOT })
  const comment = published().find((e) => e.kind === 1111)
  check(
    'ship comment --attach puts the file in the comment’s imeta, uploaded first',
    imetas(comment).length === 1 && imetaField(imetas(comment)[0], 'x') === uploads()[0]?.sha && 'upload' in steps[0],
    JSON.stringify(comment?.tags),
  )

  /*
    The issue's author wrote, in a marker description from before RIC-20, a
    paragraph that reads as a picture line naming a file on the agent's machine.
    Passed back unchanged, as `show` printed it, it must stay words: uploading
    it would publish whatever file a workspace member names.
  */
  const folder = fixture.events.find((e) => e.kind === 1851 && e.tags.some((t) => t[0] === 'a' && t[1] === issueAddress))!.tags.find((t) => t[0] === 'h')![1]
  const personLine = `![x](${OTHER})`
  ship.relay.publish({
    ...event(1851, [['a', issueAddress], ['field', 'description'], ['value', `Intro.\n\n${personLine}`], ['h', folder], ['ts', '1790000000000']], '', issue.pubkey),
    created_at: 1_790_000_000,
  })
  steps = []
  await run(shipApp as typeof fileApp, 'edit-issue', ship, [issueAddress], { description: `Intro.\n\n${personLine}\n\n![Before](${SHOT})` })
  const change = lastDescription()
  const blocks = change ? blocksOf(change.tags.find((t) => t[0] === 'value')![1]) : []
  check(
    'ship edit-issue uploads only the picture line it adds, and the change places it as an attachment block named in imeta',
    uploads().length === 1 && blocks.map((block) => block.type).join() === 'paragraph,paragraph,attachment' && blocks[2].attrs?.x === uploads()[0].sha && imetas(change).length === 1 && imetaField(imetas(change)[0], 'x') === uploads()[0].sha,
    `${uploads().length} uploads; ${blocks.map((block) => block.type).join()}; ${JSON.stringify(imetas(change))}`,
  )
  check(
    'a picture line a person already wrote stays their words, and its file is never uploaded',
    // One upload, the added line's: shot.png and other.png are the same picture once cleaned, so the count is what tells them apart.
    blocks[1]?.type === 'paragraph' && descriptionText(JSON.stringify({ type: 'doc', content: [blocks[1]] }), 'blocks') === personLine && uploads().length === 1,
    JSON.stringify(blocks[1]),
  )
}

console.log('— What is refused before any upload —')
{
  const SECRET = join(dir, '.estiva-agent.env')
  writeFileSync(SECRET, 'ESTIVA_AGENT_CLIENT_SECRET=not-a-real-one\n')
  const DISGUISED = join(dir, 'secret.png')
  writeFileSync(DISGUISED, 'ESTIVA_AGENT_CLIENT_SECRET=not-a-real-one\n')
  const FOLDERISH = join(dir, 'folder.png')
  mkdirSync(FOLDERISH)
  const reread = await run(fileApp, 'show', context, [address], {})
  for (const [label, text, wanted] of [
    ['a file that is not a picture or a PDF', `![](${SECRET})`, /not a picture or a PDF/],
    ['a file named as a picture that is not one', `![](${DISGUISED})`, /is not the image\/png its name says/],
    ['a path that is not a regular file', `![](${FOLDERISH})`, /is not a file/],
    ['a relative path', '![](shot.png)', /not an absolute path/],
    ['a good picture beside a missing one', `![](${SHOT})\n\n![](${join(dir, 'missing.png')})`, /There is no file at/],
    ['a good picture beside one inside a sentence', `![](${SHOT})\n\nSee ![this](${OTHER}) here.`, /on a line of its own/],
  ] as const) {
    steps = []
    const refused = await refusal(run(fileApp, 'describe', context, [address], { version: reread.version, description: `${reread.text}\n\n${text}` }))
    check(`${label} is refused, nothing uploaded and nothing published`, wanted.test(refused) && /Nothing was published/.test(refused) && steps.length === 0, refused || `${steps.length} steps`)
  }
  steps = []
  const refused = await refusal(run(fileApp, 'comment', context, [address], { body: 'Two.', attach: `${SHOT},${join(dir, 'missing.png')}` }))
  check('--attach with one missing file uploads none of them', /There is no file at/.test(refused) && steps.length === 0, refused || `${steps.length} steps`)
}

console.log(failures ? `\n${failures} failed.` : '\nAll attachment checks passed.')
process.exit(failures ? 1 : 0)
