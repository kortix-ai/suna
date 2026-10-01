import { describe, expect, test } from 'bun:test'
import type { HarnessForwardInput } from '@/harness/contract/proxy'
import { createOpenCodeTurnService } from '@/harness/open-code/turns'
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
      expect(await res.json()).toEqual({ reason: 'installing dependencies', phase: 'workspace_not_ready' })
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
