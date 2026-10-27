/**
 * How each link in a file's text draws, for the agent that reads it as text
 * (WBD-9). The text `show` prints is the text `--description` takes back, and
 * SPEC §13.3 *A description as text* gives a card no spelling, so a card and a
 * row print alike (a link on words prints as `[words](url)`, e0e3e907). This lists them
 * beside the text instead, by the readers' own rule: protocol's
 * `documentLineDraws` (§13.3 *A reference's card*, C22, C24), after
 * `linksAsReferences` has read each app URL as the file it names (§7.7), as
 * interop's `linkReader` answers it for every app (PEEKM-7).
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
import { linkReader, linksIn, matchObjectUrl, MAX_LINKS_ASKED, urlPatternsOf, type LinkReader, type OwnPlace } from '@estiva-app/interop'
import { BadRequest, type AgentContext } from './cli'

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

/** NIP-89's handler information, where an app publishes its manifest and `urls` (§7.2). */
const KIND_APP_HANDLER = 31990

type Manifests = () => Promise<readonly { tags: string[][] }[]>

/** One per relay connection, the signed-in agent's: the MCP server holds one for its life, the CLI one per run. */
const byRelay = new WeakMap<object, Manifests>()

/**
 * The manifests, read once per relay connection and shared by every reader and
 * `addressesOfUrl`. A failed read is forgotten, and so is an empty one (a relay
 * still starting, a read before sign-in), as interop's reader forgets its own:
 * kept, every link would name nothing for the MCP server's life.
 */
function manifestsOf(context: Pick<AgentContext, 'relay'>): Manifests {
  const held = byRelay.get(context.relay)
  if (held) return held
  let read: Promise<readonly { tags: string[][] }[]> | null = null
  const manifests = () => {
    if (read) return read
    const asked = context.relay.queryAll([{ kinds: [KIND_APP_HANDLER], limit: 500 }])
    read = asked
    asked.then(
      (found) => {
        if (found.length === 0 && read === asked) read = null
      },
      () => {
        if (read === asked) read = null
      },
    )
    return asked
  }
  byRelay.set(context.relay, manifests)
  return manifests
}

/**
 * What app links name, as every app reads them (interop's `linkReader`, §7.7,
 * PEEKM-7): the host and `<type>` against the published manifests' `urls`,
 * then one author for the `d`. The tags a comment or an edit earns come from it
 * too (`reader.tagsFor`).
 *
 * A new reader per command: a reader keeps every answer for its life, a link
 * that named nothing included, and the MCP server lives for days, so a file
 * created after its link was first asked would stay unnamed until a restart.
 */
export function linkReaderOf(context: Pick<AgentContext, 'relay'>): LinkReader {
  return linkReader({ query: (filters) => context.relay.queryAll(filters), manifests: manifestsOf(context) })
}

/**
 * The `a`, `q` and `part` tags a comment's body earns for what it links, by a
 * `nostr:` reference or an app link, as every app's comment box tags it (SPEC
 * §13.1, PEEKM-7), so the file a link names lists the comment under Mentioned
 * in. Never its own file, nor the comment it answers. An edit (`edit: true`)
 * carries the whole `a`/`q` set its new words earn and no `part`. On a send, a
 * link not answered within the reader's wait earns nothing and stays a link.
 * An edit with a link not answered is refused: it replaces the whole set, so
 * it would take the message off the file that link names.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/an-edit-says-what-the-message-links-now.md
 */
export async function commentLinkTags(context: Pick<AgentContext, 'relay'>, body: string, own: OwnPlace, options: { edit?: boolean } = {}): Promise<string[][]> {
  const reader = linkReaderOf(context)
  const tree = toRenderTree(body, 'marker')
  const tags = await reader.tagsFor(tree, own, options)
  if (options.edit && linksIn(tree).slice(0, MAX_LINKS_ASKED).some((url) => !reader.answered(url)))
    throw new BadRequest('A link in the new text could not be looked up, so the message was not edited: without it, the edit would take the message off the file that link names. Try again.')
  return tags
}

/** What an app URL names (§7.7), or undefined: the reader's answers, asked before drawing. */
export type LinkNames = (url: string) => string | undefined

const EVENT_ID = /^[0-9a-f]{64}$/i

/**
 * Every file an app URL could name (§7.7), as `kind:pubkey:d`, up to 10: none
 * when no app claims it or nothing readable holds its `d`, more than one when
 * two authors do — the caller says which. A link names nothing then
 * (`linkReader`); this asks a different question, for `file show <link>`.
 */
export async function addressesOfUrl(context: Pick<AgentContext, 'relay'>, url: string): Promise<string[]> {
  const hit = matchObjectUrl(url, (await manifestsOf(context)()).flatMap((manifest) => urlPatternsOf(manifest)))
  if (!hit || hit.by === 'id') return []
  // A path on another app's host can read as several kinds (§7.7, LTX-6): ask under each — only
  // addressable ones, where a `d` is one file per author; a manifest anyone can publish names them.
  const kinds = (hit.kinds ?? (hit.kind === undefined ? undefined : [hit.kind]))?.filter((kind) => kind >= 30000 && kind < 40000)
  if (kinds?.length === 0) return []
  const limit = 10
  const found = await context.relay.queryAll([{ '#d': [hit.identifier], limit, ...(kinds ? { kinds } : {}) }])
  const names = [...new Set(found.map((event) => `${event.kind}:${event.pubkey}:${hit.identifier}`))]
  // A full page can hide another holder behind newer events of one author: then it names none.
  return found.length >= limit && names.length === 1 ? [] : names.filter((name) => !EVENT_ID.test(name))
}

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
  const reader = linkReaderOf(context)
  // Every link the text names something by, asked before drawing; a read that failed fails the command.
  await reader.ask(linksIn(read))
  return drawnLinks(read, reader.known, titleOf)
}

/** {@link printedLinks} over a tree already read, with what its app URLs name. */
export function drawnLinks(read: RenderBlock[], names: LinkNames, titleOf: (value: string) => string | undefined = () => undefined): PrintedLink[] {
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
