/**
 * What one agent workspace read costs, counted at the transport.
 *
 * The agent CLI reads the same way Ship does — a vendored `Store.loadAll()` over
 * `@estiva-app/protocol` — but it tracks the package on its own schedule, so its
 * cost is its own question. Part of the "read/write cost across Peek, Ship and
 * the agent tooling" the performance project asks for.
 *
 *   set -a && . ~/.estiva-agent.env && set +a
 *   npx tsx scripts/perf-agent.ts
 */
import { Relay } from '@estiva-app/protocol'
import { loadCredentials, serviceIdentitySigner } from '../lib/agent/credentials'
import { Store } from '../src/store'

const RELAY_URL = (process.env.RELAY_URL?.trim() || 'https://estiva.estiva.app').replace(/\/+$/, '')

/** The read path as it was before protocol 0.15.0, for a like-for-like comparison. */
class SerialRelay extends Relay {
  async queryAll(filters: Record<string, unknown>[], options = {}) {
    return super.queryAll(filters, { ...options, batch: false })
  }
}

async function main() {
  const { signer, relayHeaders } = await serviceIdentitySigner(loadCredentials())
  const calls: number[] = []
  let bytes = 0
  const relayFetch = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => {
      const res = await fetch(url, init as RequestInit)
      const text = await res.text()
      if (url.endsWith('/query')) {
        let filters = 0
        try {
          const body = JSON.parse(init.body)
          if (Array.isArray(body)) filters = body.length
        } catch {
          /* not filters */
        }
        calls.push(filters)
        bytes += Buffer.byteLength(text)
      }
      return { status: res.status, text: async () => text }
  }

  const relay = new Relay(RELAY_URL, signer, { headers: relayHeaders, fetch: relayFetch })

  const store = new Store(relay, signer)
  const version = await import('@estiva-app/protocol/package.json', { with: { type: 'json' } })
    .then((m) => (m.default as { version: string }).version)
    .catch(() => 'unknown')

  /*
    Both paths in one process, alternating, because the relay is shared and
    production latency drifts by hundreds of milliseconds between runs. Two
    measurements taken minutes apart are not a comparison — the first attempt at
    this reported batching as *slower*, which was drift and nothing else.
  */
  const serial = new SerialRelay(RELAY_URL, signer, { headers: relayHeaders, fetch: relayFetch })
  const serialStore = new Store(serial, signer)

  const run = async (label: string, s: Store) => {
    calls.length = 0
    bytes = 0
    const t = performance.now()
    const state = await s.loadAll()
    return {
      label,
      requests: calls.length,
      ms: Math.round(performance.now() - t),
      mib: bytes / 1024 / 1024,
      widest: Math.max(0, ...calls),
      projects: state.projects.length,
      issues: state.issues.length,
    }
  }

  // Warm both instances first: `observedPageCeiling` is per `Relay`, so a first
  // read is a different measurement and mixing the two would flatter whichever
  // went second.
  await run('warm-up', serialStore)
  await run('warm-up', store)

  const rows = []
  for (let pass = 0; pass < 3; pass++) {
    rows.push(await run('serial ', serialStore))
    rows.push(await run('batched', store))
  }

  console.log(`protocol ${version}, ${rows[1].projects} projects, ${rows[1].issues} issues\n`)
  for (const label of ['serial ', 'batched']) {
    const mine = rows.filter((r) => r.label === label)
    const median = mine.map((r) => r.ms).sort((a, b) => a - b)[1]
    console.log(
      `  ${label}  ${String(mine[0].requests).padStart(3)} requests   ` +
        `median ${String(median).padStart(5)} ms   ${mine[0].mib.toFixed(2)} MiB   ` +
        `widest POST ${mine[0].widest} filters   [${mine.map((r) => r.ms).join(', ')}]`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
