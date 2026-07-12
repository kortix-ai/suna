import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'

import type { AcpHarnessRegistry } from '../acp/harness-registry'
import { AcpRuntime } from '../acp/runtime'
import type { Config } from '../config'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { buildAcpApp } from '../proxy'

const TOKEN = 'acp-http-test-token'

function base64url(value: Buffer): string {
  return value.toString('base64url')
}

function signedContext(): string {
  const now = Math.floor(Date.now() / 1_000)
  const payload = base64url(Buffer.from(JSON.stringify({
    userId: 'user-1',
    sandboxId: 'sandbox-1',
    sandboxRole: 'owner',
    scopes: [],
    iat: now,
    exp: now + 60,
  })))
  const signature = base64url(createHmac('sha256', TOKEN).update(payload).digest())
  return `${payload}.${signature}`
}

function config(cwd: string): Config {
  return {
    servicePort: 8000,
    opencodeInternalPort: 4096,
    staticPort: 3211,
    workspace: cwd,
    projectTarget: cwd,
    defaultBranch: 'main',
    branchFetchAttempts: 1,
    branchFetchDelaySec: 0.01,
    defaultOpencodeConfigDir: '/tmp/opencode',
    autoClone: false,
    projectId: 'project-1',
    apiUrl: undefined,
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    baseSha: undefined,
    sandboxToken: TOKEN,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
  }
}

async function readSseEnvelope(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  predicate: (envelope: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE read timeout')), 5_000)),
    ])
    if (result.done) throw new Error('SSE stream ended')
    if (!result.value) continue
    buffer += decoder.decode(result.value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const data = frame.split('\n').find((line) => line.startsWith('data: '))
      if (!data) continue
      const envelope = JSON.parse(data.slice(6)) as Record<string, unknown>
      if (predicate(envelope)) return envelope
    }
  }
  throw new Error('matching SSE event did not arrive')
}

describe('ACP HTTP bridge', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  it('runs a real ACP process through signed HTTP, SSE, permission response, replay, and delete', async () => {
    const cwd = join(import.meta.dir, 'fixtures')
    const fixture = join(cwd, 'mock-acp-agent.ts')
    const registry: AcpHarnessRegistry = new Map([
      ['codex', {
        id: 'codex',
        displayName: 'Mock Codex',
        adapter: 'test',
        launch: { command: process.execPath, args: [fixture] },
      }],
      ['claude', {
        id: 'claude',
        displayName: 'Mock Claude',
        adapter: 'test',
        launch: { command: process.execPath, args: [fixture] },
      }],
    ])
    const runtime = new AcpRuntime({ registry, cwd })
    const app = buildAcpApp(
      config(cwd),
      Date.now(),
      { repoMaterializationError: null, timeline: [] },
      undefined,
      null,
      runtime,
    )
    const server = Bun.serve({ port: 0, idleTimeout: 30, fetch: app.fetch })
    cleanups.push(async () => {
      await runtime.shutdown()
      server.stop(true)
    })

    const base = `http://127.0.0.1:${server.port}`
    const auth = { [KORTIX_USER_CONTEXT_HEADER]: signedContext() }
    const post = (path: string, body: Record<string, unknown>) => fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const unauthorized = await fetch(`${base}/acp`)
    expect(unauthorized.status).toBe(401)

    const initialize = await post('/acp/session-1?agent=codex', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} },
    })
    expect(initialize.status).toBe(200)
    expect(await initialize.json()).toMatchObject({ id: 1, result: { protocolVersion: 1 } })

    const created = await fetch(`${base}/acp`, { headers: auth })
    expect(await created.json()).toMatchObject({
      servers: [{ serverId: 'session-1', harness: 'codex' }],
    })

    const events = await fetch(`${base}/acp/session-1`, {
      headers: { ...auth, Accept: 'text/event-stream' },
    })
    expect(events.status).toBe(200)
    if (!events.body) throw new Error('SSE response body missing')
    const reader = events.body.getReader()

    const promptPromise = post('/acp/session-1', {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 'mock-session', prompt: [{ type: 'text', text: 'work' }] },
    })
    const permission = await readSseEnvelope(reader, (envelope) => envelope.method === 'session/request_permission')
    expect(permission).toMatchObject({ id: 'permission-1', method: 'session/request_permission' })

    const permissionResponse = await post('/acp/session-1', {
      jsonrpc: '2.0',
      id: 'permission-1',
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    })
    expect(permissionResponse.status).toBe(202)

    const prompt = await promptPromise
    expect(prompt.status).toBe(200)
    expect(await prompt.json()).toMatchObject({ id: 2, result: { stopReason: 'end_turn' } })
    const update = await readSseEnvelope(reader, (envelope) => envelope.method === 'session/update')
    expect(update).toMatchObject({ method: 'session/update' })
    await reader.cancel()

    const replay = await fetch(`${base}/acp/session-1`, {
      headers: { ...auth, Accept: 'text/event-stream', 'Last-Event-ID': '1' },
    })
    if (!replay.body) throw new Error('replay SSE response body missing')
    const replayReader = replay.body.getReader()
    const replayedUpdate = await readSseEnvelope(replayReader, (envelope) => envelope.method === 'session/update')
    expect(replayedUpdate).toMatchObject({ method: 'session/update' })
    await replayReader.cancel()

    const conflict = await post('/acp/session-1?agent=claude', {
      jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd },
    })
    expect(conflict.status).toBe(409)

    const closingStream = await fetch(`${base}/acp/session-1`, {
      headers: { ...auth, Accept: 'text/event-stream', 'Last-Event-ID': '2' },
    })
    if (!closingStream.body) throw new Error('closing SSE response body missing')
    const closingReader = closingStream.body.getReader()
    await closingReader.read() // initial connected comment
    const removed = await fetch(`${base}/acp/session-1`, { method: 'DELETE', headers: auth })
    expect(removed.status).toBe(204)
    expect((await closingReader.read()).done).toBe(true)
    const removedAgain = await fetch(`${base}/acp/session-1`, { method: 'DELETE', headers: auth })
    expect(removedAgain.status).toBe(204)
    expect(runtime.list()).toEqual([])
  }, 15_000)
})
