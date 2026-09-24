/**
 * The pi harness, black-box through the daemon's own HTTP surface.
 *
 * pi runs in faux mode: a scripted provider, no network, no credentials. What
 * is exercised is real — the agent loop, the bash tool against a temp
 * workspace, the OpenCode wire the SDK parses, the sequenced event stream and
 * the control-plane probes the API polls.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../config'
import { resetKortixEventBusForTests } from '../kortix-event-bus'
import { buildDaemonApp } from '../proxy'
import { requirePiConfig } from '../harness/pi/config'
import { createPiHarnessService, type PiHarnessService } from '../harness/pi/service'
import type { PiBootState } from '../harness/pi/boot-state'
import { extensionAgentHooks, installedPackages, parseNpmSource, systemPackageCacheDir, warmSystemPackageCache, type InlineExtension } from '../harness/pi/extensions/host'
import { ensureProjectPackageBundle } from '../harness/pi/extensions/bundle'

const TOKEN = 'pi-test-token'

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function userContext(secret: string): string {
  const now = Math.floor(Date.now() / 1000)
  const payloadB64 = base64url(Buffer.from(JSON.stringify({ userId: 'u1', sandboxId: 's1', sandboxRole: 'owner', scopes: [], iat: now, exp: now + 60 })))
  return `${payloadB64}.${base64url(createHmac('sha256', secret).update(payloadB64).digest())}`
}

interface Rig {
  app: ReturnType<typeof buildDaemonApp>
  service: PiHarnessService
  bootState: PiBootState
  workspace: string
  user: (path: string, init?: RequestInit) => Promise<Response>
  bearer: (path: string, init?: RequestInit) => Promise<Response>
}

let rig: Rig | null = null

async function boot(input: {
  script: unknown[]
  env?: Record<string, string>
  start?: boolean
  extensions?: InlineExtension[]
  /** Runs on the fresh workspace before the runtime starts. */
  prepare?: (workspace: string) => void
}): Promise<Rig> {
  const workspace = mkdtempSync(join(tmpdir(), 'pi-harness-'))
  input.prepare?.(workspace)
  const env: NodeJS.ProcessEnv = {
    KORTIX_HARNESS: 'pi',
    KORTIX_PI_MODEL_MODE: 'faux',
    KORTIX_PI_FAUX_SCRIPT: JSON.stringify(input.script),
    KORTIX_PI_STATE_DIR: join(workspace, '.state'),
    // Never the machine's ~/.pi or the image's /opt/kortix/pi-agent.
    KORTIX_PI_AGENT_DIR: join(workspace, '.pi-agent'),
    KORTIX_PI_PACKAGES_DIR: join(workspace, '.pi-packages'),
    KORTIX_PROJECT_AUTO_CLONE: '0',
    KORTIX_WORKSPACE: workspace,
    KORTIX_PROJECT_TARGET: workspace,
    KORTIX_TOKEN: TOKEN,
    KORTIX_SESSION_ID: 'sess-pi-test',
    KORTIX_PROJECT_ID: 'proj-pi-test',
    ...(input.env ?? {}),
  }
  const cfg = requirePiConfig(loadConfig(env))
  const service = createPiHarnessService(cfg, undefined, { env, ...(input.extensions ? { extensions: input.extensions } : {}) })
  const bootState: PiBootState = { repoMaterializationError: null, timeline: [], initialOpenCodeSessionRequired: false }
  if (input.start !== false) {
    await service.lifecycle.start()
    bootState.initialOpenCodeSessionId = service.runtime()!.rootId
  }
  const app = buildDaemonApp(cfg, service, Date.now(), bootState)
  const ctx = userContext(TOKEN)
  const request = (path: string, init: RequestInit = {}, headers: Record<string, string>) =>
    Promise.resolve(app.request(path, { ...init, headers: { ...headers, ...((init.headers as Record<string, string>) ?? {}) } }))
  const built: Rig = {
    app,
    service,
    bootState,
    workspace,
    user: (path, init) => request(path, init, { 'X-Kortix-User-Context': ctx }),
    bearer: (path, init) => request(path, init, { Authorization: `Bearer ${TOKEN}` }),
  }
  rig = built
  return built
}

async function readSse(response: Response, until: (text: string) => boolean, timeoutMs = 3_000): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !until(text)) {
    const next = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => ({ done: true, value: undefined }))])
    if (next.done) break
    text += decoder.decode(next.value)
  }
  await reader.cancel().catch(() => {})
  return text
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await Bun.sleep(10)
  }
}

beforeEach(() => resetKortixEventBusForTests())
afterEach(async () => {
  if (rig) {
    await rig.service.lifecycle.stop().catch(() => {})
    rmSync(rig.workspace, { recursive: true, force: true })
    rig = null
  }
})

describe('pi harness', () => {
  test('health reports the pi runtime before and after start', async () => {
    const r = await boot({ script: [{ text: 'hi' }], start: false })
    const before = (await r.bearer('/kortix/health').then((res) => res.json())) as Record<string, unknown>
    expect(before.harness).toBe('pi')
    expect(before.runtimeReady).toBe(false)
    expect(before.opencode).toBe('down')
    expect((await r.user('/session')).status).toBe(503)

    await r.service.lifecycle.start()
    r.bootState.initialOpenCodeSessionId = r.service.runtime()!.rootId
    const after = (await r.bearer('/kortix/health').then((res) => res.json())) as Record<string, unknown>
    expect(after.runtimeReady).toBe(true)
    expect(after.status).toBe('ok')
    expect(after.opencode).toBe('ok')
    expect(after.opencode_session_id).toMatch(/^ses_pi[0-9a-f]{24}$/)
    expect(after.model).toBe('faux/faux-1')
  })

  test('a failed pi start is a boot_error, not a silent down', async () => {
    // The web paints its session error card only from boot_error. runtime() is
    // null until start() resolves, so a failed start used to leave the box
    // "down" with boot_error null and the session spinning forever.
    const r = await boot({ script: [], env: { KORTIX_PI_MODEL_MODE: 'real' }, start: false })
    await expect(r.service.lifecycle.start()).rejects.toThrow('KORTIX_LLM_BASE_URL')
    const health = (await r.bearer('/kortix/health').then((res) => res.json())) as Record<string, unknown>
    expect(health.runtimeReady).toBe(false)
    expect(health.status).toBe('error')
    expect(health.boot_error).toBe('pi harness needs KORTIX_LLM_BASE_URL and KORTIX_TOKEN (the Kortix LLM gateway)')
  })

  test('a prompt runs the agent with a real bash tool and lands on the OpenCode wire', async () => {
    const r = await boot({
      script: [{ tool: 'bash', args: { command: 'printf hello-from-pi > note.txt && cat note.txt' } }, { text: 'Wrote the note.' }],
    })
    const root = r.service.runtime()!.rootId
    const sessions = (await r.user('/session').then((res) => res.json())) as Array<{ id: string; version: string }>
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.id).toBe(root)

    const messageID = 'msg_0198e2a4b0c1ABCDEFGHIJKLMN'
    const accepted = await r.user(`/session/${root}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID, parts: [{ type: 'text', text: 'write a note' }] }),
    })
    expect(accepted.status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy())
    expect(readFileSync(join(r.workspace, 'note.txt'), 'utf8')).toBe('hello-from-pi')

    const page = (await r.bearer(`/kortix/opencode/messages/${root}`).then((res) => res.json())) as {
      source: string
      messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
    }
    expect(page.source).toBe('pi')
    expect(page.messages.map((m) => m.info.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(page.messages[0]!.info.id).toBe(messageID)
    expect(page.messages[0]!.parts[0]).toMatchObject({ type: 'text', text: 'write a note' })
    const toolTurn = page.messages[1]!
    expect(toolTurn.info.parentID).toBe(messageID)
    expect(String(toolTurn.info.id)).toMatch(/^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/)
    expect(String(toolTurn.info.id) > messageID).toBe(true)
    const tool = toolTurn.parts.find((p) => p.type === 'tool')!
    expect(tool.tool).toBe('bash')
    expect(tool.state).toMatchObject({ status: 'completed', output: expect.stringContaining('hello-from-pi') })
    const reply = page.messages[2]!
    expect(reply.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'Wrote the note.' })
    expect((reply.info.time as { completed?: number }).completed).toBeGreaterThan(0)

    // The raw OpenCode list and single-message read the API uses to prove a landing.
    const raw = (await r.user(`/session/${root}/message`).then((res) => res.json())) as Array<{ info: { id: string } }>
    expect(raw.map((m) => m.info.id)).toEqual(page.messages.map((m) => String(m.info.id)))
    expect((await r.user(`/session/${root}/message/${messageID}`)).status).toBe(200)
    expect((await r.user(`/session/${root}/message/msg_000000000000zzzzzzzzzzzzzz`)).status).toBe(404)

    // The sequenced stream replays the whole turn, deltas included.
    const stream = await r.bearer(`/kortix/opencode/events?since=0`)
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    const text = await readSse(stream, (t) => t.includes('event: session.idle'))
    expect(text).toContain('event: kortix.hello')
    expect(text).toContain('event: message.updated')
    expect(text).toContain('event: message.part.delta')
    expect(text).toContain('event: session.idle')

    // The state document and the turn probes the control plane polls.
    const state = (await r.bearer('/kortix/opencode/state').then((res) => res.json())) as Record<string, any>
    expect(state.identity.opencode_session_id).toBe(root)
    expect(state.identity.harness).toBe('pi')
    expect(state.statuses.value[root]).toEqual({ type: 'idle' })
    expect(state.agents.value[0].name).toBe('build')
    const probe = (await r.bearer(`/kortix/health?turn=1&turn_message_id=${messageID}`).then((res) => res.json())) as Record<string, unknown>
    expect(probe.turn_in_flight).toBe(false)
    expect(probe.turn_end).toBe('completed')
    const observed = (await r.bearer(`/kortix/opencode/turn/${messageID}`).then((res) => res.json())) as Record<string, unknown>
    expect(observed.in_flight).toBe(false)
    expect(observed.end).toBe('completed')
    const unknown = (await r.bearer(`/kortix/opencode/turn/msg_000000000000zzzzzzzzzzzzzz`).then((res) => res.json())) as Record<string, unknown>
    expect(unknown.end).toBe('abandoned')

    // A repeated delivery of the same id is deduplicated, not re-run.
    const again = await r.user(`/session/${root}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID, parts: [{ type: 'text', text: 'write a note' }] }),
    })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ deduplicated: true })
  })

  test('every raw /event frame carries the id the SDK dedupes deltas on', async () => {
    const r = await boot({ script: [{ text: 'Streamed answer.' }] })
    const root = r.service.runtime()!.rootId
    const stream = await r.user('/event')
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    await r.user(`/session/${root}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID: 'msg_0198e2a4b0c1ABCDEFGHIJKLMN',
        parts: [{ type: 'text', text: 'say something' }],
      }),
    })
    const text = await readSse(stream, (t) => t.includes('"type":"session.idle"'))

    const frames = text
      .split('\n\n')
      .map((chunk) => chunk.replace(/^data: /, '').trim())
      .filter((chunk) => chunk.startsWith('{'))
      .map((chunk) => JSON.parse(chunk) as { id?: string; type: string })

    const deltas = frames.filter((f) => f.type === 'message.part.delta')
    expect(deltas.length).toBeGreaterThan(0)
    /*
      The SDK store keys `message.part.delta` idempotency on the envelope's
      `id` and says so: "a delta with no id gets no protection here". Without
      one, a redelivered delta APPENDS its text again and the reply renders
      twice inside the assistant message.
    */
    for (const delta of deltas) {
      expect(typeof delta.id).toBe('string')
      expect(delta.id!.length).toBeGreaterThan(0)
    }
    // Distinct events must not collide, or the guard drops real deltas.
    const ids = frames.filter((f) => f.id !== undefined).map((f) => f.id!)
    expect(new Set(ids).size).toBe(ids.length)
    // Epoch-prefixed, so a daemon restart cannot reissue an id already applied.
    expect(ids[0]).toMatch(/^b[a-z0-9]+:\d+$/)
  })

  test('the raw message list pages older windows and only omits the cursor at the head', async () => {
    const r = await boot({
      script: [{ tool: 'bash', args: { command: 'printf paged > note.txt' } }, { text: 'Done.' }],
    })
    const root = r.service.runtime()!.rootId
    const messageID = 'msg_0198e2a4b0c1ABCDEFGHIJKLMN'
    await r.user(`/session/${root}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID, parts: [{ type: 'text', text: 'write a note' }] }),
    })
    await waitFor(() => !r.service.runtime()!.busy())

    const all = (await r.user(`/session/${root}/message`).then((res) => res.json())) as Array<{ info: { id: string } }>
    expect(all).toHaveLength(3)
    const ids = all.map((m) => m.info.id)

    // Walk the whole history one message at a time, exactly as
    // `readTranscriptPages` does: follow `x-next-cursor` until it stops coming.
    const walk = async (param: 'before' | 'cursor') => {
      const seen: string[] = []
      let cursor: string | null = null
      for (let page = 0; page < 10; page++) {
        const query = `limit=1${cursor ? `&${param}=${encodeURIComponent(cursor)}` : ''}`
        const res = await r.user(`/session/${root}/message?${query}`)
        expect(res.status).toBe(200)
        const rows = (await res.json()) as Array<{ info: { id: string } }>
        seen.unshift(...rows.map((m) => m.info.id))
        cursor = res.headers.get('x-next-cursor')
        if (!cursor) return seen
      }
      throw new Error('cursor never terminated')
    }

    // The API's capture spells it `cursor`; the SDK's page loader spells it
    // `before`. Both must walk the same history.
    expect(await walk('before')).toEqual(ids)
    expect(await walk('cursor')).toEqual(ids)

    // A window that already reaches the first message must NOT advertise more:
    // an absent cursor is what every reader treats as "this walk is complete".
    const whole = await r.user(`/session/${root}/message?limit=99`)
    expect(whole.headers.get('x-next-cursor')).toBeNull()
    expect(((await whole.json()) as unknown[]).length).toBe(3)

    // A window that stops short MUST advertise the next one, naming its oldest
    // row — the exclusive upper bound the next request passes back.
    const newest = await r.user(`/session/${root}/message?limit=2`)
    expect(newest.headers.get('x-next-cursor')).toBe(ids[1]!)
  })

  test('the catalog reads the composer needs answer from the runtime', async () => {
    const r = await boot({ script: [{ text: 'ok' }], env: { KORTIX_AGENT_NAME: 'coder', KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { coder: { prompt: 'You code.', description: 'Writes code' } } }) } })
    const config = (await r.user('/config').then((res) => res.json())) as Record<string, unknown>
    expect(config.default_agent).toBe('coder')
    expect(config.model).toBe('faux/faux-1')
    const agents = (await r.user('/agent').then((res) => res.json())) as Array<Record<string, unknown>>
    expect(agents[0]).toMatchObject({ name: 'coder', description: 'Writes code', mode: 'primary', prompt: 'You code.' })
    const tools = (await r.user('/tool/ids').then((res) => res.json())) as string[]
    expect([...tools]).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'question', 'task'])
    const providers = (await r.user('/provider').then((res) => res.json())) as { all: Array<{ id: string }>; default: Record<string, string> }
    expect(providers.all[0]!.id).toBe('faux')
    expect(providers.default).toEqual({ faux: 'faux-1' })
    expect((await r.user('/session/status').then((res) => res.json()))).toEqual({})
    expect((await r.user('/lsp/diagnostics')).status).toBe(200)
    expect((await r.user('/no/such/route')).status).toBe(404)
  })

  test('a permission policy of ask pauses the tool until the product replies', async () => {
    const r = await boot({
      script: [{ tool: 'bash', args: { command: 'echo gated' } }, { text: 'done' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { build: { permission: { bash: 'ask' } } } }) },
    })
    const root = r.service.runtime()!.rootId
    expect((await r.user(`/session/${root}/prompt_async`, { method: 'POST', body: JSON.stringify({ parts: [{ type: 'text', text: 'go' }] }) })).status).toBe(204)
    await waitFor(() => r.service.runtime()!.permissions.list().length === 1)
    const pending = (await r.user('/permission').then((res) => res.json())) as Array<Record<string, unknown>>
    expect(pending[0]).toMatchObject({ permission: 'bash', sessionID: root })
    expect(pending[0]!.tool).toMatchObject({ messageID: expect.any(String), callID: expect.any(String) })
    const stateWhileAsked = (await r.bearer('/kortix/opencode/state').then((res) => res.json())) as Record<string, any>
    expect(stateWhileAsked.permissions.value).toHaveLength(1)

    const replied = await r.user(`/permission/${pending[0]!.id}/reply`, { method: 'POST', body: JSON.stringify({ reply: 'once' }) })
    expect(replied.status).toBe(200)
    await waitFor(() => !r.service.runtime()!.busy())
    const page = (await r.bearer(`/kortix/opencode/messages/${root}`).then((res) => res.json())) as { messages: Array<{ parts: Array<Record<string, unknown>> }> }
    const tool = page.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool')!
    expect(tool.state).toMatchObject({ status: 'completed', output: expect.stringContaining('gated') })
    const stream = await r.bearer('/kortix/opencode/events?since=0')
    const text = await readSse(stream, (t) => t.includes('event: permission.replied'))
    expect(text).toContain('event: permission.asked')
    expect(text).toContain('event: permission.replied')
  })

  test('a rejected permission blocks the tool and the turn still ends', async () => {
    const r = await boot({
      script: [{ tool: 'bash', args: { command: 'echo never' } }, { text: 'blocked, sorry' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { build: { permission: { '*': 'ask' } } } }) },
    })
    const root = r.service.runtime()!.rootId
    await r.bearer('/kortix/opencode/act', { method: 'POST', body: JSON.stringify({ kind: 'stop' }) })
    expect((await r.user(`/session/${root}/prompt_async`, { method: 'POST', body: JSON.stringify({ parts: [{ type: 'text', text: 'go' }] }) })).status).toBe(204)
    await waitFor(() => r.service.runtime()!.permissions.list().length === 1)
    const id = r.service.runtime()!.permissions.list()[0]!.id
    const act = await r.bearer('/kortix/opencode/act', { method: 'POST', body: JSON.stringify({ kind: 'permission', id, reply: 'reject' }) })
    expect(act.status).toBe(200)
    await waitFor(() => !r.service.runtime()!.busy())
    const page = (await r.bearer(`/kortix/opencode/messages/${root}`).then((res) => res.json())) as { messages: Array<{ parts: Array<Record<string, unknown>> }> }
    const tool = page.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool')!
    expect(tool.state).toMatchObject({ status: 'error' })
    expect(String((tool.state as { error: string }).error)).toContain('rejected')
  })

  test('a per-pattern deny blocks the command it names and lets the rest run', async () => {
    // `bash: { 'rm -rf *': 'deny', '*': 'allow' }` is a valid manifest rule.
    // Compiling it down to its `*` entry would run the denied command.
    const permission = { bash: { 'rm -rf *': 'deny', '*': 'allow' } }
    const denied = await boot({
      script: [{ tool: 'bash', args: { command: 'rm -rf /workspace' } }, { text: 'blocked' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { build: { permission } } }) },
    })
    const deniedRoot = denied.service.runtime()!.rootId
    expect((await denied.user(`/session/${deniedRoot}/prompt_async`, { method: 'POST', body: JSON.stringify({ parts: [{ type: 'text', text: 'go' }] }) })).status).toBe(204)
    await waitFor(() => !denied.service.runtime()!.busy())
    expect(denied.service.runtime()!.permissions.list()).toHaveLength(0)
    const deniedPage = (await denied.bearer(`/kortix/opencode/messages/${deniedRoot}`).then((res) => res.json())) as { messages: Array<{ parts: Array<Record<string, unknown>> }> }
    const deniedTool = deniedPage.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool')!
    expect(deniedTool.state).toMatchObject({ status: 'error' })
    expect(String((deniedTool.state as { error: string }).error)).toContain('denies')

    const allowed = await boot({
      script: [{ tool: 'bash', args: { command: 'echo fine' } }, { text: 'done' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { build: { permission } } }) },
    })
    const allowedRoot = allowed.service.runtime()!.rootId
    expect((await allowed.user(`/session/${allowedRoot}/prompt_async`, { method: 'POST', body: JSON.stringify({ parts: [{ type: 'text', text: 'go' }] }) })).status).toBe(204)
    await waitFor(() => !allowed.service.runtime()!.busy())
    const allowedPage = (await allowed.bearer(`/kortix/opencode/messages/${allowedRoot}`).then((res) => res.json())) as { messages: Array<{ parts: Array<Record<string, unknown>> }> }
    const allowedTool = allowedPage.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool')!
    expect(allowedTool.state).toMatchObject({ status: 'completed', output: expect.stringContaining('fine') })
  })

  test('abort stops a running tool and ends the turn as aborted', async () => {
    const r = await boot({ script: [{ tool: 'bash', args: { command: 'sleep 20' } }, { text: 'unreachable' }] })
    const root = r.service.runtime()!.rootId
    const messageID = 'msg_0198e2a4b0c2ABCDEFGHIJKLMN'
    expect((await r.user(`/session/${root}/prompt_async`, { method: 'POST', body: JSON.stringify({ messageID, parts: [{ type: 'text', text: 'wait' }] }) })).status).toBe(204)
    await waitFor(() => r.service.runtime()!.busy())
    await Bun.sleep(100)
    const probe = (await r.bearer(`/kortix/health?turn=1&turn_message_id=${messageID}`).then((res) => res.json())) as Record<string, unknown>
    expect(probe.turn_in_flight).toBe(true)
    const abort = await r.user(`/session/${root}/abort`, { method: 'POST' })
    expect(abort.status).toBe(200)
    await waitFor(() => !r.service.runtime()!.busy())
    const after = (await r.bearer(`/kortix/health?turn=1&turn_message_id=${messageID}`).then((res) => res.json())) as Record<string, unknown>
    expect(after.turn_in_flight).toBe(false)
    const state = (await r.bearer('/kortix/opencode/state').then((res) => res.json())) as Record<string, any>
    expect(state.statuses.value[root]).toEqual({ type: 'idle' })
  })

  test('an armed abort-after-tool lets the running tool finish, then ends the turn', async () => {
    const r = await boot({ script: [{ tool: 'bash', args: { command: 'sleep 0.6; echo tool-finished' } }, { text: 'unreachable' }] })
    const root = r.service.runtime()!.rootId
    const messageID = 'msg_0198e2a4b0c3ABCDEFGHIJKLMN'
    expect((await r.user(`/session/${root}/prompt_async`, { method: 'POST', body: JSON.stringify({ messageID, parts: [{ type: 'text', text: 'run it' }] }) })).status).toBe(204)
    await waitFor(() => r.service.runtime()!.busy())
    await Bun.sleep(150)
    const armed = await r.user('/kortix/abort/after-tool', {
      method: 'POST',
      body: JSON.stringify({ prompt_id: 'prm_queue_1', opencode_session_id: root, turn_message_id: messageID }),
    })
    expect(armed.status).toBe(202)
    // The tool is still running: arming must not kill it.
    expect(r.service.runtime()!.busy()).toBe(true)
    await waitFor(() => !r.service.runtime()!.busy())
    const messages = (await r.user(`/session/${root}/message`).then((res) => res.json())) as Array<{ info: any; parts: any[] }>
    const tool = messages.flatMap((m) => m.parts).find((p) => p.type === 'tool')
    expect(tool.state.status).toBe('completed')
    expect(String(tool.state.output)).toContain('tool-finished')
    const text = messages.flatMap((m) => m.parts).filter((p) => p.type === 'text').map((p) => p.text).join(' ')
    expect(text).not.toContain('unreachable')
  })

  test('an abort-after-tool armed for another turn is ignored, and disarm clears a pending one', async () => {
    const r = await boot({ script: [{ tool: 'bash', args: { command: 'sleep 0.5; echo ok' } }, { text: 'finished normally' }] })
    const root = r.service.runtime()!.rootId
    const messageID = 'msg_0198e2a4b0c4ABCDEFGHIJKLMN'
    expect((await r.user(`/session/${root}/prompt_async`, { method: 'POST', body: JSON.stringify({ messageID, parts: [{ type: 'text', text: 'run it' }] }) })).status).toBe(204)
    await waitFor(() => r.service.runtime()!.busy())
    await Bun.sleep(100)
    // Stale: names a different turn.
    const stale = await r.user('/kortix/abort/after-tool', {
      method: 'POST',
      body: JSON.stringify({ prompt_id: 'prm_stale', opencode_session_id: root, turn_message_id: 'msg_0198e2a4b0c5ABCDEFGHIJKLMN' }),
    })
    expect(stale.status).toBe(202)
    // Armed for this turn, then disarmed before the tool ends.
    await r.user('/kortix/abort/after-tool', {
      method: 'POST',
      body: JSON.stringify({ prompt_id: 'prm_live', opencode_session_id: root, turn_message_id: messageID }),
    })
    const disarmed = await r.user('/kortix/abort/after-tool', { method: 'DELETE', body: JSON.stringify({ prompt_id: 'prm_live' }) })
    expect(disarmed.status).toBe(200)
    await waitFor(() => !r.service.runtime()!.busy())
    const messages = (await r.user(`/session/${root}/message`).then((res) => res.json())) as Array<{ info: any; parts: any[] }>
    const text = messages.flatMap((m) => m.parts).filter((p) => p.type === 'text').map((p) => p.text).join(' ')
    expect(text).toContain('finished normally')
  })

  test('the transcript survives a runtime restart', async () => {
    const r = await boot({ script: [{ text: 'first answer' }] })
    const root = r.service.runtime()!.rootId
    expect((await r.user(`/session/${root}/prompt_async`, { method: 'POST', body: JSON.stringify({ parts: [{ type: 'text', text: 'remember me' }] }) })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy())
    await r.service.lifecycle.stop()
    await r.service.lifecycle.start()
    const page = (await r.bearer(`/kortix/opencode/messages/${root}`).then((res) => res.json())) as { messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> }
    expect(page.messages.map((m) => m.info.role)).toEqual(['user', 'assistant'])
    expect(page.messages[1]!.parts[0]).toMatchObject({ type: 'text', text: 'first answer' })
    const sessions = (await r.user('/session').then((res) => res.json())) as Array<{ title: string }>
    expect(sessions[0]!.title).toBe('remember me')
  })

  test('skills in the project are loaded into the system prompt', async () => {
    const r = await boot({ script: [{ text: 'ok' }], start: false })
    writeFileSync(join(r.workspace, '.kortix'), '', { flag: 'a' })
    rmSync(join(r.workspace, '.kortix'), { force: true })
    const skillDir = join(r.workspace, '.kortix', 'skills', 'deploy')
    require('node:fs').mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: deploy\ndescription: Ship to prod\n---\nRun the deploy script.\n')
    await r.service.lifecycle.start()
    const skills = (await r.user('/skill').then((res) => res.json())) as Array<{ name: string }>
    expect(skills.map((s) => s.name)).toEqual(['deploy'])
  })
})

type WirePage = { messages: Array<{ info: Record<string, any>; parts: Array<Record<string, any>> }> }

async function promptAndSettle(r: Rig, text: string): Promise<void> {
  const root = r.service.runtime()!.rootId
  const accepted = await r.user(`/session/${root}/prompt_async`, { method: 'POST', body: JSON.stringify({ parts: [{ type: 'text', text }] }) })
  expect(accepted.status).toBe(204)
  await waitFor(() => !r.service.runtime()!.busy())
}

function toolParts(page: WirePage, tool: string): Array<Record<string, any>> {
  return page.messages.flatMap((m) => m.parts.filter((p) => p.type === 'tool' && p.tool === tool))
}

/** An npm package as pi installs it: `<root>/node_modules/<name>` with a `pi` manifest. */
function fakePackage(npmRoot: string, name: string, version: string, source: string): void {
  const dir = join(npmRoot, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, keywords: ['pi-package'], pi: { extensions: ['./index.ts'] } }))
  writeFileSync(join(dir, 'index.ts'), source)
}

const DIGEST = 'a'.repeat(64)

type FakePrebuilt = { name: string; version: string; code?: string; fallback?: string; files?: Record<string, string>; pi?: object }

/** Write the pre-built layout (apps/api prebuild.ts) into `root`: manifest.json + packages/<name>/. */
function writePrebuilt(root: string, packages: FakePrebuilt[]): void {
  const manifest = {
    format: 'pi-packages-v2',
    packages: packages.map((p) =>
      p.fallback ? { name: p.name, version: p.version, fallback: p.fallback } : { name: p.name, version: p.version, dir: `packages/${p.name}`, extensions: [`packages/${p.name}/index.js.kortix.js`] },
    ),
  }
  for (const p of packages.filter((p) => !p.fallback)) {
    const dir = join(root, 'packages', p.name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: p.name, version: p.version, ...(p.pi ? { pi: p.pi } : {}) }))
    writeFileSync(join(dir, 'index.js.kortix.js'), p.code ?? '')
    for (const [rel, contents] of Object.entries(p.files ?? {})) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), contents)
    }
  }
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
}

/** A pre-built bundle as bundle.ts leaves it: `<dir>/<digest>`, marked complete. */
function fakePrebuilt(workspace: string, packages: FakePrebuilt[]): void {
  const root = join(workspace, '.pi-packages', DIGEST)
  writePrebuilt(root, packages)
  writeFileSync(join(root, '.complete'), DIGEST)
}

/** The installed fallback: `<dir>/<digest>.node_modules/node_modules`, marked complete. */
function fakeFallback(workspace: string, fill: (root: string) => void): void {
  const root = join(workspace, '.pi-packages', `${DIGEST}.node_modules`)
  fill(root)
  writeFileSync(join(root, '.complete'), DIGEST)
}

/** A pre-built extension as prebuild.ts emits it: plain ESM, pi's modules read from the host registry. */
function prebuiltTool(tool: string, prefix: string): string {
  return `const { Type } = globalThis.__kortixPiHost['typebox']
export default function (pi) {
  pi.registerTool({
    name: '${tool}',
    label: '${tool}',
    description: 'Echo the text back.',
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params) { return { content: [{ type: 'text', text: '${prefix}:' + params.text }], details: {} } },
  })
}
`
}

/** An extension source that registers one tool answering `<prefix>:<text>`. */
function echoTool(tool: string, prefix: string): string {
  return `export default function (pi) {
  pi.registerTool({
    name: '${tool}',
    label: '${tool}',
    description: 'Echo the text back.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async execute(_id, params) { return { content: [{ type: 'text', text: '${prefix}:' + params.text }], details: {} } },
  })
}
`
}

describe('pi extensions', () => {
  test('a tool_call handler blocks a tool and a tool_result handler patches another', async () => {
    let promptSeen = ''
    const guard: InlineExtension = {
      name: 'guard',
      factory(pi) {
        pi.on('tool_call', (event, ctx) => {
          promptSeen = ctx.getSystemPrompt()
          return event.toolName === 'write' ? { block: true, reason: 'writes are blocked by guard' } : undefined
        })
        pi.on('tool_result', (event) => (event.toolName === 'bash' ? { content: [{ type: 'text' as const, text: 'patched output' }] } : undefined))
        pi.on('before_agent_start', (event) => ({ systemPrompt: `${event.systemPrompt}\n\nGUARD ACTIVE` }))
      },
    }
    const r = await boot({
      script: [{ tool: 'write', args: { path: 'blocked.txt', content: 'x' } }, { tool: 'bash', args: { command: 'echo real' } }, { text: 'done' }],
      extensions: [guard],
    })
    await promptAndSettle(r, 'try')
    expect(existsSync(join(r.workspace, 'blocked.txt'))).toBe(false)
    const root = r.service.runtime()!.rootId
    const page = (await r.bearer(`/kortix/opencode/messages/${root}`).then((res) => res.json())) as WirePage
    expect(toolParts(page, 'write')[0]!.state.status).toBe('error')
    expect(String(toolParts(page, 'write')[0]!.state.error)).toContain('writes are blocked by guard')
    expect(toolParts(page, 'bash')[0]!.state.status).toBe('completed')
    expect(toolParts(page, 'bash')[0]!.state.output).toBe('patched output')
    expect(promptSeen).toContain('GUARD ACTIVE')
    expect(r.service.runtime()!.extensionStatus()).toEqual({ loaded: ['guard'], failed: [] })
  })

  test('the prompt system field reaches the model for its turn only, on top of extension edits', async () => {
    let seen: string[] = []
    const probe: InlineExtension = { name: 'probe', factory: (pi) => void pi.on('tool_call', (_event, ctx) => void seen.push(ctx.getSystemPrompt())) }
    const r = await boot({ script: [{ tool: 'bash', args: { command: 'true' } }, { text: 'a' }, { tool: 'bash', args: { command: 'true' } }, { text: 'b' }], extensions: [probe] })
    const root = r.service.runtime()!.rootId
    expect((await r.user(`/session/${root}/prompt_async`, { method: 'POST', body: JSON.stringify({ parts: [{ type: 'text', text: 'one' }], system: 'TURN RULE' }) })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy())
    await promptAndSettle(r, 'two')
    expect(seen).toHaveLength(2)
    expect(seen[0]).toContain('TURN RULE')
    expect(seen[1]).not.toContain('TURN RULE')
  })

  test('an extension that throws is reported and skipped; lifecycle events reach the others', async () => {
    const broken: InlineExtension = { name: 'broken', factory: () => { throw new Error('boom') } }
    const events: string[] = []
    const lifecycle: InlineExtension = {
      name: 'lifecycle',
      factory(pi) {
        pi.on('session_start', (event) => void events.push(`start:${event.reason}`))
        pi.on('session_shutdown', () => void events.push('shutdown'))
        pi.on('turn_end', () => void events.push('turn_end'))
      },
    }
    const r = await boot({ script: [{ text: 'ok' }], extensions: [broken, lifecycle] })
    const status = r.service.runtime()!.extensionStatus()
    expect(status.loaded).toEqual(['lifecycle'])
    expect(status.failed.map((f) => f.name)).toEqual(['broken'])
    expect(status.failed[0]!.error).toContain('boom')
    await promptAndSettle(r, 'hi')
    await r.service.lifecycle.stop()
    expect(events).toEqual(['start:startup', 'turn_end', 'shutdown'])
  })

  test('a context handler rewrites what the model receives', async () => {
    const counts: number[] = []
    const trim: InlineExtension = {
      name: 'trim',
      factory(pi) {
        pi.on('context', (event) => {
          counts.push(event.messages.length)
          return { messages: event.messages.slice(-1) }
        })
      },
    }
    const r = await boot({ script: [{ text: 'first' }, { text: 'second' }], extensions: [trim] })
    await promptAndSettle(r, 'one')
    await promptAndSettle(r, 'two')
    // Turn two sees user, assistant, user; the model gets only the last one.
    expect(counts).toEqual([1, 3])
  })

  test('the provider hooks route through the current runner, and pass through without one', async () => {
    const ref: { current?: any } = {}
    const hooks = extensionAgentHooks(ref)
    expect(await hooks.onPayload!({ model: 'm' }, {} as never)).toEqual({ model: 'm' })
    ref.current = { hasHandlers: (type: string) => type === 'before_provider_request', emitBeforeProviderRequest: async (p: object) => ({ ...p, temperature: 0 }) }
    expect(await hooks.onPayload!({ model: 'm' }, {} as never)).toEqual({ model: 'm', temperature: 0 })
  })
})

describe('pi packages', () => {
  test('npm sources parse with scopes and pins', () => {
    expect(parseNpmSource('npm:pi-web-access@0.30.0')).toEqual({ name: 'pi-web-access', version: '0.30.0' })
    expect(parseNpmSource('npm:@juicesharp/rpiv-todo@1.2.0')).toEqual({ name: '@juicesharp/rpiv-todo', version: '1.2.0' })
    expect(parseNpmSource('npm:@juicesharp/rpiv-todo')).toEqual({ name: '@juicesharp/rpiv-todo' })
    expect(parseNpmSource('./local.ts')).toBeNull()
  })

  test('only installed sources at the pinned version are kept; git is refused', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-npm-'))
    try {
      fakePackage(root, 'have', '1.0.0', 'export default () => {}')
      const { kept, failed } = installedPackages(
        ['npm:have@1.0.0', { source: 'npm:have', extensions: [] }, 'npm:have@2.0.0', 'npm:missing@1.0.0', 'git:github.com/a/b@v1', '/abs/local.ts'],
        root,
      )
      expect(kept).toEqual(['npm:have@1.0.0', { source: 'npm:have', extensions: [] }, '/abs/local.ts'])
      expect(failed).toEqual([
        { name: 'npm:have@2.0.0', error: 'installed version 1.0.0 does not match 2.0.0' },
        { name: 'npm:missing@1.0.0', error: 'package is not installed' },
        { name: 'git:github.com/a/b@v1', error: 'git packages are not supported; use an npm package' },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('system and project packages load from disk and their tools run; nothing is installed at boot', async () => {
    const r = await boot({
      script: [{ tool: 'system_echo', args: { text: 'hi' } }, { tool: 'project_echo', args: { text: 'yo' } }, { tool: 'local_echo', args: { text: 'l' } }, { text: 'done' }],
      env: {
        KORTIX_PI_PACKAGES: JSON.stringify(['npm:project-ext@2.0.0', 'npm:project-missing@1.0.0', './.kortix/pi/local.ts']),
        KORTIX_PI_PACKAGES_BUNDLE_DIGEST: DIGEST,
      },
      prepare(workspace) {
        const agentDir = join(workspace, '.pi-agent')
        mkdirSync(agentDir, { recursive: true })
        writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:system-ext@1.0.0', 'npm:system-missing@1.0.0'] }))
        fakePackage(join(agentDir, 'npm'), 'system-ext', '1.0.0', echoTool('system_echo', 'system'))
        fakePrebuilt(workspace, [
          {
            name: 'project-ext',
            version: '2.0.0',
            code: prebuiltTool('project_echo', 'project'),
            pi: { skills: ['./skills'] },
            files: { 'skills/package-skill/SKILL.md': '---\nname: package-skill\ndescription: Shipped by a package\n---\nDo it.\n' },
          },
        ])
        mkdirSync(join(workspace, '.kortix', 'pi'), { recursive: true })
        writeFileSync(join(workspace, '.kortix', 'pi', 'local.ts'), echoTool('local_echo', 'local'))
        mkdirSync(join(workspace, '.pi', 'extensions'), { recursive: true })
        writeFileSync(join(workspace, '.pi', 'extensions', 'repo.ts'), echoTool('repo_echo', 'repo'))
      },
    })
    const tools = (await r.user('/tool/ids').then((res) => res.json())) as string[]
    expect(tools).toEqual(expect.arrayContaining(['system_echo', 'project_echo', 'local_echo', 'repo_echo', 'task', 'bash']))
    const status = r.service.runtime()!.extensionStatus()
    expect(status.loaded).toEqual(expect.arrayContaining(['subagents', 'npm:system-ext@1.0.0', 'npm:project-ext@2.0.0']))
    // A pre-built package still brings its skills: pi reads them from its folder.
    expect(((await r.user('/skill').then((res) => res.json())) as Array<{ name: string }>).map((s) => s.name)).toContain('package-skill')
    expect(status.failed).toEqual([
      { name: 'npm:system-missing@1.0.0', error: 'package is not installed' },
      { name: 'npm:project-missing@1.0.0', error: 'package is not installed' },
    ])
    // The same report, where support reads it: the daemon's health.
    const health = (await r.bearer('/kortix/health').then((res) => res.json())) as { extensions: typeof status }
    expect(health.extensions).toEqual(status)
    await promptAndSettle(r, 'use them')
    const page = (await r.bearer(`/kortix/opencode/messages/${r.service.runtime()!.rootId}`).then((res) => res.json())) as WirePage
    expect(toolParts(page, 'system_echo')[0]!.state.output).toBe('system:hi')
    expect(toolParts(page, 'project_echo')[0]!.state.output).toBe('project:yo')
    expect(toolParts(page, 'local_echo')[0]!.state.output).toBe('local:l')
    expect(existsSync(join(r.workspace, '.pi-agent', 'npm', 'node_modules', 'system-missing'))).toBe(false)
    expect(existsSync(join(r.workspace, '.pi-packages', `${DIGEST}.node_modules`))).toBe(false)
  })

  test('a project package overrides the system package of the same name', async () => {
    const r = await boot({
      script: [{ tool: 'shared_echo', args: { text: 'x' } }, { text: 'done' }],
      env: { KORTIX_PI_PACKAGES: JSON.stringify(['npm:shared-ext@2.0.0']), KORTIX_PI_PACKAGES_BUNDLE_DIGEST: DIGEST },
      prepare(workspace) {
        const agentDir = join(workspace, '.pi-agent')
        mkdirSync(agentDir, { recursive: true })
        writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:shared-ext@1.0.0'] }))
        fakePackage(join(agentDir, 'npm'), 'shared-ext', '1.0.0', echoTool('shared_echo', 'system'))
        fakePrebuilt(workspace, [{ name: 'shared-ext', version: '2.0.0', code: prebuiltTool('shared_echo', 'project') }])
      },
    })
    await promptAndSettle(r, 'go')
    const page = (await r.bearer(`/kortix/opencode/messages/${r.service.runtime()!.rootId}`).then((res) => res.json())) as WirePage
    expect(toolParts(page, 'shared_echo').map((p) => p.state.output)).toEqual(['project:x'])
  })

  test('the project bundle downloads once, unpacks outside the repo, and its tool runs', async () => {
    const source = mkdtempSync(join(tmpdir(), 'pi-bundle-src-'))
    writePrebuilt(join(source, 'tree'), [{ name: 'bundled-ext', version: '3.0.0', code: prebuiltTool('bundled_echo', 'bundled') }])
    const archive = join(source, 'bundle.tar.gz')
    await require('tar').c({ gzip: true, cwd: join(source, 'tree'), file: archive }, ['.'])
    let downloads = 0
    let fallbackDownloads = 0
    const server = Bun.serve({
      port: 0,
      fetch: (req) => (new URL(req.url).pathname === '/fallback' ? (fallbackDownloads++, new Response('no', { status: 404 })) : (downloads++, new Response(Bun.file(archive)))),
    })
    try {
      const url = `http://127.0.0.1:${server.port}/bundle.tar.gz`
      const r = await boot({
        script: [{ tool: 'bundled_echo', args: { text: 'b' } }, { text: 'done' }],
        env: {
          KORTIX_PI_PACKAGES: JSON.stringify(['npm:bundled-ext@3.0.0']),
          KORTIX_PI_PACKAGES_BUNDLE_URL: url,
          KORTIX_PI_PACKAGES_FALLBACK_URL: `http://127.0.0.1:${server.port}/fallback`,
          KORTIX_PI_PACKAGES_BUNDLE_DIGEST: DIGEST,
        },
        start: false,
      })
      // The download starts with the service, beside the repo clone, not at runtime start.
      await waitFor(() => downloads === 1)
      await r.service.lifecycle.start()
      expect(downloads).toBe(1)
      expect(r.service.runtime()!.extensionStatus().loaded).toContain('npm:bundled-ext@3.0.0')
      await promptAndSettle(r, 'go')
      const page = (await r.bearer(`/kortix/opencode/messages/${r.service.runtime()!.rootId}`).then((res) => res.json())) as WirePage
      expect(toolParts(page, 'bundled_echo')[0]!.state.output).toBe('bundled:b')
      // Nothing lands in the repo; a restart reuses the unpacked bundle.
      expect(existsSync(join(r.workspace, 'node_modules'))).toBe(false)
      await r.service.lifecycle.stop()
      await r.service.lifecycle.start()
      expect(downloads).toBe(1)
      // Everything pre-built loaded natively: the installed tree was never fetched.
      expect(fallbackDownloads).toBe(0)
    } finally {
      server.stop(true)
      rmSync(source, { recursive: true, force: true })
    }
  })

  test('a package with no pre-built form, one whose file throws, and one with its own filter load from node_modules', async () => {
    const source = mkdtempSync(join(tmpdir(), 'pi-fallback-src-'))
    fakePackage(source, 'fb-ext', '1.0.0', echoTool('fb_echo', 'fb'))
    fakePackage(source, 'throws-ext', '1.0.0', echoTool('thr_echo', 'thr'))
    fakePackage(source, 'filtered-ext', '1.0.0', echoTool('fil_echo', 'fil'))
    const archive = join(source, 'node_modules.tar.gz')
    await require('tar').c({ gzip: true, cwd: source, file: archive }, ['node_modules'])
    let fallbackDownloads = 0
    const server = Bun.serve({ port: 0, fetch: () => (fallbackDownloads++, new Response(Bun.file(archive))) })
    try {
      const r = await boot({
        script: [{ tool: 'fb_echo', args: { text: '1' } }, { tool: 'thr_echo', args: { text: '2' } }, { tool: 'fil_echo', args: { text: '3' } }, { text: 'done' }],
        env: {
          KORTIX_PI_PACKAGES: JSON.stringify(['npm:fb-ext@1.0.0', 'npm:throws-ext@1.0.0', { source: 'npm:filtered-ext@1.0.0', extensions: ['index.ts'] }]),
          KORTIX_PI_PACKAGES_FALLBACK_URL: `http://127.0.0.1:${server.port}/node_modules.tar.gz`,
          KORTIX_PI_PACKAGES_BUNDLE_DIGEST: DIGEST,
        },
        prepare(workspace) {
          fakePrebuilt(workspace, [
            { name: 'fb-ext', version: '1.0.0', fallback: 'extension paths use globs or overrides' },
            { name: 'throws-ext', version: '1.0.0', code: "throw new Error('boom at import')\nexport default () => {}\n" },
            { name: 'filtered-ext', version: '1.0.0', code: prebuiltTool('fil_echo', 'prebuilt') },
          ])
        },
      })
      expect(fallbackDownloads).toBe(1)
      const status = r.service.runtime()!.extensionStatus()
      expect(status.loaded).toEqual(expect.arrayContaining(['npm:fb-ext@1.0.0', 'npm:throws-ext@1.0.0', 'npm:filtered-ext@1.0.0']))
      expect(status.failed).toEqual([])
      await promptAndSettle(r, 'go')
      const page = (await r.bearer(`/kortix/opencode/messages/${r.service.runtime()!.rootId}`).then((res) => res.json())) as WirePage
      expect([toolParts(page, 'fb_echo'), toolParts(page, 'thr_echo'), toolParts(page, 'fil_echo')].map((parts) => parts[0]!.state.output)).toEqual(['fb:1', 'thr:2', 'fil:3'])
    } finally {
      server.stop(true)
      rmSync(source, { recursive: true, force: true })
    }
  })

  test('the image-build warm step fills the extension cache a boot copies in, and names a broken package', async () => {
    const r = await boot({
      script: [{ text: 'ok' }],
      start: false,
      prepare(workspace) {
        const agentDir = join(workspace, '.pi-agent')
        mkdirSync(agentDir, { recursive: true })
        writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:warm-ext@1.0.0'] }))
        fakePackage(join(agentDir, 'npm'), 'warm-ext', '1.0.0', echoTool('warm_echo', 'warm'))
      },
    })
    const agentDir = join(r.workspace, '.pi-agent')
    const warm = async () => {
      const saved = process.env.TMPDIR
      try {
        return await warmSystemPackageCache(agentDir)
      } finally {
        if (saved === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = saved
      }
    }
    expect(await warm()).toEqual({ loaded: ['npm:warm-ext@1.0.0'], failed: [] })
    // Under `bun test` jiti imports TypeScript natively and caches nothing; the
    // compiled daemon transpiles and writes here. A boot copies whatever is there.
    const cached = `warm-ext-index.${Date.now()}.mjs`
    mkdirSync(systemPackageCacheDir(agentDir), { recursive: true })
    writeFileSync(join(systemPackageCacheDir(agentDir), cached), '/* warmed */')
    await r.service.lifecycle.start()
    expect(readFileSync(join(tmpdir(), 'jiti', cached), 'utf8')).toBe('/* warmed */')
    rmSync(join(tmpdir(), 'jiti', cached), { force: true })
    expect(r.service.runtime()!.extensionStatus().loaded).toContain('npm:warm-ext@1.0.0')

    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:warm-ext@1.0.0', 'npm:gone@1.0.0'] }))
    expect((await warm()).failed).toEqual([{ name: 'npm:gone@1.0.0', error: 'package is not installed' }])
  })

  test('a failed or absent bundle leaves the project packages out, never the session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-bundle-dir-'))
    const server = Bun.serve({ port: 0, fetch: () => new Response('gone', { status: 404 }) })
    try {
      expect(await ensureProjectPackageBundle({ dir, digest: DIGEST, url: `http://127.0.0.1:${server.port}/x` })).toBeNull()
      expect(await ensureProjectPackageBundle({ dir, digest: DIGEST })).toBeNull()
      expect(await ensureProjectPackageBundle({ dir, digest: '../escape', url: 'http://127.0.0.1:1/' })).toBeNull()
      expect(await ensureProjectPackageBundle({ dir })).toBeNull()
      expect(require('node:fs').readdirSync(dir)).toEqual([])
    } finally {
      server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('pi subagents extension', () => {
  const TASK = (args: Record<string, unknown>) => ({ tool: 'task', args: { description: 'Write the note', prompt: 'write sub.txt', subagent_type: 'general', ...args } })

  test('task runs a child session whose transcript the product can read', async () => {
    const r = await boot({
      script: [TASK({}), { tool: 'bash', args: { command: 'printf from-subagent > sub.txt && cat sub.txt' } }, { text: 'child wrote sub.txt' }, { text: 'parent done' }],
    })
    const root = r.service.runtime()!.rootId
    const tools = (await r.user('/tool/ids').then((res) => res.json())) as string[]
    expect(tools).toContain('task')

    await promptAndSettle(r, 'delegate it')
    expect(readFileSync(join(r.workspace, 'sub.txt'), 'utf8')).toBe('from-subagent')

    const page = (await r.bearer(`/kortix/opencode/messages/${root}`).then((res) => res.json())) as WirePage
    const task = toolParts(page, 'task')[0]!
    const childId = task.state.metadata.sessionId as string
    expect(childId).toMatch(/^ses_pi[0-9a-f]{24}$/)
    expect(childId).not.toBe(root)
    expect(task.state.status).toBe('completed')
    expect(task.state.output).toContain(`task_id: ${childId}`)
    expect(task.state.output).toContain('<task_result>\nchild wrote sub.txt\n</task_result>')
    expect(page.messages.at(-1)!.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'parent done' })

    // The child session, through every read the web client uses.
    const child = (await r.bearer(`/kortix/opencode/messages/${childId}`).then((res) => res.json())) as WirePage
    expect(child.messages.map((m) => m.info.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(child.messages.every((m) => m.info.sessionID === childId)).toBe(true)
    expect(child.messages[0]!.parts[0]).toMatchObject({ type: 'text', text: 'write sub.txt' })
    expect(child.messages[1]!.info).toMatchObject({ parentID: child.messages[0]!.info.id, agent: 'general' })
    expect(toolParts(child, 'bash')[0]!.state).toMatchObject({ status: 'completed', output: expect.stringContaining('from-subagent') })
    const raw = (await r.user(`/session/${childId}/message`).then((res) => res.json())) as Array<{ info: { id: string } }>
    expect(raw.map((m) => m.info.id)).toEqual(child.messages.map((m) => String(m.info.id)))
    // A child transcript pages like the root's: `x-next-cursor` while older messages remain.
    const newestPage = await r.user(`/session/${childId}/message?limit=1`)
    const newest = (await newestPage.json()) as Array<{ info: { id: string } }>
    expect(newestPage.headers.get('x-next-cursor')).toBe(newest[0]!.info.id)
    const olderPage = await r.user(`/session/${childId}/message?limit=10&cursor=${newest[0]!.info.id}`)
    expect(((await olderPage.json()) as unknown[]).length).toBe(2)
    expect(olderPage.headers.get('x-next-cursor')).toBeNull()
    expect(await r.user(`/session/${childId}`).then((res) => res.json())).toMatchObject({ id: childId, parentID: root, title: expect.stringContaining('Write the note') })
    expect(((await r.user(`/session/${root}/children`).then((res) => res.json())) as Array<{ id: string }>).map((s) => s.id)).toEqual([childId])
    expect(((await r.user('/session').then((res) => res.json())) as Array<{ id: string }>).map((s) => s.id)).toEqual([root, childId])
    // The root transcript holds no child message.
    expect(page.messages.every((m) => m.info.sessionID === root)).toBe(true)

    const state = (await r.bearer('/kortix/opencode/state').then((res) => res.json())) as Record<string, any>
    expect(state.sessions.value.map((s: { id: string; parent_id: string | null }) => [s.id, s.parent_id])).toEqual([[root, null], [childId, root]])
    expect(state.statuses.value).toEqual({ [root]: { type: 'idle' }, [childId]: { type: 'idle' } })

    // The stream carried the child id on the RUNNING task part, so the UI links the child while it works.
    const text = await readSse(await r.bearer('/kortix/opencode/events?since=0'), (t) => t.includes(`"sessionID":"${childId}"`) && t.includes('parent done'))
    const running = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
      .find((e) => e.type === 'message.part.updated' && e.payload.part.tool === 'task' && e.payload.part.state.status === 'running' && e.payload.part.state.metadata?.sessionId)
    expect(running?.payload.part.state.metadata.sessionId).toBe(childId)
  })

  test('explore is read-only, children cannot nest tasks, and an unknown type is an error', async () => {
    const r = await boot({
      script: [
        TASK({ subagent_type: 'explore', prompt: 'look around' }),
        { tool: 'write', args: { path: 'nope.txt', content: 'x' } },
        { tool: 'task', args: { description: 'nested', prompt: 'x', subagent_type: 'general' } },
        { text: 'explored' },
        TASK({ subagent_type: 'wizard' }),
        { text: 'parent done' },
      ],
    })
    await promptAndSettle(r, 'explore')
    expect(require('node:fs').existsSync(join(r.workspace, 'nope.txt'))).toBe(false)
    const root = r.service.runtime()!.rootId
    const page = (await r.bearer(`/kortix/opencode/messages/${root}`).then((res) => res.json())) as WirePage
    const [explore, wizard] = toolParts(page, 'task')
    expect(explore!.state.status).toBe('completed')
    expect(wizard!.state.status).toBe('error')
    expect(wizard!.state.error).toBe('Unknown subagent_type "wizard". Available: general, explore.')
    const child = (await r.bearer(`/kortix/opencode/messages/${explore!.state.metadata.sessionId}`).then((res) => res.json())) as WirePage
    expect(toolParts(child, 'write')[0]!.state.status).toBe('error')
    expect(toolParts(child, 'task')[0]!.state.status).toBe('error')
    expect(((await r.user(`/session/${root}/children`).then((res) => res.json())) as unknown[]).length).toBe(1)
  })

  test('a compiled subagent is offered and used; task_id resumes the same child after a restart', async () => {
    const compiled = {
      agent: {
        build: { mode: 'primary', prompt: 'You build.' },
        reviewer: { mode: 'subagent', description: 'Reviews one change', prompt: 'You review.' },
        hidden: { mode: 'subagent', description: 'Disabled', disable: true },
      },
    }
    const r = await boot({
      script: [TASK({ subagent_type: 'reviewer', prompt: 'review it' }), { text: 'looks good' }, { text: 'first done' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify(compiled) },
    })
    const described = ((await r.user('/tool').then((res) => res.json())) as Array<{ id: string; description: string }>).find((t) => t.id === 'task')!
    expect(described.description).toContain('reviewer: Reviews one change')
    expect(described.description).not.toContain('hidden')
    await promptAndSettle(r, 'review')
    const root = r.service.runtime()!.rootId
    let page = (await r.bearer(`/kortix/opencode/messages/${root}`).then((res) => res.json())) as WirePage
    const childId = toolParts(page, 'task')[0]!.state.metadata.sessionId as string
    let child = (await r.bearer(`/kortix/opencode/messages/${childId}`).then((res) => res.json())) as WirePage
    expect(child.messages[1]!.info.agent).toBe('reviewer')

    // A restart rebuilds the faux provider from the runtime's config: queue the second turn.
    ;(r.service.runtime() as unknown as { cfg: { piFauxScript: string } }).cfg.piFauxScript = JSON.stringify([
      TASK({ subagent_type: 'reviewer', prompt: 'check again', task_id: childId }),
      { text: 'still good' },
      { text: 'second done' },
    ])
    await r.service.lifecycle.stop()
    await r.service.lifecycle.start()
    expect((await r.user(`/session/${childId}/message`)).status).toBe(200)
    await promptAndSettle(r, 'again')
    child = (await r.bearer(`/kortix/opencode/messages/${childId}`).then((res) => res.json())) as WirePage
    expect(child.messages.map((m) => m.info.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    page = (await r.bearer(`/kortix/opencode/messages/${root}`).then((res) => res.json())) as WirePage
    expect(toolParts(page, 'task')[1]!.state.output).toContain('<task_result>\nstill good\n</task_result>')
    expect(((await r.user(`/session/${root}/children`).then((res) => res.json())) as unknown[]).length).toBe(1)
  })

  test('a subagent cannot run a call the session denies, even when its own rules allow it', async () => {
    const compiled = {
      agent: {
        build: { mode: 'primary', permission: { bash: { 'rm -rf *': 'deny', '*': 'allow' } } },
        cleaner: { mode: 'subagent', description: 'Cleans up', prompt: 'You clean.', permission: { '*': 'allow' } },
      },
    }
    const r = await boot({
      script: [
        TASK({ subagent_type: 'cleaner', prompt: 'delete keep' }),
        { tool: 'bash', args: { command: 'rm -rf keep' } },
        { text: 'tried as cleaner' },
        TASK({ subagent_type: 'general', prompt: 'delete keep' }),
        { tool: 'bash', args: { command: 'rm -rf keep' } },
        { text: 'tried as general' },
        { text: 'parent done' },
      ],
      env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify(compiled) },
    })
    require('node:fs').mkdirSync(join(r.workspace, 'keep'))
    writeFileSync(join(r.workspace, 'keep', 'file'), 'x')
    await promptAndSettle(r, 'clean up')
    expect(readFileSync(join(r.workspace, 'keep', 'file'), 'utf8')).toBe('x')
    const root = r.service.runtime()!.rootId
    const page = (await r.bearer(`/kortix/opencode/messages/${root}`).then((res) => res.json())) as WirePage
    const tasks = toolParts(page, 'task')
    expect(tasks.map((t) => t.state.status)).toEqual(['completed', 'completed'])
    for (const task of tasks) {
      const child = (await r.bearer(`/kortix/opencode/messages/${task.state.metadata.sessionId}`).then((res) => res.json())) as WirePage
      const bash = toolParts(child, 'bash')[0]!
      expect(bash.state.status).toBe('error')
      expect(String(bash.state.error)).toContain('denies')
    }
  })

  test('a live agent-config change re-lists the subagent types in the task tool', async () => {
    const r = await boot({ script: [{ text: 'ok' }] })
    const describe = async () =>
      ((await r.user('/tool').then((res) => res.json())) as Array<{ id: string; description: string }>).find((t) => t.id === 'task')!.description
    expect(await describe()).not.toContain('reviewer')
    const runtime = r.service.runtime()! as unknown as { env: NodeJS.ProcessEnv; reconfigure: () => Promise<unknown> }
    runtime.env.KORTIX_COMPILED_AGENT_CONFIG = JSON.stringify({ agent: { build: { mode: 'primary' }, reviewer: { mode: 'subagent', description: 'Reviews one change' } } })
    await runtime.reconfigure()
    expect(await describe()).toContain('reviewer: Reviews one change')
    expect(((await r.user('/tool/ids').then((res) => res.json())) as string[]).filter((id) => id === 'task')).toHaveLength(1)
  })

  test('several task calls in one message run their subagents concurrently', async () => {
    const r = await boot({
      script: [
        { tools: [TASK({ description: 'A', prompt: 'a' }).args, TASK({ description: 'B', prompt: 'b' }).args].map((args) => ({ tool: 'task', args })) },
        // Both children take their first step from the shared queue at once: each sleeps 1 s.
        { tool: 'bash', args: { command: 'sleep 1 && printf x >> ran.txt' } },
        { tool: 'bash', args: { command: 'sleep 1 && printf x >> ran.txt' } },
        { text: 'child done' },
        { text: 'child done' },
        { text: 'parent done' },
      ],
    })
    const started = Date.now()
    await promptAndSettle(r, 'fan out')
    const elapsed = Date.now() - started
    expect(readFileSync(join(r.workspace, 'ran.txt'), 'utf8')).toBe('xx')
    expect(elapsed).toBeLessThan(1_900)
    const root = r.service.runtime()!.rootId
    const page = (await r.bearer(`/kortix/opencode/messages/${root}`).then((res) => res.json())) as WirePage
    const tasks = toolParts(page, 'task')
    expect(tasks.map((t) => t.state.status)).toEqual(['completed', 'completed'])
    expect(new Set(tasks.map((t) => t.state.metadata.sessionId)).size).toBe(2)
  })

  test('aborting the parent turn aborts the running subagent', async () => {
    const r = await boot({ script: [TASK({}), { tool: 'bash', args: { command: 'sleep 20' } }, { text: 'never' }, { text: 'never' }] })
    const root = r.service.runtime()!.rootId
    expect((await r.user(`/session/${root}/prompt_async`, { method: 'POST', body: JSON.stringify({ parts: [{ type: 'text', text: 'go' }] }) })).status).toBe(204)
    await waitFor(() => (r.service.runtime()!.stateDoc().sessions as { value: unknown[] }).value.length === 2)
    await Bun.sleep(200)
    const started = Date.now()
    expect((await r.user(`/session/${root}/abort`, { method: 'POST' })).status).toBe(200)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(r.service.runtime()!.busy()).toBe(false)
    const state = r.service.runtime()!.stateDoc() as Record<string, any>
    expect(Object.values(state.statuses.value)).toEqual([{ type: 'idle' }, { type: 'idle' }])
  })
})
