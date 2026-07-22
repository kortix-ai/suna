import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'

import type { AcpHarnessId, AcpHarnessRegistry } from '../acp/harness-registry'
import { AcpRuntime } from '../acp/runtime'
import type { Config } from '../config'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { buildAcpApp } from '../proxy'

// Companion to acp-hollow-prompt-completion.test.ts. The hollow guard only
// catches a turn with ZERO usage; it cannot see the codex-specific blind spot
// where the Codex/ChatGPT backend rejects a request (e.g. an unsupported
// model) and codex-acp streams that raw `{"detail":"…"}` body as an
// agent_message_chunk + a normal end_turn WITH real usage — a "successful"
// turn whose content is actually an error. The bridge now assembles the
// codex turn's message text and, when the WHOLE turn is an error envelope,
// rewrites the response into a real JSON-RPC error (same AcpRpcError rail the
// hollow guard uses). This proves it fires for codex, does NOT fire for a real
// JSON answer, and is codex-only (an identical body on another harness rides
// through untouched).

const TOKEN = 'acp-codex-error-content-test-token'

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

describe('ACP codex error-as-content completion', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function harness(agent: AcpHarnessId) {
    const cwd = join(import.meta.dir, 'fixtures')
    const fixture = join(cwd, 'mock-acp-hollow-agent.ts')
    const registry: AcpHarnessRegistry = new Map([
      [agent, {
        id: agent,
        displayName: `Mock ${agent}`,
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
      const res = await fetch(`${base}/acp/${id}?agent=${agent}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    }

    async function prompt(id: string, text: string) {
      await rpc(id, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
      await rpc(id, { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/workspace', mcpServers: [] } })
      return rpc(id, {
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: { sessionId: 'mock-session', prompt: [{ type: 'text', text }] },
      })
    }

    return { prompt }
  }

  it('rewrites a codex turn whose entire message was an upstream error envelope into a JSON-RPC error', async () => {
    const { prompt } = await harness('codex')
    const { status, body } = await prompt('sess-err', 'error-detail')

    expect(status).toBe(200)
    expect(body.result).toBeUndefined()
    expect(body.error).toBeDefined()
    const error = body.error as { code: number; message: string; data?: unknown }
    expect(error.code).toBe(-32002)
    expect(error.message).toContain('not supported when using Codex with a ChatGPT account')
    expect((error.data as { kortix?: { reason?: string } } | undefined)?.kortix?.reason).toBe('upstream_error_content')
  }, 15_000)

  it('does NOT rewrite a real JSON answer with domain keys (no false positive)', async () => {
    const { prompt } = await harness('codex')
    const { status, body } = await prompt('sess-json', 'json-answer')

    expect(status).toBe(200)
    expect(body.error).toBeUndefined()
    const result = body.result as { stopReason?: string; usage?: { totalTokens?: number } }
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage?.totalTokens).toBeGreaterThan(0)
  }, 15_000)

  it('is codex-only: an identical error envelope on another harness rides through untouched', async () => {
    const { prompt } = await harness('opencode')
    const { status, body } = await prompt('sess-oc', 'error-detail')

    expect(status).toBe(200)
    expect(body.error).toBeUndefined()
    const result = body.result as { stopReason?: string }
    expect(result.stopReason).toBe('end_turn')
  }, 15_000)
})
