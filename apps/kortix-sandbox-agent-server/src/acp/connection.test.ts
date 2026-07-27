import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'

import {
  AcpConnection,
  AcpProtocolError,
  type AcpStreamEvent,
  buildOpenCodeLaunch,
  type JsonRpcEnvelope,
  parseJsonRpcEnvelope,
  redactAcpDiagnostic,
  resolveOpenCodeTransport,
} from './connection'

type Harness = ReturnType<typeof createHarness>

function createHarness(options: {
  requestTimeoutMs?: number
  maxReplayEvents?: number
  initialEventId?: number
} = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  const diagnostics: string[] = []
  const connection = new AcpConnection({
    input,
    output,
    requestTimeoutMs: options.requestTimeoutMs,
    maxReplayEvents: options.maxReplayEvents,
    initialEventId: options.initialEventId,
    onDiagnostic: (line) => diagnostics.push(line),
  })
  const writes: Record<string, unknown>[] = []
  let pending = ''
  input.on('data', (chunk) => {
    pending += chunk.toString()
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim()) writes.push(JSON.parse(line))
    }
  })
  return { connection, input, output, diagnostics, writes }
}

function respond(harness: Harness, envelope: Record<string, unknown>) {
  harness.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...envelope })}\n`)
}

async function nextTick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('OpenCode ACP launch', () => {
  test('defaults to native ACP and keeps REST as an explicit rollback', () => {
    expect(resolveOpenCodeTransport({})).toBe('acp')
    expect(resolveOpenCodeTransport({ KORTIX_OPENCODE_PROCESS_TRANSPORT: 'acp' })).toBe('acp')
    expect(resolveOpenCodeTransport({ KORTIX_OPENCODE_PROCESS_TRANSPORT: 'rest' })).toBe('rest')
    expect(() =>
      resolveOpenCodeTransport({ KORTIX_OPENCODE_PROCESS_TRANSPORT: 'claude' }),
    ).toThrow("KORTIX_OPENCODE_PROCESS_TRANSPORT must be 'acp' or 'rest'")
  })

  test('starts one OpenCode ACP process with the existing internal HTTP port', () => {
    expect(buildOpenCodeLaunch('acp', 4096, '/workspace')).toEqual({
      args: [
        'acp',
        '--port',
        '4096',
        '--hostname',
        '127.0.0.1',
        '--cwd',
        '/workspace',
      ],
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { OPENCODE_ENABLE_QUESTION_TOOL: '1' },
    })
    expect(buildOpenCodeLaunch('rest', 4096, '/workspace')).toEqual({
      args: ['serve', '--port', '4096', '--hostname', '127.0.0.1'],
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {},
    })
  })
})

describe('ACP NDJSON connection', () => {
  test('validates JSON-RPC envelopes', () => {
    expect(parseJsonRpcEnvelope({ jsonrpc: '2.0', method: 'session/new' })).toEqual({
      jsonrpc: '2.0',
      method: 'session/new',
    })
    expect(() => parseJsonRpcEnvelope({ method: 'session/new' })).toThrow(
      'JSON-RPC 2.0',
    )
    expect(() => parseJsonRpcEnvelope({ jsonrpc: '2.0' })).toThrow(
      'request, notification, or response',
    )
  })

  test('initializes ACP v1 before the connection reports ready', async () => {
    const harness = createHarness()
    expect(harness.connection.ready).toBe(false)

    const initializing = harness.connection.initialize({
      clientInfo: { name: 'kortix', version: '1' },
    })
    await nextTick()

    expect(harness.writes).toEqual([
      {
        jsonrpc: '2.0',
        id: 'kortix:initialize',
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
          clientInfo: { name: 'kortix', version: '1' },
        },
      },
    ])

    respond(harness, {
      id: 'kortix:initialize',
      result: { protocolVersion: 1, agentInfo: { name: 'OpenCode' } },
    })
    await expect(initializing).resolves.toMatchObject({
      protocolVersion: 1,
      agentInfo: { name: 'OpenCode' },
    })
    expect(harness.connection.ready).toBe(true)
  })

  test('correlates concurrent responses by JSON-RPC id', async () => {
    const harness = createHarness()
    const first = harness.connection.request('session/load', { sessionId: 'a' }, 'a')
    const second = harness.connection.request('session/load', { sessionId: 'b' }, 'b')
    await nextTick()

    respond(harness, { id: 'b', result: { loaded: 'b' } })
    respond(harness, { id: 'a', result: { loaded: 'a' } })

    await expect(first).resolves.toEqual({ loaded: 'a' })
    await expect(second).resolves.toEqual({ loaded: 'b' })
  })

  test('replays only the bounded notification window', async () => {
    const harness = createHarness({ maxReplayEvents: 2 })
    respond(harness, { method: 'session/update', params: { index: 1 } })
    respond(harness, { method: 'session/update', params: { index: 2 } })
    respond(harness, { method: 'session/update', params: { index: 3 } })
    await nextTick()

    const replayed: number[] = []
    harness.connection.subscribe(0, (event) => replayed.push(event.id))
    expect(replayed).toEqual([2, 3])
  })

  test('continues event ids after an OpenCode ACP process restart', async () => {
    const harness = createHarness({ initialEventId: 41 })
    respond(harness, {
      method: 'session/update',
      params: { sessionId: 'session', update: { sessionUpdate: 'agent_message_chunk' } },
    })
    await nextTick()

    const replayed: number[] = []
    harness.connection.subscribe(40, (event) => replayed.push(event.id))

    expect(replayed).toEqual([41])
    expect(harness.connection.lastEventId).toBe(41)
  })

  test('publishes daemon runtime notifications to reconnecting clients', () => {
    const harness = createHarness({ initialEventId: 41 })

    harness.connection.notifyClient('kortix/runtime_ready', {
      sessionId: 'session',
    })

    const replayed: AcpStreamEvent[] = []
    harness.connection.subscribe(40, (event) => replayed.push(event))
    expect(replayed).toEqual([
      {
        id: 41,
        envelope: {
          jsonrpc: '2.0',
          method: 'kortix/runtime_ready',
          params: { sessionId: 'session' },
        },
      },
    ])
  })

  test('rejects a request after the configured timeout', async () => {
    const harness = createHarness({ requestTimeoutMs: 10 })
    await expect(
      harness.connection.request('session/load', { sessionId: 'missing' }, 'timeout'),
    ).rejects.toBeInstanceOf(AcpProtocolError)
  })

  test('rejects pending requests and closes subscribers when the stream ends', async () => {
    const harness = createHarness()
    let closed = 0
    harness.connection.subscribe(0, () => {}, () => closed++)
    const pending = harness.connection.request(
      'session/load',
      { sessionId: 'a' },
      'close',
    )
    harness.output.end()

    await expect(pending).rejects.toThrow('ACP output closed')
    expect(closed).toBe(1)
  })

  test('does not emit response envelopes as stream notifications', async () => {
    const harness = createHarness()
    const events: unknown[] = []
    harness.connection.subscribe(0, (event) => events.push(event))
    const request = harness.connection.request('session/load', {}, 'response')
    respond(harness, { id: 'response', result: {} })
    await request
    expect(events).toEqual([])
  })

  test('publishes a daemon-owned client request and intercepts its browser response', async () => {
    const harness = createHarness()
    const events: JsonRpcEnvelope[] = []
    const handled: JsonRpcEnvelope[] = []
    harness.connection.subscribe(0, (event) => events.push(event.envelope))

    harness.connection.requestClient(
      'session/request_input',
      {
        sessionId: 'session',
        questions: [{ question: 'Choose one', options: [] }],
      },
      'kortix:question:q1',
      async (response) => {
        handled.push(response)
      },
    )

    expect(events).toEqual([
      {
        jsonrpc: '2.0',
        id: 'kortix:question:q1',
        method: 'session/request_input',
        params: {
          sessionId: 'session',
          questions: [{ question: 'Choose one', options: [] }],
        },
      },
    ])

    await harness.connection.post({
      jsonrpc: '2.0',
      id: 'kortix:question:q1',
      result: { action: 'accept', content: { answers: [['Beta']] } },
    })

    expect(handled).toEqual([
      {
        jsonrpc: '2.0',
        id: 'kortix:question:q1',
        result: { action: 'accept', content: { answers: [['Beta']] } },
      },
    ])
    expect(harness.writes).toEqual([])
  })

  test('reissues a pending client request to a fresh subscriber at the event tail', () => {
    const harness = createHarness()
    const request = {
      jsonrpc: '2.0' as const,
      id: 'kortix:question:q1',
      method: 'session/request_input',
      params: {
        sessionId: 'session',
        questions: [{ question: 'Choose one', options: ['Alpha', 'Beta'] }],
      },
    }

    harness.connection.requestClient(
      request.method,
      request.params,
      request.id,
      async () => {},
      { timeoutMs: null },
    )
    const tail = harness.connection.lastEventId
    const events: AcpStreamEvent[] = []

    harness.connection.subscribe(tail, (event) => events.push(event))

    expect(events).toEqual([
      {
        id: tail + 1,
        envelope: request,
      },
    ])
    expect(harness.connection.lastEventId).toBe(tail + 1)
  })

  test('keeps an explicit no-timeout client request pending until the browser responds', async () => {
    const harness = createHarness({ requestTimeoutMs: 10 })
    const handled: JsonRpcEnvelope[] = []

    harness.connection.requestClient(
      'session/request_input',
      { sessionId: 'session', questions: [] },
      'kortix:question:slow',
      async (response) => {
        handled.push(response)
      },
      { timeoutMs: null },
    )

    await new Promise((resolve) => setTimeout(resolve, 25))
    await harness.connection.post({
      jsonrpc: '2.0',
      id: 'kortix:question:slow',
      result: { action: 'accept', content: { answers: [['Beta']] } },
    })

    expect(handled).toEqual([
      {
        jsonrpc: '2.0',
        id: 'kortix:question:slow',
        result: { action: 'accept', content: { answers: [['Beta']] } },
      },
    ])
    expect(harness.diagnostics).toEqual([])
  })

  test('accepts only the first response when two subscribers answer one client request', async () => {
    const harness = createHarness()
    const handled: JsonRpcEnvelope[] = []
    const requestId = 'kortix:question:race'

    harness.connection.requestClient(
      'session/request_input',
      { sessionId: 'session', questions: [] },
      requestId,
      async (response) => {
        handled.push(response)
      },
      { timeoutMs: null },
    )
    harness.connection.subscribe(harness.connection.lastEventId, () => {})
    harness.connection.subscribe(harness.connection.lastEventId, () => {})

    const response: JsonRpcEnvelope = {
      jsonrpc: '2.0',
      id: requestId,
      result: { action: 'accept', content: { answers: [['Beta']] } },
    }
    await Promise.all([
      harness.connection.post(response),
      harness.connection.post(response),
    ])
    await nextTick()

    expect(handled).toEqual([response])
    expect(harness.writes).toEqual([])
  })

  test('forwards browser requests immediately and publishes their responses', async () => {
    const harness = createHarness()
    const events: unknown[] = []
    harness.connection.subscribe(0, (event) => events.push(event.envelope))
    const posted = harness.connection.post({
      jsonrpc: '2.0',
      id: 'error',
      method: 'session/load',
      params: { sessionId: 'missing' },
    })
    await expect(posted).resolves.toBeUndefined()
    respond(harness, {
      id: 'error',
      error: { code: -32000, message: 'session not found' },
    })
    await nextTick()

    expect(events).toEqual([
      {
        jsonrpc: '2.0',
        id: 'error',
        error: { code: -32000, message: 'session not found' },
      },
    ])
  })

  test('redacts credential values from diagnostics', () => {
    expect(
      redactAcpDiagnostic('failed token-secret-123', {
        KORTIX_TOKEN: 'token-secret-123',
        HOME: '/workspace',
      }),
    ).toBe('failed [REDACTED]')
  })
})
