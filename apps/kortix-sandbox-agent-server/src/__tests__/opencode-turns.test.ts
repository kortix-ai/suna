import { beforeEach, describe, expect, test } from 'bun:test'
import type { HarnessForwardInput } from '@/harness/contract/proxy'
import { createOpenCodeDiagnosticsService } from '@/harness/open-code/diagnostics'
import { configureRuntimeState, resetRuntimeStateForTests } from '@/harness/open-code/runtime-state-projection'
import { createOpenCodeTurnService, observeSteerRead, opencodeSupportsSteer, resetSteerWitnessForTests } from '@/harness/open-code/turns'
import { createRuntimeRouter, parseRuntimePromptBody } from '@/routes/kortix/runtime'

/** A proxy forward that records the native request and answers from a script. */
function fakeProxy(answer: (input: HarnessForwardInput) => { status: number; body: unknown }) {
  const seen: Array<{ method: string; path: string; search: string; body: unknown }> = []
  return {
    seen,
    proxy: {
      async forward(input: HarnessForwardInput) {
        const text = input.body ? await new Response(input.body).text() : ''
        seen.push({ method: input.method, path: input.path, search: input.search, body: text ? JSON.parse(text) : null })
        const { status, body } = answer(input)
        return { status, statusText: '', headers: new Headers(), body: body === null ? null : JSON.stringify(body) }
      },
    },
  }
}

describe('the Kortix turn verbs on OpenCode (W5 E4)', () => {
  test('a prompt is prompt_async with ?directory=, messageID and the {providerID, modelID} split', async () => {
    const { proxy, seen } = fakeProxy(() => ({ status: 204, body: null }))
    const turns = createOpenCodeTurnService(proxy, () => '/workspace')
    const input = parseRuntimePromptBody({
      message_id: 'msg_1',
      parts: [{ type: 'text', text: 'hi' }],
      agent: 'coder',
      model: 'kortix/anthropic/claude',
      variant: 'high',
      no_reply: true,
    })
    if (typeof input === 'string') throw new Error(input)
    expect(await turns.prompt('ses_1', input)).toEqual({ status: 202, body: { message_id: 'msg_1' } })
    expect(seen).toEqual([
      // The dedupe read: OpenCode answers no message under that id.
      { method: 'GET', path: '/session/ses_1/message/msg_1', search: '?directory=%2Fworkspace', body: null },
      {
        method: 'POST',
        path: '/session/ses_1/prompt_async',
        search: '?directory=%2Fworkspace',
        body: {
          messageID: 'msg_1',
          parts: [{ type: 'text', text: 'hi' }],
          agent: 'coder',
          model: { providerID: 'kortix', modelID: 'anthropic/claude' },
          variant: 'high',
          noReply: true,
        },
      },
    ])
  })

  test('a prompt names its own directory, and a refusal passes through', async () => {
    const { proxy, seen } = fakeProxy(() => ({ status: 400, body: { error: 'bad' } }))
    const turns = createOpenCodeTurnService(proxy, () => '/workspace')
    expect(await turns.prompt('ses_1', { parts: [{ type: 'text', text: 'hi' }], directory: '/workspace/app' })).toEqual({
      status: 400,
      body: { error: 'bad' },
    })
    expect(seen[0]!.search).toBe('?directory=%2Fworkspace%2Fapp')
  })

  test('abort, read, remove and agents map to the native routes', async () => {
    const { proxy, seen } = fakeProxy((input) =>
      input.path === '/agent'
        ? { status: 200, body: [{ name: 'build', mode: 'primary', description: 'Builds', prompt: 'secret' }] }
        : { status: 200, body: true },
    )
    const turns = createOpenCodeTurnService(proxy, () => '/workspace')
    await turns.abort('ses_1')
    await turns.readMessage('ses_1', 'msg_1')
    await turns.removeMessage('ses_1', 'msg_1')
    expect(await turns.agents(null)).toEqual({
      status: 200,
      body: { agents: [{ name: 'build', description: 'Builds', mode: 'primary' }] },
    })
    expect(seen.map((call) => `${call.method} ${call.path}${call.search}`)).toEqual([
      'POST /session/ses_1/abort?directory=%2Fworkspace',
      'GET /session/ses_1/message/msg_1?directory=%2Fworkspace',
      'DELETE /session/ses_1/message/msg_1?directory=%2Fworkspace',
      'GET /agent?directory=%2Fworkspace',
    ])
  })
})

describe('a repeated messageID on OpenCode is answered as a duplicate, like pi (R9.4)', () => {
  const prompt = (id?: string) => ({ ...(id ? { messageId: id } : {}), parts: [{ type: 'text', text: 'hi' }] })
  const forwards = (seen: Array<{ method: string; path: string }>) => seen.filter((c) => c.path.endsWith('/prompt_async')).length

  test('an id OpenCode already holds is not sent again', async () => {
    const { proxy, seen } = fakeProxy((input) =>
      input.method === 'GET' ? { status: 200, body: { info: { id: 'msg_1' }, parts: [] } } : { status: 204, body: null },
    )
    const turns = createOpenCodeTurnService(proxy, () => '/workspace')
    expect(await turns.prompt('ses_1', prompt('msg_1'))).toEqual({ status: 200, body: { deduplicated: true } })
    expect(forwards(seen)).toBe(0)
  })

  test('two concurrent sends of one id forward once', async () => {
    const { proxy, seen } = fakeProxy((input) => (input.method === 'GET' ? { status: 404, body: { error: 'not found' } } : { status: 204, body: null }))
    const turns = createOpenCodeTurnService(proxy, () => '/workspace')
    const [a, b] = await Promise.all([turns.prompt('ses_1', prompt('msg_1')), turns.prompt('ses_1', prompt('msg_1'))])
    expect([a.status, b.status].sort()).toEqual([200, 202])
    expect(forwards(seen)).toBe(1)
  })

  test('a send of an id this daemon already forwarded is a duplicate, before OpenCode lists it', async () => {
    const { proxy, seen } = fakeProxy((input) => (input.method === 'GET' ? { status: 404, body: null } : { status: 204, body: null }))
    const turns = createOpenCodeTurnService(proxy, () => '/workspace')
    await turns.prompt('ses_1', prompt('msg_1'))
    expect(await turns.prompt('ses_1', prompt('msg_1'))).toEqual({ status: 200, body: { deduplicated: true } })
    expect(forwards(seen)).toBe(1)
  })

  test('a send that OpenCode refused may be sent again', async () => {
    let refuse = true
    const { proxy, seen } = fakeProxy((input) =>
      input.method === 'GET' ? { status: 404, body: null } : refuse ? { status: 500, body: { error: 'busy' } } : { status: 204, body: null },
    )
    const turns = createOpenCodeTurnService(proxy, () => '/workspace')
    expect((await turns.prompt('ses_1', prompt('msg_1'))).status).toBe(500)
    refuse = false
    expect((await turns.prompt('ses_1', prompt('msg_1'))).status).toBe(202)
    expect(forwards(seen)).toBe(2)
  })

  test('a message the API removed may be sent again under its id', async () => {
    const { proxy, seen } = fakeProxy((input) => (input.method === 'GET' ? { status: 404, body: null } : { status: 204, body: null }))
    const turns = createOpenCodeTurnService(proxy, () => '/workspace')
    await turns.prompt('ses_1', prompt('msg_1'))
    await turns.removeMessage('ses_1', 'msg_1')
    expect((await turns.prompt('ses_1', prompt('msg_1'))).status).toBe(202)
    expect(forwards(seen)).toBe(2)
  })

  test('a failed existence read does not block the prompt', async () => {
    const forwardsSeen: string[] = []
    const proxy = {
      async forward(input: HarnessForwardInput) {
        if (input.method === 'GET') throw new Error('socket hang up')
        forwardsSeen.push(input.path)
        return { status: 204, statusText: '', headers: new Headers(), body: null }
      },
    }
    const turns = createOpenCodeTurnService(proxy, () => '/workspace')
    expect(await turns.prompt('ses_1', prompt('msg_1'))).toEqual({ status: 202, body: { message_id: 'msg_1' } })
    expect(forwardsSeen).toEqual(['/session/ses_1/prompt_async'])
  })

  test('a prompt without an id is forwarded with no read, as before', async () => {
    const { proxy, seen } = fakeProxy(() => ({ status: 204, body: null }))
    const turns = createOpenCodeTurnService(proxy, () => '/workspace')
    await turns.prompt('ses_1', prompt())
    await turns.prompt('ses_1', prompt())
    expect(seen.map((c) => c.method)).toEqual(['POST', 'POST'])
  })
})

describe('parseRuntimePromptBody', () => {
  test.each([
    [null, 'body must be a JSON object'],
    [{ parts: [] }, 'parts must be a non-empty array'],
    [{ parts: ['x'] }, 'parts must be objects'],
    [{ parts: [{}], agent: 1 }, 'agent must be a string'],
    [{ parts: [{}], model: 'bare' }, 'model must be "provider/model"'],
    [{ parts: [{}], model: 'kortix/' }, 'model must be "provider/model"'],
    [{ parts: [{}], no_reply: 'yes' }, 'no_reply must be a boolean'],
  ])('%j is refused', (body, error) => {
    expect(parseRuntimePromptBody(body)).toBe(error)
  })
})

describe('the Kortix turn routes keep the runtime gate of the proxy they replace (W5 E4)', () => {
  const TOKEN = 'sandbox-token'
  const cfg = { sandboxToken: TOKEN } as Parameters<typeof createRuntimeRouter>[0]
  const noQueries = {} as Parameters<typeof createRuntimeRouter>[1]
  const post = (app: ReturnType<typeof createRuntimeRouter>, path: string) =>
    app.request(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'hi' }] }),
    })

  test('a runtime that is not ready answers 503 with its boot phase, and the verb never runs', async () => {
    const { proxy, seen } = fakeProxy(() => ({ status: 204, body: null }))
    const app = createRuntimeRouter(cfg, noQueries, {
      turns: createOpenCodeTurnService(proxy, () => '/workspace'),
      readiness: async () => ({ ready: false, phase: 'workspace_not_ready', details: { reason: 'installing dependencies' } }),
    })
    for (const path of ['/sessions/ses_1/prompt', '/sessions/ses_1/abort']) {
      const res = await post(app, path)
      expect(res.status).toBe(503)
      expect(res.headers.get('X-Kortix-Boot-Phase')).toBe('workspace_not_ready')
      // `code` is the one machine answer a client matches; the harness's own details follow it.
      expect(await res.json()).toEqual({ code: 'runtime_not_ready', reason: 'installing dependencies', phase: 'workspace_not_ready' })
    }
    const read = await app.request('/messages/ses_1/msg_1', { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(read.status).toBe(503)
    expect(seen).toEqual([])
  })

  test('an upstream that cannot be reached answers 502, not 500', async () => {
    const proxy = {
      async forward(): Promise<never> {
        throw new Error('connect ECONNREFUSED 127.0.0.1:4096')
      },
    }
    const app = createRuntimeRouter(cfg, noQueries, {
      turns: createOpenCodeTurnService(proxy, () => '/workspace'),
      readiness: async () => ({ ready: true }),
    })
    const res = await post(app, '/sessions/ses_1/prompt')
    expect(res.status).toBe(502)
    expect(res.headers.get('X-Kortix-Turn-Verb')).toBe('1')
    expect(await res.json()).toEqual({ error: 'upstream unreachable', details: 'connect ECONNREFUSED 127.0.0.1:4096' })
  })
})

describe('steering on OpenCode (R10)', () => {
  const steerInput = (id: string) => ({ messageId: id, parts: [{ type: 'text', text: 'also this' }] })
  /** OpenCode with `status` as the root's `/session/status` entry; no message is held yet. */
  const opencode = (status: Record<string, unknown>) =>
    fakeProxy((input) => {
      if (input.path === '/session/status') return { status: 200, body: status }
      if (input.method === 'GET') return { status: 404, body: { error: 'not found' } }
      return { status: 204, body: null }
    })
  const at = (version: string | null) => async () => version

  beforeEach(() => resetSteerWitnessForTests())

  test('an idle session answers 409 no_active_turn and sends nothing; a busy one gets prompt_async', async () => {
    const idle = opencode({})
    const turns = createOpenCodeTurnService(idle.proxy, () => '/workspace', at('1.18.23'))
    expect(await turns.steer('ses_1', steerInput('msg_s'))).toEqual({ status: 409, body: { code: 'no_active_turn' } })
    expect(idle.seen.filter((c) => c.method === 'POST')).toEqual([])
    // Nothing was stored, so the same id may go in as a prompt.
    expect((await turns.prompt('ses_1', steerInput('msg_s'))).status).toBe(202)

    const busy = opencode({ ses_1: { type: 'busy' } })
    const steering = createOpenCodeTurnService(busy.proxy, () => '/workspace', at('1.18.23'))
    expect(await steering.steer('ses_1', steerInput('msg_s'))).toEqual({ status: 202, body: { message_id: 'msg_s', steered: true } })
    expect(busy.seen.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: '/session/ses_1/prompt_async', search: '?directory=%2Fworkspace', body: { messageID: 'msg_s', parts: [{ type: 'text', text: 'also this' }] } },
    ])
    expect(await steering.steer('ses_1', steerInput('msg_s'))).toEqual({ status: 200, body: { deduplicated: true } })
  })

  test('an OpenCode older than 1.18.15 answers 501; an unknown version still steers', async () => {
    const old = opencode({ ses_1: { type: 'busy' } })
    expect(await createOpenCodeTurnService(old.proxy, () => '/workspace', at('1.18.14')).steer('ses_1', steerInput('msg_s'))).toEqual({
      status: 501,
      body: { code: 'feature_not_supported' },
    })
    expect(old.seen).toEqual([])
    const unknown = opencode({ ses_1: { type: 'retry' } })
    expect((await createOpenCodeTurnService(unknown.proxy, () => '/workspace', at(null)).steer('ses_1', steerInput('msg_s'))).status).toBe(202)
  })

  test.each([
    ['1.18.14', false],
    ['1.18.15', true],
    ['1.18.23', true],
    ['1.19.0', true],
    [null, null],
  ] as const)('OpenCode %p steers: %p', (version, expected) => {
    expect(opencodeSupportsSteer(version)).toBe(expected)
  })

  test('health lists session.steer only for a running OpenCode at 1.18.15 or later', async () => {
    let version: string | null = '1.18.23'
    const server = Bun.serve({ port: 0, fetch: () => (version ? Response.json({ healthy: true, version }) : new Response('down', { status: 503 })) })
    const lifecycle = { getInternalUrl: () => `http://127.0.0.1:${server.port}` }
    const capabilities = () => createOpenCodeDiagnosticsService(lifecycle as never).capabilities()
    try {
      configureRuntimeState({ opencode: lifecycle } as never)
      expect(await capabilities()).toContain('session.steer')
      version = '1.18.14'
      configureRuntimeState({ opencode: lifecycle } as never)
      const old = await capabilities()
      expect(old).not.toContain('session.steer')
      expect(old).toContain('session.rewind')
      version = null
      configureRuntimeState({ opencode: lifecycle } as never)
      expect(await capabilities()).not.toContain('session.steer')
      resetRuntimeStateForTests()
      expect(await capabilities()).not.toContain('session.steer')
    } finally {
      resetRuntimeStateForTests()
      server.stop(true)
    }
  })

  test('the first assistant message parented on a steered id relays steer_read once', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const api = Bun.serve({ port: 0, fetch: async (req) => (bodies.push((await req.json()) as Record<string, unknown>), Response.json({ ok: true })) })
    const saved = { ...process.env }
    Object.assign(process.env, { KORTIX_PROJECT_ID: 'proj_1', KORTIX_SESSION_ID: 'sess_1', KORTIX_TOKEN: 'tok', KORTIX_API_URL: `http://127.0.0.1:${api.port}` })
    try {
      const busy = opencode({ ses_1: { type: 'busy' } })
      await createOpenCodeTurnService(busy.proxy, () => '/workspace', at('1.18.23')).steer('ses_1', steerInput('msg_s'))
      const updated = (info: Record<string, unknown>) => ({ type: 'message.updated', properties: { info: { sessionID: 'ses_1', ...info } } })
      observeSteerRead(updated({ role: 'user', id: 'msg_s' }))
      observeSteerRead(updated({ role: 'assistant', parentID: 'msg_turn' }))
      observeSteerRead(updated({ role: 'assistant', parentID: 'msg_s' }))
      observeSteerRead(updated({ role: 'assistant', parentID: 'msg_s' }))
      const deadline = Date.now() + 2_000
      while (bodies.length === 0 && Date.now() < deadline) await Bun.sleep(10)
      await Bun.sleep(50)
      expect(bodies).toEqual([{ session_id: 'sess_1', kind: 'steer_read', runtime_session_id: 'ses_1', turn_message_id: 'msg_s' }])
    } finally {
      for (const key of ['KORTIX_PROJECT_ID', 'KORTIX_SESSION_ID', 'KORTIX_TOKEN', 'KORTIX_API_URL']) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
      api.stop(true)
    }
  })
})
