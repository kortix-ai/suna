import { createHmac } from 'crypto'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { Config } from '../config'
import type { Opencode } from '../opencode'
import { buildOpencodeApp } from '../proxy'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { INLINE_ATTACHMENT_MAX_BYTES } from '../inline-attachments'

/**
 * End to end through the daemon: a transcript list leaves WITHOUT its
 * attachment bytes, and those bytes are served back one part at a time.
 *
 * Why: on a real session (essentia, 2026-08-24) 20 messages weighed 7-19 MB
 * because every file part carried its whole file as a `data:` url, reads died
 * on the browser's 30 s deadline, and the retry re-issued the whole thing. The
 * same read answered in-VM in 276 ms. The bytes were the entire cost.
 */

const SECRET = 'test-sandbox-token'
const SESSION = 'ses_test'
const MESSAGE = 'msg_1'
const IMAGE_BYTES = Buffer.alloc(INLINE_ATTACHMENT_MAX_BYTES * 2, 0xab)
const DATA_URL = `data:image/png;base64,${IMAGE_BYTES.toString('base64')}`

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function signCtx(secret: string): string {
  const now = Math.floor(Date.now() / 1000)
  const body = { userId: 'u', sandboxId: 's', sandboxRole: 'owner', scopes: [], iat: now, exp: now + 60 }
  const payloadB64 = base64url(Buffer.from(JSON.stringify(body), 'utf8'))
  const sig = base64url(createHmac('sha256', secret).update(payloadB64).digest())
  return `${payloadB64}.${sig}`
}

function config(): Config {
  return {
    servicePort: 8000,
    opencodeInternalPort: 4096,
    opencodeStandbyPort: 4097,
    staticPort: 3211,
    workspace: '/workspace',
    sandboxToken: SECRET,
  } as unknown as Config
}

function fakeOpencode(internalUrl: string): Opencode {
  return {
    getState: () => 'ok',
    getPid: () => null,
    getInternalUrl: () => internalUrl,
    getActivePort: () => 4096,
    restart: async () => {},
    reloadConfig: async () => 'restarted' as const,
    reloadVerified: async () => ({ outcome: 'swapped' as const, port: 4097, pid: null }),
  } as unknown as Opencode
}

const message = {
  info: { id: MESSAGE, sessionID: SESSION, role: 'assistant', time: { created: 1 } },
  parts: [
    { id: 'prt_text', type: 'text', text: 'here is the screenshot' },
    { id: 'prt_img', type: 'file', mime: 'image/png', filename: 'shot.png', url: DATA_URL },
    { id: 'prt_small', type: 'file', mime: 'image/gif', url: 'data:image/gif;base64,R0lGOD' },
  ],
}

let upstream: ReturnType<typeof Bun.serve>
let upstreamHits: string[] = []

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      upstreamHits.push(path)
      if (path === `/session/${SESSION}/message`) {
        return Response.json([message])
      }
      if (path === `/session/${SESSION}/message/${MESSAGE}`) {
        return Response.json(message)
      }
      return new Response('not found', { status: 404 })
    },
  })
})

afterAll(() => {
  upstream.stop(true)
})

function app() {
  return buildOpencodeApp(config(), fakeOpencode(`http://127.0.0.1:${upstream.port}`), Date.now())
}

describe('attachment bytes leave the daemon on demand, never in the list', () => {
  it('the message list carries a reference instead of the bytes', async () => {
    const res = await app().request(`/session/${SESSION}/message?limit=20`, {
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signCtx(SECRET) },
    })
    expect(res.status).toBe(200)
    const text = await res.text()

    // The whole point.
    expect(text.length).toBeLessThan(DATA_URL.length / 10)
    expect(text).not.toContain(IMAGE_BYTES.toString('base64').slice(0, 64))

    const body = JSON.parse(text) as typeof message[]
    const img = body[0]!.parts[1]!
    expect(img).toEqual({
      id: 'prt_img',
      type: 'file',
      mime: 'image/png',
      filename: 'shot.png',
      url: `/kortix/part/${SESSION}/${MESSAGE}/prt_img`,
    })
    // Small enough to inline stays inline; text is untouched.
    expect(body[0]!.parts[2]!.url).toBe('data:image/gif;base64,R0lGOD')
    expect(body[0]!.parts[0]!.text).toBe('here is the screenshot')
  })

  it('the part endpoint serves the exact bytes with the part mime, cacheable forever', async () => {
    const res = await app().request(`/kortix/part/${SESSION}/${MESSAGE}/prt_img`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(res.headers.get('etag')).toBe('"prt_img"')
    const bytes = Buffer.from(await res.arrayBuffer())
    expect(bytes.equals(IMAGE_BYTES)).toBe(true)
  })

  it('a revalidation with the etag costs nothing', async () => {
    const res = await app().request(`/kortix/part/${SESSION}/${MESSAGE}/prt_img`, {
      headers: { 'if-none-match': '"prt_img"' },
    })
    expect(res.status).toBe(304)
  })

  it('an unknown part is a 404, not a crash', async () => {
    const res = await app().request(`/kortix/part/${SESSION}/${MESSAGE}/prt_nope`)
    expect(res.status).toBe(404)
  })

  it('an unknown message is a 404, not a crash', async () => {
    const res = await app().request(`/kortix/part/${SESSION}/msg_nope/prt_img`)
    expect(res.status).toBe(404)
  })

  it('a single-message read is NOT stripped — that is where the part endpoint reads the bytes from', async () => {
    const res = await app().request(`/session/${SESSION}/message/${MESSAGE}`, {
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signCtx(SECRET) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as typeof message
    expect(body.parts[1]!.url).toBe(DATA_URL)
  })
})
