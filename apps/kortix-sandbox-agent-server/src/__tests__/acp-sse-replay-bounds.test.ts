import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'

import type { AcpHarnessRegistry } from '../acp/harness-registry'
import { AcpRuntime } from '../acp/runtime'
import type { Config } from '../config'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { buildAcpApp } from '../proxy'

// Gate 5 (WS3-P4-a): "SSE reconnect with Last-Event-ID replays ONLY events
// after the id (bounded in-memory buffer semantics)". acp-http.e2e.test.ts
// already proves the "only after the id" half with a couple of events. This
// file proves the half it doesn't reach: the replay buffer is bounded
// (AcpProcess.MAX_REPLAY_EVENTS = 2,000 in src/acp/runtime.ts — evicting the
// oldest events once the cap is exceeded), driven against the real bridge
// and a real child process emitting more events than the cap holds.

const TOKEN = 'acp-sse-replay-bounds-test-token'
const BURST_COUNT = 2_010 // > MAX_REPLAY_EVENTS(2000), margin of 10

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

/** Reads an SSE body until `atLeast` `data:` frames with a numeric `id:` line
 * have been collected, or the deadline passes. Returns them in arrival order. */
async function collectSseEvents(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  atLeast: number,
  deadlineMs = 20_000,
): Promise<Array<{ id: number; envelope: Record<string, unknown> }>> {
  const decoder = new TextDecoder()
  let buffer = ''
  const events: Array<{ id: number; envelope: Record<string, unknown> }> = []
  const deadline = Date.now() + deadlineMs
  while (events.length < atLeast && Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE read timeout')), deadlineMs)),
    ])
    if (result.done) break
    if (!result.value) continue
    buffer += decoder.decode(result.value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const lines = frame.split('\n')
      const idLine = lines.find((line) => line.startsWith('id: '))
      const dataLine = lines.find((line) => line.startsWith('data: '))
      if (!idLine || !dataLine) continue
      events.push({ id: Number(idLine.slice(4)), envelope: JSON.parse(dataLine.slice(6)) })
    }
  }
  return events
}

describe('ACP SSE replay buffer bounds', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  it('caps the in-memory replay buffer and only replays events after Last-Event-ID within that window', async () => {
    const cwd = join(import.meta.dir, 'fixtures')
    const fixture = join(cwd, 'mock-acp-burst-agent.ts')
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
    const post = (body: Record<string, unknown>) => fetch(`${base}/acp/replay-bounds-1?agent=codex`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const initialize = await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    expect(initialize.status).toBe(200)

    // Awaiting this POST guarantees every notification line the burst wrote
    // has already been processed into (or evicted from) the replay buffer,
    // since the child only sends its response after every burst line.
    const burst = await post({ jsonrpc: '2.0', id: 'burst-1', method: 'burst', params: { count: BURST_COUNT } })
    expect(burst.status).toBe(200)
    expect(await burst.json()).toMatchObject({ id: 'burst-1', result: { emitted: BURST_COUNT } })

    // Fresh reconnect (Last-Event-ID: 0) should replay the full buffer window,
    // capped at MAX_REPLAY_EVENTS — proving the oldest events (ids 1..10) were
    // evicted, not retained forever.
    const fullReplay = await fetch(`${base}/acp/replay-bounds-1`, {
      headers: { ...auth, Accept: 'text/event-stream' },
    })
    if (!fullReplay.body) throw new Error('SSE response body missing')
    const fullReader = fullReplay.body.getReader()
    const fullEvents = await collectSseEvents(fullReader, 2_000)
    await fullReader.cancel()

    expect(fullEvents.length).toBe(2_000)
    expect(fullEvents[0]?.id).toBe(11) // ids 1..10 evicted by the 2,000-event cap
    expect(fullEvents[fullEvents.length - 1]?.id).toBe(2_010)
    for (const event of fullEvents) expect(event.envelope).toMatchObject({ method: 'session/update' })

    // Reconnect mid-window with Last-Event-ID inside the retained range: only
    // events strictly after it should replay.
    const midReplay = await fetch(`${base}/acp/replay-bounds-1`, {
      headers: { ...auth, Accept: 'text/event-stream', 'Last-Event-ID': '1500' },
    })
    if (!midReplay.body) throw new Error('SSE response body missing')
    const midReader = midReplay.body.getReader()
    const midEvents = await collectSseEvents(midReader, 510)
    await midReader.cancel()

    expect(midEvents.length).toBe(510) // ids 1501..2010
    expect(midEvents[0]?.id).toBe(1501)
    expect(midEvents.every((event) => event.id > 1500)).toBe(true)
    expect(midEvents[midEvents.length - 1]?.id).toBe(2_010)
  }, 30_000)
})
