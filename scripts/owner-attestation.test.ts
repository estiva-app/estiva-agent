/**
 * Carrying the NIP-OA owner attestation from `/token` to the relay (PEEK-164).
 *
 * The agent's identity is `claude-<somebody>` — a delegate of one person, not an
 * organisational bot. Until now the only thing on the wire saying so was a
 * `kind:0` display name, which is self-published: any admitted key can claim to
 * be steered by anybody. Estiva ID now signs a NIP-OA tag with the owner's
 * custodied key, and this is the half that gets it to Buzz, which verifies it
 * and records the result in `users.agent_owner_pubkey`.
 *
 * Offline. Everything here is a stubbed `fetch`, because the two failures worth
 * catching are both about *which bytes leave the process*:
 *
 *   * the header must go on **every** request, `/query` included — on a closed
 *     relay it is what admits an agent whose owner is the member, so a read
 *     without it is a 403;
 *   * a token renewal must replace the tag, not just the bearer. A renewal is
 *     invisible by design, so a stale tag would work for one TTL and then start
 *     failing as `relay_membership_required`, which reads as an admission
 *     problem rather than an expiry.
 *
 *   npx tsx scripts/owner-attestation.test.ts
 */
import { AUTH_TAG_HEADER, serviceIdentitySigner } from '../lib/agent/credentials'
import { Relay } from '../lib/nostr/relay'
import { secretKeySigner } from '../lib/nostr/signer'
import type { SignedEvent } from '../lib/nostr/events'

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const AGENT_SK = '11'.repeat(32)
const OWNER_PK = 'f3a38fa646debd4162125e0aed87b6d2393fb1ed9702b6875dcbc0c6529d64d1'
const tag = (sig: string): [string, string, string, string] => ['auth', OWNER_PK, '', sig]
const SIG_A = 'aa'.repeat(64)
const SIG_B = 'bb'.repeat(64)

/** Every request the code under test made, in order. */
interface Captured {
  url: string
  headers: Record<string, string>
  body: string
}

function captureFetch(respond: (url: string, call: number) => unknown) {
  const calls: Captured[] = []
  let n = 0
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v
    }
    calls.push({ url, headers, body: String(init?.body ?? '') })
    const payload = respond(url, n++)
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    } as Response
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

const event = (): SignedEvent => ({
  id: 'e'.repeat(64),
  pubkey: 'a'.repeat(64),
  created_at: 0,
  kind: 1,
  tags: [],
  content: '',
  sig: 'f'.repeat(128),
})

console.log('— the relay client carries what it is given —')

{
  const { calls, restore } = captureFetch(() => ({ accepted: true, event_id: 'x' }))
  const relay = new Relay('http://relay.test', secretKeySigner(AGENT_SK), () => ({
    [AUTH_TAG_HEADER]: JSON.stringify(tag(SIG_A)),
  }))
  await relay.publish(event())
  await relay.query([{ kinds: [1] }])
  restore()

  check('publish sends the attestation header', calls[0]?.headers[AUTH_TAG_HEADER] === JSON.stringify(tag(SIG_A)))
  /*
    The one that would otherwise be missed. `/events` is the obvious place to
    look, but `bridge.rs` enforces relay membership on `/query` too — an agent
    admitted through its owner and reading without the tag gets a 403 on every
    read while its writes keep working.
  */
  check('query sends it too', calls[1]?.headers[AUTH_TAG_HEADER] === JSON.stringify(tag(SIG_A)))
  check('it is the raw JSON array, as verify_auth_tag expects', JSON.parse(calls[0]?.headers[AUTH_TAG_HEADER] ?? 'null')?.length === 4)
  check('both requests still carry NIP-98 authorization', calls.every((c) => (c.headers.authorization ?? '').startsWith('Nostr ')))
}

{
  const { calls, restore } = captureFetch(() => ({ accepted: true }))
  await new Relay('http://relay.test', secretKeySigner(AGENT_SK)).publish(event())
  restore()
  // A browser app has no such credential; the default must leave it exactly as
  // it was before this parameter existed.
  check('no header at all when none is supplied', calls[0] !== undefined && !(AUTH_TAG_HEADER in calls[0].headers))
}

{
  const { calls, restore } = captureFetch(() => ({ accepted: true }))
  await new Relay('http://relay.test', secretKeySigner(AGENT_SK), () => ({
    authorization: 'Nostr forged',
    [AUTH_TAG_HEADER]: JSON.stringify(tag(SIG_A)),
  })).publish(event())
  restore()
  // Authorization is the client's own contract with the relay. An ambient
  // credential supplying headers must not be able to displace it.
  check('supplied headers cannot displace authorization', calls[0]?.headers.authorization !== 'Nostr forged')
}

console.log('\n— the attestation follows the token —')

{
  const { calls, restore } = captureFetch((url, n) =>
    url.endsWith('/token')
      ? { access_token: `t${n}`, token_type: 'Bearer', pubkey: 'a'.repeat(64), expires_in: 600, allowed_kinds: [9], owner_attestation: tag(SIG_A) }
      : {},
  )
  const { relayHeaders, allowedKinds } = await serviceIdentitySigner({ clientId: 'c', clientSecret: 's', base: 'http://id.test' })
  restore()
  check('the first token supplies the header', relayHeaders()[AUTH_TAG_HEADER] === JSON.stringify(tag(SIG_A)))
  check('the ceiling still comes through unchanged', JSON.stringify(allowedKinds) === '[9]')
  check('exactly one token exchange happened', calls.filter((c) => c.url.endsWith('/token')).length === 1)
}

{
  // An identity service predating this feature sends no attestation. The agent
  // must work — it just cannot prove who steers it.
  const { restore } = captureFetch(() => ({ access_token: 't', token_type: 'Bearer', pubkey: 'a'.repeat(64), expires_in: 600 }))
  const { relayHeaders } = await serviceIdentitySigner({ clientId: 'c', clientSecret: 's', base: 'http://id.test' })
  restore()
  check('no attestation means no header, not a crash', Object.keys(relayHeaders()).length === 0)
}

{
  /*
    The renewal case, and the reason `relayHeaders` is a function.

    `/sign` answers 401 once; `estivaIdSigner` renews and retries. The renewed
    token carries a *different* attestation, and the header must follow it —
    reading the tag once at construction would send SIG_A forever.
  */
  let signCalls = 0
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/token')) {
      // The first exchange happens before any signing; the second is the
      // renewal triggered by the 401 below.
      const sig = signCalls === 0 ? SIG_A : SIG_B
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: 'tok',
            token_type: 'Bearer',
            pubkey: 'a'.repeat(64),
            expires_in: 600,
            owner_attestation: tag(sig),
          }),
      } as Response
    }
    // /sign: expire once, then succeed.
    signCalls += 1
    if (signCalls === 1) return { ok: false, status: 401, text: async () => 'expired' } as Response
    return { ok: true, status: 200, text: async () => JSON.stringify({ event: event() }) } as Response
  }) as typeof fetch

  const { signer, relayHeaders } = await serviceIdentitySigner({ clientId: 'c', clientSecret: 's', base: 'http://id.test' })
  const before = relayHeaders()[AUTH_TAG_HEADER]
  await signer.sign({ pubkey: 'a'.repeat(64), created_at: 0, kind: 1, tags: [], content: '' })
  const after = relayHeaders()[AUTH_TAG_HEADER]
  globalThis.fetch = original

  check('the attestation was the first token’s before the renewal', before === JSON.stringify(tag(SIG_A)))
  check('a renewal replaces the attestation, not just the bearer', after === JSON.stringify(tag(SIG_B)), `${String(after).slice(0, 40)}…`)
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
