/**
 * Re-record only the `expected` fold, leaving `events` byte-identical.
 *
 * The fixture's checksum covers the *inputs*. A fold that gains a field changes
 * the recorded output and nothing else, so re-recording the events would be
 * both unnecessary and the thing conformance.test.ts warns against.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { foldFolder } from '../src/fold'

const path = process.argv[2]
const fixture = JSON.parse(readFileSync(path, 'utf8'))
const before = createHash('sha256').update(JSON.stringify(fixture.events)).digest('hex')
fixture.expected = foldFolder(fixture.events)
writeFileSync(path, JSON.stringify(fixture, null, 2) + '\n')
const after = createHash('sha256')
  .update(JSON.stringify(JSON.parse(readFileSync(path, 'utf8')).events))
  .digest('hex')
console.log(`events sha256 before: ${before}`)
console.log(`events sha256 after : ${after}`)
console.log(before === after ? 'inputs unchanged ✅' : 'INPUTS MOVED ❌ — stop')
