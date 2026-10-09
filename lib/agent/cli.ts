/**
 * The half of the agent CLI that knows nothing about any app.
 *
 * Ship is the first app an agent reads here, not the only one. Peek is already
 * live on the same relay and a third is coming, and all of them share one
 * relay, one identity service and one profile directory — apps sharing no code
 * and no database working on the same data is the ecosystem's whole claim.
 *
 * So the split is drawn here, while there is exactly one implementation to get
 * wrong:
 *
 *   **generic** — credentials, signing, NIP-98, the relay, argument parsing,
 *   output and exit codes. Nothing in this file may name a kind, a tag or an
 *   object type. If it does, the seam has already leaked.
 *
 *   **per app** — which kinds exist, how to fold them, and what an object looks
 *   like when printed. One module each, registered below.
 *
 * The test of whether this worked is not that it reads well: it is that adding
 * Peek touches no file in `lib/agent/` except the registry it is added to.
 */
import type { Signer } from '../nostr/signer'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Relay } from '@estiva-app/protocol'
import { clientCredentialsToken, loadCredentials, serviceIdentitySigner } from './credentials'

/** What every command is handed. Deliberately free of app concepts. */
export interface AgentContext {
  relay: Relay
  signer: Signer
  relayUrl: string
  /**
   * What this credential may sign, from `/token`. Undefined against an identity
   * service that predates PEEK-172, which means unknown rather than none.
   */
  allowedKinds?: number[]
}

export interface ParsedArgs {
  /** Everything that was not a `--flag`, in order. */
  positional: string[]
  /** `--key value` and bare `--flag` (which reads as `true`). */
  flags: Record<string, string | true>
}

export interface AgentCommand {
  name: string
  summary: string
  /** Shown in `--help`, e.g. `show <ref>`. */
  usage?: string
  /**
   * The kinds this command publishes, so the runner can refuse it up front.
   *
   * Declared per command because only the app knows what it writes, and read by
   * `cli.ts` without ever naming one — the same shape as `AgentApp.probe`.
   *
   * Omitted by a read: nothing to publish, nothing to refuse.
   */
  signs?: number[]
  /**
   * Return anything JSON-serialisable. Printing, exit codes and error shape are
   * the runner's job, so a command never calls `process.exit` or `console.log`
   * — a command that prints is a command that cannot be reused by an MCP tool
   * later without being rewritten.
   */
  run(context: AgentContext, args: ParsedArgs): Promise<unknown>
  /**
   * The result as lines of text, for a listing somebody greps rather than
   * pipes (MAK-2). Rendered by the app — the runner knows nothing about what
   * the lines contain. The CLI prints them unless `--json` asks for the shape
   * `run` returned, and the MCP server returns them as the tool's text (MAK-3),
   * so both front-ends hand a client the same bytes.
   *
   * Absent on every command that is not a listing; JSON is still the default.
   */
  lines?(result: unknown): string[]
}

/**
 * Flags the runner itself understands, accepted by every command.
 *
 * Any other flag has to appear in the command's `usage` — that string is the
 * documented contract, and reading the accepted set from it means the two
 * cannot drift. A flag outside it is refused: before this, `--projekt x` was
 * silently ignored and `issues` answered for the whole workspace.
 */
const RUNNER_FLAGS = ['help', 'json']

export function acceptedFlags(command: AgentCommand): string[] {
  const declared = [...(command.usage ?? '').matchAll(/--([a-z-]+)/g)].map((match) => match[1])
  return [...new Set([...RUNNER_FLAGS, ...declared])]
}

/** The one line an unknown flag gets: the flag, the command, its usage. */
export function unknownFlag(command: AgentCommand, flags: Record<string, unknown>): string | undefined {
  const accepted = acceptedFlags(command)
  const unknown = Object.keys(flags).filter((flag) => !accepted.includes(flag))
  if (unknown.length === 0) return undefined
  return `Unknown flag --${unknown[0]}. Usage: ${command.usage ?? command.name}`
}

export interface AgentApp {
  name: string
  summary: string
  commands: AgentCommand[]
  /**
   * A filter that proves relay reads work, supplied by the app because this
   * file may not name a kind.
   *
   * Not a stylistic concession to the seam — the relay refuses a filter with no
   * `kinds` outright (`restricted: p-gated kinds require #p tag matching your
   * pubkey`), so there is no app-agnostic query to fall back on. A connection
   * check has to ask for something in particular, and only the app knows what.
   */
  probe?: Record<string, unknown>[]
}

/**
 * Raised by a command when the input was wrong rather than the world.
 *
 * Separated so the runner can tell "you asked for something impossible" from "a
 * remote service failed", which are different things for whoever is reading and
 * would otherwise both arrive as a bare stack trace.
 */
export class BadRequest extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequest'
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const key = arg.slice(2)
    // The second would silently replace the first: `--mention a --mention b`
    // mentioned only b. A list is one value, comma-separated where a flag takes one.
    if (Object.hasOwn(flags, key)) throw new BadRequest(`--${key} was given twice. Pass it once.`)
    const next = argv[i + 1]
    // A following token that is itself a flag means this one is a boolean —
    // `--archived --project x` must not read as `archived: '--project'`.
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true
    } else {
      flags[key] = next
      i++
    }
  }
  return { positional, flags }
}

/** A flag's value, refusing a bare `--flag` where a value was required. */
export function flagValue(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name]
  if (value === true) throw new BadRequest(`--${name} needs a value`)
  return value
}

function usage(apps: AgentApp[]): string {
  const lines = ['Read the Estiva workspace as a service identity.', '']
  for (const app of apps) {
    lines.push(`  ${app.name} — ${app.summary}`)
    for (const command of app.commands) {
      lines.push(`    ${(command.usage ?? command.name).padEnd(34)} ${command.summary}`)
    }
    lines.push('')
  }
  lines.push('Credentials come from the environment:')
  lines.push('  set -a; . ~/.estiva-agent.env; set +a')
  return lines.join('\n')
}

/**
 * Build the relay connection every command shares.
 *
 * Separate from `run` so a future MCP server can obtain a context once and hold
 * it across many tool calls, rather than paying a token exchange per call.
 */
export async function connect(): Promise<AgentContext> {
  const credentials = loadCredentials()
  const { signer, allowedKinds, relayHeaders } = await serviceIdentitySigner(credentials)
  /*
    A second token exchange purely to read the ceiling would be wasteful, so the
    signer's own first token carries it — see `serviceIdentitySigner`.

    `relayHeaders` carries the NIP-OA owner attestation from the same response
    (PEEK-164). It is passed as a callback rather than a value so a token
    renewal, which is invisible by design, replaces the tag with it.
  */
  return {
    relay: new Relay(relayUrl(), signer, relayHeaders),
    signer,
    relayUrl: relayUrl(),
    allowedKinds,
  }
}

/**
 * Why a command cannot run here, or nothing.
 *
 * Checked **before** the command does any work, which is the whole point. Five
 * features in this ecosystem have shipped, worked everywhere they were checked,
 * and failed at `/sign` after their own state had already changed — a Ship
 * change from Peek, a resolution, a topic rename, a topic delete, and this
 * repository's own `peek create-topic` (PEEK-172). A refusal at the end looks
 * identical to a success from inside the app; a refusal at the start does not.
 *
 * Not an authorisation check. Estiva ID enforces the real one server-side, and
 * an unknown ceiling permits everything — this exists so a tool that cannot
 * work says so instead of failing at the last step.
 */
export function refuseUnsignable(
  command: AgentCommand,
  allowedKinds: number[] | undefined,
): string | undefined {
  if (!command.signs || allowedKinds === undefined) return undefined
  const missing = command.signs.filter((kind) => !allowedKinds.includes(kind))
  if (!missing.length) return undefined
  return (
    `This credential may not sign kind ${missing.join(', ')}, which "${command.name}" has to publish. ` +
    `It is allowed ${allowedKinds.join(', ')}. ` +
    'What a credential may sign is set per identity in Estiva ID by an administrator, ' +
    'and cannot be changed from within a conversation.'
  )
}

/**
 * The relay to read, treating a blank value as unset.
 *
 * `??` was wrong here and the Desktop extension is what exposes it: a packaged
 * extension injects **every** declared setting into the environment, so an
 * optional field nobody filled in arrives as `RELAY_URL=""` rather than absent.
 * Nullish coalescing keeps the empty string, and the whole read then fails
 * against an empty URL — a configuration screen left untouched breaking the
 * only thing the extension does.
 */
export const DEFAULT_RELAY_URL = 'https://estiva.estiva.app'

function relayUrl(): string {
  const configured = process.env.RELAY_URL?.trim()
  return (configured || DEFAULT_RELAY_URL).replace(/\/+$/, '')
}

/**
 * Where this process is running, in the terms a person would use to place it.
 *
 * Reported because the environment is what actually went wrong, twice, and was
 * invisible from either end. A packaged Desktop extension runs under Desktop's
 * own Node on Windows; a Claude Code session opened on a WSL folder runs its
 * agent inside the distro. Same application, two surfaces, opposite sides of a
 * machine boundary, two unrelated MCP registries and two credential stores —
 * and asking either one "is it working?" gave an answer that was true of itself
 * and said nothing about the other (PEEK-168).
 *
 * Diagnosing that took a process tree and a package-container path. **A person
 * without a shell had no route to the answer at all**, which is exactly the
 * person the packaged extension exists to serve. So the server says which
 * environment it is in, and "it works in one tab and not the other" is settled
 * by asking both and comparing two replies.
 */
export interface Runtime {
  platform: NodeJS.Platform
  /** True on WSL, where `platform` says `linux` and the distinction matters. */
  wsl: boolean
  /** The distro, when there is one, because a person has more than one. */
  distro?: string
  node: string
  /** The file actually running, which names the install this answer is about. */
  entry: string
  /** The client that opened this session, from the MCP handshake. */
  client?: string
  /**
   * Which code is answering, not just where it runs.
   *
   * AGE-6: this server is launched by `scripts/mcp-server.sh`, which runs
   * whatever is checked out in the shared `~/estiva-agent` at the moment the
   * session starts. That checkout sits on a peer's branch routinely, so an
   * answer can come from a revision days behind `origin/main` — and the failure
   * is silent *and* authoritative: a listing 13 issues short, with a `coverage`
   * note asserting the shortfall is a limit of the workspace rather than of the
   * binary. Measured 2026-08-28: the server reported `unreachable: 13` while the
   * CLI at `origin/main` reported `0`, same identity, same relay, minutes apart.
   *
   * A person can be told to check their checkout. An agent cannot, because the
   * answer carried no revision. Now it does.
   */
  revision?: RuntimeRevision
  /**
   * Which tree the launcher chose, when it was launched by one.
   *
   * `revision` says *what* is running; this says *why that one*. Together they
   * turn "the answer looks wrong" into one call: a `checkout` source with an
   * old commit is the AGE-6 failure exactly, and a `dev` source explains a
   * revision that matches no published commit.
   */
  source?: RuntimeSource
}

/**
 * How the launcher picked the tree.
 *
 * `pinned` — a worktree pinned to a commit, the default.
 * `dev`    — this checkout, on purpose, to test a local edit.
 * `checkout` — this checkout, as a fallback, because nothing was pinned yet.
 */
export type RuntimeSource = 'pinned' | 'dev' | 'checkout'

/**
 * The launcher's choice, or nothing when it was not launched by the script.
 *
 * Pure and narrow because an unknown value must not be reported as fact: this
 * field exists to be trusted in a diagnosis, so anything it does not recognise
 * is dropped rather than passed through.
 */
export function runtimeSource(value: string | undefined): RuntimeSource | undefined {
  return value === 'pinned' || value === 'dev' || value === 'checkout' ? value : undefined
}

/** The commit answering, and whether its tree has uncommitted changes. */
export interface RuntimeRevision {
  commit?: string
  branch?: string
  /** Undefined when it could not be determined, which is not the same as clean. */
  dirty?: boolean
}

/**
 * Whether a `/proc/version` string describes a WSL kernel.
 *
 * Split out so it can be tested at all. Asserting on the *result* only works on
 * the machine the test happens to run on — the check that shipped first was
 * `typeof wsl === 'boolean'`, which is satisfied by hardcoding `false`, proved
 * by hardcoding `false` and watching it pass. The predicate takes its input as
 * an argument so both answers can be demanded from any machine.
 */
/**
 * Detected rather than configured, and from `/proc/version` rather than an
 * environment variable, because `WSL_DISTRO_NAME` is absent exactly when it
 * would help: `wsl.exe -e` runs a program with no login shell, which is how
 * this server gets launched in the setup that needed diagnosing.
 */
export function isWslKernel(procVersion: string): boolean {
  return /microsoft|wsl/i.test(procVersion)
}

/**
 * `.git/HEAD` as a branch name or a detached commit.
 *
 * Pure, because this suite's premise is that decisions are testable without a
 * machine in a particular state — and "is HEAD parsed correctly" is exactly the
 * kind of thing that passes on the author's laptop by accident.
 */
export function parseGitHead(head: string): { branch?: string; commit?: string } {
  const text = head.trim()
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text)
  if (ref) return { branch: ref[1] }
  return /^[0-9a-f]{40}$/.test(text) ? { commit: text } : {}
}

/**
 * A path's git directories: its own, and the one refs actually live in.
 *
 * A worktree's `.git` is a *file* containing `gitdir: <path>`, and that
 * directory holds the worktree's own `HEAD` but **not** its branch refs — those
 * stay in the main repository, named by a `commondir` file beside it. Getting
 * this wrong loses the whole revision rather than just the commit, which is how
 * the first version of this failed: it read `HEAD`, could not resolve the ref,
 * and returned nothing at all.
 *
 * Not an exotic case to support. A pinned worktree is one of the fixes proposed
 * for AGE-6, so the diagnostic that reports the revision has to work in the
 * arrangement meant to fix the problem.
 */
function gitDirsFor(start: string): { gitDir: string; commonDir: string } | undefined {
  let dir = dirname(start)
  for (let up = 0; up < 8; up++) {
    const candidate = join(dir, '.git')
    let gitDir: string | undefined
    try {
      gitDir = statSync(candidate).isDirectory()
        ? candidate
        : (() => {
            const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(candidate, 'utf8'))
            return pointer ? resolve(dir, pointer[1].trim()) : undefined
          })()
    } catch {
      // Not here. Keep walking up.
    }
    if (gitDir) {
      let commonDir = gitDir
      try {
        const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
        if (common) commonDir = resolve(gitDir, common)
      } catch {
        // A normal checkout: its own git dir is the common one.
      }
      return { gitDir, commonDir }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * The revision the entry file belongs to, or nothing.
 *
 * Reads git's files rather than shelling out for the commit, so a missing `git`
 * binary costs the dirty flag and not the whole answer. Each lookup fails on its
 * own: an unresolvable ref loses the commit and keeps the branch, because a
 * branch name alone still answers "which code is this?".
 *
 * `dirty` needs the binary, and when it cannot be determined it stays
 * **undefined** — which a reader must not read as clean. That is the reason it
 * is optional rather than defaulting to false.
 */
function revisionFor(entry: string): RuntimeRevision | undefined {
  const dirs = gitDirsFor(entry)
  if (!dirs) return undefined

  let branch: string | undefined
  let commit: string | undefined
  try {
    const head = parseGitHead(readFileSync(join(dirs.gitDir, 'HEAD'), 'utf8'))
    branch = head.branch
    commit = head.commit
  } catch {
    return undefined
  }

  if (branch && !commit) {
    try {
      commit = readFileSync(join(dirs.commonDir, 'refs', 'heads', branch), 'utf8').trim()
    } catch {
      try {
        const packed = readFileSync(join(dirs.commonDir, 'packed-refs'), 'utf8')
        commit = new RegExp(`^([0-9a-f]{40}) refs/heads/${branch}$`, 'm').exec(packed)?.[1]
      } catch {
        // Keep the branch; the commit is the half we lose.
      }
    }
  }

  let dirty: boolean | undefined
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: dirname(entry),
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    dirty = out.trim().length > 0
  } catch {
    // No git, not a repo, or too slow. Left undefined on purpose.
  }

  return { commit, branch, dirty }
}

function detectRuntime(client?: string): Runtime {
  const entry = process.argv[1] ?? process.execPath
  let wsl = false
  try {
    wsl = isWslKernel(readFileSync('/proc/version', 'utf8'))
  } catch {
    // Not Linux, or no procfs. Either way this is not WSL.
  }
  return {
    platform: process.platform,
    wsl,
    distro: process.env.WSL_DISTRO_NAME?.trim() || undefined,
    node: process.version,
    entry,
    client,
    revision: revisionFor(entry),
    source: runtimeSource(process.env.ESTIVA_AGENT_SOURCE),
  }
}

/** One hop of the connection check, and whether it held. */
export interface StatusHop {
  hop: 'credentials' | 'token' | 'relay'
  ok: boolean
  detail: string
}

export interface ConnectionStatus {
  ok: boolean
  runtime: Runtime
  /** Where the credential came from, when there was one to find. */
  credentialSource?: string
  /** The hop that broke, absent when everything held. */
  failed?: StatusHop['hop']
  identityService: string
  relayUrl: string
  /** The role identity this credential signs as, once a token has proved it. */
  signsAs?: string
  hops: StatusHop[]
  summary: string
}

/**
 * Walk every hop between a credential and a relay read, and name the one that broke.
 *
 * This is `scripts/probe-agent.ts` as a tool rather than as a terminal command,
 * and packaging is why it has to exist. The runbook's most valuable instruction
 * was "run the probe before involving Claude Desktop", because it separates
 * "my client is misconfigured" from "my identity was never admitted" — two
 * problems that are indistinguishable from inside a conversation and have
 * completely different fixes. An extension deliberately removes the terminal,
 * the clone and the probe along with them, so the diagnosis has to be reachable
 * from the one surface that is left.
 *
 * Every string it produces describes state. None of them tells anybody to run
 * anything: this output reaches a model as untrusted text like any other tool
 * result, and `docs/untrusted-content.md` is the incident that taught us so.
 */
export async function connectionStatus(
  app: AgentApp,
  { client }: { client?: string } = {},
): Promise<ConnectionStatus> {
  const hops: StatusHop[] = []
  const relay = relayUrl()
  const runtime = detectRuntime(client)
  const done = (
    ok: boolean,
    summary: string,
    extra: Partial<ConnectionStatus> = {},
  ): ConnectionStatus => ({
    ok,
    runtime,
    failed: ok ? undefined : hops.find((h) => !h.ok)?.hop,
    identityService: extra.identityService ?? 'unknown',
    relayUrl: relay,
    hops,
    summary,
    ...extra,
  })

  let credentials
  try {
    credentials = loadCredentials()
    /*
      The source is named, not just the fact that something was found. Two
      surfaces on one machine can each be correctly configured and be holding
      *different* credentials, and this line is the only place that becomes
      visible without a shell.
    */
    const { from, file, fileState } = credentials.source
    hops.push({
      hop: 'credentials',
      ok: true,
      detail:
        `client id "${credentials.clientId}", from ${
          from === 'environment'
            ? 'the environment this process was launched with'
            : from === 'file'
              ? file
              : `the environment and ${file} together`
        }` + (from === 'environment' && fileState === 'read' ? ` (${file} exists and was not used)` : ''),
    })
  } catch (error) {
    hops.push({
      hop: 'credentials',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    })
    return done(
      false,
      'Not configured. No client id and secret are available to this process, so nothing has been attempted. ' +
        'They are issued by an Estiva ID administrator and entered into this connection\'s own settings; ' +
        'neither step can be carried out from inside a conversation.',
    )
  }

  let token
  try {
    token = await clientCredentialsToken(credentials)
    hops.push({ hop: 'token', ok: true, detail: `signs as ${token.pubkey}` })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    hops.push({ hop: 'token', ok: false, detail: message })
    return done(
      false,
      message.includes('invalid_client')
        ? 'The identity service rejected this client id and secret. Re-issuing a credential replaces the previous one, ' +
            'so a secret that worked before and fails now is the expected shape of that rather than a fault. ' +
            'A replacement comes from an Estiva ID administrator.'
        : `The identity service could not be reached or refused the credential at ${credentials.base}. Nothing reached the relay.`,
      { identityService: credentials.base },
    )
  }

  const filters = app.probe
  if (!filters) {
    return done(true, 'Credentials and signing work. Relay access was not checked: this app declares no probe.', {
      identityService: credentials.base,
      signsAs: token.pubkey,
    })
  }

  try {
    const context = await connect()
    const events = await context.relay.query(filters)
    hops.push({ hop: 'relay', ok: true, detail: `read ${events.length} event(s)` })
    return done(
      true,
      `Connected. Signing as ${token.pubkey} and reading ${relay}, ` +
        `from ${runtime.wsl ? `WSL${runtime.distro ? ` (${runtime.distro})` : ''}` : runtime.platform}` +
        `${runtime.client ? ` via ${runtime.client}` : ''}.`,
      {
        identityService: credentials.base,
        signsAs: token.pubkey,
        credentialSource: credentials.source.from === 'file' ? credentials.source.file : credentials.source.from,
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    hops.push({ hop: 'relay', ok: false, detail: message })

    /*
      The two remote refusals that look identical from a conversation and are
      not. Naming them is the difference between somebody asking an admin for
      relay admission and somebody reinstalling a working extension.
    */
    let summary = `The relay at ${relay} refused the read. Signing worked, so this is not a credential problem.`
    if (message.includes('relay_membership_required')) {
      summary =
        `Signing works and the relay refused the read: this identity (${token.pubkey}) has never been admitted to ${relay}. ` +
        'Admission is an action an Estiva ID administrator takes on the identity, and it is not available from inside a conversation.'
    } else if (message.includes('nip98')) {
      summary =
        'The identity service declined to mint the authentication header, so no request reached the relay. ' +
        'The cause is which destinations this credential is allowed to authenticate to, which is server-side configuration an administrator holds.'
    }
    return done(false, summary, { identityService: credentials.base, signsAs: token.pubkey })
  }
}

/**
 * Parse, dispatch, print, exit.
 *
 * Output is indented JSON on stdout and nothing else, so a caller can pipe it
 * without stripping banners. Diagnostics go to stderr for the same reason.
 *
 * The one exception is a command that offers `lines`: a listing prints as
 * text, one row per line, unless `--json` asks for the shape it pipes. The
 * text is the app's rendering of the same result; nothing is computed twice.
 */
export async function run(apps: AgentApp[], argv: string[]): Promise<never> {
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  const [appName, commandName] = args.positional

  // `ship issues --help` is a question about one command, and the answer is
  // its usage line — not the 3.7K characters of everything (MAK-2).
  const asked = apps.find((candidate) => candidate.name === appName)?.commands.find((candidate) => candidate.name === commandName)
  if (args.flags.help && asked) {
    console.error(`${appName} ${asked.usage ?? asked.name}\n  ${asked.summary}`)
    process.exit(0)
  }

  if (!appName || args.flags.help) {
    console.error(usage(apps))
    process.exit(appName ? 0 : 1)
  }

  const app = apps.find((candidate) => candidate.name === appName)
  if (!app) {
    console.error(`Unknown app "${appName}". Known: ${apps.map((a) => a.name).join(', ')}`)
    process.exit(1)
  }

  const command = app.commands.find((candidate) => candidate.name === commandName)
  if (!command) {
    console.error(
      commandName
        ? `Unknown command "${appName} ${commandName}".`
        : `"${appName}" needs a command.`,
    )
    console.error(`Available: ${app.commands.map((c) => c.name).join(', ')}`)
    process.exit(1)
  }

  // Refused before connecting: a typo in a flag costs one line, not a relay
  // round trip and a listing of the whole workspace.
  const rejected = unknownFlag(command, args.flags)
  if (rejected) {
    console.error(rejected)
    process.exit(1)
  }

  try {
    const context = await connect()

    /*
      Before the command runs, not after it fails. A refusal at the end is
      indistinguishable from success inside the app that asked (PEEK-172).
    */
    const unsignable = refuseUnsignable(command, context.allowedKinds)
    if (unsignable) throw new BadRequest(unsignable)

    // The app and command names are consumed here so a command sees only its
    // own arguments — `show <ref>` reads positional[0], not positional[2].
    const result = await command.run(context, {
      ...args,
      positional: args.positional.slice(2),
    })
    const output = command.lines && !args.flags.json ? command.lines(result).join('\n') : JSON.stringify(result, null, 2)
    /*
      Exit once stdout has taken all of it. Into a pipe, a write past 64 KB is
      still queued when `process.exit` runs, and the rest is dropped — a
      whole-workspace `issues --json` reached the reading process cut off
      mid-string, which a reader parses as an error or, worse, as less.
    */
    await new Promise<void>((resolve) => process.stdout.write(`${output}\n`, () => resolve()))
    process.exit(0)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(error instanceof BadRequest ? message : `Failed: ${message}`)

    /*
      Two failures worth naming, because they are the ones that will actually
      happen and each sends you somewhere different — the same distinction
      `scripts/probe-agent.ts` draws, kept here so a CLI user is not told to go
      and run a second tool to find out which they hit.
    */
    if (message.includes('relay_membership_required')) {
      console.error('The signing identity is not a relay member. Admission, not signing.')
    }
    if (message.includes('nip98')) {
      console.error('Estiva ID refused to mint NIP-98. Nothing ever reached the relay.')
    }
    process.exit(1)
  }
}
