import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createHmac } from 'crypto'
import { loadOpenCodeConfig, type OpenCodeConfig as Config } from '../harness/open-code/config'
import type { Opencode } from '../harness/open-code/lifecycle'
import { OpenPartText, openPartText, OPEN_PART_TEXT_MAX_PARTS } from '../harness/open-code/open-part-text'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { buildOpenCodeTestApp } from './helpers/open-code-harness'

/**
 * OpenCode 1.18 persists an open text or reasoning part EMPTY and writes its
 * text once, when the part ends. A page reload in the middle of a step
 * therefore read the step's answer as '' — the words the user had just watched
 * stream in vanished until the step finished (measured on the local stack
 * 2026-09-23: text part persisted `''` with `time.start` set and no
 * `time.end` while three tools ran after it).
 *
 * The daemon already observes every delta on its own `/event` subscription.
 * It keeps each open part's accumulated text and the transcript list carries
 * it, so a reload reads the in-flight answer instead of a blank.
 */

const SID = 'ses_live'
const MID = 'msg_live'

function deltaEvent(partID: string, delta: string, field = 'text') {
  return {
    type: 'message.part.delta',
    properties: { sessionID: SID, messageID: MID, partID, field, delta },
  }
}

function partEvent(part: Record<string, unknown>) {
  return { type: 'message.part.updated', properties: { part: { sessionID: SID, messageID: MID, ...part } } }
}

/** OpenCode opens every text/reasoning part with an empty snapshot. */
function started(partID: string, type = 'text') {
  return partEvent({ id: partID, type, text: '', time: { start: 1 } })
}

function page(parts: Array<Record<string, unknown>>) {
  return [
    { info: { id: 'msg_user', sessionID: SID, role: 'user', time: { created: 1 } }, parts: [] },
    { info: { id: MID, sessionID: SID, role: 'assistant', time: { created: 2 } }, parts },
  ]
}

describe('OpenPartText — the accumulated text of every open part', () => {
  let store: OpenPartText
  beforeEach(() => {
    store = new OpenPartText()
  })

  it('an open text part persisted empty reads back with the text streamed so far', () => {
    store.noteEvent(partEvent({ id: 'prt_t', type: 'text', text: '', time: { start: 1 } }))
    store.noteEvent(deltaEvent('prt_t', 'I now have 12 products. '))
    store.noteEvent(deltaEvent('prt_t', 'Building the outputs.'))

    const body = page([
      { id: 'prt_r', type: 'reasoning', text: 'Plan the files.', time: { start: 1, end: 2 } },
      { id: 'prt_t', type: 'text', text: '', time: { start: 3 } },
    ])
    expect(store.overlay(body)).toBe(1)
    expect(body[1]!.parts[1]!.text).toBe('I now have 12 products. Building the outputs.')
    // The ended reasoning is untouched.
    expect(body[1]!.parts[0]!.text).toBe('Plan the files.')
  })

  it('an open reasoning part reads back with its streamed text, and keeps its type', () => {
    store.noteEvent(started('prt_r', 'reasoning'))
    store.noteEvent(deltaEvent('prt_r', 'Compare price first.'))
    const body = page([{ id: 'prt_r', type: 'reasoning', text: '', time: { start: 1 } }])
    store.overlay(body)
    expect(body[1]!.parts[0]).toEqual({ id: 'prt_r', type: 'reasoning', text: 'Compare price first.', time: { start: 1 } })
  })

  it('an ENDED part is never overlaid, and its entry is released', () => {
    store.noteEvent(started('prt_t'))
    store.noteEvent(deltaEvent('prt_t', 'Done.  '))
    store.noteEvent(partEvent({ id: 'prt_t', type: 'text', text: 'Done.', time: { start: 1, end: 2 } }))
    expect(store.size).toBe(0)
    const body = page([{ id: 'prt_t', type: 'text', text: 'Done.', time: { start: 1, end: 2 } }])
    expect(store.overlay(body)).toBe(0)
    expect(body[1]!.parts[0]!.text).toBe('Done.')
  })

  it('persisted text the stream does not extend is left alone', () => {
    store.noteEvent(started('prt_t'))
    store.noteEvent(deltaEvent('prt_t', 'something else'))
    const body = page([{ id: 'prt_t', type: 'text', text: 'Persisted', time: { start: 1 } }])
    expect(store.overlay(body)).toBe(0)
    expect(body[1]!.parts[0]!.text).toBe('Persisted')
  })

  it('a delta for a part never seen starting is ignored — it would serve a fragment as the whole text', () => {
    // The daemon resubscribed (or evicted the entry) mid-part: what arrives
    // now lacks the part's beginning.
    store.noteEvent(deltaEvent('prt_t', 'the middle of a sentence'))
    expect(store.size).toBe(0)
    const body = page([{ id: 'prt_t', type: 'text', text: '', time: { start: 1 } }])
    expect(store.overlay(body)).toBe(0)
    expect(body[1]!.parts[0]!.text).toBe('')
  })

  it('a non-text delta field is ignored', () => {
    store.noteEvent(deltaEvent('prt_tool', '{"a":', 'input'))
    expect(store.size).toBe(0)
  })

  it('the part, its message, or its session ending releases the entry', () => {
    store.noteEvent(started('prt_a'))
    store.noteEvent(deltaEvent('prt_a', 'a'))
    store.noteEvent({ type: 'message.part.removed', properties: { sessionID: SID, messageID: MID, partID: 'prt_a' } })
    expect(store.size).toBe(0)

    store.noteEvent(started('prt_b'))
    store.noteEvent(deltaEvent('prt_b', 'b'))
    store.noteEvent({ type: 'message.updated', properties: { info: { id: MID, sessionID: SID, role: 'assistant', time: { created: 2, completed: 3 } } } })
    expect(store.size).toBe(0)

    store.noteEvent(started('prt_c'))
    store.noteEvent(deltaEvent('prt_c', 'c'))
    store.noteEvent({ type: 'session.idle', properties: { sessionID: SID } })
    expect(store.size).toBe(0)

    store.noteEvent(started('prt_d'))
    store.noteEvent(deltaEvent('prt_d', 'd'))
    store.noteEvent({ type: 'session.status', properties: { sessionID: SID, status: { type: 'idle' } } })
    expect(store.size).toBe(0)
  })

  it('an open message update keeps the entry', () => {
    store.noteEvent(started('prt_a'))
    store.noteEvent(deltaEvent('prt_a', 'a'))
    store.noteEvent({ type: 'message.updated', properties: { info: { id: MID, sessionID: SID, role: 'assistant', time: { created: 2 } } } })
    expect(store.size).toBe(1)
  })

  it('holds a bounded number of parts, dropping the least recently written', () => {
    for (let i = 0; i <= OPEN_PART_TEXT_MAX_PARTS; i++) {
      store.noteEvent(started(`prt_${i}`))
      store.noteEvent(deltaEvent(`prt_${i}`, 'x'))
    }
    expect(store.size).toBe(OPEN_PART_TEXT_MAX_PARTS)
    const body = page([
      { id: 'prt_0', type: 'text', text: '', time: { start: 1 } },
      { id: `prt_${OPEN_PART_TEXT_MAX_PARTS}`, type: 'text', text: '', time: { start: 1 } },
    ])
    store.overlay(body)
    expect(body[1]!.parts[0]!.text).toBe('')
    expect(body[1]!.parts[1]!.text).toBe('x')
  })

  it('clear() forgets everything — a resubscribed stream may have missed deltas', () => {
    store.noteEvent(started('prt_a'))
    store.noteEvent(deltaEvent('prt_a', 'a'))
    store.clear()
    expect(store.size).toBe(0)
  })

  it('a malformed body or event never throws', () => {
    expect(store.overlay(null)).toBe(0)
    expect(store.overlay({ not: 'a list' })).toBe(0)
    expect(store.overlay([{ info: null, parts: null }])).toBe(0)
    expect(() => store.noteEvent({ type: 'message.part.delta', properties: null })).not.toThrow()
    expect(() => store.noteEvent({ type: 'message.part.updated', properties: { part: null } })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// End to end through the daemon's proxied transcript list.
// ---------------------------------------------------------------------------

const SECRET = 'test-sandbox-token'

function signCtx(secret: string): string {
  const b64 = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const now = Math.floor(Date.now() / 1000)
  const payload = b64(Buffer.from(JSON.stringify({ userId: 'u', sandboxId: 's', sandboxRole: 'owner', scopes: [], iat: now, exp: now + 60 })))
  return `${payload}.${b64(createHmac('sha256', secret).update(payload).digest())}`
}

function config(): Config {
  return {
    ...loadOpenCodeConfig({}),
    servicePort: 8000,
    opencodeInternalPort: 4096,
    opencodeStandbyPort: 4097,
    staticPort: 3211,
    workspace: '/workspace',
    sandboxToken: SECRET,
  }
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

describe('the proxied transcript list carries the in-flight text', () => {
  let upstream: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    upstream = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === `/session/${SID}/message`) {
          return Response.json(page([
            { id: 'prt_r', type: 'reasoning', text: 'Ended thought.', time: { start: 1, end: 2 } },
            { id: 'prt_t', type: 'text', text: '', time: { start: 3 } },
            { id: 'prt_tool', type: 'tool', tool: 'write', state: { status: 'running' } },
          ]))
        }
        return new Response('not found', { status: 404 })
      },
    })
  })
  afterAll(() => {
    upstream.stop(true)
    openPartText().clear()
  })

  it('GET /session/:id/message returns the open text part with its streamed text', async () => {
    openPartText().clear()
    openPartText().noteEvent(started('prt_t'))
    openPartText().noteEvent(deltaEvent('prt_t', 'I now have 12 products plus market context. '))
    openPartText().noteEvent(deltaEvent('prt_t', 'Building the outputs…'))

    const app = buildOpenCodeTestApp(config(), fakeOpencode(`http://127.0.0.1:${upstream.port}`), Date.now())
    const res = await app.request(`/session/${SID}/message?limit=20`, {
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signCtx(SECRET) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as ReturnType<typeof page>
    const parts = body[1]!.parts as Array<{ id: string; type: string; text?: string }>
    expect(parts.map((p) => [p.id, p.type, p.text ?? null])).toEqual([
      ['prt_r', 'reasoning', 'Ended thought.'],
      ['prt_t', 'text', 'I now have 12 products plus market context. Building the outputs…'],
      ['prt_tool', 'tool', null],
    ])
  })

  it('with nothing streamed the list passes through unchanged', async () => {
    openPartText().clear()
    const app = buildOpenCodeTestApp(config(), fakeOpencode(`http://127.0.0.1:${upstream.port}`), Date.now())
    const res = await app.request(`/session/${SID}/message?limit=20`, {
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signCtx(SECRET) },
    })
    const body = (await res.json()) as ReturnType<typeof page>
    expect((body[1]!.parts[1] as { text: string }).text).toBe('')
  })
})
