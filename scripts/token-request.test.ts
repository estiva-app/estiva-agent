/**
 * The client-credentials request on the wire is plain OAuth 2.0 (RFC 6749 §4.4,
 * §2.3.1), and an RFC 6749 §5.2 refusal still reads as one. Estiva ID is
 * dropping its own JSON format, so a JSON request would stop working.
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/sign-in-is-plain-oauth.md
 */
import { clientCredentialsToken } from '../lib/agent/credentials'

let failures = 0
function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const original = globalThis.fetch
function answer(status: number, payload: unknown) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v
    calls.push({ url: String(input), headers, body: String(init?.body ?? '') })
    return { ok: status < 400, status, text: async () => JSON.stringify(payload) } as Response
  }) as typeof fetch
  return calls
}

console.log('— the request —')
{
  const calls = answer(200, { access_token: 't', token_type: 'Bearer', pubkey: 'a'.repeat(64), expires_in: 600 })
  // A secret with the characters §2.3.1's encoding exists for.
  await clientCredentialsToken({ clientId: 'claude-miky', clientSecret: 'a:b+c d/é', base: 'http://id.test/' })
  globalThis.fetch = original
  const [call] = calls
  check('one POST to the token endpoint', calls.length === 1 && call?.url === 'http://id.test/token')
  check('the body is a form', call?.headers['content-type'] === 'application/x-www-form-urlencoded', call?.headers['content-type'])
  const form = new URLSearchParams(call?.body ?? '')
  check('it names the client-credentials grant and nothing else', form.get('grant_type') === 'client_credentials' && [...form.keys()].length === 1, call?.body)
  check('the secret is not in the body', !(call?.body ?? '').includes('a:b'))
  const [scheme, encoded] = (call?.headers.authorization ?? '').split(' ')
  const decoded = Buffer.from(encoded ?? '', 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  const part = (s: string) => decodeURIComponent(s.replace(/\+/g, ' '))
  check('the id and secret go in Basic, each form-urlencoded first', scheme === 'Basic' && part(decoded.slice(0, colon)) === 'claude-miky' && part(decoded.slice(colon + 1)) === 'a:b+c d/é', decoded)
}

console.log('\n— a refusal —')
{
  answer(401, { error: 'invalid_client', error_description: 'Unknown or disabled app' })
  const message = await clientCredentialsToken({ clientId: 'c', clientSecret: 's', base: 'http://id.test' }).then(
    () => 'resolved',
    (error: Error) => error.message,
  )
  globalThis.fetch = original
  // `doctor` tells a rotated secret apart by this word.
  check('a rotated secret still says invalid_client', message === 'POST /token → 401 invalid_client: Unknown or disabled app', message)
}

process.exit(failures === 0 ? 0 : 1)
