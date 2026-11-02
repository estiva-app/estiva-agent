/**
 * An agent below the workspace's minimum version refuses every write with a
 * sentence saying to update, and still reads (ALO-7; Miky, 2026-11-02). The
 * minimum is read from estiva-agent's `main` at most once an hour; when it
 * cannot be read, the agent runs.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { minimumVersion, refuseOutdated } from '../lib/agent/minimum-version'

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const write = { signs: [1851] }
const read = {}
const refusal = (await refuseOutdated(write, '0.27.0', async () => '0.28.0')) ?? ''
check('below the minimum, a write is refused with a sentence saying to update', /0\.27\.0/.test(refusal) && /0\.28\.0/.test(refusal) && /Update the agent/.test(refusal), refusal)
check('below the minimum, a read still runs', (await refuseOutdated(read, '0.27.0', async () => '0.28.0')) === undefined)
check('at the minimum, a write runs', (await refuseOutdated(write, '0.28.0', async () => '0.28.0')) === undefined)
check('above it by a minor version, a write runs', (await refuseOutdated(write, '0.30.0', async () => '0.28.9')) === undefined)
check('an unreachable minimum lets it run', (await refuseOutdated(write, '0.27.0', async () => undefined)) === undefined)

const file = join(mkdtempSync(join(tmpdir(), 'minimum-')), 'minimum-version.json')
let fetched = 0
const answering = (async () => (fetched++, new Response(JSON.stringify({ minimum: '0.30.0' })))) as typeof fetch
check('it is read from main and kept', (await minimumVersion({ now: 1_000, fetchImpl: answering, file })) === '0.30.0' && fetched === 1)
check('within the hour it is not asked again', (await minimumVersion({ now: 1_000 + 3_599_000, fetchImpl: answering, file })) === '0.30.0' && fetched === 1)
check('after the hour it is asked again', (await minimumVersion({ now: 1_000 + 3_600_000, fetchImpl: answering, file })) === '0.30.0' && fetched === 2)
writeFileSync(file, '{}')
const failing = (async () => {
  throw new Error('offline')
}) as typeof fetch
check('unreachable and uncached, there is no minimum', (await minimumVersion({ now: 5, fetchImpl: failing, file })) === undefined)

if (failures) {
  console.error(`\n${failures} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll minimum-version checks passed.')
