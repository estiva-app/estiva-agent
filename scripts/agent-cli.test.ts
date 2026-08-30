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
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BadRequest, flagValue, parseArgs } from '../lib/agent/cli'
import { resolveMaybe } from '../lib/agent/resolve'
import { isWslKernel, parseGitHead, refuseUnsignable, runtimeSource } from '../lib/agent/cli'
import { mayPublish } from '../lib/agent/credentials'
import { loadCredentials } from '../lib/agent/credentials'
import { archivedRemoved, assigneeFor, findIssue, findProject, issueEdits, participants, projectEdits, resolvePubkeys, statusesFor } from '../lib/agent/apps/ship'
import type { Project } from '../src/fold'
import { findTopic, type Topic } from '../lib/agent/apps/peek'
import type { Issue } from '../src/fold'
import type { Directory } from '../src/profiles'

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
  fields: {},
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
  originFolder: 'f',
  status: 'planned',
  archived: false,
  fields: {},
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
const topic = (over: Partial<Topic>): Topic => ({
  folder: 'f',
  name: 'Untitled',
  createdBy: 'abc',
  createdAt: 0,
  ...over,
})

const topics = [
  topic({ folder: 'aaa', name: 'test' }),
  topic({ folder: 'bbb', name: 'test 2' }),
  topic({ folder: 'ccc', name: 'test 3' }),
  topic({ folder: 'ddd', name: 'Planning and sequencing' }),
]

check('finds a topic by exact name', findTopic(topics, 'Planning and sequencing').folder === 'ddd')
check('finds a topic by folder id', findTopic(topics, 'ccc').folder === 'ccc')

/*
  "test" is both an exact name and a prefix of two others. Exact must win, or
  every topic whose name is a prefix of another becomes unreachable.
*/
check('an exact name beats names containing it', findTopic(topics, 'test').folder === 'aaa')
check('a unique fragment still resolves', findTopic(topics, 'sequencing').folder === 'ddd')
refuses('refuses an ambiguous topic fragment', () => findTopic(topics, 'tes'), 'matches 3 topics')
refuses('refuses an unknown topic', () => findTopic(topics, 'nope'), 'No topic matches')

console.log('\n— what "open" means —')

/*
  Asked "what issues are open", Desktop chose `todo` from the vocabulary and
  left out everything In Progress. Defensible from the enum offered, and not
  what was asked — so the alias exists to stop the most natural question having
  the narrowest answer.
*/
check('open covers todo and in_progress', statusesFor('open').join(',') === 'todo,in_progress')
check('a real status stays itself', statusesFor('done').join(',') === 'done')
refuses('an unknown status is refused', () => statusesFor('wibble'), 'Unknown status')
refuses('and the refusal mentions open', () => statusesFor('wibble'), 'open')

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
    originFolder: 'f',
    status: 'planned',
    archived: false,
    fields: {},
    ...over,
  })

  const plan = (flags: Record<string, string | true>, over: Partial<Project> = {}) =>
    projectEdits(project(over), { positional: [], flags }, self)

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
    { addr: '30850:abc:p1', id: 'p1', author: 'abc', createdAt: 0, title: 'Peek: Feedback & Bugs', description: '', contentFolder: 'f1', originFolder: 'f1', status: 'planned', archived: false, fields: {} },
    { addr: '30850:abc:p2', id: 'p2', author: 'abc', createdAt: 0, title: 'Ship: Feedback & Bugs', description: '', contentFolder: 'f2', originFolder: 'f2', status: 'planned', archived: false, fields: {} },
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
      { title: 'Peek: Feedback' } as never,
      { title: 'Ship: Feedback' } as never,
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
