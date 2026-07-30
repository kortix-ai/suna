import { afterEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { join } from 'node:path'

import type { AcpHarnessRegistry } from '../acp/harness-registry'
import { AcpRuntime } from '../acp/runtime'
import type { Config } from '../config'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { createAcpRouter } from './acp'

const TOKEN = 'test-kortix-token-32-chars-1234567890'

function config(): Config {
  return {
    servicePort: 8000,
    opencodeInternalPort: 4096,
    staticPort: 3211,
    workspace: '/workspace',
    projectTarget: '/workspace',
    defaultBranch: 'main',
    branchFetchAttempts: 60,
    branchFetchDelaySec: 0.25,
    defaultOpencodeConfigDir: '/ephemeral/opencode',
    autoClone: false,
    projectId: 'project',
    apiUrl: undefined,
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    baseSha: undefined,
    sandboxToken: TOKEN,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
    cloneDepth: 1,
  }
}

function base64url(value: Buffer): string {
  return value.toString('base64url')
}

function signedContext(): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = base64url(
    Buffer.from(
      JSON.stringify({
        userId: 'user',
        sandboxId: 'sandbox',
        sandboxRole: 'owner',
        scopes: [],
        iat: now,
        exp: now + 60,
      }),
    ),
  )
  const signature = base64url(
    createHmac('sha256', TOKEN).update(payload).digest(),
  )
  return `${payload}.${signature}`
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function createSseReader(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('SSE response has no body')
  const decoder = new TextDecoder()
  let buffered = ''

  return {
    async next(
      predicate: (envelope: Record<string, unknown>) => boolean,
    ): Promise<{ id: number; envelope: Record<string, unknown> }> {
      for (;;) {
        const frameEnd = buffered.indexOf('\n\n')
        if (frameEnd >= 0) {
          const frame = buffered.slice(0, frameEnd)
          buffered = buffered.slice(frameEnd + 2)
          const idLine = frame
            .split('\n')
            .find((line) => line.startsWith('id: '))
          const dataLine = frame
            .split('\n')
            .find((line) => line.startsWith('data: '))
          if (idLine && dataLine) {
            const envelope = JSON.parse(
              dataLine.slice('data: '.length),
            ) as Record<string, unknown>
            if (predicate(envelope)) {
              return {
                id: Number(idLine.slice('id: '.length)),
                envelope,
              }
            }
          }
          continue
        }

        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error('timed out waiting for SSE event')),
              2_000,
            ).unref()
          }),
        ])
        if (result.done) {
          throw new Error('SSE stream closed before the expected event')
        }
        buffered += decoder.decode(result.value, { stream: true })
      }
    },
    cancel: () => reader.cancel(),
  }
}

describe('multi-harness ACP HTTP bridge', () => {
  const runtimes: AcpRuntime[] = []

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()))
  })

  function createRuntime(): AcpRuntime {
    const fixture = join(
      import.meta.dir,
      '../acp/fixtures/mock-acp-agent.ts',
    )
    const registry: AcpHarnessRegistry = new Map([
      [
        'codex',
        {
          id: 'codex',
          displayName: 'Mock Codex',
          adapter: 'test',
          launch: { command: process.execPath, args: [fixture] },
        },
      ],
      [
        'claude',
        {
          id: 'claude',
          displayName: 'Mock Claude Code',
          adapter: 'test',
          launch: { command: process.execPath, args: [fixture] },
        },
      ],
    ])
    const runtime = new AcpRuntime({
      registry,
      cwd: import.meta.dir,
    })
    runtimes.push(runtime)
    return runtime
  }

  function request(
    app: ReturnType<typeof createAcpRouter>,
    path: string,
    init: RequestInit = {},
  ) {
    const headers = new Headers(init.headers)
    headers.set(KORTIX_USER_CONTEXT_HEADER, signedContext())
    return app.request(`http://localhost${path}`, { ...init, headers })
  }

  test('creates, lists, reuses, conflicts, and deletes a harness process', async () => {
    const runtime = createRuntime()
    const app = createAcpRouter(
      config(),
      () => null,
      () => 'opencode-session',
      undefined,
      runtime,
    )

    const missingAgent = await request(app, '/server-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} },
      }),
    })
    expect(missingAgent.status).toBe(400)

    const initialized = await request(app, '/server-1?agent=codex', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} },
      }),
    })
    expect(initialized.status).toBe(200)
    expect(
      initialized.headers.get('x-kortix-acp-runtime-instance'),
    ).toMatch(/^[0-9a-f-]{36}$/)
    expect(await initialized.json()).toMatchObject({
      id: 1,
      result: { protocolVersion: 1 },
    })

    const listed = await request(app, '/')
    expect(await listed.json()).toMatchObject({
      servers: [{ serverId: 'server-1', harness: 'codex' }],
    })

    const pid = runtime.list()[0]?.pid
    expect(typeof pid).toBe('number')
    expect(pidIsAlive(pid as number)).toBe(true)

    const conflict = await request(app, '/server-1?agent=claude', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: '/workspace', mcpServers: [] },
      }),
    })
    expect(conflict.status).toBe(409)

    const removed = await request(app, '/server-1', { method: 'DELETE' })
    expect(removed.status).toBe(204)
    expect(runtime.list()).toEqual([])
    expect(pidIsAlive(pid as number)).toBe(false)
  })

  test('creates a managed harness from the first SSE GET', async () => {
    const runtime = createRuntime()
    const app = createAcpRouter(
      config(),
      () => null,
      () => 'opencode-session',
      undefined,
      runtime,
    )

    const stream = await request(app, '/server-get?agent=codex', {
      headers: {
        accept: 'text/event-stream',
        'last-event-id': '0',
      },
    })

    expect(stream.status).toBe(200)
    expect(runtime.list()).toMatchObject([
      { serverId: 'server-get', harness: 'codex' },
    ])
    await stream.body?.cancel()
  })

  test('carries an agent request and client response without blocking the prompt', async () => {
    const runtime = createRuntime()
    const app = createAcpRouter(
      config(),
      () => null,
      () => 'opencode-session',
      undefined,
      runtime,
    )

    const initialized = await request(app, '/server-2?agent=codex', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} },
      }),
    })
    expect(initialized.status).toBe(200)

    const stream = await request(app, '/server-2', {
      headers: {
        accept: 'text/event-stream',
        'last-event-id': '0',
      },
    })
    expect(stream.status).toBe(200)
    const events = createSseReader(stream)

    const prompt = request(app, '/server-2', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: {
          sessionId: 'mock-session',
          prompt: [{ type: 'text', text: 'request permission' }],
        },
      }),
    })

    const permission = await events.next(
      (envelope) =>
        envelope.method === 'session/request_permission',
    )
    expect(permission.envelope).toMatchObject({
      id: 'permission:2',
      method: 'session/request_permission',
    })

    const answered = await request(app, '/server-2', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'permission:2',
        result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
      }),
    })
    expect(answered.status).toBe(202)

    const completed = await prompt
    expect(completed.status).toBe(200)
    expect(await completed.json()).toMatchObject({
      id: 2,
      result: { stopReason: 'end_turn' },
    })

    const update = await events.next(
      (envelope) => envelope.method === 'session/update',
    )
    expect(update.envelope).toMatchObject({
      params: {
        update: {
          content: { text: 'permission response received' },
        },
      },
    })
    await events.cancel()

    const replay = await request(app, '/server-2', {
      headers: {
        accept: 'text/event-stream',
        'last-event-id': String(permission.id - 1),
      },
    })
    const replayedEvents = createSseReader(replay)
    const replayed = await replayedEvents.next(
      (envelope) =>
        envelope.method === 'session/request_permission',
    )
    expect(replayed.id).toBe(permission.id)
    await replayedEvents.cancel()
  })

  test('requires signed context for every runtime operation', async () => {
    const runtime = createRuntime()
    const app = createAcpRouter(
      config(),
      () => null,
      () => 'opencode-session',
      undefined,
      runtime,
    )

    const operations: Array<[string, RequestInit]> = [
      ['/', {}],
      [
        '/server-3?agent=codex',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {},
          }),
        },
      ],
      ['/server-3', { headers: { accept: 'text/event-stream' } }],
      ['/server-3', { method: 'DELETE' }],
    ]

    for (const [path, init] of operations) {
      const response = await app.request(
        `http://localhost${path}`,
        init,
      )
      expect(response.status).toBe(401)
    }
  })
})
