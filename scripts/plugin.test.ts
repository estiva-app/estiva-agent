/**
 * The Claude Code plugin, checked the way Claude Code will actually load it.
 *
 * `extension.test.ts` proves the Desktop artefact. This proves the other one —
 * and they are deliberately not two artefacts: `plugin/server/index.js` is the
 * single generated file this repository commits, and the `.mcpb` is assembled
 * from it. The last check here is that those bytes are still identical, because
 * "the same server, whichever client" is the claim PEEK-161 is really making
 * and it is one careless build away from quietly becoming false.
 *
 *   npx tsx scripts/plugin.test.ts
 *
 * Offline, and with no credentials — the first-run state of every install.
 *
 * ## Why a committed build artefact needs its own guard
 *
 * A plugin runs no install step: whatever is in the directory is what executes.
 * That is what makes it installable by someone who does not have Node tooling,
 * and it is also why the bundle has to be in git. A committed generated file
 * has exactly one failure mode — being a version behind its source, silently —
 * so this rebuilds and compares rather than trusting whoever last committed.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const pluginDir = join(root, 'plugin')
const committed = join(pluginDir, 'server/index.js')
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

/*
  Hashed *before* the rebuild. The build writes in place, so comparing after the
  fact against the file on disk would compare a file with itself and pass on
  every commit, stale or not.
*/
check('the plugin ships a built server', existsSync(committed))
const committedSha = existsSync(committed) ? sha(committed) : ''

execFileSync('node', ['scripts/build-extension.mjs'], { cwd: root, stdio: 'pipe' })

check(
  'the committed bundle is what the current source builds',
  committedSha === sha(committed),
  committedSha === sha(committed) ? '' : 'run `npm run extension` and commit plugin/server/',
)

/*
  Desktop and Claude Code are one file, not two builds that agree. If this ever
  fails, someone has reintroduced a second build path and the two clients can
  now drift.
*/
check(
  'the extension and the plugin are the same bytes',
  sha(committed) === sha(join(root, 'extension/build/server/index.js')),
)

/*
  This file is in git, unlike `extension/build`, so a credential that reached it
  would be committed and then impossible to unpublish. The extension suite makes
  the same check against an artefact nobody keeps; here it is the difference
  between a mistake and a disclosure.
*/
const built = readFileSync(committed, 'utf8')
const secret = process.env.ESTIVA_ID_CLIENT_SECRET?.trim()
check('no credential is built into the committed bundle', !secret || !built.includes(secret))

// ── The manifests ───────────────────────────────────────────────────────────

const marketplace = JSON.parse(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin/plugin.json'), 'utf8'))

check('the marketplace names an owner', Boolean(marketplace.owner?.name))
check('it lists exactly one plugin', (marketplace.plugins ?? []).length === 1)

const entry = (marketplace.plugins ?? [])[0] ?? {}
check('the entry points at this repository’s plugin', entry.source === './plugin')
check(
  'the marketplace entry and the manifest agree on the name',
  entry.name === manifest.name,
  `${entry.name} vs ${manifest.name}`,
)

/*
  Both artefacts are the same server, so both have to claim the same version —
  and the version is the *only* thing an installed copy compares against to
  notice a newer one exists. Left to drift, one client offers an update and the
  other silently keeps running last month's tools.

  Read from the Desktop manifest rather than from `package.json`, which is
  `private` and carries no version at all: these two files are the whole of what
  ships.
*/
const desktop = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'))
check(
  'the plugin and the extension agree on the version',
  manifest.version === desktop.version,
  `${manifest.version} vs ${desktop.version}`,
)

/*
  Only `plugin.json` may live in `.claude-plugin/`. Everything else — `.mcp.json`
  included — belongs at the plugin root, and a file in the wrong place is not an
  error: it is silently ignored, which presents as a plugin that installs
  cleanly and contributes nothing.
*/
check('the MCP config is at the plugin root', existsSync(join(pluginDir, '.mcp.json')))
check(
  'and not inside .claude-plugin/',
  !existsSync(join(pluginDir, '.claude-plugin/.mcp.json')),
)

const mcp = JSON.parse(readFileSync(join(pluginDir, '.mcp.json'), 'utf8'))
const servers = mcp.mcpServers ?? {}
check('it declares exactly one server', Object.keys(servers).length === 1, Object.keys(servers).join(', '))

const server = servers.estiva ?? {}
const args: string[] = server.args ?? []
check('the server is launched by node', server.command === 'node')
check(
  'its path is relative to the plugin root',
  args.some((arg) => arg.includes('${CLAUDE_PLUGIN_ROOT}')),
  args.join(' '),
)

/*
  The substitution Claude Code performs, performed here. An entry point that
  does not exist is the one failure this file exists to catch before a person
  meets it as "the plugin installed and has no tools".
*/
const resolved = args.map((arg) => arg.replace('${CLAUDE_PLUGIN_ROOT}', pluginDir))
check('the entry point it names exists', resolved.some((arg) => existsSync(arg)))

/*
  No credential may be declared here. Desktop collects them through
  `user_config`; a plugin has no such surface, so anything in `env` would have to
  be a literal — a secret in a public repository. The server reads
  `~/.estiva-agent.env` instead, which is the same file the CLI already uses.
*/
const declaredEnv = Object.keys(server.env ?? {})
check('no credential is declared in the plugin config', declaredEnv.length === 0, declaredEnv.join(', '))

// ── The declared command, actually run ──────────────────────────────────────

interface Rpc {
  id?: number
  result?: { tools?: { name: string }[]; content?: { text: string }[] }
}

const replies = await new Promise<Rpc[]>((resolve) => {
  const child = spawn(server.command, resolved, {
    // No repository on PATH, no credentials — what a fresh install looks like.
    env: { PATH: process.env.PATH, HOME: join(root, '.no-credentials-here') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (chunk) => {
    out += chunk
  })
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  })
  setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 300)
  setTimeout(() => {
    child.kill()
    resolve(
      out
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Rpc),
    )
  }, 2500)
})

const reply = (id: number) => replies.find((message) => message.id === id)
check('the plugin’s declared command starts and answers initialize', Boolean(reply(1)?.result))

const tools = reply(2)?.result?.tools ?? []
check('it lists its tools', tools.length > 0, `${tools.length} tools`)

/*
  The point of the ticket, as a check: nothing about the server changed to serve
  a second client. If this list ever diverges from the extension's, one of the
  clients is being special-cased somewhere.
*/
const extensionManifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'))
const declared = new Set<string>((extensionManifest.tools ?? []).map((tool: { name: string }) => tool.name))
const actual = new Set(tools.map((tool) => tool.name))
const divergent = [...actual].filter((name) => !declared.has(name))
check(
  'the plugin offers the same tools as the extension',
  divergent.length === 0 && actual.size === declared.size,
  divergent.join(', '),
)

console.log(failures === 0 ? '\nplugin: ok' : `\nplugin: ${failures} failing`)
process.exit(failures === 0 ? 0 : 1)
