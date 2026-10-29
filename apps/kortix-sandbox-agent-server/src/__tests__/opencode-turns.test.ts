import { describe, expect, test } from 'bun:test'
import type { HarnessForwardInput } from '@/harness/contract/proxy'
import { createOpenCodeTurnService } from '@/harness/open-code/turns'
import type { HarnessTurnService, RuntimePromptInput } from '@/harness/contract/turns'
import { KORTIX_SERVICE_CALL_HEADER } from '@/lib/kortix-api/kortix-user-context'
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

describe('parseRuntimePromptBody', () => {
  test.each([
    [null, 'body must be a JSON object'],
    [{ parts: [] }, 'parts must be a non-empty array'],
    [{ parts: ['x'] }, 'parts must be objects'],
    [{ parts: [{}], agent: 1 }, 'agent must be a string'],
    [{ parts: [{}], model: 'bare' }, 'model must be "provider/model"'],
    [{ parts: [{}], model: 'kortix/' }, 'model must be "provider/model"'],
    [{ parts: [{}], no_reply: 'yes' }, 'no_reply must be a boolean'],
    [{ parts: [{}], system: 5 }, 'system must be a string'],
    [{ parts: [{}], system: 'x'.repeat(16_001) }, 'system must be at most 16000 characters'],
  ])('%j is refused', (body, error) => {
    expect(parseRuntimePromptBody(body)).toBe(error)
  })

  test('system is the turn system text, up to 16,000 characters; a blank one or none leaves the input as before', () => {
    const parts = [{ type: 'text', text: 'hi' }]
    expect(parseRuntimePromptBody({ parts, system: '  ## Memory\n- Q4 launch  ' })).toEqual({ parts, system: '## Memory\n- Q4 launch' })
    expect(parseRuntimePromptBody({ parts, system: 'x'.repeat(16_000) })).toEqual({ parts, system: 'x'.repeat(16_000) })
    expect(parseRuntimePromptBody({ parts, system: '  ' })).toEqual({ parts })
    expect(parseRuntimePromptBody({ parts })).toEqual({ parts })
  })
})

describe('the turn system text on OpenCode', () => {
  test('the steer route drops a system field; the prompt route passes it on', async () => {
    const seen: Array<[string, RuntimePromptInput]> = []
    const record = (verb: string) => async (_id: string, input: RuntimePromptInput) => {
      seen.push([verb, input])
      return { status: 202, body: {} }
    }
    const turns = { prompt: record('prompt'), steer: record('steer') } as unknown as HarnessTurnService
    const app = createRuntimeRouter({ sandboxToken: 'sandbox-token' } as Parameters<typeof createRuntimeRouter>[0], {} as Parameters<typeof createRuntimeRouter>[1], { turns })
    const body = JSON.stringify({ message_id: 'msg_1', parts: [{ type: 'text', text: 'hi' }], system: 'LIST' })
    const headers = { Authorization: 'Bearer sandbox-token', 'content-type': 'application/json', [KORTIX_SERVICE_CALL_HEADER]: '1' }
    expect((await app.request('/sessions/ses_1/steer', { method: 'POST', headers, body })).status).toBe(202)
    expect((await app.request('/sessions/ses_1/prompt', { method: 'POST', headers, body })).status).toBe(202)
    expect(seen.map(([verb, input]) => [verb, input.system])).toEqual([
      ['steer', undefined],
      ['prompt', 'LIST'],
    ])
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
