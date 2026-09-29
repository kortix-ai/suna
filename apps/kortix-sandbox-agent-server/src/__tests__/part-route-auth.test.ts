/**
 * GET /kortix/part/:sessionID/:messageID/:partID serves prompt-attachment
 * bytes and, unlike every other route in the /kortix/* namespace, checked no
 * credential at all. The namespace is exempt from the daemon's global auth
 * gate (app/server.ts) precisely so each route authenticates itself — see
 * `/kortix/logs` (routes/logs.ts), which this mirrors via the shared
 * `authorizeControl` helper (routes/control-auth.ts).
 *
 * Today the daemon is reachable only through the API's sandbox proxy, which
 * authenticates the caller and stamps these same credentials before
 * forwarding — so this was defence-in-depth, not a live breach. It becomes a
 * real hole the moment a daemon runs anywhere that proxy is not in front of
 * it.
 */
import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type { Config } from '@/lib/config/config'
import type { HarnessAttachmentResult, HarnessAttachmentService } from '@/harness/contract/queries'
import { KORTIX_USER_CONTEXT_HEADER } from '@/lib/kortix-api/kortix-user-context'
import { createPartRouter } from '@/routes/kortix/part'

const TOKEN = 'test-sandbox-token'
const WRONG_TOKEN = 'wrong-sandbox-token'
const SESSION = 'ses_test'
const MESSAGE = 'msg_test'
const PART = 'prt_test'
const BYTES = new Uint8Array([1, 2, 3])

function cfg(): Config {
  return { sandboxToken: TOKEN } as Config
}

function attachments(): HarnessAttachmentService {
  const result: HarnessAttachmentResult = { kind: 'bytes', bytes: BYTES, mime: 'image/png' }
  return { read: async () => result }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function signCtx(secret: string, exp: number): string {
  const payloadB64 = base64url(
    Buffer.from(
      JSON.stringify({ userId: 'u', sandboxId: 's', sandboxRole: 'owner', scopes: [], iat: 0, exp }),
      'utf8',
    ),
  )
  const sig = base64url(createHmac('sha256', secret).update(payloadB64).digest())
  return `${payloadB64}.${sig}`
}

const futureExp = () => Math.floor(Date.now() / 1000) + 60
const pastExp = () => Math.floor(Date.now() / 1000) - 60

const url = `http://d/${SESSION}/${MESSAGE}/${PART}`

describe('GET /kortix/part/:s/:m/:p auth', () => {
  test('no credential is rejected', async () => {
    const app = createPartRouter(cfg(), attachments())
    const res = await app.request(url)
    expect(res.status).toBe(401)
  })

  test('a valid service bearer runs the handler', async () => {
    const app = createPartRouter(cfg(), attachments())
    const res = await app.request(url, { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(BYTES))).toBe(true)
  })

  test('a valid signed user context runs the handler', async () => {
    const app = createPartRouter(cfg(), attachments())
    const res = await app.request(url, {
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signCtx(TOKEN, futureExp()) },
    })
    expect(res.status).toBe(200)
  })

  test('an expired signed context is rejected', async () => {
    const app = createPartRouter(cfg(), attachments())
    const res = await app.request(url, {
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signCtx(TOKEN, pastExp()) },
    })
    expect(res.status).toBe(401)
  })

  test('a context signed with the wrong key is rejected', async () => {
    const app = createPartRouter(cfg(), attachments())
    const res = await app.request(url, {
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signCtx(WRONG_TOKEN, futureExp()) },
    })
    expect(res.status).toBe(401)
  })

  test('an unconfigured daemon refuses rather than serving unauthenticated', async () => {
    const app = createPartRouter({ sandboxToken: undefined } as Config, attachments())
    const res = await app.request(url, { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(res.status).toBe(503)
  })
})
