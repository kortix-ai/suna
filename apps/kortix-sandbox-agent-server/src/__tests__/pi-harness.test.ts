/**
 * The pi harness, black-box through the daemon's own HTTP surface.
 *
 * pi runs its REAL model path: the `kortix` provider over pi-ai's
 * openai-completions client, pointed through `KORTIX_LLM_BASE_URL` +
 * `KORTIX_TOKEN` at a local OpenAI-compatible fake that streams scripted SSE
 * chunks (text deltas, tool calls, finish reasons). Everything else is real:
 * the agent loop, the bash tool against a temp workspace, the OpenCode wire the
 * SDK parses, the sequenced event stream and the control-plane probes the API
 * polls.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../config'
import { resetKortixEventBusForTests } from '../kortix-event-bus'
import { buildDaemonApp } from '../proxy'
import { requirePiConfig } from '../harness/pi/config'
import { createPiHarnessService, piDefinition, type PiHarnessService } from '../harness/pi/service'
import type { PiBootState } from '../harness/pi/boot-state'
import { signTestUserContext } from './helpers/open-code-harness'

const TOKEN = 'pi-test-token'
const MODEL_ID = 'test-model'

/** One scripted model reply: text, a tool call, or text ending on `finish`. */
type Step = { text: string; finish?: 'stop' | 'length' } | { tool: string; args: Record<string, unknown> }

/**
 * An OpenAI-compatible `/chat/completions` that answers each request with the
 * next scripted step as an SSE chunk stream, and records what it was sent.
 */
function startFakeGateway() {
  let script: Step[] = []
  let calls = 0
  const requests: Array<{ path: string; auth: string | null }> = []
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model: MODEL_ID, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
      await req.text()
      requests.push({ path: url.pathname, auth: req.headers.get('authorization') })
      const step: Step = script.shift() ?? { text: '' }
      calls += 1
      let body = chunk({ role: 'assistant', content: '' })
      if ('tool' in step) {
        const id = `call_${calls}`
        const args = JSON.stringify(step.args)
        body += chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name: step.tool, arguments: '' } }] })
        body += chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, 5) } }] })
        body += chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] })
        body += chunk({}, 'tool_calls')
      } else {
        // Two deltas, so the stream carries more than one `message.part.delta`.
        const half = Math.ceil(step.text.length / 2)
        if (step.text) body += chunk({ content: step.text.slice(0, half) })
        if (step.text.length > half) body += chunk({ content: step.text.slice(half) })
        body += chunk({}, step.finish ?? 'stop')
      }
      body += `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model: MODEL_ID, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
      body += 'data: [DONE]\n\n'
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1/llm`,
    requests,
    script: (steps: Step[]) => {
      script = [...steps]
    },
    stop: () => server.stop(true),
  }
}

let gateway: ReturnType<typeof startFakeGateway>
let catalogDir: string
beforeAll(() => {
  gateway = startFakeGateway()
  catalogDir = mkdtempSync(join(tmpdir(), 'pi-catalog-'))
  writeFileSync(join(catalogDir, 'catalog.json'), JSON.stringify({ models: { [MODEL_ID]: { name: 'Test Model', limit: { context: 64_000, output: 4_096 } } } }))
})
afterAll(() => {
  gateway.stop()
  rmSync(catalogDir, { recursive: true, force: true })
})

interface Rig {
  app: ReturnType<typeof buildDaemonApp>
  service: PiHarnessService
  bootState: PiBootState
  workspace: string
  env: NodeJS.ProcessEnv
  user: (path: string, init?: RequestInit) => Promise<Response>
  bearer: (path: string, init?: RequestInit) => Promise<Response>
}

const rigs: Rig[] = []

function rigEnv(workspace: string, env: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    KORTIX_HARNESS: 'pi',
    KORTIX_LLM_BASE_URL: gateway.baseUrl,
    KORTIX_LLM_CATALOG_FILE: join(catalogDir, 'catalog.json'),
    KORTIX_PI_STATE_DIR: join(workspace, '.state'),
    KORTIX_PROJECT_AUTO_CLONE: '0',
    KORTIX_WORKSPACE: workspace,
    KORTIX_PROJECT_TARGET: workspace,
    KORTIX_TOKEN: TOKEN,
    KORTIX_SESSION_ID: 'sess-pi-test',
    KORTIX_PROJECT_ID: 'proj-pi-test',
    ...env,
  }
}

async function boot(input: {
  script: Step[]
  env?: Record<string, string>
  start?: boolean
  workspace?: string
}): Promise<Rig> {
  const workspace = input.workspace ?? mkdtempSync(join(tmpdir(), 'pi-harness-'))
  gateway.script(input.script)
  const env = rigEnv(workspace, input.env)
  const cfg = requirePiConfig(loadConfig(env))
  const service = createPiHarnessService(cfg, undefined, { env })
  const bootState: PiBootState = { repoMaterializationError: null, timeline: [], initialOpenCodeSessionRequired: false }
  if (input.start !== false) await service.lifecycle.start()
  const app = buildDaemonApp(cfg, service, Date.now(), bootState)
  const ctx = signTestUserContext({ userId: 'u1', sandboxId: 's1', sandboxRole: 'owner' }, TOKEN)
  const request = (path: string, init: RequestInit = {}, headers: Record<string, string>) =>
    Promise.resolve(app.request(path, { ...init, headers: { ...headers, ...((init.headers as Record<string, string>) ?? {}) } }))
  const built: Rig = {
    app,
    service,
    bootState,
    workspace,
    env,
    user: (path, init) => request(path, init, { 'X-Kortix-User-Context': ctx }),
    bearer: (path, init) => request(path, init, { Authorization: `Bearer ${TOKEN}` }),
  }
  rigs.push(built)
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
  for (const rig of rigs.splice(0)) {
    await rig.service.lifecycle.stop().catch(() => {})
    rmSync(rig.workspace, { recursive: true, force: true })
  }
})

/** Wait until the root's transcript shows a tool part in the running state. */
async function waitForRunningTool(r: Rig, root: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const messages = (await r.user(`/session/${root}/message`).then((res) => res.json())) as Array<{ parts: Array<{ type: string; state?: { status?: string } }> }>
    if (messages.flatMap((m) => m.parts).some((p) => p.type === 'tool' && p.state?.status === 'running')) return
    await Bun.sleep(10)
  }
  throw new Error('no tool started running')
}

const prompt = (r: Rig, root: string, body: Record<string, unknown>) =>
  r.user(`/session/${root}/prompt_async`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('pi harness', () => {
  test('health reports the pi runtime before and after start', async () => {
    const r = await boot({ script: [{ text: 'hi' }], start: false })
    const before = (await r.bearer('/kortix/health').then((res) => res.json())) as Record<string, unknown>
    expect(before.harness).toBe('pi')
    expect(before.runtimeReady).toBe(false)
    expect(before.opencode).toBe('down')
    expect((await r.user('/session')).status).toBe(503)

    await r.service.lifecycle.start()
    const after = (await r.bearer('/kortix/health').then((res) => res.json())) as Record<string, unknown>
    expect(after.runtimeReady).toBe(true)
    expect(after.status).toBe('ok')
    expect(after.opencode).toBe('ok')
    expect(after.model).toBe(`kortix/${MODEL_ID}`)
  })

  test('a failed pi start is a boot_error, not a silent down', async () => {
    // The web paints its session error card only from boot_error. runtime() is
    // null until start() resolves, so a failed start used to leave the box
    // "down" with boot_error null and the session spinning forever.
    const r = await boot({ script: [], env: { KORTIX_LLM_BASE_URL: '' }, start: false })
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
    // Both model steps went to the gateway with the session credential.
    expect(gateway.requests.slice(-2)).toEqual([
      { path: '/v1/llm/chat/completions', auth: `Bearer ${TOKEN}` },
      { path: '/v1/llm/chat/completions', auth: `Bearer ${TOKEN}` },
    ])

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

  test('every raw /event frame carries the id the SDK dedupes deltas on, the same on every connection', async () => {
    // The SDK store keys `message.part.delta` idempotency on the envelope's
    // `id`: a delta with no id, or a different id on redelivery, APPENDS its
    // text again and the reply renders twice.
    const r = await boot({ script: [{ text: 'Streamed answer.' }] })
    const root = r.service.runtime()!.rootId
    const first = await r.user('/event')
    const second = await r.user('/event')
    expect(first.headers.get('content-type')).toContain('text/event-stream')
    await prompt(r, root, { messageID: 'msg_0198e2a4b0c1ABCDEFGHIJKLMN', parts: [{ type: 'text', text: 'say something' }] })
    const frames = async (res: Response) =>
      (await readSse(res, (t) => t.includes('"type":"session.idle"')))
        .split('\n\n')
        .map((chunk) => chunk.replace(/^data: /, '').trim())
        .filter((chunk) => chunk.startsWith('{'))
        .map((chunk) => JSON.parse(chunk) as { id?: string; type: string })
    const [a, b] = await Promise.all([frames(first), frames(second)])

    const deltaIds = (list: Array<{ id?: string; type: string }>) => list.filter((f) => f.type === 'message.part.delta').map((f) => f.id)
    expect(deltaIds(a).length).toBeGreaterThan(1)
    expect(deltaIds(a)).toEqual(deltaIds(b))
    const ids = a.filter((f) => f.id !== undefined).map((f) => f.id!)
    // Distinct events never collide, or the guard drops real deltas.
    expect(new Set(ids).size).toBe(ids.length)
    // Epoch-prefixed, so a daemon restart cannot reissue an id already applied.
    for (const id of ids) expect(id).toMatch(/^b[a-z0-9]+:\d+$/)
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
    // The pattern map survives compilation into the agent object the web shows.
    const permission = { bash: { 'rm -rf *': 'deny', '*': 'allow' } }
    const r = await boot({ script: [{ text: 'ok' }], env: { KORTIX_AGENT_NAME: 'coder', KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { coder: { prompt: 'You code.', description: 'Writes code', permission } } }) } })
    const config = (await r.user('/config').then((res) => res.json())) as Record<string, unknown>
    expect(config.default_agent).toBe('coder')
    expect(config.model).toBe(`kortix/${MODEL_ID}`)
    const agents = (await r.user('/agent').then((res) => res.json())) as Array<Record<string, unknown>>
    expect(agents[0]).toMatchObject({ name: 'coder', description: 'Writes code', mode: 'primary', prompt: 'You code.', permission })
    const tools = (await r.user('/tool/ids').then((res) => res.json())) as string[]
    expect([...tools]).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'question'])
    const providers = (await r.user('/provider').then((res) => res.json())) as { all: Array<{ id: string }>; default: Record<string, string> }
    expect(providers.all[0]!.id).toBe('kortix')
    expect(providers.default).toEqual({ kortix: MODEL_ID })
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
    // Stop on an idle root is a no-op success.
    const idleStop = await r.bearer('/kortix/opencode/act', { method: 'POST', body: JSON.stringify({ kind: 'stop' }) })
    expect(idleStop.status).toBe(200)
    expect(await idleStop.json()).toMatchObject({ ok: true })
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
    // Compiling it down to its `*` entry would run the denied command. The
    // sentinel it targets lives inside the rig, so a regression costs nothing.
    const permission = { bash: { 'rm -rf *': 'deny', '*': 'allow' } }
    const denied = await boot({
      script: [{ tool: 'bash', args: { command: 'rm -rf ./keep' } }, { text: 'blocked' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { build: { permission } } }) },
    })
    mkdirSync(join(denied.workspace, 'keep'))
    writeFileSync(join(denied.workspace, 'keep', 'sentinel'), 'still here')
    const deniedRoot = denied.service.runtime()!.rootId
    expect((await prompt(denied, deniedRoot, { parts: [{ type: 'text', text: 'go' }] })).status).toBe(204)
    await waitFor(() => !denied.service.runtime()!.busy())
    expect(denied.service.runtime()!.permissions.list()).toHaveLength(0)
    expect(existsSync(join(denied.workspace, 'keep', 'sentinel'))).toBe(true)
    const deniedPage = (await denied.bearer(`/kortix/opencode/messages/${deniedRoot}`).then((res) => res.json())) as { messages: Array<{ parts: Array<Record<string, unknown>> }> }
    const deniedTool = deniedPage.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool')!
    expect(deniedTool.state).toMatchObject({ status: 'error' })
    expect(String((deniedTool.state as { error: string }).error)).toContain('denies')

    const allowed = await boot({
      script: [{ tool: 'bash', args: { command: 'echo fine' } }, { text: 'done' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { build: { permission } } }) },
    })
    const allowedRoot = allowed.service.runtime()!.rootId
    expect((await prompt(allowed, allowedRoot, { parts: [{ type: 'text', text: 'go' }] })).status).toBe(204)
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
    await waitForRunningTool(r, root)
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
    await waitForRunningTool(r, root)
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

  test.each([
    ['another turn', (root: string) => ({ opencode_session_id: root, turn_message_id: 'msg_0198e2a4b0c5ABCDEFGHIJKLMN' })],
    ['another session', () => ({ opencode_session_id: 'ses_someone_else', turn_message_id: 'msg_0198e2a4b0c4ABCDEFGHIJKLMN' })],
  ])('an abort-after-tool armed for %s is ignored and the turn finishes', async (_name, target) => {
    const r = await boot({ script: [{ tool: 'bash', args: { command: 'sleep 0.5; echo ok' } }, { text: 'finished normally' }] })
    const root = r.service.runtime()!.rootId
    const messageID = 'msg_0198e2a4b0c4ABCDEFGHIJKLMN'
    expect((await prompt(r, root, { messageID, parts: [{ type: 'text', text: 'run it' }] })).status).toBe(204)
    await waitForRunningTool(r, root)
    const stale = await r.user('/kortix/abort/after-tool', {
      method: 'POST',
      body: JSON.stringify({ prompt_id: 'prm_stale', ...target(root) }),
    })
    expect(stale.status).toBe(202)
    await waitFor(() => !r.service.runtime()!.busy())
    const messages = (await r.user(`/session/${root}/message`).then((res) => res.json())) as Array<{ info: any; parts: any[] }>
    const text = messages.flatMap((m) => m.parts).filter((p) => p.type === 'text').map((p) => p.text).join(' ')
    expect(text).toContain('finished normally')
  })

  test('disarming a pending abort-after-tool lets the turn finish', async () => {
    const r = await boot({ script: [{ tool: 'bash', args: { command: 'sleep 0.5; echo ok' } }, { text: 'finished normally' }] })
    const root = r.service.runtime()!.rootId
    const messageID = 'msg_0198e2a4b0c4ABCDEFGHIJKLMN'
    expect((await prompt(r, root, { messageID, parts: [{ type: 'text', text: 'run it' }] })).status).toBe(204)
    await waitForRunningTool(r, root)
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

  test('a restarted daemon restores the transcript, title and turn verdicts from the state dir', async () => {
    // A daemon restart is a new process: a second service on the same state
    // dir must restore what the first one persisted, not reuse its memory.
    const r = await boot({ script: [{ text: 'first answer' }] })
    const root = r.service.runtime()!.rootId
    const messageID = 'msg_0198e2a4b0c6ABCDEFGHIJKLMN'
    expect((await prompt(r, root, { messageID, parts: [{ type: 'text', text: 'remember me' }] })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy())
    const before = (await r.user(`/session/${root}/message`).then((res) => res.json())) as Array<{ info: { id: string } }>
    await r.service.lifecycle.stop()

    const restarted = await boot({ script: [{ text: 'second answer' }], workspace: r.workspace })
    rigs.splice(rigs.indexOf(r), 1)
    expect(restarted.service.runtime()!.rootId).toBe(root)
    const page = (await restarted.bearer(`/kortix/opencode/messages/${root}`).then((res) => res.json())) as { messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> }
    expect(page.messages.map((m) => m.info.role)).toEqual(['user', 'assistant'])
    expect(page.messages[1]!.parts[0]).toMatchObject({ type: 'text', text: 'first answer' })
    const sessions = (await restarted.user('/session').then((res) => res.json())) as Array<{ title: string }>
    expect(sessions[0]!.title).toBe('remember me')
    const probe = (await restarted.bearer(`/kortix/health?turn=1&turn_message_id=${messageID}`).then((res) => res.json())) as Record<string, unknown>
    expect(probe.turn_end).toBe('completed')

    // The id clock was restored too: a new turn's ids sort after every restored id.
    expect((await prompt(restarted, root, { parts: [{ type: 'text', text: 'again' }] })).status).toBe(204)
    await waitFor(() => !restarted.service.runtime()!.busy())
    const after = (await restarted.user(`/session/${root}/message`).then((res) => res.json())) as Array<{ info: { id: string } }>
    const newest = before.map((m) => m.info.id).sort().at(-1)!
    for (const m of after.slice(before.length)) expect(m.info.id > newest).toBe(true)
  })

  test('a managed-skill overlay that lands after start reaches the running pi', async () => {
    const managed = mkdtempSync(join(tmpdir(), 'pi-managed-'))
    const previous = process.env.KORTIX_MANAGED_SKILLS_DIR
    process.env.KORTIX_MANAGED_SKILLS_DIR = managed
    try {
      const r = await boot({ script: [{ text: 'ok' }], start: false })
      const write = (root: string, name: string, description: string) => {
        mkdirSync(join(root, name), { recursive: true })
        writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`)
      }
      write(join(r.workspace, 'skills'), 'kortix-cli', 'Committed copy')
      await r.service.lifecycle.start()
      const list = async () =>
        ((await r.user('/skill').then((res) => res.json())) as Array<{ name: string; description: string }>)
          .map((s) => [s.name, s.description])
          .sort()
      expect(await list()).toEqual([['kortix-cli', 'Committed copy']])

      // runtime-assets writes the overlay after the harness started, then calls injectSkills.
      write(managed, 'kortix-cli', 'Managed copy')
      write(managed, 'kortix-system', 'Platform reference')
      await piDefinition.assets.injectSkills(r.workspace, managed)

      expect(await list()).toEqual([
        ['kortix-cli', 'Managed copy'],
        ['kortix-system', 'Platform reference'],
      ])
    } finally {
      if (previous === undefined) delete process.env.KORTIX_MANAGED_SKILLS_DIR
      else process.env.KORTIX_MANAGED_SKILLS_DIR = previous
    }
  })

  test('skills in the project are loaded into the system prompt: root skills/, then the legacy dir', async () => {
    const r = await boot({ script: [{ text: 'ok' }], start: false })
    const skill = (root: string, name: string, description: string) => {
      const dir = join(r.workspace, root, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`)
    }
    skill('skills', 'deploy', 'Ship to prod')
    skill('.kortix/opencode/skills', 'review', 'Review a change')
    // Same name in both roots: the root layout wins.
    skill('.kortix/opencode/skills', 'deploy', 'Stale legacy copy')
    await r.service.lifecycle.start()
    const skills = (await r.user('/skill').then((res) => res.json())) as Array<{ name: string; description: string }>
    expect(skills.map((s) => [s.name, s.description]).sort()).toEqual([
      ['deploy', 'Ship to prod'],
      ['review', 'Review a change'],
    ])
  })

  test.each([
    ['a messageID outside the OpenCode wire format', { messageID: 'not-a-wire-id', parts: [{ type: 'text', text: 'hi' }] }],
    ['an empty parts array', { parts: [] }],
    ['an unsupported part type', { parts: [{ type: 'image', url: 'x' }] }],
    ['no content at all', { parts: [{ type: 'text', text: '   ' }] }],
  ])('a prompt with %s is refused with 400, so the API stops redelivering it', async (_name, body) => {
    const r = await boot({ script: [] })
    const root = r.service.runtime()!.rootId
    expect((await prompt(r, root, body)).status).toBe(400)
    expect(r.service.runtime()!.busy()).toBe(false)
  })

  test('a model reply cut off by the length limit ends the turn as failed', async () => {
    const r = await boot({ script: [{ text: 'partial answ', finish: 'length' }] })
    const root = r.service.runtime()!.rootId
    const messageID = 'msg_0198e2a4b0c7ABCDEFGHIJKLMN'
    expect((await prompt(r, root, { messageID, parts: [{ type: 'text', text: 'long question' }] })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy())
    const probe = (await r.bearer(`/kortix/health?turn=1&turn_message_id=${messageID}`).then((res) => res.json())) as Record<string, unknown>
    expect(probe.turn_in_flight).toBe(false)
    expect(probe.turn_end).toBe('failed')
  })
})
