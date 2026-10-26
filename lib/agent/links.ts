/**
 * How each link in a file's text draws, for the agent that reads it as text
 * (WBD-9). The text `show` prints is the text `--description` takes back, and
 * SPEC §13.3 *A description as text* gives a card no spelling, so a card and a
 * row print alike, and a link on words prints as its words. This lists them
 * beside the text instead, by the readers' own rule: protocol's
 * `documentLineDraws` (§13.3 *A reference's card*, C22, C24), after
 * `linksAsReferences` has read each app URL as the file it names (§7.7).
 *
 * Generic rather than Ship's: a block document and an app URL are the
 * protocol's, and `file show` prints the same list for a Leaf page.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-link-on-words-counts-toward-the-card.md
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-lone-links-chip-menu-offers-row-or-card.md
 */
import {
  documentLineDraws,
  linesOf,
  linksAsReferences,
  toRenderTree,
  urlRunsIn,
  valueOfReference,
  type ContentFormat,
  type RenderBlock,
} from '@estiva-app/protocol'
import { matchObjectUrl, urlPatternsOf } from '@estiva-app/interop'
import type { AgentContext } from './cli'

/** One link as it draws: `chip` in a sentence, `row` or `card` alone on its line, `link` for words or a URL no app claims. */
export interface PrintedLink {
  /** The first words of the block it is in. */
  in: string
  draws: 'chip' | 'row' | 'card' | 'link'
  /** What it names: a file's address, a message's id, a person's npub — or the URL. */
  to: string
  /** A link on words: its words. */
  words?: string
  /** The URL as written, when it was one. */
  url?: string
  title?: string
  /** Alone on its line, naming something this key cannot read: the unreadable row. */
  unreadable?: true
}

/** What an app URL names (§7.7), or undefined; `byUrl` holds every answer, asked before drawing. */
export type LinkNames = (url: string) => string | undefined

const EVENT_ID = /^[0-9a-f]{64}$/i

/**
 * Each app URL in the text, asked once: the host and `<type>` against every
 * published manifest's `urls`, then one author for the `d` — a `d` two authors
 * hold names nothing, as Ship's and Peek's readers ask it (§7.7, LTX-6).
 */
export async function namesOfLinks(context: Pick<AgentContext, 'relay'>, tree: RenderBlock[]): Promise<LinkNames> {
  const urls = new Set<string>()
  const walk = (blocks: RenderBlock[]) => {
    for (const block of blocks) {
      if (block.type === 'codeBlock') continue
      for (const run of block.inline ?? []) {
        if (run.marks.includes('code')) continue
        if (run.href !== undefined) urls.add(run.href)
        else for (const { url } of urlRunsIn(run.text)) urls.add(url)
      }
      if (block.children) walk(block.children)
    }
  }
  walk(tree)
  const names = new Map<string, string>()
  if (urls.size === 0) return () => undefined
  const manifests = await context.relay.queryAll([{ kinds: [KIND_APP_HANDLER], limit: 500 }] as never)
  const shapes = manifests.flatMap((manifest) => urlPatternsOf(manifest as never))
  await Promise.all(
    [...urls].map(async (url) => {
      const hit = matchObjectUrl(url, shapes)
      if (!hit) return
      if (hit.by === 'id') {
        if (EVENT_ID.test(hit.identifier)) names.set(url, hit.identifier.toLowerCase())
        return
      }
      // A path on another app's host can read as several kinds (§7.7, LTX-6): ask under each.
      const kinds = hit.kinds ?? (hit.kind === undefined ? undefined : [hit.kind])
      const found = await context.relay.queryAll([{ '#d': [hit.identifier], limit: 2, ...(kinds ? { kinds } : {}) }] as never)
      const holders = new Set(found.map((event) => `${event.kind}:${event.pubkey}`))
      if (holders.size === 1) names.set(url, `${[...holders][0]}:${hit.identifier}`)
    }),
  )
  return (url) => names.get(url)
}
/** NIP-89's handler information, where an app publishes its manifest and `urls` (§7.2). */
const KIND_APP_HANDLER = 31990

/** A block as one line of words, for saying where a link is. */
function firstWords(block: RenderBlock): string {
  const words = (block.inline ?? []).map((run) => run.text).join('').replace(/\s+/g, ' ').trim()
  return words.length > 60 ? `${words.slice(0, 59)}…` : words || `[${block.type}]`
}

/**
 * Every link in a file's text, in order, as a reader draws it. `titleOf` says
 * what a value is called, where the caller already holds it; nothing is read
 * for a title alone.
 */
export async function printedLinks(
  context: Pick<AgentContext, 'relay'>,
  value: string,
  format: ContentFormat | undefined,
  titleOf?: (value: string) => string | undefined,
): Promise<PrintedLink[]> {
  if (!value) return []
  const read = toRenderTree(value, format ?? 'marker')
  return linksIn(read, await namesOfLinks(context, read), titleOf)
}

/** {@link printedLinks} over a tree already read, with what its app URLs name ({@link namesOfLinks}). */
export function linksIn(read: RenderBlock[], names: LinkNames, titleOf: (value: string) => string | undefined = () => undefined): PrintedLink[] {
  const tree = linksAsReferences(read, names)
  const draws = documentLineDraws(tree, { resolveLink: names })
  const out: PrintedLink[] = []
  const add = (link: PrintedLink) => {
    const title = titleOf(link.to)
    out.push(title ? { ...link, title } : link)
  }
  const walk = (blocks: RenderBlock[]) => {
    for (const block of blocks) {
      const lines = draws.get(block)
      if (lines && block.type !== 'codeBlock') {
        const where = firstWords(block)
        linesOf(block).forEach((line, i) => {
          const drawn = lines[i]
          if (drawn?.draw === 'row' || drawn?.draw === 'card') {
            const url = 'url' in drawn ? drawn.url : undefined
            add({ in: where, draws: drawn.draw, to: drawn.value!, ...(url ? { url } : {}) })
            return
          }
          if (drawn?.draw === 'unreadable') {
            add({ in: where, draws: 'row', to: drawn.reference!, unreadable: true })
            return
          }
          for (const run of line) {
            if (run.marks.includes('code')) continue
            // An app URL read as the reference it names keeps the URL as its text.
            const url = run.reference && run.text !== run.reference ? run.text : undefined
            if (run.reference) add({ in: where, draws: 'chip', to: valueOfReference(run.reference) ?? personOf(run.reference), ...(url ? { url } : {}) })
            else if (run.href !== undefined) add({ in: where, draws: 'link', to: run.href, ...(run.text !== run.href ? { words: run.text } : {}) })
            else for (const { url: bare } of urlRunsIn(run.text)) add({ in: where, draws: 'link', to: bare })
          }
        })
      }
      if (block.children) walk(block.children)
    }
  }
  walk(tree)
  return out
}

/** A person's reference as their npub, the way `--mention` takes one. */
const personOf = (reference: string) => reference.replace(/^nostr:/i, '')
