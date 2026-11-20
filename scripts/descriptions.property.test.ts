/**
 * The agent edits a description as text and gives back the same document
 * where the text did not change (TES-3), on thousands of made-up documents
 * (`@estiva-app/protocol/testing`'s `documentArb`): headings, nested lists,
 * checklists, callouts, tables, code, dividers, links, mentions, pictures,
 * empty lines and blocks from a later version.
 *
 * - The text `show` prints, sent back unchanged, publishes the very same
 *   document: every block, its id and its content.
 * - One block changed: every other block keeps its id and its content, the
 *   changed block keeps its id, and a changed list's other items keep theirs —
 *   so a comment anchored to any of them (§13.6) still resolves. Next to a
 *   block text cannot carry (a picture, a later block), the edit is either
 *   made the same way or refused with nothing published; never a silent loss.
 *
 * A failure prints the smallest document that breaks a rule and the seed that
 * replays it: `FC_SEED=<seed> npx tsx scripts/descriptions.property.test.ts`.
 */
import fc from 'fast-check'
import { parseBlockDocument, serializeBlockDocument, type Block, type BlockDocument } from '@estiva-app/protocol'
import { documentArb, documentShape, runSettings } from '@estiva-app/protocol/testing'
import { BadRequest } from '../lib/agent/cli'
import { descriptionText, editBlockDocument } from '../lib/agent/descriptions'

// 300 documents a rule: about 2 s each (measured 20 Nov 2026).
const settings = runSettings(300)
console.log(`fast-check seed ${settings.seed}, ${settings.numRuns} runs per rule`)

let failures = 0
function rule<T>(label: string, property: fc.IProperty<T>) {
  try {
    fc.assert(property, settings)
    console.log(`✅ ${label}`)
  } catch (error) {
    failures++
    console.log(`❌ ${label}\n${error instanceof Error ? error.message : String(error)}`)
  }
}

const doc = (content: Block[]): BlockDocument => ({ type: 'doc', content })
/** One block as `show` prints it. */
const chunkOf = (block: Block) => descriptionText(serializeBlockDocument(doc([block])), 'blocks')
const shapeWithIds = (block: Block | undefined) => JSON.stringify(block && documentShape(doc([block]), { ids: true }))
const fail = (message: string): never => {
  throw new Error(message)
}

/** The blocks whose last line takes one more word as text: a paragraph, a heading, a quote, a list. */
const EDITABLE = new Set(['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList'])
/** A paragraph's last line that a word after it would turn into a heading, an item or a quote: the text would then mean that, rightly. */
const PREFIX_ALONE = /(^|\n)\s*(#{1,2}|[-•>]|\d+\.)\s*$/
const editableAt = (d: BlockDocument) =>
  d.content
    .map((b, i) => (EDITABLE.has(b.type) && Array.isArray(b.content) && b.content.length && !(b.type === 'paragraph' && PREFIX_ALONE.test(chunkOf(b))) ? i : -1))
    .filter((i) => i >= 0)

/** The document's text with one block's last line ending in one more word. */
function withOneEdit(d: BlockDocument, at: number): string {
  return d.content.map((block, i) => (i === at ? `${chunkOf(block)} edited` : chunkOf(block))).join('\n\n')
}

function checkEdit(before: BlockDocument, at: number, value: string) {
  const after = parseBlockDocument(value)
  if (after.content.length !== before.content.length) fail(`${before.content.length} blocks became ${after.content.length}`)
  before.content.forEach((block, i) => {
    if (i === at) return
    if (shapeWithIds(after.content[i]) !== shapeWithIds(block)) fail(`block ${i} (${block.type}) changed although only block ${at} was edited:\n${shapeWithIds(after.content[i])}`)
  })
  const edited = after.content[at]
  // A paragraph `1.` with a word added is a numbered list: the text now says so, and a new block is right.
  if (edited.type !== before.content[at].type) return
  if (edited.id !== before.content[at].id) fail(`the edited ${edited.type} lost its id`)
  const items = (b: Block) => ((b.content ?? []) as Block[]).map((item) => item.id)
  if (edited.type === 'bulletList' || edited.type === 'orderedList') {
    if (JSON.stringify(items(edited)) !== JSON.stringify(items(before.content[at]))) fail(`an item of the edited list lost its id: ${items(before.content[at])} → ${items(edited)}`)
  }
}

rule(
  'the text show prints, sent back unchanged, publishes the same document, every id kept',
  fc.property(documentArb({ form: 'editor' }), (d) => {
    const value = serializeBlockDocument(d)
    const edit = editBlockDocument(value, descriptionText(value, 'blocks'))
    if (JSON.stringify(documentShape(parseBlockDocument(edit.value), { ids: true })) !== JSON.stringify(documentShape(d, { ids: true }))) fail('the document changed')
    if (edit.removed.length) fail(`ids removed: ${edit.removed}`)
  }),
)

rule(
  'one block of a description changed keeps every other block and every id, the changed list’s other items included',
  fc.property(
    documentArb({ form: 'description' }).filter((d) => editableAt(d).length > 0).chain((d) => fc.tuple(fc.constant(d), fc.constantFrom(...editableAt(d)))),
    ([d, at]) => checkEdit(d, at, editBlockDocument(serializeBlockDocument(d), withOneEdit(d, at)).value),
  ),
)

rule(
  'beside a block text cannot carry, one block changed is made the same way or refused, never lost',
  fc.property(
    documentArb({ form: 'editor' }).filter((d) => editableAt(d).length > 0).chain((d) => fc.tuple(fc.constant(d), fc.constantFrom(...editableAt(d)))),
    ([d, at]) => {
      let value: string
      try {
        value = editBlockDocument(serializeBlockDocument(d), withOneEdit(d, at)).value
      } catch (error) {
        if (error instanceof BadRequest && /Nothing was published/.test(error.message)) return
        throw error
      }
      checkEdit(d, at, value)
    },
  ),
)

if (failures) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nall passed')
