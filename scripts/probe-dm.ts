/**
 * Does a DM channel open, stay idempotent, and carry a `kind:9` — on the HTTP
 * bridge Peek already uses? (DMS-2)
 *
 * Four assumptions the DM project rests on, each of which fails in a way that
 * looks like something else:
 *
 *   1. `41010` is accepted over the **HTTP bridge**. `ingest.rs` restricts only
 *      `KIND_GIFT_WRAP` and `KIND_PRESENCE_UPDATE` to WebSocket, so a DM command
 *      should be fine on the path Peek already uses. The whole project's
 *      independence from *Peek: Real-time Ship→Peek updates* rests on this one.
 *   2. The response identifies the created channel. `handle_dm_open` returns
 *      `(channel, was_created)` internally; what reaches a *client* is a
 *      different question, and §2 below is why it is the interesting one.
 *   3. Opening is idempotent — `open_dm` derives the channel from
 *      `compute_participant_hash` over the deduplicated participant set.
 *   4. A `kind:9` against the DM channel's `h` is accepted and readable back.
 *
 * It reports which hop broke, which a single rejection at the end does not tell
 * you.
 *
 *   set -a; . ~/.estiva-agent.env; set +a
 *   npx tsx scripts/probe-dm.ts --with <pubkey-hex>
 *
 * ## This writes to production
 *
 * There is no staging workspace. It opens a real DM between this agent's
 * identity and `--with`, and sends one message into it, both visible to those
 * two identities for ever. Pass `--with` deliberately; there is no default.
 *
 * ## §2 — why this does not call `Relay.publish()` and read its result
 *
 * `handle_dm_open` returns the channel uuid in `IngestResult.message`, as the
 * string `response:{"channel_id":…,"created":…}`. `parsePublishResponse` keeps
 * `message` **only on the `accepted: false` branch**, where it becomes `reason`;
 * the accepted branch returns `{ ok, eventId, httpStatus }` and drops it.
 *
 * So a caller using the shared bridge client cannot see the channel it just
 * opened. That is a finding about `@estiva-app/protocol`, not about the relay,
 * and a probe that re-implemented `POST /events` would have missed it entirely —
 * it would have read the raw body, reported success, and left DMS-3 to discover
 * the gap in Peek.
 *
 * The seam that keeps both properties is `RelayOptions.fetch`: the real `Relay`
 * signs the NIP-98 auth and posts the body exactly as Peek will, and the
 * transport tees the response text on the way past. Bridge behaviour stays the
 * relay's; the raw answer is still legible here.
 */
import { clientCredentialsToken, loadCredentials, mayPublish } from '../lib/agent/credentials'
import { Relay, type SignedEvent } from '@estiva-app/protocol'
import { estivaIdSigner } from '../lib/nostr/signer'

const RELAY_URL = (process.env.RELAY_URL ?? 'https://estiva.estiva.app').replace(/\/+$/, '')

const KIND_DM_OPEN = 41010
const KIND_MESSAGE = 9

/** The last raw response body the transport saw, per URL path. */
const lastBody = new Map<string, string>()

/**
 * `fetch`, plus a copy of the body for the caller.
 *
 * `text()` is single-use on a real `Response`, so this reads it once and hands
 * back a stub that replays it — otherwise `Relay` would find the stream already
 * consumed and report an unparseable answer.
 */
const teeingFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
  const response = await fetch(url, init)
  const text = await response.text()
  lastBody.set(new URL(url).pathname, text)
  return { status: response.status, text: async () => text }
}

/** What `handle_dm_open` put in `IngestResult.message`, if it is there. */
function channelFromResponse(body: string | undefined): { channelId?: string; created?: boolean; raw: string } {
  if (!body) return { raw: '(no body captured)' }
  let message: string
  try {
    message = JSON.parse(body).message ?? ''
  } catch {
    return { raw: body.slice(0, 200) }
  }
  if (!message.startsWith('response:')) return { raw: message }
  try {
    const payload = JSON.parse(message.slice('response:'.length))
    return { channelId: payload.channel_id, created: payload.created, raw: message }
  } catch {
    return { raw: message }
  }
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main() {
  const partner = arg('with')
  if (!partner || !/^[0-9a-f]{64}$/.test(partner)) {
    console.error('Pass the other participant: --with <64-hex-pubkey>')
    console.error('This publishes a real DM to production. There is no default.')
    process.exit(2)
  }

  const credentials = loadCredentials()
  const token = await clientCredentialsToken(credentials)
  const me = token.pubkey

  console.log(`relay     ${RELAY_URL}`)
  console.log(`signs as  ${me}`)
  console.log(`dm with   ${partner}\n`)

  /*
    Hop 0. The ceiling is a property of the *credential*, and for this agent it
    is a hand-made row that no `estiva-id` re-seed touches — DMS-1 granted
    `estiva-peek` in `src/db/seed.ts` and left every other client alone. Without
    this check the run fails at `/sign` with a refusal that reads like the relay
    rejecting kind 41010, which is the opposite conclusion.
  */
  if (!mayPublish(token.allowed_kinds, KIND_DM_OPEN)) {
    console.log(`❌ ceiling  this credential may not sign ${KIND_DM_OPEN}`)
    console.log(`            allowed: ${token.allowed_kinds?.join(', ') ?? '(unknown)'}`)
    console.log(`            Grant it on app_credentials.allowed_kinds for '${credentials.clientId}'.`)
    process.exit(1)
  }
  console.log(`✅ ceiling  ${KIND_DM_OPEN} and ${KIND_MESSAGE} are both signable`)

  const signer = estivaIdSigner({ base: credentials.base, pubkey: me, token: token.access_token })
  const relay = new Relay(RELAY_URL, signer, { fetch: teeingFetch })

  const openEvent = async (): Promise<SignedEvent> =>
    signer.sign({
      pubkey: me,
      kind: KIND_DM_OPEN,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', partner]],
      content: '',
    })

  // 1 + 2. Accepted over HTTP, and does the answer name the channel?
  const first = await relay.publish(await openEvent())
  const firstBody = channelFromResponse(lastBody.get('/events'))
  if (!first.ok) {
    console.log(`❌ open     refused: ${first.reason} (HTTP ${first.httpStatus})`)
    console.log(`            If this says "only accepted via WebSocket", assumption 1 is`)
    console.log(`            wrong: add the WebSocket publish path to the project brief`)
    console.log(`            before anyone starts M2.`)
    process.exit(1)
  }
  console.log(`✅ open     accepted over HTTP (assumption 1)`)
  console.log(`   raw      ${firstBody.raw}`)
  console.log(
    firstBody.channelId
      ? `✅ channel  ${firstBody.channelId}  created=${firstBody.created} (assumption 2)`
      : `❌ channel  the response named no channel (assumption 2)`,
  )
  console.log(
    `   via API  PublishResult exposes ${JSON.stringify(first)}\n            — note whether channel_id survives it (see §2)`,
  )

  // 3. A second, distinct 41010 over the same participants.
  const second = await relay.publish(await openEvent())
  const secondBody = channelFromResponse(lastBody.get('/events'))
  const same = firstBody.channelId && secondBody.channelId === firstBody.channelId
  console.log(
    same
      ? `✅ reopen   same channel, created=${secondBody.created} (assumption 3)`
      : `❌ reopen   ${secondBody.channelId ?? secondBody.raw} (assumption 3)`,
  )
  console.log(`   ok=${second.ok} duplicate=${second.duplicate ?? false}`)

  if (!firstBody.channelId) {
    console.log('\nNo channel id, so the kind:9 leg cannot run. Stopping here.')
    process.exit(1)
  }

  // 4. A message into it, read back.
  const marker = `DMS-2 probe ${new Date().toISOString()}`
  const message = await signer.sign({
    pubkey: me,
    kind: KIND_MESSAGE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['h', firstBody.channelId]],
    content: marker,
  })
  const sent = await relay.publish(message)
  console.log(
    sent.ok ? `✅ send     kind:9 accepted (${sent.eventId})` : `❌ send     ${sent.reason} (HTTP ${sent.httpStatus})`,
  )
  if (!sent.ok) process.exit(1)

  const read = await relay.query([{ kinds: [KIND_MESSAGE], '#h': [firstBody.channelId], limit: 10 }])
  const found = read.find((event) => event.content === marker)
  console.log(
    found
      ? `✅ read     the message came back on #h (assumption 4)`
      : `❌ read     ${read.length} events on that channel, none of them ours (assumption 4)`,
  )
}

main().catch((error) => {
  console.error(`\n💥 ${(error as Error).message}`)
  process.exit(1)
})
