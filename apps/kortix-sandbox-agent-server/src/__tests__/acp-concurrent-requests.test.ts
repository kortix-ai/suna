import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'

import type { AcpHarnessRegistry } from '../acp/harness-registry'
import { AcpRuntime } from '../acp/runtime'
import type { Config } from '../config'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { buildAcpApp } from '../proxy'

// Gate 7 (WS3-P4-a): "a long session/prompt does NOT block answering a
// permission request (write-queue serializes stdin writes, not request
// lifetimes)". acp-http.e2e.test.ts already demonstrates this shape at the
// protocol level (a permission response resolves with 202 while a
// session/prompt is still in flight). This file adds a direct, timing-based
// proof against the real bridge + a real child process: a slow in-flight
// request must not delay a concurrently issued fast request's resolution.

const TOKEN = 'acp-concurrent-requests-test-token'

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

describe('ACP concurrent request handling', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  it('a slow in-flight request does not block a concurrently issued fast one from resolving first', async () => {
    const cwd = join(import.meta.dir, 'fixtures')
    const fixture = join(cwd, 'mock-acp-concurrent-agent.ts')
    const registry: AcpHarnessRegistry = new Map([
      ['codex', {
        id: 'codex',
        displayName: 'Mock Codex',
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
    const post = (body: Record<string, unknown>) => fetch(`${base}/acp/concurrent-1?agent=codex`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    // Establish the harness so both subsequent calls reuse the same
    // AcpProcess and its single stdin write queue.
    const initialize = await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    expect(initialize.status).toBe(200)

    const order: string[] = []
    const slow = post({ jsonrpc: '2.0', id: 'slow-1', method: 'slow', params: {} }).then((res) => {
      order.push('slow')
      return res
    })
    // Issued immediately after `slow`, while it is still pending on the
    // agent side (its 300ms setTimeout hasn't fired). If the bridge blocked
    // request *lifetimes* on the write queue instead of just serializing the
    // writes, `fast` could not resolve until `slow` did.
    const fast = post({ jsonrpc: '2.0', id: 'fast-1', method: 'fast', params: {} }).then((res) => {
      order.push('fast')
      return res
    })

    const [slowRes, fastRes] = await Promise.all([slow, fast])
    expect(fastRes.status).toBe(200)
    expect(await fastRes.json()).toMatchObject({ id: 'fast-1', result: { kind: 'fast' } })
    expect(slowRes.status).toBe(200)
    expect(await slowRes.json()).toMatchObject({ id: 'slow-1', result: { kind: 'slow' } })

    // The load-bearing assertion: fast resolved before slow, proving the
    // write queue did not serialize on response lifetimes.
    expect(order).toEqual(['fast', 'slow'])
  }, 15_000)
})
