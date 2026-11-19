/**
 * The agent reads and writes issues field by field (ISS-7), as it has written
 * projects since ALO-7.
 *
 * `show` prints an issue's `version`; `edit-issue --description` takes it back,
 * is merged onto a change saved since — on a team whose issues the relay keeps
 * in order and on one where it does not yet — and says whose, or, the same
 * block changed by both, saves nothing and names them; `set-status`, `assign`
 * and `archive` from an older copy are written after the newer change and
 * stand; `create-issue` writes a record with no text and the text as its first
 * change, and never says "created" when the text did not land; `delete-issue`
 * is a `deleted` change `--restore` undoes, and `show` says who deleted it; an
 * issue is found by a word of its current text, never of an old one.
 *
 * Offline, over the in-memory relay in `fields-relay.ts`, holding the manifest
 * Ship published. Asserted on the signed events that reach it and the answers.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-file-is-its-fields-each-kept-in-order-by-the-relay.md
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-new-files-text-is-its-first-change.md
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/merging-two-changes-to-one-text-never-loses-words.md
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SignedEvent } from '@estiva-app/protocol'
import { FOLDER, QA1, SELF, addressOf, check, doc, fieldChange, finish, mine, relay, run, signed, tag, textChange, wordsOfDoc, type RelayOptions } from './fields-relay'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, '..', 'conformance', 'ship-manifest.json'), 'utf8')) as { event: SignedEvent }
const ISSUES = ['osnova.project', 'osnova.issue']

/** An issue by QA-1 in a project of the QA team, its text saved twice: the second save is the version the agent reads. */
function workspace(options: RelayOptions = {}) {
  const project = signed(QA1, 30850, [['d', 'c0ffee00-0000-4000-8000-000000000001'], ['name', 'Launch plan'], ['buzz-channel', FOLDER]])
  const root = signed(QA1, 30851, [['d', 'beef0000-0000-4000-8000-000000000001'], ['title', 'Login is slow'], ['h', FOLDER], ['a', addressOf(project)], ['ref', 'LAU-1']])
  const addr = addressOf(root)
  const first = textChange(QA1, addr, doc(['b1', 'One.'], ['b2', 'Two.']), root.id)
  const read = textChange(QA1, addr, doc(['b1', 'One, with the rollout in it.'], ['b2', 'Two.']), first.id)
  const status = fieldChange(QA1, addr, 'status', 'todo', root.id)
  const profile = signed(QA1, 0, [], JSON.stringify({ name: 'QA-1' }))
  return { ...relay([manifest.event, project, root, first, read, status, profile], { search: ISSUES, ...options }), project, root, addr, first, read, status }
}

// — Opening an issue prints its text's version —
{
  const { context, addr, read } = workspace()
  const shown = await run(context, 'show', [addr])
  check('show prints the issue\'s text and its version: the current text change', shown.ok && shown.answer.version === read.id && String(shown.answer.description).includes('rollout'), shown.ok ? String(shown.answer.version) : shown.message)
}

// — edit-issue --description needs the version the change was made on —
{
  const { context, published, addr } = workspace()
  const bare = await run(context, 'edit-issue', [addr], { description: 'b1 text' })
  check('a description without --version is refused, nothing published', !bare.ok && /edit-issue --description needs --version/.test(bare.message) && published.length === 0, bare.ok ? 'it saved' : bare.message)
}

// — A different block: merged, whether or not the relay keeps this team's issues in order —
for (const keepsOrder of [true, false]) {
  const label = keepsOrder ? 'a team kept in order' : 'a team not switched yet'
  const { context, published, addr, read, events } = workspace({ keepsOrder })
  const theirs = textChange(QA1, addr, doc(['b1', 'One, with the rollout in it.'], ['b2', 'Two, by QA-1.']), read.id)
  events.push(theirs)
  const answer = await run(context, 'edit-issue', [addr], { description: 'One, with the rollout in it, by Claude.\n\nTwo.', version: read.id })
  const saved = mine(published).find((e) => tag(e, 'field') === 'description')
  check(`${label}: the save follows QA-1's change`, tag(saved, 'prev') === theirs.id, answer.ok ? tag(saved, 'prev') : answer.message)
  const words = wordsOfDoc(tag(saved, 'value'))
  check(`${label}: it keeps both people's words`, JSON.stringify(words) === JSON.stringify(['One, with the rollout in it, by Claude.', 'Two, by QA-1.']), JSON.stringify(words))
  const applied = answer.ok ? (answer.answer.applied as { merged?: string }[]) : []
  check(`${label}: the answer says whose change it kept`, /QA-1/.test(applied[0]?.merged ?? ''), answer.ok ? applied[0]?.merged : answer.message)
}

// — The same block: nothing saved, no other field either; names them, shows both —
for (const keepsOrder of [true, false]) {
  const label = keepsOrder ? 'a team kept in order' : 'a team not switched yet'
  const { context, published, addr, read, events } = workspace({ keepsOrder })
  events.push(textChange(QA1, addr, doc(['b1', 'One, rewritten by QA-1.'], ['b2', 'Two.']), read.id))
  const answer = await run(context, 'edit-issue', [addr], { description: 'One, rewritten by Claude.\n\nTwo.', version: read.id, title: 'Login is slow on Safari' })
  check(`${label}: nothing of the agent's is saved, the title included`, mine(published).length === 0, JSON.stringify(mine(published).map((e) => tag(e, 'field'))))
  const message = answer.ok ? '' : answer.message
  check(`${label}: the answer names QA-1, shows both versions and says to read the issue again`, /as QA-1 left it at \d{4}-/.test(message) && message.includes('One, rewritten by QA-1.') && message.includes('One, rewritten by Claude.') && /read the issue again/.test(message), message.split('\n')[0])
}

// — A status set with nobody crossing it follows the status change it replaces, not the record —
{
  // On a team not switched yet, where nothing corrects a wrong `prev` with a refusal.
  const { context, published, addr, status } = workspace({ keepsOrder: false })
  const answer = await run(context, 'set-status', [addr, 'in_progress'])
  const saved = mine(published).find((e) => tag(e, 'field') === 'status')
  check('set-status follows the current status change', answer.ok && tag(saved, 'prev') === status.id, answer.ok ? tag(saved, 'prev') : answer.message)
}

// — A status, an assignee and an archive set from an older copy: the later stands —
for (const [command, positional, flags, field, value] of [
  ['set-status', ['in_progress'], {}, 'status', 'in_progress'],
  ['assign', ['me'], {}, 'assignee', SELF],
  ['archive', [], { resolution: 'Done elsewhere.' }, 'archived', 'true'],
] as const) {
  let crossed: SignedEvent | undefined
  const setup = workspace({
    beforePublish: (e) => {
      // QA-1 sets the same field between the agent's read and its write.
      if (!crossed && e.pubkey === SELF && tag(e, 'field') === field) {
        const prev = setup.events.filter((x) => tag(x, 'a') === setup.addr && tag(x, 'field') === field).at(-1)?.id ?? setup.root.id
        crossed = fieldChange(QA1, setup.addr, field, field === 'archived' ? '' : field === 'status' ? 'done' : QA1, prev)
        setup.events.push(crossed)
      }
    },
  })
  const answer = await run(setup.context, command, [setup.addr, ...positional], { ...flags })
  const saved = mine(setup.published).find((e) => tag(e, 'field') === field)
  check(`${command}: written after QA-1's ${field} and stands`, answer.ok && tag(saved, 'prev') === crossed?.id && tag(saved, 'value') === value, answer.ok ? `${tag(saved, 'prev')} vs ${crossed?.id}` : answer.message)
}

// — create-issue: a record with no text, the text as its first change —
{
  const { context, published, project } = workspace()
  const created = await run(context, 'create-issue', [], { project: addressOf(project), title: 'Probe', description: 'Its text.' })
  const record = mine(published).find((e) => e.kind === 30851)
  const described = mine(published).find((e) => tag(e, 'field') === 'description')
  check('the record carries no text', created.ok && record !== undefined && record.content === '' && !record.tags.some((t) => t[0] === 'description' || t[0] === 'content-format'), created.ok ? JSON.stringify(record?.tags) : created.message)
  check('the text is its first change, following the record', tag(described, 'prev') === record?.id && wordsOfDoc(tag(described, 'value')).join() === 'Its text.', JSON.stringify({ prev: tag(described, 'prev'), record: record?.id }))
}
{
  const refusals: string[] = []
  const { context, published, project } = workspace({
    beforePublish: (e) => {
      if (e.pubkey === SELF && tag(e, 'field') === 'description') {
        refusals.push(e.id)
        return { ok: false, reason: 'error: relay busy' }
      }
    },
  })
  const created = await run(context, 'create-issue', [], { project: addressOf(project), title: 'Probe', description: 'Its text.' })
  const record = mine(published).find((e) => e.kind === 30851)
  check('a text that does not land is sent once more', refusals.length === 2, String(refusals.length))
  check('then the answer is not "created": it names the issue and says its text did not land', !created.ok && record !== undefined && created.message.includes(addressOf(record)) && /text did not land/.test(created.message), created.ok ? JSON.stringify(created.answer) : created.message)
}

{
  // The relay takes the text but its answer is lost: the text is not sent twice.
  let lost = false
  const setup = workspace({
    beforePublish: (e) => {
      if (!lost && e.pubkey === SELF && tag(e, 'field') === 'description') {
        lost = true
        setup.events.push(e)
        return { ok: false, reason: 'error: relay busy' }
      }
    },
  })
  const created = await run(setup.context, 'create-issue', [], { project: addressOf(setup.project), title: 'Probe', description: 'Its text.' })
  const texts = setup.events.filter((e) => e.pubkey === SELF && tag(e, 'field') === 'description')
  check('a text whose answer was lost is not sent again, and the issue is created', created.ok && texts.length === 1, created.ok ? String(texts.length) : created.message)
}

// — Delete and restore —
for (const how of [{ inOrder: ISSUES }, { refuseKind5: 'issue' as const }]) {
  const label = 'inOrder' in how ? 'relay announcing issues in order' : 'team refusing kind:5 (the fence)'
  const { context, published, addr, root } = workspace(how)
  const answer = await run(context, 'delete-issue', [addr], { yes: true })
  const deleted = mine(published).find((e) => tag(e, 'field') === 'deleted')
  check(`${label}: a delete is a deleted change after the record, no kind:5 stored`, answer.ok && tag(deleted, 'value') === 'true' && tag(deleted, 'prev') === root.id && !mine(published).some((e) => e.kind === 5), answer.ok ? '' : answer.message)
  const listed = await run(context, 'issues', [], { json: true })
  check(`${label}: it leaves the list`, listed.ok && !(listed.answer.issues as { addr?: string; ref?: string }[]).some((i) => i.ref === 'LAU-1'))
  const shown = await run(context, 'show', [addr])
  const by = shown.ok ? (shown.answer.deleted as { by?: string; at?: string } | undefined) : undefined
  check(`${label}: it still opens by its id, and says who deleted it and when`, typeof by?.at === 'string' && typeof by?.by === 'string' && by.by.length > 0, shown.ok ? JSON.stringify(by) : shown.message)
  await run(context, 'delete-issue', [addr], { restore: true })
  const restored = mine(published).filter((e) => tag(e, 'field') === 'deleted').at(-1)
  check(`${label}: a restore is the empty value after the delete`, tag(restored, 'value') === '' && tag(restored, 'prev') === deleted?.id)
  const back = await run(context, 'issues', [], { json: true })
  check(`${label}: it is back in the list with its number`, back.ok && (back.answer.issues as { ref?: string }[]).some((i) => i.ref === 'LAU-1'))
}

// — Found by a word of its current text, not of an old one —
{
  const { context, events, project } = workspace()
  // A second issue in the project, without the word: the search must leave it out.
  events.push(signed(QA1, 30851, [['d', 'beef0000-0000-4000-8000-000000000002'], ['title', 'Signup is slow'], ['h', FOLDER], ['a', addressOf(project)], ['ref', 'LAU-2']]))
  const now = await run(context, 'show', ['rollout'])
  check('show finds an issue by a word in its current text', now.ok && now.answer.title === 'Login is slow', now.ok ? String(now.answer.title) : now.message)
  const listed = await run(context, 'issues', [], { search: 'rollout', json: true })
  check('issues --search lists it', listed.ok && (listed.answer.issues as { ref?: string }[]).map((i) => i.ref).join() === 'LAU-1', listed.ok ? JSON.stringify(listed.answer.issues) : listed.message)
  // The relay ranks a title match first; the list keeps its order, not newest first.
  const ranked = { ...context, relay: { ...context.relay, queryWithMatches: async () => ({ events: [], matches: [{ a: `30851:${QA1}:beef0000-0000-4000-8000-000000000001` }, { a: `30851:${QA1}:beef0000-0000-4000-8000-000000000002` }] }) } } as unknown as typeof context
  const both = await run(ranked, 'issues', [], { search: 'slow', json: true })
  check('issues --search keeps the relay\'s order, best first', both.ok && (both.answer.issues as { ref?: string }[]).map((i) => i.ref).join() === 'LAU-1,LAU-2', both.ok ? (both.answer.issues as { ref?: string }[]).map((i) => i.ref).join() : both.message)
  const { context: c2, events: e2, addr, read } = workspace()
  e2.push(textChange(QA1, addr, doc(['b1', 'One.'], ['b2', 'Two.']), read.id))
  const old = await run(c2, 'show', ['rollout'])
  check('a word only in an old text finds nothing', !old.ok, old.ok ? String(old.answer.title) : old.message)
}

finish('issue field')
