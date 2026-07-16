import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'

import type { AcpHarnessRegistry } from '../acp/harness-registry'
import { AcpRuntime } from '../acp/runtime'
import type { Config } from '../config'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { buildAcpApp } from '../proxy'

// Gate 6 (WS3-P4-a): DELETE /acp/:serverId must terminate the real OS child
// process, not merely drop the in-memory handle. acp-http.e2e.test.ts already
// proves the HTTP-visible contract (204, SSE stream closes, second DELETE is
// a 204 no-op, runtime.list() empties out) — this file closes the one gap it
// leaves open: an assertion that the underlying PID is actually gone.

const TOKEN = 'acp-process-lifecycle-test-token'

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

/** true if the OS still has a live process at `pid` (POSIX signal-0 probe). */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('ACP process lifecycle', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  it('DELETE actually kills the spawned child OS process (not just the in-memory handle), and is idempotent', async () => {
    const cwd = join(import.meta.dir, 'fixtures')
    const fixture = join(cwd, 'mock-acp-agent.ts')
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

    const initialize = await fetch(`${base}/acp/lifecycle-1?agent=codex`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }),
    })
    expect(initialize.status).toBe(200)

    const listed = await fetch(`${base}/acp`, { headers: auth })
    const { servers } = (await listed.json()) as { servers: Array<{ serverId: string; pid: number | null }> }
    const pid = servers.find((s) => s.serverId === 'lifecycle-1')?.pid
    expect(typeof pid).toBe('number')
    expect(pid).not.toBeNull()

    // The real spawned process must be alive before we delete it, or the
    // post-delete "gone" assertion below would be vacuously true.
    expect(pidIsAlive(pid as number)).toBe(true)

    const removed = await fetch(`${base}/acp/lifecycle-1`, { method: 'DELETE', headers: auth })
    expect(removed.status).toBe(204)

    // AcpRuntime.delete() awaits AcpProcess.stop(), which itself awaits the
    // child's 'exit' event (or force-SIGKILLs after 2s) before resolving. By
    // the time the HTTP 204 lands, the OS process must already be reaped.
    expect(pidIsAlive(pid as number)).toBe(false)

    const removedAgain = await fetch(`${base}/acp/lifecycle-1`, { method: 'DELETE', headers: auth })
    expect(removedAgain.status).toBe(204)
    expect(runtime.list()).toEqual([])
  }, 15_000)
})
