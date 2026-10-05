/**
 * The agent CLI's decisions, tested without a relay.
 *
 * Everything here is a pure function over already-fetched data, which is the
 * point: argument parsing and reference resolution are where an agent quietly
 * does the wrong thing, and neither needs a network to be wrong. The parts that
 * do need one are covered by `probe-agent.ts` and `agent-signer.test.ts`, which
 * talk to the real services on purpose.
 *
 *   npx tsx scripts/agent-cli.test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BadRequest, acceptedFlags, flagValue, parseArgs, unknownFlag } from '../lib/agent/cli'
import { resolveMaybe } from '../lib/agent/resolve'
import { isWslKernel, parseGitHead, refuseUnsignable, runtimeSource } from '../lib/agent/cli'
import { mayPublish } from '../lib/agent/credentials'
import { loadCredentials } from '../lib/agent/credentials'
import { archivedRemoved, assigneeFor, clip, findIssue, findProject, issueEdits, issueLine, issueRow, moveFile, participants, parseSince, projectEdits, projectRow, pullRequestOn, resolvePubkeys, shipApp, statusesFor } from '../lib/agent/apps/ship'
import { peekApp } from '../lib/agent/apps/peek'
import type { Issue, Project, Vocabulary } from '../lib/agent/apps/ship-workspace'
import { buildActionEvent, buildActionEvents, topLevelFolders } from '@estiva-app/interop'
import { findTopic, replyToOf, type Topic } from '../lib/agent/apps/peek'
import { edited, findMessage } from '../lib/agent/conversation'
import { KIND_EDIT, foldEdits } from '@estiva-app/conversation'
import type { SignedEvent } from '@estiva-app/protocol'
import type { Directory } from '../lib/agent/profiles'

/*
  The vocabularies Ship's manifest declares (`issueStatuses`, `statuses`). Since
  PER-21 the agent reads them off the manifest at run time; these tests pass
  them in, as the commands do.
*/
const ISSUE_VOCAB: Vocabulary = {
  entries: [
    { value: 'todo', label: 'Todo' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'done', label: 'Done' },
    { value: 'cancelled', label: 'Cancelled' },
  ],
  fallback: 'todo',
}
const PROJECT_VOCAB: Vocabulary = {
  entries: [
    { value: 'planned', label: 'Planned' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'completed', label: 'Completed' },
    { value: 'cancelled', label: 'Cancelled' },
  ],
  fallback: 'planned',
}

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

function refuses(label: string, action: () => unknown, contains?: string) {
  try {
    action()
    check(label, false, 'it succeeded, which it must not')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(label, error instanceof BadRequest && (!contains || message.includes(contains)), message.split('\n')[0])
  }
}

const issue = (over: Partial<Issue>): Issue => ({
  addr: '30851:abc:1',
  id: '1',
  author: 'abc',
  createdAt: 0,
  title: 'Untitled',
  description: '',
  folder: 'f',
  status: 'todo',
  ...over,
})

console.log('— parsing —')

{
  const args = parseArgs(['ship', 'issues', '--project', 'Peek', '--archived'])
  check('keeps positionals in order', args.positional.join(',') === 'ship,issues')
  check('reads a value flag', args.flags.project === 'Peek')
  check('reads a bare flag as true', args.flags.archived === true)
}

{
  // The one that silently corrupts input: a boolean flag immediately followed
  // by another flag must not swallow it as its value.
  const args = parseArgs(['ship', 'issues', '--archived', '--project', 'Peek'])
  check('a flag before a flag stays boolean', args.flags.archived === true)
  check('and the next flag keeps its value', args.flags.project === 'Peek')
}

refuses('a value flag with nothing after it is refused', () =>
  flagValue(parseArgs(['ship', 'issues', '--status']), 'status'),
)

check('an absent flag is undefined, not an error', flagValue(parseArgs(['ship']), 'status') === undefined)

console.log('\n— resolving a reference —')

const issues = [
  issue({ id: 'a', addr: '30851:abc:a', ref: 'PEE-1', title: 'Assignee picker is missing' }),
  issue({ id: 'b', addr: '30851:abc:b', ref: 'PEE-2', title: 'Editing / renaming topics' }),
  issue({ id: 'c', addr: '30851:abc:c', ref: 'PEE-3', title: 'Files panel when opening topics' }),
]

check('finds by display ref', findIssue(issues, 'PEE-2').id === 'b')
check('is case-insensitive', findIssue(issues, 'pee-2').id === 'b')
check('finds by address', findIssue(issues, '30851:abc:c').id === 'c')
check('finds by a unique title fragment', findIssue(issues, 'assignee picker').id === 'a')

/*
  The important one. Two issues mention "topics", and picking either would be an
  agent confidently reporting on the wrong ticket — a mistake that leaves no
  trace once it has been made. Refusing costs one more question; guessing costs
  somebody's afternoon and their trust in the tool.
*/
refuses('refuses an ambiguous fragment rather than guessing', () => findIssue(issues, 'topics'), 'matches 2 issues')
refuses('names the candidates when it refuses', () => findIssue(issues, 'topics'), 'PEE-2')
refuses('refuses nothing at all', () => findIssue(issues, 'nothing-like-this'), 'No issue matches')
refuses('refuses an empty reference', () => findIssue(issues, '   '))

/*
  An exact ref must win even when it is also a substring of another title —
  otherwise adding an issue called "About PEE-1" would break every lookup of
  PEE-1, which is a booby trap nobody would think to test after the fact.
*/
const withDecoy = [...issues, issue({ id: 'd', addr: '30851:abc:d', ref: 'PEE-9', title: 'Follow-up to PEE-1' })]
check('an exact ref beats a title containing it', findIssue(withDecoy, 'PEE-1').id === 'a')

/*
  Short addresses (MAK-1). The first characters of the `d` name an issue the
  way the whole address does, because refs collide and nobody types 110
  characters from memory. Two ids sharing the fragment is a refusal — longer,
  please — not a fall-through to whatever title happens to contain it.
*/
console.log('\n— resolving by a prefix of the id —')

const uuids = [
  issue({ id: 'a57c26e3-9e23-4665-a9f6-c9885950fd7b', addr: '30851:abc:a57c26e3-9e23', ref: 'MAK-1', title: 'Writes echo state' }),
  issue({ id: 'a57c9999-0000-4665-a9f6-c9885950fd7b', addr: '30851:abc:a57c9999-0000', ref: 'MAK-2', title: 'One-line listings' }),
  issue({ id: '42d82497-1111-4665-a9f6-c9885950fd7b', addr: '30851:abc:42d82497-1111', ref: 'FOL-19', title: 'A ?file= URL does not open a57c' }),
]

check('finds by a unique prefix of the id', findIssue(uuids, '42d82497').id.startsWith('42d8'))
check('any unique length works, not only eight', findIssue(uuids, '42d8').id.startsWith('42d8'))
check('a prefix is case-insensitive', findIssue(uuids, '42D82497').id.startsWith('42d8'))
check('a prefix longer than eight still resolves', findIssue(uuids, 'a57c26e3-9e23').ref === 'MAK-1')
refuses('refuses a prefix two ids share, rather than searching titles', () => findIssue(uuids, 'a57c'), 'matches 2 issues')
refuses('and lists them by short id', () => findIssue(uuids, 'a57c'), 'a57c9999')
check('a fragment under four characters is a word, not an id', findIssue(uuids, 'a57').ref === 'FOL-19')
check('an exact ref beats an id that starts the same way', findIssue([...uuids, issue({ id: 'mak-1-000', addr: '30851:abc:mak-1-000', ref: 'X-1', title: 'decoy' })], 'MAK-1').ref === 'MAK-1')

console.log('\n— the one-line state a write echoes —')

const stated = issueLine(
  { ref: 'MAK-1', id: 'a57c26e3-9e23-4665-a9f6-c9885950fd7b', status: 'in_progress', comments: [{ body: 'first' }, { body: '  PR is up:\n\nhttps://github.com/estiva-app/estiva-agent/pull/48  ' }] },
  'Claude',
)
check('names ref, short id, status, assignee, count and the last comment', stated === 'MAK-1 · a57c26e3 · in_progress · Claude · 2 comments · last: "PR is up: https://github.com/estiva-app/estiva-agent/pull/48"', stated)
check('an unassigned issue with no comments says so', issueLine({ ref: 'X-1', id: 'abcdefgh', status: 'todo', comments: [] }, undefined) === 'X-1 · abcdefgh · todo · unassigned · 0 comments')
check('one comment is singular', issueLine({ ref: 'X-1', id: 'abcdefgh', status: 'done', comments: [{ body: 'x' }] }, 'M').includes('1 comment ·'))
check('a long comment is clipped with an ellipsis', clip('a'.repeat(100), 80).length === 80 && clip('a'.repeat(100), 80).endsWith('…'))
check('a short one is not', clip('short', 80) === 'short')
check('the newest PR named wins', pullRequestOn(['see https://github.com/o/r/pull/2 and https://github.com/o/r/pull/3', 'https://github.com/o/r/pull/1']) === 'https://github.com/o/r/pull/3')
check('no PR is undefined, not a string', pullRequestOn(['nothing here', 'https://github.com/o/r/issues/4']) === undefined)

/*
  A flag outside the command's usage is refused in one line, before anything
  connects (MAK-2). Before this, `--projekt x` was silently ignored and the
  listing answered for the whole workspace — the wrong answer at 14K chars,
  followed by a retry. The accepted set is read from `usage` so it cannot
  drift from what is documented.
*/
console.log('\n— a flag the command does not take —')

const listing = { name: 'issues', summary: 's', usage: 'issues [--project <ref>] [--status <value>] [--json]', run: async () => ({}) }
check('flags are read from the usage line', acceptedFlags(listing).includes('project') && acceptedFlags(listing).includes('status'))
check('help and json are accepted everywhere', acceptedFlags({ name: 'x', summary: 's', run: async () => ({}) }).join() === 'help,json')
check('a declared flag passes', unknownFlag(listing, { project: 'x' }) === undefined)
const refused = unknownFlag(listing, { projekt: 'x' })
check('an undeclared one is refused in one line naming it and the usage', refused === 'Unknown flag --projekt. Usage: issues [--project <ref>] [--status <value>] [--json]', refused)
check('the refusal is one line, not the help', refused !== undefined && !refused.includes('\n'))

/*
  Every command that reads a flag must declare it, or the runner refuses what
  the command would have honoured. Checked over both apps rather than trusted.
*/
for (const app of [shipApp, peekApp]) {
  for (const command of app.commands) {
    const read = [...command.run.toString().matchAll(/flagValue\(args, '([a-z-]+)'\)|args\.flags\.([a-z]+)/g)].map((m) => m[1] ?? m[2])
    const undeclared = read.filter((flag) => !acceptedFlags(command).includes(flag))
    check(`${app.name} ${command.name} declares every flag it reads`, undeclared.length === 0, undeclared.join(', '))
  }
}

console.log('\n— listing rows —')

const row = issueRow({ ref: 'FOL-19', short: '42d82497', addr: 'x', title: 'A ?file= URL does not open the file it names when the Folder is a team Folder and the file is old', status: 'In Progress', assignee: undefined, author: 'A', project: undefined }, ISSUE_VOCAB)
check('an issue row is ref, status value, short id, clipped title', row.startsWith('FOL-19   in_progress  42d82497 A ?file= URL') && row.endsWith('…'), row)
check('and under 100 chars', row.length < 100, String(row.length))
const prow = projectRow({ ref: 'x', short: '2385fd92', title: 'Make Agent more token efficient', status: 'Planned', lead: 'Miky', archived: true, folder: 'f', issues: 2 } as never, PROJECT_VOCAB)
check('a project row carries short, status, count, title, archived and lead', prow === '2385fd92 planned        2 issues Make Agent more token efficient (archived) — Miky', prow)

console.log('\n— resolving a project (the one that used to guess) —')

/*
  The real collision, reproduced. Three projects on prod contain "Feedback", and
  `--project "Feedback"` silently answered about Ship's for over a week because
  the filter used `.find()` while the issue and topic lookups beside it refused.
  A rule kept in two places out of three is worse than no rule, since a reader
  assumes it holds everywhere.
*/
const project = (over: Partial<Project>): Project => ({
  addr: '30850:abc:x',
  id: 'x',
  author: 'abc',
  createdAt: 0,
  title: 'Untitled',
  description: '',
  contentFolder: 'f',
  status: 'planned',
  archived: false,
  ...over,
})

const projects = [
  project({ id: 'ship', addr: '30850:abc:ship', title: 'Ship: Feedback & Bugs' }),
  project({ id: 'id', addr: '30850:abc:id', title: 'Estiva ID: Feedback & Bugs' }),
  project({ id: 'peek', addr: '30850:abc:peek', title: 'Peek: Feedback & Bugs' }),
  project({ id: 'other', addr: '30850:abc:other', title: 'Other' }),
]

refuses('refuses a word three projects share', () => findProject(projects, 'Feedback'), 'matches 3 projects')
refuses('and names every one of them', () => findProject(projects, 'Feedback'), 'Peek: Feedback & Bugs')

/*
  The fix must not become "be stricter". "Peek: Feedback" is what a person types
  and it has to keep working, so a *unique* partial still resolves.
*/
check('a unique partial still resolves', findProject(projects, 'Peek: Feedback').id === 'peek')
check('an exact title resolves', findProject(projects, 'Other').id === 'other')
check('an address resolves', findProject(projects, '30850:abc:id').id === 'id')
refuses('refuses a project that is not there', () => findProject(projects, 'Nope'), 'No project matches')

console.log('\n— resolving a topic (second app, same rules) —')

/*
  The guard has to hold per app, not per codebase. Peek's topics are named by
  people rather than generated, so near-duplicates are the norm rather than the
  exception — the live workspace has "test", "test 2", "test 3", "test 4" and
  "test 5" side by side, which is exactly where a substring match would guess.
*/
const topic = (id: string, title: string): Topic => ({
  address: `30840:abc:${id}`,
  title,
  folder: { id: 'f', name: 'Peek' },
  object: {} as Topic['object'],
})

const topics = [
  topic('aaa', 'test'),
  topic('bbb', 'test 2'),
  topic('ccc', 'test 3'),
  topic('ddd', 'Planning and sequencing'),
]

const idOf = (found: Topic) => found.address.split(':')[2]
check('finds a topic by exact title', idOf(findTopic(topics, 'Planning and sequencing')) === 'ddd')
check('finds a topic by its id', idOf(findTopic(topics, 'ccc')) === 'ccc')
check('finds a topic by its address', idOf(findTopic(topics, '30840:abc:bbb')) === 'bbb')
{
  // The eight characters a refusal's label prints must resolve back.
  const long = [topic('f51e7476-5bcb-4ea4-ae6c-a3e24691c8b7', 'probe'), topic('a1c14e50-0000-4000-8000-000000000000', 'probe 2')]
  check('finds a topic by the short id its label prints', findTopic(long, 'f51e7476').title === 'probe')
}

/*
  "test" is both an exact title and a prefix of two others. Exact must win, or
  every topic whose title is a prefix of another becomes unreachable.
*/
check('an exact title beats titles containing it', idOf(findTopic(topics, 'test')) === 'aaa')
check('a unique fragment still resolves', idOf(findTopic(topics, 'sequencing')) === 'ddd')
refuses('refuses an ambiguous topic fragment', () => findTopic(topics, 'tes'), 'matches 3 topics')
refuses('refuses an unknown topic', () => findTopic(topics, 'nope'), 'No topic matches')

console.log('\n— what "open" means —')

/*
  Asked "what issues are open", Desktop chose `todo` from the vocabulary and
  left out everything In Progress. Defensible from the enum offered, and not
  what was asked — so the alias exists to stop the most natural question having
  the narrowest answer.
*/
check('open covers todo and in_progress', statusesFor('open', ISSUE_VOCAB).join(',') === 'todo,in_progress')
check('a real status stays itself', statusesFor('done', ISSUE_VOCAB).join(',') === 'done')
refuses('an unknown status is refused', () => statusesFor('wibble', ISSUE_VOCAB), 'Unknown status')
refuses('and the refusal mentions open', () => statusesFor('wibble', ISSUE_VOCAB), 'open')

console.log('\n— naming a change\'s value —')

/*
  A change's value can be a public key: `assignee` is one. Resolving only the
  actor produced "Claude set assignee to b38fd268…" on a real issue — half a
  sentence, where you can see who acted but not who it landed on.

  Ship's own UI already did this (`apps/ship/views/issue.ts`); the agent module
  did not, which is the drift PEEK-155 warns about in miniature.
*/
const people: Directory = new Map([
  ['a'.repeat(64), { pubkey: 'a'.repeat(64), name: 'Claude', createdAt: 0 }],
])

check('names a pubkey it knows', resolvePubkeys(people, 'a'.repeat(64)) === 'Claude')
check('is case-insensitive about the key', resolvePubkeys(people, 'A'.repeat(64)) === 'Claude')

/*
  Left as-is rather than prettified. An unnamed participant is unnamed, and an
  invented label would be worse than the hex — it would imply somebody had a
  profile when nobody does.
*/
check('leaves a pubkey nobody knows alone', resolvePubkeys(people, 'b'.repeat(64)) === 'b'.repeat(64))

// Matched on shape, so a status value is never mistaken for a key.
check('leaves an ordinary value alone', resolvePubkeys(people, 'in_progress') === 'in_progress')
check('leaves an empty value alone', resolvePubkeys(people, '') === '')

console.log('\n— credentials —')

/*
  Claude Desktop launches the server with `wsl.exe -e`, which runs a program
  directly: no login shell, no profile, nothing exported. A server that could
  only read process.env would work in every terminal and fail in the one place
  it is actually used, which is how this was found — Desktop reported missing
  credentials while the CLI worked perfectly.
*/
const dir = mkdtempSync(join(tmpdir(), 'estiva-creds-'))
const file = join(dir, 'agent.env')
writeFileSync(
  file,
  ['# a comment', '', 'ESTIVA_ID_CLIENT_ID=from-file', 'ESTIVA_ID_CLIENT_SECRET="quoted-secret"'].join('\n'),
)

{
  const loaded = loadCredentials({ ESTIVA_AGENT_ENV_FILE: file } as NodeJS.ProcessEnv)
  check('reads credentials from a file when the environment is empty', loaded.clientId === 'from-file')
  check('strips surrounding quotes', loaded.clientSecret === 'quoted-secret')
  check('defaults the identity service', loaded.base.startsWith('https://'))
}

{
  // A terminal must be able to override the file without editing it.
  const loaded = loadCredentials({
    ESTIVA_AGENT_ENV_FILE: file,
    ESTIVA_ID_CLIENT_ID: 'from-env',
    ESTIVA_ID_CLIENT_SECRET: 'env-secret',
  } as NodeJS.ProcessEnv)
  check('the environment wins over the file', loaded.clientId === 'from-env')
}

/*
  The refusal is a security property, not a nicety.

  An earlier version told the caller to run `set -a; . ~/.estiva-agent.env;
  set +a`. Claude Desktop read that, recognised shell commands arriving through
  tool output as indistinguishable from a prompt injection, and refused to act
  — correctly. Anything a tool says reaches a model as untrusted text, so it
  must describe state and never issue a command.
*/
try {
  loadCredentials({ ESTIVA_AGENT_ENV_FILE: join(dir, 'nothing-here.env') } as NodeJS.ProcessEnv)
  check('refuses when no credentials exist anywhere', false, 'it succeeded')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  check('refuses when no credentials exist anywhere', true)
  check('names the file it looked for', message.includes('nothing-here.env'))
  check('says the fix is not available from a conversation', message.includes('cannot be'))

  const commandLike = /set -a|source |npm |npx |chmod |export [A-Z_]+=/.test(message)
  check('contains no command for a model to run', !commandLike, message.slice(0, 70))
}

/*
  Where this process is running (PEEK-168).

  The environment is what actually broke twice — a Desktop extension on the
  Windows host and a Code session inside WSL are separate installs with separate
  credentials, and each answered "is it working?" truthfully about itself while
  saying nothing about the other. Both checks below take their input as an
  argument, because a check that reads the machine it runs on can only ever
  confirm that machine.
*/
{
  const wslKernel = 'Linux version 6.6.87.2-microsoft-standard-WSL2 (root@abc) #1 SMP'
  const plainKernel = 'Linux version 6.1.0-18-amd64 (debian-kernel@lists.debian.org) #1 SMP'
  check('a WSL kernel is recognised', isWslKernel(wslKernel))
  check('an ordinary Linux kernel is not', !isWslKernel(plainKernel))
  // Case, because the string is not ours and has varied across releases.
  check('and the match is case-insensitive', isWslKernel('Linux version 5.15-Microsoft-Standard'))
}

/*
  Which credential won, and where it came from.

  Two surfaces of one client can each be correctly configured while holding
  *different* credentials, and re-issuing either revokes the other because
  minting replaces. Naming the source is the only thing that makes that visible
  without a shell.
*/
{
  const both = loadCredentials({
    ESTIVA_AGENT_ENV_FILE: file,
    ESTIVA_ID_CLIENT_ID: 'from-env',
    ESTIVA_ID_CLIENT_SECRET: 'env-secret',
  } as NodeJS.ProcessEnv)
  check('the environment is named when it wins', both.source.from === 'environment', both.source.from)
  check('and the ignored file is still named', both.source.file === file && both.source.fileState === 'read')

  const fileOnly = loadCredentials({ ESTIVA_AGENT_ENV_FILE: file } as NodeJS.ProcessEnv)
  check('the file is named when it wins', fileOnly.source.from === 'file', fileOnly.source.from)

  // Half from each is the state somebody who set up a file and then installed
  // the extension is actually in, and the one most likely to surprise them.
  const mixed = loadCredentials({
    ESTIVA_AGENT_ENV_FILE: file,
    ESTIVA_ID_CLIENT_ID: 'from-env',
  } as NodeJS.ProcessEnv)
  check('a split credential says so', mixed.source.from === 'mixed', mixed.source.from)
}

/*
  Refusing before the attempt (PEEK-172).

  Five features in this ecosystem shipped, worked everywhere they were checked,
  and failed at `/sign` after their own state had already changed — including
  `peek create-topic` in this repository, which was written, documented and
  merged in a state where it could never succeed. A refusal at the end is
  indistinguishable from success from inside the app that asked.
*/
{
  const agentCeiling = [27235, 1851, 9, 30851, 30850] // claude-agent, as on prod
  const createTopic = { name: 'create-topic', summary: '', signs: [9007], run: async () => null }
  const reply = { name: 'reply', summary: '', signs: [9], run: async () => null }
  const read = { name: 'topics', summary: '', run: async () => null }

  const refusal = refuseUnsignable(createTopic, agentCeiling)
  check('a command needing an unpermitted kind is refused', Boolean(refusal))
  check('the refusal names the kind', refusal?.includes('9007') ?? false)
  check('and names the command', refusal?.includes('create-topic') ?? false)
  /*
    Whose problem it is. The ceiling is per identity in Estiva ID, so nobody in
    a conversation can widen it — and saying so is what stops a model trying.
  */
  check('and says who can change it', refusal?.includes('administrator') ?? false)
  check(
    'without issuing a command to run',
    !/set -a|source |npm |npx |chmod |export [A-Z_]+=/.test(refusal ?? ''),
  )

  check('a permitted command is not refused', refuseUnsignable(reply, agentCeiling) === undefined)
  check('a read is never refused', refuseUnsignable(read, agentCeiling) === undefined)

  /*
    Unknown permits everything, and this is the assertion that matters most.
    An identity service predating PEEK-172 sends no ceiling, and treating absent
    as empty would disable every write against it — turning a diagnostic into an
    outage. Verified against production before the deploy: the ceiling was
    absent and every command still ran.
  */
  check('an unknown ceiling permits everything', refuseUnsignable(createTopic, undefined) === undefined)
  check('mayPublish agrees', mayPublish(undefined, 9007) && !mayPublish([9], 9007))
}

{
  /*
    AGE-7: `ship projects` returned 11 projects and then 9 an hour later, and a
    ticket was filed against discovery. Nothing was wrong with discovery — two
    tracks finished and were archived in between, and the listing hid them
    without saying so.

    The expensive part was the diagnosis, because the obvious check misleads: a
    project is archived by a `kind:1851` change, so the record event carries no
    `archived` tag and reading it "rules out" an archive that has happened.
  */
  const projects = [
    { title: 'live one', archived: false },
    { title: 'finished track', archived: true },
    { title: 'never set', archived: undefined },
  ]

  check('archived projects are hidden by default', archivedRemoved(projects).length === 2)
  check(
    'a project that never set the flag is not treated as archived',
    archivedRemoved(projects).some((p) => p.title === 'never set'),
  )
  check('the hidden one is the archived one', !archivedRemoved(projects).some((p) => p.archived))
  check('nothing is hidden when none are archived', archivedRemoved([{ archived: false }]).length === 1)
}

console.log('— editing a project —')

{
  /*
    AGE-8: the agent could create a project and then never change one. The
    decisions worth pinning are the ones that look right and are not: a project
    status is a *different* vocabulary from an issue status, and clearing a lead
    has to be expressible at all — an append-only stream has no undo, so
    "nobody" is written as a value rather than by removing something.
  */
  const self = 'a'.repeat(64)
  const other = 'b'.repeat(64)
  const project = (over: Partial<Project> = {}): Project => ({
    addr: '30850:abc:p1',
    id: 'p1',
    author: 'abc',
    createdAt: 0,
    title: 'Cross-app read state',
    description: 'the old blurb',
    contentFolder: 'f',
    status: 'planned',
    archived: false,
    ...over,
  })

  const plan = (flags: Record<string, string | true>, over: Partial<Project> = {}) =>
    projectEdits(project(over), { positional: [], flags }, self, PROJECT_VOCAB)

  const rename = plan({ title: 'Read state, everywhere' })
  check('a rename is one change to title', rename.length === 1 && rename[0].field === 'title')
  check('and it carries the value it is coming from', rename[0].from === 'Cross-app read state')
  check('with the note the web UI writes', rename[0].note === 'Rename')

  const many = plan({ title: 'New name', description: 'new blurb', status: 'completed' })
  check('several fields are several changes', many.length === 3, many.map((e) => e.field).join(','))
  check('in the order they are declared', many.map((e) => e.field).join(',') === 'title,description,status')

  check('a project status comes from the project vocabulary', plan({ status: 'completed' })[0].value === 'completed')
  check('and is case-insensitive', plan({ status: 'In_Progress' })[0].value === 'in_progress')
  refuses('an issue status is refused on a project', () => plan({ status: 'done' }), 'planned')
  refuses('and the refusal lists the real vocabulary', () => plan({ status: 'done' }), 'completed')

  const lead = plan({ lead: 'me' })
  check('“me” resolves to the signing identity', lead[0].value === self)
  check('and reads as an assignment', lead[0].note === 'Assign project')
  check('another person is taken by pubkey', plan({ lead: other })[0].value === other)
  check('a pubkey is lowercased', plan({ lead: other.toUpperCase() })[0].value === other)
  refuses('a display name is refused as a lead', () => plan({ lead: 'Miky' }), 'not unique')

  const cleared = plan({ lead: 'none' })
  check('“none” clears the lead', cleared[0].value === '')
  check('by writing an empty value rather than removing anything', cleared[0].field === 'lead')
  check('and reads as an unassignment', cleared[0].note === 'Unassign project')
  check('an empty string clears it too', plan({ lead: '' })[0].value === '')
  check('clearing reports who it was', plan({ lead: 'none' }, { lead: other })[0].from === other)

  check('a description can be cleared', plan({ description: '' })[0].value === '')
  refuses('an empty title is refused', () => plan({ title: '   ' }), 'cannot be empty')
  refuses('a call that changes nothing is refused', () => plan({}), 'at least one')
  refuses('a bare flag with no value is refused', () => plan({ status: true }), 'needs a value')
}

console.log('— editing an issue —')

{
  /*
    AGE-9. The decision worth pinning is the move: an issue's parent was
    believed to be fixed for the life of the issue, and it is not — it is a
    `project` change carrying the target's *address*, which is why the
    reference has to resolve before anything is published. Passing a project
    name straight through as the value would produce an issue parented to a
    string that matches no project, and no reader would report it.
  */
  const projects: Project[] = [
    { addr: '30850:abc:p1', id: 'p1', author: 'abc', createdAt: 0, title: 'Peek: Feedback & Bugs', description: '', contentFolder: 'f1', status: 'planned', archived: false },
    { addr: '30850:abc:p2', id: 'p2', author: 'abc', createdAt: 0, title: 'Ship: Feedback & Bugs', description: '', contentFolder: 'f2', status: 'planned', archived: false },
  ]

  const subject = issue({ addr: '30851:abc:9', title: 'Old title', description: 'old body', projectAddr: '30850:abc:p1' })
  const plan = (flags: Record<string, string | true>) => issueEdits(subject, { positional: [], flags }, projects)

  const renamed = plan({ title: 'New title' })
  check('a rename is one change to title', renamed.length === 1 && renamed[0].field === 'title')
  check('carrying what it came from', renamed[0].from === 'Old title')
  check('with the note the app writes', renamed[0].note === 'Rename')

  const moved = plan({ project: 'Ship: Feedback' })
  check('a move resolves the project to an address', moved[0].value === '30850:abc:p2', moved[0].value)
  check('not to the name it was given', moved[0].value !== 'Ship: Feedback')
  check('and says where it came from', moved[0].from === '30850:abc:p1')
  check('with the note the app writes', moved[0].note === 'Move to Ship: Feedback & Bugs', moved[0].note)

  const detached = plan({ project: 'none' })
  check('“none” detaches the issue', detached[0].value === '')
  check('and reads as such', detached[0].note === 'Move to No project', detached[0].note)

  refuses('an ambiguous project is refused rather than guessed', () => plan({ project: 'Feedback' }), 'Feedback')
  refuses('a project that matches nothing is refused', () => plan({ project: 'nonexistent' }))

  check('a description can be cleared', plan({ description: '' })[0].value === '')
  refuses('an empty title is refused', () => plan({ title: '  ' }), 'cannot be empty')
  refuses('a call that changes nothing is refused', () => plan({}), 'at least one')

  const several = plan({ title: 'T', description: 'D', project: 'Ship: Feedback' })
  check('several fields are several changes', several.length === 3, several.map((e) => e.field).join(','))
}

console.log('— where a Peek write lands (AGE-1) —')

{
  /*
    AGE-1, PRO-20. A reply names the comment answered — its id, its own kind
    (a Ship reply's is 9) and its author — and `buildActionEvent` turns that
    into NIP-22's shape. Wrong fields here and it lands as a second root.
  */
  const opening = { id: 'comment-id', author: 'someone', body: 'hi', createdAt: 0, kind: 9, folder: 'folder' }
  const reply = buildActionEvent({
    manifest: { actions: [{ id: 'comment', label: 'Comment', appliesTo: '30840', emits: { kind: 1111 } }], records: { targetTag: 'a', fieldTag: 'field', valueTag: 'value' } } as never,
    kind: 30840,
    address: '30840:owner:t',
    objectAuthor: 'owner',
    folder: 'folder',
    actionId: 'comment',
    value: 'ok',
    replyTo: replyToOf(opening),
    pubkey: 'agent',
    createdAtMs: 0,
  })
  const tag = (name: string) => (typeof reply === 'string' ? [] : reply.tags.filter((t) => t[0] === name).map((t) => t[1]))
  check('a reply is built', typeof reply !== 'string', typeof reply === 'string' ? reply : '')
  check('the root is still the file', tag('A')[0] === '30840:owner:t')
  check('the parent is the comment, with its own kind', tag('e')[0] === 'comment-id' && tag('k')[0] === '9')
  check('and its author', tag('p').length === 1 && tag('p')[0] === 'someone')
  check('with no lowercase a naming the file', tag('a').length === 0, 'a reply on the #a read would be a second root')

  /*
    Where `create-topic` may put one: a Folder at the top of Peek's tree. A
    Folder another lists, or a bare channel, is not on every person's tree.
  */
  const top = topLevelFolders([
    { id: 'team', hasState: true },
    { id: 'nested', hasState: true, listedIn: ['team'] },
    { id: 'bare', hasState: false },
  ]).map((folder) => folder.id)
  check('a top-level Folder is one', top.join() === 'team', top.join())
}

console.log('— editing a message —')

{
  /*
    AGE-3. An edit is a separate `kind:40003` naming its target, so the fold is
    what decides which body a reader shows — and getting it wrong is not a
    cosmetic bug here. An agent quoting a comment back at somebody is the only
    thing between them and a body that was rewritten after they were told about
    it, so `edited` marks the pair rather than silently substituting.
  */
  // 64-hex ids: SPEC §6.8's target is the first `e` whose value is 64 hex (`@estiva-app/conversation`).
  const M1 = '1'.repeat(64)
  const M2 = '2'.repeat(64)
  const edit = (over: Partial<SignedEvent> & { target: string }): SignedEvent => ({
    id: over.id ?? 'e1',
    pubkey: 'abc',
    kind: KIND_EDIT,
    created_at: over.created_at ?? 1_000,
    content: over.content ?? 'new text',
    sig: '',
    tags: [
      ['h', 'folder'],
      ['e', over.target],
      ...(over.tags ?? []),
    ],
  })

  {
    const index = foldEdits([edit({ target: M1, content: 'corrected' })])
    check('an edit is folded onto its target', index[M1]?.body === 'corrected')
    check('and nothing else picks it up', index[M2] === undefined)
  }

  {
    /*
      `ts` is honoured only when it agrees with `created_at` to the second
      (SPEC §6.2). Both of these land in the same second, so without `ts` there
      would be no defined order at all — which is the whole reason the builder
      emits one that Buzz's own does not.
    */
    const index = foldEdits([
      edit({ id: 'a', target: M1, content: 'first', created_at: 1_000, tags: [['ts', '1000200']] }),
      edit({ id: 'b', target: M1, content: 'second', created_at: 1_000, tags: [['ts', '1000900']] }),
    ])
    check('the later ts wins inside one second', index[M1]?.body === 'second')
    check('and the time reported is the ts, in milliseconds', index[M1]?.editedAt === 1_000_900)
  }

  {
    // A `ts` disagreeing with `created_at` is ignored rather than preferred —
    // otherwise a client with a wrong clock reorders somebody's conversation,
    // and the relay validates only `created_at`.
    const index = foldEdits([
      edit({ id: 'a', target: M1, content: 'honest', created_at: 2_000 }),
      edit({ id: 'b', target: M1, content: 'liar', created_at: 1_000, tags: [['ts', '9999000']] }),
    ])
    check('a ts outside its own second cannot win', index[M1]?.body === 'honest')
  }

  {
    const index = foldEdits([{ ...edit({ target: M1 }), tags: [['h', 'folder']] }])
    check('an edit naming no target is dropped', Object.keys(index).length === 0)
  }

  {
    const index = foldEdits([edit({ target: M1, content: 'now', created_at: 5 })])

    const untouched = edited(index, { id: M2, body: 'as written' })
    check('an unedited message keeps its body', untouched.body === 'as written')
    check('and carries no marker at all', untouched.edited === undefined && untouched.editedAt === undefined)

    const changed = edited(index, { id: M1, body: 'as written' })
    check('an edited message shows the new text', changed.body === 'now')
    check('and says that it was edited', changed.edited === true)
    check('with when, to the millisecond', changed.editedAt === new Date(5_000).toISOString())
  }
}

{
  /*
    Resolving the target. The candidate set is narrowed by the caller — one
    conversation, or one object's conversations — because a phrase matched
    across a busy topic is how the wrong message gets rewritten, and unlike a
    misplaced reply nothing afterwards shows what the text used to be.
  */
  const messages = [
    { id: 'm1', body: 'Gate cleared. estiva-id#60 merged' },
    { id: 'm2', body: 'Ship half is up for review' },
    { id: 'm3', body: 'Peek half is up for review' },
  ]

  check('an exact id resolves', findMessage(messages, 'm2').id === 'm2')
  check('a distinctive phrase resolves', findMessage(messages, 'Gate cleared').id === 'm1')
  refuses('a phrase matching two messages is refused, not guessed', () => findMessage(messages, 'up for review'), 'matches')
  refuses('a phrase matching nothing is refused', () => findMessage(messages, 'nonexistent'))
  refuses('an empty conversation says so rather than refusing the phrase', () => findMessage([], 'anything'), 'no messages')
}

console.log('— since, for the activity feed —')

{
  /*
    AGE-12. `--since` has to accept both shapes the question comes in — "what
    happened while I was away" is a duration, "what happened on the day it
    broke" is a date — and refuse anything else rather than defaulting.

    Defaulting is the failure worth preventing: a `--since` that quietly meant
    "everything" answers a narrow question with the whole workspace, and the
    answer looks exactly like a correct one.
  */
  const now = Date.parse('2026-08-30T12:00:00.000Z')
  const iso = (at: number) => new Date(at).toISOString()

  check('hours', iso(parseSince('12h', now)) === '2026-08-30T00:00:00.000Z', iso(parseSince('12h', now)))
  check('days', iso(parseSince('2d', now)) === '2026-08-28T12:00:00.000Z', iso(parseSince('2d', now)))
  check('minutes', iso(parseSince('30m', now)) === '2026-08-30T11:30:00.000Z')
  check('case does not matter', parseSince('12H', now) === parseSince('12h', now))
  check('spacing does not matter', parseSince('12 h', now) === parseSince('12h', now))

  check('a bare date is midnight UTC', iso(parseSince('2026-08-29', now)) === '2026-08-29T00:00:00.000Z')
  check('a full timestamp is taken as written', iso(parseSince('2026-08-29T06:30:00Z', now)) === '2026-08-29T06:30:00.000Z')

  refuses('a word is refused, not treated as everything', () => parseSince('yesterday', now), 'neither')
  refuses('and the refusal shows the forms', () => parseSince('yesterday', now), '2d')
  refuses('an empty value is refused', () => parseSince('', now))
  refuses('a bare number is refused', () => parseSince('7', now))
}

console.log('— assigning, and unassigning —')

{
  /*
    AGE-16. `assign` could set an assignee and never clear one, which made it
    the only irreversible write in the CLI — while `--lead none` had cleared a
    project lead all along. The asymmetry mattered beyond tidiness: it is why
    AGE-15's end-to-end check could not assign a key to a throwaway issue and
    had to use an already-assigned one instead.
  */
  const self = 'a'.repeat(64)
  const other = 'b'.repeat(64)

  check('a key passes through', assigneeFor(other, self) === other)
  check('“me” is the signing identity', assigneeFor('me', self) === self)
  check('a key is lowercased', assigneeFor(other.toUpperCase(), self) === other)

  check('“none” clears the assignment', assigneeFor('none', self) === '')
  check('an empty value clears it too', assigneeFor('', self) === '')
  check(
    'clearing writes a value rather than removing anything',
    assigneeFor('none', self) === '',
    'an append-only stream has no undo',
  )

  refuses('a display name is still refused', () => assigneeFor('Katerina', self), 'not unique')
  refuses('and the refusal names the escape hatch', () => assigneeFor('Katerina', self), 'none')
  refuses('a truncated key is refused', () => assigneeFor(other.slice(0, 40), self))
}

{
  /*
    SHA-28, through interop 0.48: an assignee is a member of the file, so the
    change names them where the relay indexes it — `["p", key]` — and a clear
    names nobody. Built from the manifest Ship published, as `edit-issue` does.
  */
  const shipManifest = JSON.parse(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'conformance', 'ship-manifest.json'), 'utf8')).event.content)
  const self = 'a'.repeat(64)
  const qa2 = 'c'.repeat(64)
  const assign = (value: string) => {
    const built = buildActionEvents({
      manifest: shipManifest,
      kind: 30851,
      address: `30851:${self}:issue-1`,
      objectAuthor: self,
      folder: 'f'.repeat(32),
      actionId: 'assign-issue',
      value,
      pubkey: self,
      createdAtMs: 1_000_000,
    })
    if (typeof built === 'string') throw new Error(built)
    return built[0]
  }
  const pTags = (event: { tags: string[][] }) => event.tags.filter((tag) => tag[0] === 'p')
  check('an assignee is a p tag on the change', JSON.stringify(pTags(assign(qa2))) === JSON.stringify([['p', qa2]]), JSON.stringify(pTags(assign(qa2))))
  check('clearing the assignee names nobody', pTags(assign(assigneeFor('none', self))).length === 0, JSON.stringify(pTags(assign(''))))
}

console.log('— moving a project with what is under it (MAN-17) —')

{
  /*
    interop 0.47's `planMoveFile` takes the source Folder's listing and moves
    the file with everything listed beneath it, in one add and one remove.
    Before, the agent moved the project alone and left a topic started under
    it in the old Folder. Mirrors Ship's `Store.moveProject` (ship#239).
  */
  const self = 'a'.repeat(64)
  const project = `30850:${self}:project-1`
  const topic = `30840:${self}:topic-1`
  const elsewhere = `30840:${self}:topic-2`
  const from = { id: '1'.repeat(32), hasState: true }
  const to = { id: '2'.repeat(32), hasState: true }
  const listing = [
    { ref: project, address: project },
    { ref: topic, address: topic, parentRef: project, folder: from.id },
    { ref: elsewhere, address: elsewhere, folder: from.id },
  ]
  const fake = () => {
    const sent: { kind: number; tags: string[][] }[] = []
    const context = {
      signer: { pubkey: self, sign: async (event: { kind: number; tags: string[][] }) => ({ ...event, id: String(sent.length) }) },
      relay: { publish: async (event: { kind: number; tags: string[][] }) => (sent.push(event), { ok: true }) },
    } as unknown as Parameters<typeof moveFile>[0]
    return { context, sent }
  }
  const named = (event: { tags: string[][] }) => event.tags.filter((tag) => tag[0] === 'a').map((tag) => tag[1]).sort()

  {
    {
      const { context, sent } = fake()
      const moved = await moveFile(context, { address: project, from: [from], to, listings: new Map([[from.id, listing]]) })
      check('one add, then one remove', sent.length === 2 && sent.every((event) => event.kind === 1852), `${sent.length} sent`)
      check('both name the project and the topic under it', sent.every((event) => JSON.stringify(named(event)) === JSON.stringify([project, topic].sort())), JSON.stringify(sent.map(named)))
      check('a topic beside it stays where it is', !sent.some((event) => named(event).includes(elsewhere)))
      check('the add goes to the target', sent[0].tags.some((tag) => tag[0] === 'h' && tag[1] === to.id))
      check('and what went with it is reported', JSON.stringify(moved.moved.sort()) === JSON.stringify([project, topic].sort()))
      check('no name rides on a Folder command', !sent.some((event) => event.tags.some((tag) => tag[0] === 'name')))
    }
    {
      const { context, sent } = fake()
      const moved = await moveFile(context, { address: project, from: [from], to: { ...to, private: true }, listings: new Map([[from.id, listing]]) })
      check('a private target is refused before anything is sent', moved.refused === 'target-is-private' && sent.length === 0, moved.refused)
    }
    {
      const { context, sent } = fake()
      const moved = await moveFile(context, { address: project, from: [from], to: { ...to, hasState: false }, listings: new Map([[from.id, listing]]) })
      check('a target with no state is refused before anything is sent', moved.refused === 'target-has-no-state' && sent.length === 0, moved.refused)
    }
    {
      const { context, sent } = fake()
      const moved = await moveFile(context, { address: project, from: [], to: { ...to, private: true }, listings: new Map() })
      check('placing a project listed nowhere into a private Folder is refused too', moved.refused === 'target-is-private' && sent.length === 0, moved.refused)
    }
    {
      // The relay's answer per publish, in order.
      const answering = (...answers: boolean[]) => {
        const { context, sent } = fake()
        ;(context.relay as unknown as { publish: (event: { kind: number; tags: string[][] }) => Promise<{ ok: boolean; reason?: string }> }).publish = async (event) => {
          sent.push(event)
          const ok = answers[sent.length - 1] ?? true
          return ok ? { ok } : { ok, reason: 'refused' }
        }
        return { context, sent }
      }
      {
        const { context, sent } = answering(false)
        const moved = await moveFile(context, { address: project, from: [from], to, listings: new Map([[from.id, listing]]) })
        check('a refused add removes nothing', sent.length === 1 && moved.removed.length === 0 && moved.added?.ok === false && !moved.partly)
      }
      {
        const { context, sent } = answering(true, false)
        const moved = await moveFile(context, { address: project, from: [from], to, listings: new Map([[from.id, listing]]) })
        check('a refused remove is reported against its Folder', sent.length === 2 && moved.added?.ok === true && moved.removed[0]?.folder === from.id && moved.removed[0]?.result.ok === false)
      }
      {
        // Listed in two Folders with different sets beneath it: two adds, and the second is refused.
        const other = { id: '3'.repeat(32), hasState: true }
        const { context, sent } = answering(true, false)
        const moved = await moveFile(context, {
          address: project,
          from: [from, other],
          to,
          listings: new Map([[from.id, listing], [other.id, [{ ref: project, address: project }]]]),
        })
        check('a second add refused after the first landed is reported as partly moved', sent.length === 2 && moved.partly === true && moved.removed.length === 0)
      }
    }
  }
}

console.log('— who the workspace has seen —')

{
  /*
    AGE-15. `assign` and `edit-project --lead` take a key and refuse a name,
    correctly — but nothing exposed the keys, so the only assignment the agent
    could make was to itself.

    The counting rule worth pinning is that a change's *value* can be a key:
    somebody who has only ever been assigned work by other people has authored
    nothing, and a naive pass over authors would leave them out of the one list
    that exists to find them.
  */
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  const c = 'c'.repeat(64)

  const state = {
    issues: [
      { author: a, assignee: undefined },
      { author: a, assignee: b },
    ],
    projects: [{ author: a, lead: c }],
    activity: [
      { author: a, field: 'assignee', value: b },
      { author: a, field: 'status', value: 'done' },
    ],
    conversations: [{ root: { author: c }, replies: [{ author: b }] }],
  } as never

  const found = participants(state)
  const of = (key: string) => found.find((person) => person.pubkey === key)

  check('everyone who touched anything appears', found.length === 3, found.map((p) => p.pubkey[0]).join(','))
  check('an author is counted as filing', of(a)?.filed === 2)
  check('an assignee is counted', (of(b)?.assigned ?? 0) >= 1)
  check(
    'somebody named only in a change value still appears',
    Boolean(of(b)),
    'assigned by others, authored nothing',
  )
  check('a project lead is counted', of(c)?.leads === 1)
  check('a commenter is counted as acting', (of(c)?.acted ?? 0) >= 1)

  check('a non-key value is not mistaken for a person', !found.some((p) => p.pubkey === 'done'))
  check('the busiest is first', found[0].pubkey === a, found[0].pubkey[0])
  check('keys are lowercased', found.every((p) => p.pubkey === p.pubkey.toLowerCase()))

  const upper = participants({ issues: [{ author: a.toUpperCase(), assignee: undefined }], projects: [], activity: [], conversations: [] } as never)
  check('an uppercase key is the same person', upper[0].pubkey === a)

  // A relay member who has done nothing yet can still be found to assign (PER-21).
  const quiet = 'd'.repeat(64)
  const withMembers = participants(state, [quiet, a, 'not-a-key'])
  check('a relay member who did nothing appears', withMembers.some((p) => p.pubkey === quiet && p.filed + p.assigned + p.leads + p.acted === 0))
  check('a member who did nothing comes last', withMembers.at(-1)?.pubkey === quiet)
  check('a member who acted is counted once', withMembers.filter((p) => p.pubkey === a).length === 1 && withMembers.length === 4)
}

console.log('— resolving across two kinds —')

{
  /*
    AGE-11. `show` now asks the same question of issues and of projects, which
    is only safe because the matching rule stayed in one place. The distinction
    worth pinning is between "nothing matched" and "several matched": a
    fallback that treats them alike would answer about a project when three
    issues matched, and there would be nothing in the answer to say so.
  */
  const by = {
    noun: 'thing',
    exact: (item: { id: string }) => [item.id],
    text: (item: { id: string }) => item.id,
    label: (item: { id: string }) => item.id,
  }
  const items = [{ id: 'alpha' }, { id: 'alphabet' }, { id: 'beta' }]

  const one = resolveMaybe(items, 'beta', by)
  check('a single match is found', 'found' in one && one.found.id === 'beta')

  const exact = resolveMaybe(items, 'alpha', by)
  check('an exact match still beats a substring', 'found' in exact && exact.found.id === 'alpha')

  const many = resolveMaybe(items, 'alph', by)
  check('several matches are reported as ambiguous', 'ambiguous' in many)
  check('and the candidates are listed', 'ambiguous' in many && many.ambiguous.includes('alphabet'))

  const none = resolveMaybe(items, 'gamma', by)
  check('no match is its own answer, not an ambiguity', 'none' in none)
  check(
    'which is the distinction show depends on',
    'none' in none && !('ambiguous' in none) && !('found' in none),
  )

  refuses('resolveOne still throws on ambiguity', () => findProject(
    [
      { id: 'p1', title: 'Peek: Feedback' } as never,
      { id: 'p2', title: 'Ship: Feedback' } as never,
    ],
    'Feedback',
  ), 'matches 2')
}

{
  /*
    AGE-6: the MCP server runs whatever branch the shared checkout is parked on,
    and a listing 13 issues short arrived with a note blaming the workspace. The
    answer now carries the revision that produced it.

    Parsed rather than shelled out for, and tested here rather than on whatever
    the author's HEAD happens to be — asserting against the real repository
    would pass for the wrong reason on any machine.
  */
  check('a branch HEAD yields the branch', parseGitHead('ref: refs/heads/main\n').branch === 'main')
  check('a branch name with slashes survives', parseGitHead('ref: refs/heads/janmikula/peek-161\n').branch === 'janmikula/peek-161')
  check('a detached HEAD yields the commit', parseGitHead('a'.repeat(40)).commit === 'a'.repeat(40))
  check('a detached HEAD has no branch', parseGitHead('b'.repeat(40)).branch === undefined)
  check('a short hash is not mistaken for a commit', parseGitHead('abc123').commit === undefined)
  check('a tag ref is neither', Object.keys(parseGitHead('ref: refs/tags/v1')).length === 0)
}

{
  /*
    The launcher's choice of tree, reported so a diagnosis is one call.

    Anything unrecognised is dropped rather than passed through: this field
    exists to be trusted, and a stray value in the environment reported as fact
    is worse than no field at all.
  */
  check('pinned is reported', runtimeSource('pinned') === 'pinned')
  check('dev is reported', runtimeSource('dev') === 'dev')
  check('the fallback is reported', runtimeSource('checkout') === 'checkout')
  check('an unknown value is dropped', runtimeSource('production') === undefined)
  check('an unset variable is dropped', runtimeSource(undefined) === undefined)
}

console.log(failures === 0 ? '\nAll agent CLI checks passed.' : `\n${failures} failed.`)
process.exit(failures === 0 ? 0 : 1)
