import { describe, expect, test } from 'bun:test'
import type { HarnessForwardInput } from '@/harness/contract/proxy'
import { createOpenCodeTurnService } from '@/harness/open-code/turns'
import { parseRuntimePromptBody } from '@/routes/kortix/runtime'

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
