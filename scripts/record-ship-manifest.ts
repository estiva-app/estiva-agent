/**
 * Re-record `conformance/ship-manifest.json` from production — Ship's
 * `kind:31990`, the manifest `conformance.test.ts` folds the fixture through.
 *
 *   npx tsx scripts/record-ship-manifest.ts
 *
 * Run it when Ship republishes its manifest, then run the conformance test:
 * a failure means the published manifest no longer says what Ship's own fold
 * does, which is a finding about Ship, not a reason to change `expected`.
 * Refuses unless exactly one manifest answers, because two competing ones is
 * itself the thing to look at.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { connect } from '../lib/agent/cli'

const SHIP_MANIFEST = { author: '88ac6aae1a874652ef05e2deba8c8a9526cda0c78e6b7d98b815cd0b5a710d13', d: 'estiva-ship' }

const context = await connect()
const found = await context.relay.queryAll([{ kinds: [31990], authors: [SHIP_MANIFEST.author], '#d': [SHIP_MANIFEST.d] }] as never)
if (found.length !== 1) {
  console.error(`Expected exactly one Ship manifest, found ${found.length}. Nothing was written.`)
  process.exit(1)
}
const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'conformance', 'ship-manifest.json')
writeFileSync(
  path,
  JSON.stringify(
    {
      note: "Ship's kind:31990 as published on production. The agent folds the fixture through it. Re-record with scripts/record-ship-manifest.ts when Ship republishes.",
      recordedAt: new Date().toISOString(),
      event: found[0],
    },
    null,
    2,
  ) + '\n',
)
console.log(`Recorded the manifest published ${new Date(found[0].created_at * 1000).toISOString()}.`)
process.exit(0)
