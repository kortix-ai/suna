import { describe, expect, test } from 'bun:test'

import type { JsonRpcEnvelope } from './connection'
import { createQuestionResponseHandler, publishQuestionRequest } from './questions'

describe('OpenCode question ACP compatibility bridge', () => {
  test('publishes the OpenCode question as a session-scoped ACP input request', () => {
    const calls: Array<{
      method: string
      params: unknown
      id: string | number
      options: { timeoutMs?: number | null }
    }> = []
    const connection = {
      requestClient(
        method: string,
        params: unknown,
        id: string | number,
        _handle: (response: JsonRpcEnvelope) => Promise<void>,
        options: { timeoutMs?: number | null } = {},
      ) {
        calls.push({ method, params, id, options })
      },
    }

    publishQuestionRequest(
      connection,
      {
        id: 'question-1',
        sessionID: 'session-1',
        questions: [
          {
            question: 'Choose one',
            header: 'Choice',
            options: [
              { label: 'Alpha', description: 'First' },
              { label: 'Beta', description: 'Second' },
            ],
          },
        ],
      },
      async () => {},
    )

    expect(calls).toEqual([
      {
        method: 'session/request_input',
        id: 'kortix:question:question-1',
        options: { timeoutMs: null },
        params: {
          sessionId: 'session-1',
          questions: [
            {
              question: 'Choose one',
              header: 'Choice',
              options: [
                { label: 'Alpha', description: 'First' },
                { label: 'Beta', description: 'Second' },
              ],
            },
          ],
        },
      },
    ])
  })

  test('maps an accepted ACP response to the native OpenCode question reply', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const handler = createQuestionResponseHandler({
      baseUrl: 'http://127.0.0.1:4096',
      workspace: '/workspace',
      requestId: 'question-1',
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        return new Response('{}', { status: 200 })
      },
    })

    await handler({
      jsonrpc: '2.0',
      id: 'kortix:question:question-1',
      result: {
        action: 'accept',
        content: { answers: [['Beta']] },
      },
    } as JsonRpcEnvelope)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('http://127.0.0.1:4096/question/question-1/reply?directory=%2Fworkspace')
    expect(requests[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      answers: [['Beta']],
    })
  })

  test('maps a declined ACP response to the native OpenCode question reject route', async () => {
    const requests: string[] = []
    const handler = createQuestionResponseHandler({
      baseUrl: 'http://127.0.0.1:4096',
      workspace: '/workspace',
      requestId: 'question-1',
      fetch: async (url) => {
        requests.push(String(url))
        return new Response('{}', { status: 200 })
      },
    })

    await handler({
      jsonrpc: '2.0',
      id: 'kortix:question:question-1',
      result: { action: 'decline' },
    } as JsonRpcEnvelope)

    expect(requests).toEqual(['http://127.0.0.1:4096/question/question-1/reject?directory=%2Fworkspace'])
  })
})
