/**
 * `--mention` (8e8d4b68): who a comment asks, as a key, so it reaches them.
 *
 * A name is a key, an npub, or a NIP-05 handle on the workspace's own domain —
 * never a display name — and each must be a relay member; any one failing
 * refuses the whole write. The body opens with each mention it lacks.
 */
import { encodeNpub } from '@estiva-app/protocol'
import { buildActionEvent } from '@estiva-app/interop'
import { BadRequest } from '../lib/agent/cli'
import { mentionedKeys, withMentions, type HandleLookup } from '../lib/agent/mentions'

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}
async function refuses(label: string, action: () => Promise<unknown>, contains: string) {
  try {
    await action()
    check(label, false, 'it succeeded, which it must not')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(label, error instanceof BadRequest && message.includes(contains), message)
  }
}

const MIKY = 'f3a38fa646debd4162125e0aed87b6d2393fb1ed9702b6875dcbc0c6529d64d1'
const QA2 = '3bb30d683788016b85c83604dd5660e4e172e95d46d4e3ebab623ff5847b1f71'
const STRANGER = 'e'.repeat(64)
const HANDLES: Record<string, string> = { miky: MIKY, 'qa-2': QA2, stranger: STRANGER }

const asked: string[] = []
const lookup: HandleLookup = async (domain, name) => {
  asked.push(`${name}@${domain}`)
  return HANDLES[name]
}
const workspace = { relayUrl: 'https://estiva.estiva.app', members: async () => [MIKY, QA2], lookup }
const keys = (value: string, over: Partial<typeof workspace> = {}) => mentionedKeys(value, { ...workspace, ...over })

console.log('— who a mention names —')
{
  const found = await keys(`miky, ${encodeNpub(QA2)}`)
  check('a handle and an npub resolve to keys, in the order named', found.join() === [MIKY, QA2].join())
  check('a handle is asked of the workspace domain', asked.includes('miky@estiva.estiva.app'), asked.join())
  check('a hex key stands as named, lower-cased', (await keys(QA2.toUpperCase())).join() === QA2)
  check('nostr: in front of an npub is accepted', (await keys(`nostr:${encodeNpub(MIKY)}`)).join() === MIKY)
  check('the full handle on the workspace domain resolves', (await keys('Miky@estiva.estiva.app')).join() === MIKY)
  check('the same person twice is mentioned once', (await keys(`miky,${MIKY}`)).join() === MIKY)
  check('an empty roster lets the key stand', (await keys('stranger', { members: async () => [] })).join() === STRANGER)
}

await refuses('a display name is never matched', () => keys('Katerina Kelepouri'), 'never matched')
await refuses('an unknown handle is refused', () => keys('nobody'), 'No one has the handle')
await refuses('a handle on another domain is refused', () => keys('miky@example.com'), "this workspace's domain")
await refuses('a key that is not a relay member is refused', () => keys('stranger'), 'not a member')
await refuses('the refusal quotes the outsider as named, after a duplicate', () => keys(`miky,${MIKY},stranger`), 'stranger is not a member')
await refuses('one bad name refuses the whole list', () => keys('miky,nobody'), 'No one has the handle')
await refuses('a malformed npub is refused', () => keys('npub1notreally'), 'not a valid npub')
await refuses('an empty value is refused', () => keys(' , '), 'needs a key')

console.log('\n— the body —')
{
  const npub = `nostr:${encodeNpub(MIKY)}`
  check('the body opens with a mention it lacks', withMentions('Which one?', [MIKY]) === `${npub} Which one?`)
  check('a body that already names them is unchanged', withMentions(`Which one, ${npub}?`, [MIKY]) === `Which one, ${npub}?`)
  check('no mentions, no change', withMentions('Plain.', []) === 'Plain.')
  check('a body opening with a heading keeps it on its own line', withMentions('# Q\nWhich?', [MIKY]) === `${npub}\n\n# Q\nWhich?`)
}
// The p is earned from the body, so an npub copied from workspace text would notify past the roster check.
await refuses('a body naming somebody --mention does not is refused', async () => withMentions(`cc nostr:${encodeNpub(STRANGER)}`, [MIKY]), 'whom --mention does not name')
await refuses('and so is one with no --mention at all', async () => withMentions(`cc nostr:${encodeNpub(QA2)}`, []), 'whom --mention does not name')

console.log('\n— on the wire, through interop —')
{
  // The `p` is interop's, earned from the body (0.53): the CLI only writes the text.
  const body = withMentions('Plain or urgent?', [QA2])
  const event = buildActionEvent({
    manifest: {
      records: { changeKind: 1851, targetTag: 'a', fieldTag: 'field', valueTag: 'value', order: ['ts', 'created_at', 'id'] },
      actions: [{ id: 'comment', label: 'Comment', appliesTo: '30851', emits: { kind: 1111, scope: 'address' } }],
    } as never,
    kind: 30851,
    address: `30851:${MIKY}:i1`,
    objectAuthor: MIKY,
    folder: '6f1b5cce-96ae-4817-bac2-89a1bd142576',
    actionId: 'comment',
    value: body,
    pubkey: 'c'.repeat(64),
    createdAtMs: 1_700_000_000_000,
  })
  const ps = typeof event === 'string' ? [] : event.tags.filter((t) => t[0] === 'p').map((t) => t[1])
  check('the comment carries the mentioned person in p, beside the issue author', ps.join() === [MIKY, QA2].join(), ps.join())
}

console.log(failures === 0 ? '\nAll mention checks passed.' : `\n${failures} failed.`)
process.exit(failures === 0 ? 0 : 1)
