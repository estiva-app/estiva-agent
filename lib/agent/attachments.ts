/**
 * A local file put on the relay, as a description's attachment block or a
 * comment's `imeta` (d273d4f5).
 *
 * The apps already do both: Ship's `/ File` uploads first and inserts an
 * `attachment` block whose attributes are the relay's answers (SHI-2), and
 * every comment box uploads before the send and names the files in `imeta`.
 * This is the same upload — protocol's `uploadBlob`, which strips a picture's
 * metadata the way the relay demands and hashes what it actually stores — so a
 * picture the agent adds reads exactly like one a person attached.
 *
 * The order matters as it does there: ingest refuses an event naming a blob the
 * relay does not hold, so every upload lands before anything names it, and a
 * refused upload publishes nothing.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { imetaFor, uploadBlob, type ContentFormat, type Imeta } from '@estiva-app/protocol'
import { BadRequest, type AgentContext } from './cli'
import { describe, descriptionText } from './descriptions'

/** What the PUT says the bytes are. The relay stores its own answer, which is what `imeta` carries. */
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
}

/** Each type's opening bytes, so a file named `shot.png` that is not a picture is never uploaded. */
function startsWith(bytes: Buffer, at: number, signature: string | number[]): boolean {
  const wanted = typeof signature === 'string' ? Buffer.from(signature, 'latin1') : Buffer.from(signature)
  return wanted.equals(bytes.subarray(at, at + wanted.length))
}
const SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  'image/png': (bytes) => startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (bytes) => startsWith(bytes, 0, [0xff, 0xd8, 0xff]),
  'image/gif': (bytes) => startsWith(bytes, 0, 'GIF8'),
  'image/webp': (bytes) => startsWith(bytes, 0, 'RIFF') && startsWith(bytes, 8, 'WEBP'),
  'application/pdf': (bytes) => startsWith(bytes, 0, '%PDF-'),
}

/** The relay's default `max_file_bytes` (buzz-media `config.rs`). */
const MAX_BYTES = 100 * 1024 * 1024

/** A local file read and checked, not yet uploaded. */
interface LocalFile {
  filename: string
  contentType: string
  bytes: Buffer
}

/**
 * Reads one file the agent named, refusing it before anything is uploaded:
 * every file of a write is read first, so one bad path uploads none.
 */
async function readLocal(path: string): Promise<LocalFile> {
  // Relative to whose directory is not knowable through the MCP server, whose working directory is not the agent's.
  if (!isAbsolute(path)) throw new BadRequest(`${path} is not an absolute path. Give the file's full path. Nothing was published.`)
  const full = resolve(path)
  const filename = basename(full)
  // Pictures and PDFs only: a path written into text is uploaded for everyone in the Folder, so a credential file must never qualify.
  const contentType = CONTENT_TYPES[extname(full).toLowerCase()]
  if (!contentType) {
    throw new BadRequest(`${filename} is not a picture or a PDF (${Object.keys(CONTENT_TYPES).join(', ')}). Nothing was published.`)
  }
  let bytes: Buffer
  try {
    // A device or a pipe never ends, so only a regular file is read, and none larger than the relay takes.
    const info = await stat(full)
    if (!info.isFile()) throw new BadRequest(`${path} is not a file. Nothing was published.`)
    if (info.size > MAX_BYTES) throw new BadRequest(`${filename} is larger than the relay takes (100 MB). Nothing was published.`)
    bytes = await readFile(full)
  } catch (error) {
    if (error instanceof BadRequest) throw error
    const code = (error as NodeJS.ErrnoException).code
    throw new BadRequest(`${code === 'ENOENT' ? 'There is no file' : 'The file cannot be read'} at ${path}. Nothing was published.`)
  }
  // The name is the agent's claim; the first bytes are what the file is.
  if (!SIGNATURES[contentType](bytes)) throw new BadRequest(`${filename} is not the ${contentType} its name says. Nothing was published.`)
  return { filename, contentType, bytes }
}

/** One file read by {@link readLocal}, uploaded, as the `imeta` that names it. Refused in the relay's own words. */
async function upload(context: Pick<AgentContext, 'relayUrl' | 'signer'>, { filename, contentType, bytes }: LocalFile): Promise<Imeta> {
  try {
    const blob = await uploadBlob({
      relayUrl: context.relayUrl,
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      contentType,
      filename,
      sign: (unsigned) => context.signer.sign(unsigned),
      pubkey: context.signer.pubkey,
    })
    return imetaFor(blob, { filename })
  } catch (error) {
    throw new BadRequest(`The relay did not take ${filename}: ${(error as Error).message}. Nothing was published.`)
  }
}

/** Each file in a comma-separated `--attach` list, uploaded in order. */
export async function uploadFiles(context: Pick<AgentContext, 'relayUrl' | 'signer'>, list: string): Promise<Imeta[]> {
  const paths = list.split(',').map((path) => path.trim()).filter(Boolean)
  if (!paths.length) throw new BadRequest('--attach needs a path, or several separated by commas.')
  const local: LocalFile[] = []
  for (const path of paths) local.push(await readLocal(path))
  const files: Imeta[] = []
  for (const file of local) files.push(await upload(context, file))
  return files
}

/**
 * A picture placed in a description: `![alt](/abs/path/shot.png)` alone in its block,
 * a blank line on each side. Matched on the whole line so the text the agent
 * wrote is the key the block is found by.
 */
const IMAGE_LINE = /^!\[([^\]\n]*)\]\(([^)\n]+)\)$/

/** An image line's text → the attachment block attributes for the file it names, or `null` for a line that stays words. */
export type PlacedFiles = Map<string, Record<string, unknown> | null>

/** Every image line in `text` that stands as a block of its own, outside a code fence. */
export function imageLines(text: string): { line: string; alt: string; path: string }[] {
  const found: { line: string; alt: string; path: string }[] = []
  let fenced = false
  for (const chunk of text.split(/\n[ \t]*\n/)) {
    const trimmed = chunk.trim()
    const match = !fenced && IMAGE_LINE.exec(trimmed)
    if (match) found.push({ line: trimmed, alt: match[1].trim(), path: match[2].trim() })
    // A fence's blank lines are not block boundaries; an odd count of ``` in a chunk opens or closes one.
    if ((chunk.match(/^```/gm)?.length ?? 0) % 2 === 1) fenced = !fenced
  }
  return found
}

/**
 * Uploads every file the text's image lines name, before anything is written,
 * and returns the attachment block each line becomes: the relay's `imeta` as
 * the block's attributes, as Ship's `/ File` inserts it, and the alt text when
 * one was given. A line naming a URL rather than a local file is refused —
 * this does not fetch anything.
 *
 * Only a line the agent adds is a picture. One already in `previous` (the
 * description as it prints now) was written by whoever wrote that text, and
 * passing it back unchanged must not read and upload the file it names — a
 * paragraph reading `![x](/home/miky/.estiva-agent.env)` would otherwise
 * publish the credential on the next edit. It stays words (`null`).
 *
 * `check` is the write the text is for, run first with placeholder blocks: a
 * text it refuses (a picture inside other text, a description that has
 * nowhere to go) is refused before a single byte is uploaded.
 */
export async function placeFiles(
  context: Pick<AgentContext, 'relayUrl' | 'signer'>,
  text: string,
  { previous = '', check }: { previous?: string; check?: (placeholders: PlacedFiles) => unknown } = {},
): Promise<PlacedFiles> {
  const already = new Set(imageLines(previous).map(({ line }) => line))
  const lines = imageLines(text).filter(({ line }) => !already.has(line))
  for (const { line, path } of lines) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('/media/')) {
      throw new BadRequest(`${line} names a URL. A picture is added from a file on this machine: save it and give its path. Nothing was published.`)
    }
  }
  const kept: PlacedFiles = new Map([...already].map((line) => [line, null]))
  check?.(new Map([...kept, ...lines.map(({ line, path }) => [line, { filename: basename(path) }] as const)]))
  // Each path read once, all before the first upload; the same file under two alt texts is one upload.
  const local = new Map<string, LocalFile>()
  for (const { path } of lines) if (!local.has(path)) local.set(path, await readLocal(path))
  const uploaded = new Map<string, Imeta>()
  for (const [path, file] of local) uploaded.set(path, await upload(context, file))
  const placed: PlacedFiles = kept
  for (const { line, alt, path } of lines) placed.set(line, { ...uploaded.get(path)!, ...(alt ? { alt } : {}) })
  return placed
}

/** {@link describe} with the text's pictures uploaded and placed — a text `describe` refuses uploads nothing. */
export async function describePlacing(
  context: Pick<AgentContext, 'relayUrl' | 'signer'>,
  previous: string,
  format: ContentFormat | undefined,
  text: string,
): Promise<ReturnType<typeof describe>> {
  const check = (placeholders: PlacedFiles) => describe(previous, format, text, placeholders)
  const files = await placeFiles(context, text, { previous: previous ? descriptionText(previous, format) : '', check })
  return describe(previous, format, text, files)
}
