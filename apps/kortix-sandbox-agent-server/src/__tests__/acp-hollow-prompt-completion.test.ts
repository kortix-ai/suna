import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'

import type { AcpHarnessRegistry } from '../acp/harness-registry'
import { AcpRuntime } from '../acp/runtime'
import type { Config } from '../config'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { buildAcpApp } from '../proxy'

// Regression test for the silent-failure bug live-diagnosed on
// acp-harness-runtime-v2: OpenCode 1.17.11's built-in Anthropic provider
// still sends the legacy `thinking.type=enabled` request shape, which
// Anthropic's API now rejects (400) for its newest models (claude-sonnet-5,
// claude-opus-4-8) — "Use thinking.type.adaptive and output_config.effort
// instead" (proven live against api.anthropic.com with a real BYOK key: the
// key, model id, and network path were ALL independently verified working;
// only the request SHAPE opencode emits is stale). OpenCode's ACP layer
// swallows that upstream rejection and answers `session/prompt` with a bare
// `{stopReason: 'end_turn', usage: {0,0,0}}` — a technically-valid ACP
// result that looks exactly like "the agent chose to say nothing". The
// standing fail-fast mandate on this branch is that a failed turn must
// NEVER look like silence, so `AcpProcess` now detects this specific
// pattern (real prompt content in, end_turn out, zero usage) and rewrites
// the response into a genuine JSON-RPC error — reusing the SDK's EXISTING
// `AcpRpcError` path (client.ts's `request()` already throws on any
// `envelope.error`; `AcpSession.send()` already catches that and patches
// `snapshot.error`) so the failure surfaces without any composer change.

const TOKEN = 'acp-hollow-prompt-test-token'

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

describe('ACP hollow session/prompt completion', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function harness() {
    const cwd = join(import.meta.dir, 'fixtures')
    const fixture = join(cwd, 'mock-acp-hollow-agent.ts')
    const registry: AcpHarnessRegistry = new Map([
      ['opencode', {
        id: 'opencode',
        displayName: 'Mock OpenCode',
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

    async function rpc(id: string, body: Record<string, unknown>) {
      const res = await fetch(`${base}/acp/${id}?agent=opencode`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    }

    return { rpc }
  }

  it('rewrites a hollow end_turn (real prompt in, zero usage out) into a JSON-RPC error instead of a silent success', async () => {
    const { rpc } = await harness()
    await rpc('sess-1', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    await rpc('sess-1', { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/workspace', mcpServers: [] } })

    const { status, body } = await rpc('sess-1', {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: 'mock-session', prompt: [{ type: 'text', text: 'hollow' }] },
    })

    // The daemon's ACP router always answers HTTP 200 — JSON-RPC errors are
    // transport-agnostic — but the BODY must carry a real `error`, not a
    // `result` that reads as a normal completion.
    expect(status).toBe(200)
    expect(body.result).toBeUndefined()
    expect(body.error).toBeDefined()
    const error = body.error as { code: number; message: string; data?: unknown }
    expect(error.code).toBe(-32001)
    expect(error.message).toContain('zero tokens')
    expect((error.data as { kortix?: { reason?: string } } | undefined)?.kortix?.reason).toBe('hollow_prompt_completion')
  }, 15_000)

  it('does NOT rewrite a legitimate cancellation (zero usage is expected there)', async () => {
    const { rpc } = await harness()
    await rpc('sess-2', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    await rpc('sess-2', { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/workspace', mcpServers: [] } })

    const { status, body } = await rpc('sess-2', {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: 'mock-session', prompt: [{ type: 'text', text: 'cancelled' }] },
    })

    expect(status).toBe(200)
    expect(body.error).toBeUndefined()
    expect((body.result as { stopReason?: string } | undefined)?.stopReason).toBe('cancelled')
  }, 15_000)

  it('does NOT rewrite a healthy completion with real usage (no regression on the happy path)', async () => {
    const { rpc } = await harness()
    await rpc('sess-3', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    await rpc('sess-3', { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/workspace', mcpServers: [] } })

    const { status, body } = await rpc('sess-3', {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: 'mock-session', prompt: [{ type: 'text', text: 'say banana' }] },
    })

    expect(status).toBe(200)
    expect(body.error).toBeUndefined()
    const result = body.result as { stopReason?: string; usage?: { totalTokens?: number } }
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage?.totalTokens).toBeGreaterThan(0)
  }, 15_000)
})
