/**
 * Cursor reads `.cursor/mcp.json` — no pack step, no install artefact.
 *
 * `plugin.test.ts` guards Claude Code's `.mcp.json`; this guards Cursor's.
 * Both should launch the same MCP server and list the same tools. Cursor's
 * config uses `mcp-server.sh` (pinned runtime when present) rather than the
 * bundled `plugin/server/index.js`, so the declared command is tested here.
 *
 *   npx tsx scripts/cursor.test.ts
 *
 * Offline, credential-free.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const configPath = join(root, '.cursor/mcp.json')

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

check('Cursor MCP config is committed', existsSync(configPath))
if (!existsSync(configPath)) {
  console.log(`\ncursor: ${failures} failing`)
  process.exit(1)
}

const mcp = JSON.parse(readFileSync(configPath, 'utf8'))
const servers = mcp.mcpServers ?? {}
check('it declares exactly one server', Object.keys(servers).length === 1, Object.keys(servers).join(', '))

const server = servers.estiva ?? {}
check('the server is named estiva', Boolean(servers.estiva))
check('connection type is stdio', server.type === 'stdio')
check('the server is launched by bash', server.command === 'bash')

const args: string[] = server.args ?? []
check(
  'the launcher path is workspace-relative',
  args.some((arg) => arg.includes('${workspaceFolder}')),
  args.join(' '),
)

const resolvedArgs = args.map((arg) => arg.replace('${workspaceFolder}', root))
const launcher = resolvedArgs[0] ?? ''
check('the launcher script exists', existsSync(launcher), launcher)

const envFile: string = server.envFile ?? ''
check(
  'credentials load from the home env file, not inline',
  envFile === '${userHome}/.estiva-agent.env',
  envFile,
)
check('no credential is declared inline', Object.keys(server.env ?? {}).length === 0)

const desktop = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'))
const declared = new Set<string>((desktop.tools ?? []).map((tool: { name: string }) => tool.name))

interface Rpc {
  id?: number
  result?: { tools?: { name: string }[] }
}

const replies = await new Promise<Rpc[]>((resolve) => {
  const child = spawn(server.command, resolvedArgs, {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: join(root, '.no-credentials-here'),
      ESTIVA_AGENT_DEV: '1',
    },
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
  setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 400)
  setTimeout(() => {
    child.kill()
    resolve(
      out
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Rpc),
    )
  }, 3000)
})

const reply = (id: number) => replies.find((message) => message.id === id)
check('the declared command starts and answers initialize', Boolean(reply(1)?.result))

const tools = reply(2)?.result?.tools ?? []
check('it lists its tools', tools.length > 0, `${tools.length} tools`)

const actual = new Set(tools.map((tool) => tool.name))
const divergent = [...actual].filter((name) => !declared.has(name))
check(
  'Cursor config exposes the same tools as the Desktop extension',
  divergent.length === 0 && actual.size === declared.size,
  divergent.join(', '),
)

console.log(failures === 0 ? '\ncursor: ok' : `\ncursor: ${failures} failing`)
process.exit(failures === 0 ? 0 : 1)
