/**
 * The oldest agent that may still write (ALO-7; Miky, 2026-11-02).
 *
 * When the workspace starts expecting something of every writer — a change
 * naming the one it follows, say — an agent installed before that writes the
 * old way and nothing stops it. So the oldest version that may write is a
 * number on estiva-agent's `main`, `minimum-version.json`; below it, every
 * command that publishes is refused with a sentence saying to update, and
 * every read still works.
 *
 * Read at most once an hour, kept in the user's cache. When it cannot be read
 * the agent runs as it is: a network fault must not stop somebody's work.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import plugin from '../../plugin/.claude-plugin/plugin.json' with { type: 'json' }
import type { AgentCommand } from './cli'

/** This agent's version: the plugin's, which the extension is packed from. */
export const AGENT_VERSION: string = plugin.version

export const MINIMUM_URL = 'https://raw.githubusercontent.com/estiva-app/estiva-agent/main/minimum-version.json'

const HOUR = 3_600_000

const cacheFile = () => join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'estiva-agent', 'minimum-version.json')

/** Whether `version` is older than `minimum`, both `x.y.z`. Anything else is never older. */
export function olderThan(version: string, minimum: string): boolean {
  const parts = (value: string) => (/^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : undefined)
  const [a, b] = [parts(version), parts(minimum)]
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}

/** The minimum version, from the cache while it is under an hour old, else from `main`; undefined when unreadable. */
export async function minimumVersion({
  now = Date.now(),
  fetchImpl = fetch,
  file = cacheFile(),
}: { now?: number; fetchImpl?: typeof fetch; file?: string } = {}): Promise<string | undefined> {
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8')) as { minimum?: unknown; readAt?: unknown }
    if (typeof cached.minimum === 'string' && typeof cached.readAt === 'number' && now - cached.readAt >= 0 && now - cached.readAt < HOUR) return cached.minimum
  } catch {
    // No cache yet, or one nobody can parse: read it from `main`.
  }
  try {
    const response = await fetchImpl(MINIMUM_URL, { signal: AbortSignal.timeout(3000) })
    if (!response.ok) return undefined
    const { minimum } = (await response.json()) as { minimum?: unknown }
    if (typeof minimum !== 'string') return undefined
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ minimum, readAt: now }))
    } catch {
      // A cache that cannot be written is read again next time.
    }
    return minimum
  } catch {
    return undefined
  }
}

/** The refusal of a command that publishes, from an agent older than the minimum; undefined for a read, or when it may write. */
export async function refuseOutdated(
  command: Pick<AgentCommand, 'signs'>,
  version: string = AGENT_VERSION,
  read: () => Promise<string | undefined> = minimumVersion,
): Promise<string | undefined> {
  if (!command.signs?.length) return undefined
  const minimum = await read()
  if (!minimum || !olderThan(version, minimum)) return undefined
  return `This Estiva plugin is version ${version}, and the workspace takes changes only from version ${minimum} on, so nothing was saved. Update the Estiva plugin (or the Claude Desktop extension) to save again; reading still works.`
}
