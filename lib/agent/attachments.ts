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
import { readFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { imetaFor, uploadBlob, type Imeta } from '@estiva-app/protocol'
import { BadRequest, type AgentContext } from './cli'

/** What the PUT says the bytes are. The relay stores its own answer, which is what `imeta` carries. */
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
}

/** One local file uploaded, as the `imeta` that names it. Refused in the relay's own words. */
export async function uploadFile(context: Pick<AgentContext, 'relayUrl' | 'signer'>, path: string): Promise<Imeta> {
  const full = resolve(path)
  const filename = basename(full)
  let bytes: Buffer
  try {
    bytes = await readFile(full)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new BadRequest(`${code === 'ENOENT' ? 'There is no file' : 'The file cannot be read'} at ${path}. Nothing was published.`)
  }
  try {
    const blob = await uploadBlob({
      relayUrl: context.relayUrl,
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      contentType: CONTENT_TYPES[extname(full).toLowerCase()],
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
  const files: Imeta[] = []
  for (const path of paths) files.push(await uploadFile(context, path))
  return files
}

/**
 * A picture placed in a description: `![alt](./shot.png)` alone in its block,
 * a blank line on each side. Matched on the whole line so the text the agent
 * wrote is the key the block is found by.
 */
const IMAGE_LINE = /^!\[([^\]\n]*)\]\(([^)\n]+)\)$/

/** An image line's text → the attachment block attributes for the file it names. */
export type PlacedFiles = Map<string, Record<string, unknown>>

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
 */
export async function placeFiles(context: Pick<AgentContext, 'relayUrl' | 'signer'>, text: string): Promise<PlacedFiles> {
  const placed: PlacedFiles = new Map()
  for (const { line, alt, path } of imageLines(text)) {
    if (placed.has(line)) continue
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('/media/')) {
      throw new BadRequest(`${line} names a URL. A picture is added from a file on this machine: save it and give its path. Nothing was published.`)
    }
    const meta = await uploadFile(context, path)
    placed.set(line, { ...meta, ...(alt ? { alt } : {}) })
  }
  return placed
}
