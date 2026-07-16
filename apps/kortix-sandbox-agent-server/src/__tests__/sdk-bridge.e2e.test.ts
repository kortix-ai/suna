import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'

// DISC-06: this file exercises the PUBLISHED `@kortix/sdk` surface exactly as
// an external consumer would — `@kortix/sdk/acp`, never a relative
// `packages/sdk/src/...` import — driven against the REAL bridge
// (`buildAcpApp` + `Bun.serve`, the same in-process harness
// `acp-http.e2e.test.ts` uses) and a REAL spawned ACP agent process
// (`fixtures/mock-acp-agent.ts`). No env keys, no cloud API, no browser.
import { AcpClient, AcpSession, type AcpStreamEvent } from '@kortix/sdk/acp'

import type { AcpHarnessRegistry } from '../acp/harness-registry'
import { AcpRuntime } from '../acp/runtime'
import type { Config } from '../config'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { buildAcpApp } from '../proxy'

const TOKEN = 'sdk-bridge-e2e-token'

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

/**
 * The published `AcpClient`/`AcpSession` have no `headers`/auth-header option
 * — `AcpClientOptions.fetch` (read in `client.ts`) is the documented seam for
 * exactly this: a caller-supplied `typeof fetch` the client uses for every
 * request instead of its `authenticatedFetch` default. This is NOT an SDK
 * gap — it is the mechanism the SDK ships for a bridge whose auth is a
 * static signed header rather than a bearer token `getToken()` would fit.
 */
function createSignedFetch(): typeof fetch {
  const signed = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(init?.headers)
    headers.set(KORTIX_USER_CONTEXT_HEADER, signedContext())
    return fetch(input, { ...init, headers })
  }
  // `client.test.ts` in the SDK uses the same cast for the same reason:
  // Bun's global `fetch` type carries a `.preconnect` static that a plain
  // function value structurally lacks — irrelevant to the request path
  // `AcpClient`/`AcpSession` actually exercise.
  return signed as unknown as typeof fetch
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

/** Boots the real bridge (real Hono app, real `Bun.serve`, real
 *  `AcpRuntime`) wired to the real `mock-acp-agent.ts` stdio ACP process —
 *  identical harness shape to `acp-http.e2e.test.ts`. */
function startBridge(cleanups: Array<() => Promise<void> | void>): { base: string; runtime: AcpRuntime } {
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
  return { base: `http://127.0.0.1:${server.port}`, runtime }
}

/** Polls an in-memory event log for a matching `AcpStreamEvent` — the SDK's
 *  `connect()` delivers events via callback, not a readable stream the test
 *  can `await`, so this is the client-side equivalent of `acp-http.e2e.test`'s
 *  `readSseEnvelope` (which reads the raw SSE body directly). */
function waitForEvent(
  events: readonly AcpStreamEvent[],
  predicate: (event: AcpStreamEvent) => boolean,
  timeoutMs = 5_000,
): Promise<AcpStreamEvent> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      const found = events.find(predicate)
      if (found) return resolve(found)
      if (Date.now() > deadline) return reject(new Error('expected ACP stream event did not arrive in time'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

function isMethod(envelope: AcpStreamEvent['envelope'], method: string): boolean {
  return 'method' in envelope && envelope.method === method
}

async function getServerInfo(base: string, serverId: string): Promise<{ serverId: string; busy: boolean } | undefined> {
  const listed = await fetch(`${base}/acp`, { headers: { [KORTIX_USER_CONTEXT_HEADER]: signedContext() } })
  const { servers } = (await listed.json()) as { servers: Array<{ serverId: string; busy: boolean }> }
  return servers.find((s) => s.serverId === serverId)
}

describe('SDK <-> bridge e2e (DISC-06: published @kortix/sdk against the real daemon bridge)', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  it('scenario 1: AcpClient daemon-bridge mode (baseUrl + serverId + agent) authenticates via a custom fetch wrapper', async () => {
    const { base } = startBridge(cleanups)
    const serverId = 'sdk-e2e-construct'

    // Prove the HMAC gate is real and live on the exact route the SDK client
    // is about to use — an unauthenticated request is rejected.
    const unauthenticated = await fetch(`${base}/acp/${serverId}?agent=codex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
    })
    expect(unauthenticated.status).toBe(401)

    const client = new AcpClient({ baseUrl: base, serverId, agent: 'codex', fetch: createSignedFetch() })
    const initialized = await client.initialize({ protocolVersion: 1, clientCapabilities: {} })
    expect(initialized).toMatchObject({ protocolVersion: 1 })

    const info = await getServerInfo(base, serverId)
    expect(info).toMatchObject({ serverId })
  })

  it('scenario 2: initialize -> session/new -> prompt -> streamed session/update through the real SSE connect() path', async () => {
    const { base } = startBridge(cleanups)
    const serverId = 'sdk-e2e-flow'
    const client = new AcpClient({ baseUrl: base, serverId, agent: 'codex', fetch: createSignedFetch() })

    await client.initialize({ protocolVersion: 1, clientCapabilities: {} })
    const session = await client.newSession({ cwd: base })
    expect(session.sessionId).toBe('mock-session')

    const events: AcpStreamEvent[] = []
    const states: string[] = []
    const handle = client.connect({
      onEvent: (event) => events.push(event),
      onState: (state) => states.push(state),
    })
    cleanups.push(() => handle.close())

    const promptPromise = client.prompt('mock-session', [{ type: 'text', text: 'work' }])

    const permissionEvent = await waitForEvent(events, (e) => isMethod(e.envelope, 'session/request_permission'))
    expect(permissionEvent.envelope).toMatchObject({ id: 'permission-1', method: 'session/request_permission' })

    await client.respond('permission-1', { outcome: { outcome: 'selected', optionId: 'allow_once' } })

    const updateEvent = await waitForEvent(events, (e) => isMethod(e.envelope, 'session/update'))
    expect(updateEvent.envelope).toMatchObject({ method: 'session/update' })

    const result = await promptPromise
    expect(result).toMatchObject({ stopReason: 'end_turn' })
    expect(states).toContain('open')

    handle.close()
  })

  it('scenario 3: permission round-trip — client.respond() answers session/request_permission and the agent acknowledges receipt', async () => {
    const { base } = startBridge(cleanups)
    const serverId = 'sdk-e2e-permission'
    const client = new AcpClient({ baseUrl: base, serverId, agent: 'codex', fetch: createSignedFetch() })

    await client.initialize({ protocolVersion: 1, clientCapabilities: {} })
    await client.newSession({ cwd: base })

    const events: AcpStreamEvent[] = []
    const handle = client.connect({ onEvent: (event) => events.push(event) })
    cleanups.push(() => handle.close())

    const promptPromise = client.prompt('mock-session', [{ type: 'text', text: 'work' }])
    const permissionEvent = await waitForEvent(events, (e) => isMethod(e.envelope, 'session/request_permission'))
    expect(permissionEvent.envelope).toMatchObject({ id: 'permission-1' })

    await client.respond('permission-1', { outcome: { outcome: 'selected', optionId: 'allow_once' } })

    // `kortix/test_permission_ack` is a fixture-only notification
    // (`mock-acp-agent.ts`) the mock agent sends the instant it reads the
    // permission response off stdin — the only way to prove, from the
    // client side, that the answer actually reached the real child process
    // rather than merely that the HTTP POST returned 202.
    const ack = await waitForEvent(events, (e) => isMethod(e.envelope, 'kortix/test_permission_ack'))
    expect(ack.envelope).toMatchObject({
      method: 'kortix/test_permission_ack',
      params: { receivedOutcome: 'selected', receivedOptionId: 'allow_once' },
    })

    await promptPromise
    handle.close()
  })

  it('scenario 4: AcpSession over the bare bridge — documents a real integration gap (missing /transcript)', async () => {
    const { base } = startBridge(cleanups)
    const serverId = 'sdk-e2e-session-store'

    // AcpSession has no `agent` option (unlike AcpClient's baseUrl+serverId+
    // agent mode — see the finding in the DISC-06 report), so a brand-new
    // bridge server must be pre-created with a raw signed POST carrying
    // `?agent=` before AcpSession can even attach to it.
    const precreate = await fetch(`${base}/acp/${serverId}?agent=codex`, {
      method: 'POST',
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signedContext(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }),
    })
    expect(precreate.status).toBe(200)

    const session = new AcpSession({
      endpoint: `${base}/acp/${serverId}`,
      fetch: createSignedFetch(),
    })
    cleanups.push(() => session.close())

    session.connect()

    // `AcpSession.runBootstrap()` (session.ts) unconditionally calls
    // `client.transcript()` — a GET to `${endpoint}/transcript` — as its
    // FIRST step, before `initialize`. The bare sandbox daemon bridge
    // (routes/acp.ts) only ever registers GET/POST/DELETE on `/acp/:serverId`
    // — there is no `/transcript` route, and `AcpProcess` (runtime.ts) never
    // records `client_to_agent` envelopes, so the bridge has no data to serve
    // one from even if a route existed. That REST leg is implemented only by
    // the platform API's session-scoped ACP proxy in front of the bridge
    // (see `packages/sdk/src/acp/README.md`'s 3-identity model and
    // `apps/api/src/projects/lib/session-transcript.ts`), which persists
    // envelope history to a database the bare bridge does not have.
    //
    // So bootstrap 404s on its very first call, and — because 404 is a
    // terminal status (`isTerminalStatus` in client.ts) — settles into a
    // clean, well-defined failure rather than a hang: connection 'failed',
    // a terminal `kind: 'bootstrap'` error. This is the real, reproducible
    // behavior of the published SDK against the bare bridge today.
    await waitForSnapshot(session, (snapshot) => snapshot.connection === 'failed', 5_000)

    const snapshot = session.getSnapshot()
    expect(snapshot.ready).toBe(false)
    expect(snapshot.connection).toBe('failed')
    expect(snapshot.error).toMatchObject({ kind: 'bootstrap', terminal: true })
    expect(snapshot.error?.message).toContain('404')
  })

  it('scenario 5: reconnect — Last-Event-ID replay resumes without duplicating events', async () => {
    const { base } = startBridge(cleanups)
    const serverId = 'sdk-e2e-reconnect'
    const client = new AcpClient({ baseUrl: base, serverId, agent: 'codex', fetch: createSignedFetch() })

    await client.initialize({ protocolVersion: 1, clientCapabilities: {} })
    await client.newSession({ cwd: base })

    const firstConnectionEvents: AcpStreamEvent[] = []
    const firstHandle = client.connect({ onEvent: (event) => firstConnectionEvents.push(event) })

    const promptPromise = client.prompt('mock-session', [{ type: 'text', text: 'work' }])
    const permissionEvent = await waitForEvent(firstConnectionEvents, (e) => isMethod(e.envelope, 'session/request_permission'))

    // Kill the stream mid-session, before the permission response's
    // downstream events (ack + update) have been produced.
    firstHandle.close()
    const lastSeenId = permissionEvent.id

    await client.respond('permission-1', { outcome: { outcome: 'selected', optionId: 'allow_once' } })

    const secondConnectionEvents: AcpStreamEvent[] = []
    const secondHandle = client.connect({
      lastEventId: lastSeenId,
      onEvent: (event) => secondConnectionEvents.push(event),
    })
    cleanups.push(() => secondHandle.close())

    await waitForEvent(secondConnectionEvents, (e) => isMethod(e.envelope, 'kortix/test_permission_ack'))
    await waitForEvent(secondConnectionEvents, (e) => isMethod(e.envelope, 'session/update'))
    await promptPromise

    // The reconnect must never re-deliver the already-seen permission-request
    // event, and the two connections combined must never repeat an id.
    expect(secondConnectionEvents.some((e) => e.id === lastSeenId)).toBe(false)
    const allIds = [...firstConnectionEvents, ...secondConnectionEvents].map((e) => e.id)
    expect(new Set(allIds).size).toBe(allIds.length)

    secondHandle.close()
  })

  it('scenario 6: cancel — session/cancel mid-prompt clears the bridge\'s real busy flag', async () => {
    const { base } = startBridge(cleanups)
    const serverId = 'sdk-e2e-cancel'
    const client = new AcpClient({ baseUrl: base, serverId, agent: 'codex', fetch: createSignedFetch() })

    await client.initialize({ protocolVersion: 1, clientCapabilities: {} })
    await client.newSession({ cwd: base })

    const events: AcpStreamEvent[] = []
    const handle = client.connect({ onEvent: (event) => events.push(event) })
    cleanups.push(() => handle.close())

    const promptPromise = client.prompt('mock-session', [{ type: 'text', text: 'work' }])
    await waitForEvent(events, (e) => isMethod(e.envelope, 'session/request_permission'))

    // `AcpRuntime`/`AcpProcess.busy` (runtime.ts) is `true` exactly while a
    // JSON-RPC request id is in flight to the real child process — a real,
    // bridge-native "busy" signal, surfaced over `GET /acp`. The prompt is
    // still outstanding (never answered the permission request), so it must
    // read busy here.
    const beforeCancel = await getServerInfo(base, serverId)
    expect(beforeCancel?.busy).toBe(true)

    await client.cancel('mock-session')
    const result = await promptPromise
    expect(result).toMatchObject({ stopReason: 'cancelled' })

    const afterCancel = await getServerInfo(base, serverId)
    expect(afterCancel?.busy).toBe(false)

    handle.close()
  })
})

async function waitForSnapshot(
  session: AcpSession,
  predicate: (snapshot: ReturnType<AcpSession['getSnapshot']>) => boolean,
  timeoutMs: number,
): Promise<void> {
  if (predicate(session.getSnapshot())) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('expected AcpSession snapshot state did not arrive in time'))
    }, timeoutMs)
    const unsubscribe = session.subscribe(() => {
      if (!predicate(session.getSnapshot())) return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}
