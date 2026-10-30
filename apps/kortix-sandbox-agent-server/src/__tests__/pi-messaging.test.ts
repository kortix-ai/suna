/**
 * `send_message` and `list_agents` through the production pi runtime: pi boots
 * against a local fake model gateway, and a `Bun.serve` fake of the Kortix API
 * on a real port answers the multi-agent routes
 * (`@kortix/api-contract/multi-agent`): `GET …/sessions/:self/reachable` and
 * `POST …/sessions/:self/peer-messages`, plus the child-session routes the
 * `agent` tool's background default calls. Every row reads the tool part the
 * runtime publishes (the card document) and the request the fake API saw.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PeerMessageSendResult, ReachableAgent, ReachableAgents } from '@kortix/api-contract/multi-agent'
import { loadConfig } from '@/harness/harness'
import { requirePiConfig } from '@/harness/pi/config'
import type { PiRuntime } from '@/harness/pi/runtime'
import { createPiHarnessService, type PiHarnessService } from '@/harness/pi/service'
import { resetKortixEventBusForTests } from '@/services/event-bus/kortix-event-bus'
import { startFakeModel, type Step } from './helpers/fake-model'

const MODEL_ID = 'test-model'
const PROJECT_ID = 'proj-pi-messaging'
const SELF = '3f2a1b9c-0000-4000-8000-000000000001'
const REVIEWER = '7c1d2e3f-0000-4000-8000-000000000002'
const OTHER = '9a8b7c6d-0000-4000-8000-000000000003'

type ToolState = { status: string; output?: string; error?: string; metadata?: Record<string, any> }
type ToolFrame = { tool: string; state: ToolState }
type Seen = { method: string; path: string; query: string; auth: string | null; body: any }

const agent = (over: Partial<ReachableAgent>): ReachableAgent => ({
  handle: 'reviewer',
  session_id: REVIEWER,
  short_id: REVIEWER.slice(0, 8),
  project_id: PROJECT_ID,
  agent_name: 'reviewer',
  title: 'Review the auth module',
  relation: 'child',
  state: 'working',
  inbound: 'accept',
  can_receive: true,
  ...over,
})

const REACHABLE: ReachableAgents = {
  self: agent({ handle: 'main', session_id: SELF, short_id: SELF.slice(0, 8), agent_name: 'kortix', title: 'Plan the launch', relation: 'self', state: 'working' }),
  agents: [
    agent({}),
    agent({ handle: 'docs-writer', session_id: OTHER, short_id: OTHER.slice(0, 8), agent_name: null, title: 'Write the docs', relation: 'session', state: 'idle', inbound: 'hold' }),
    agent({ handle: 'quiet', session_id: 'aaaaaaaa-0000-4000-8000-000000000004', short_id: 'aaaaaaaa', relation: 'session', state: 'completed', inbound: 'refuse', can_receive: false }),
  ],
}

function startFakeApi() {
  const seen: Seen[] = []
  let send: (body: any) => { status: number; body: unknown } = (body) => ({ status: 200, body: sendResult('delivered', body) })
  let delayMs = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const body: any = req.method === 'GET' ? null : await req.json().catch(() => null)
      seen.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.get('authorization'), body })
      if (delayMs) await Bun.sleep(delayMs)
      const base = `/v1/projects/${PROJECT_ID}/sessions`
      if (req.method === 'GET' && url.pathname === `${base}/${SELF}/reachable`) return Response.json(REACHABLE)
      if (req.method === 'POST' && url.pathname === `${base}/${SELF}/peer-messages`) {
        const answer = send(body)
        return Response.json(answer.body, { status: answer.status })
      }
      if (req.method === 'GET' && url.pathname === base) return Response.json([])
      if (req.method === 'POST' && url.pathname === base) return Response.json({ session_id: 'child-1' }, { status: 201 })
      return new Response('not found', { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    seen,
    onSend: (fn: typeof send) => void (send = fn),
    hold: (ms: number) => void (delayMs = ms),
    stop: () => server.stop(true),
  }
}

function sendResult(status: PeerMessageSendResult['status'], body: any, note = ''): PeerMessageSendResult {
  return {
    status,
    message: {
      id: 'm_7Kq2',
      project_id: PROJECT_ID,
      from_session_id: SELF,
      from_handle: 'main',
      to_session_id: REVIEWER,
      to_handle: 'reviewer',
      type: body?.type ?? 'message',
      message: body?.message ?? '',
      summary: body?.summary ?? null,
      status,
      notify_when_idle: body?.notify_when_idle === true,
      created_at: '2026-10-30T10:00:00.000Z',
      decided_at: null,
    },
    to: REACHABLE.agents[0]!,
    note,
  }
}

let model: ReturnType<typeof startFakeModel>
let api: ReturnType<typeof startFakeApi>
const services: PiHarnessService[] = []
const dirs: string[] = []
const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  model = startFakeModel(MODEL_ID, { [MODEL_ID]: { name: 'Test Model', limit: { context: 64_000, output: 4_096 } } })
})
afterAll(() => model.stop())
beforeEach(() => {
  resetKortixEventBusForTests()
  api = startFakeApi()
  const home = mkdtempSync(join(tmpdir(), 'pi-messaging-home-'))
  dirs.push(home)
  const absent = join(tmpdir(), 'pi-messaging-absent-box-state')
  for (const [key, value] of Object.entries({ HOME: home, KORTIX_MANAGED_SKILLS_DIR: absent, KORTIX_PT_ENV_PATH: absent })) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
})
afterEach(async () => {
  for (const service of services.splice(0)) await service.lifecycle.stop().catch(() => {})
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  api.stop()
  resetKortixEventBusForTests()
})

async function boot(steps: Step[], env: Record<string, string> = {}): Promise<{ rt: PiRuntime; frames: ToolFrame[]; service: PiHarnessService }> {
  const workspace = mkdtempSync(join(tmpdir(), 'pi-messaging-box-'))
  dirs.push(workspace)
  const frames: ToolFrame[] = []
  const boxEnv: NodeJS.ProcessEnv = {
    KORTIX_HARNESS: 'pi',
    KORTIX_LLM_BASE_URL: model.url,
    KORTIX_PI_STATE_DIR: join(workspace, '.state'),
    KORTIX_PI_AGENT_DIR: join(workspace, '.pi-agent'),
    KORTIX_PI_PACKAGES_DIR: join(workspace, '.pi-packages'),
    KORTIX_RUNTIME_STATE_DIR: join(workspace, '.runtime-state'),
    KORTIX_PROJECT_AUTO_CLONE: '0',
    KORTIX_WORKSPACE: workspace,
    KORTIX_PROJECT_TARGET: workspace,
    KORTIX_TOKEN: 'box-token',
    KORTIX_SESSION_ID: SELF,
    KORTIX_PROJECT_ID: PROJECT_ID,
    KORTIX_API_URL: api.url,
    KORTIX_PI_TURN_RETRY_BASE_MS: '5',
    ...env,
  }
  for (const [key, value] of Object.entries(env)) if (value === '') delete boxEnv[key]
  model.script(steps)
  const service = createPiHarnessService(requirePiConfig(loadConfig(boxEnv)), undefined, {
    env: boxEnv,
    hooks: {
      onFrame: (frame) => {
        const part = (frame.properties as { part?: { type?: string; tool?: string; state?: ToolState } }).part
        if (frame.type === 'message.part.updated' && part?.type === 'tool' && part.tool && part.state) frames.push({ tool: part.tool, state: part.state })
      },
    },
  })
  services.push(service)
  await service.lifecycle.start()
  return { rt: service.runtime()!, frames, service }
}

/** The final part of the last call to `tool`, its output parsed as the result document. */
function lastResult(frames: ToolFrame[], tool: string): { state: ToolState; result: any } {
  const state = frames.filter((frame) => frame.tool === tool && frame.state.status === 'completed').at(-1)!.state
  return { state, result: JSON.parse(state.output!) }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

describe('pi list_agents', () => {
  test('lists the reachable sessions as the session itself, with the API answer as data and one card row per session', async () => {
    const { rt, frames } = await boot([{ tool: 'list_agents', args: {} }, { text: 'listed' }])
    expect(rt.toolNames()).toEqual(expect.arrayContaining(['send_message', 'list_agents', 'task_stop']))
    expect(await rt.admit({ text: 'who is around?', files: [] }).done).toBe('completed')

    const call = api.seen.find((s) => s.path.endsWith('/reachable'))!
    expect(call).toMatchObject({ method: 'GET', path: `/v1/projects/${PROJECT_ID}/sessions/${SELF}/reachable`, query: '?scope=project', auth: 'Bearer box-token' })
    const { state, result } = lastResult(frames, 'list_agents')
    expect(result).toEqual({
      ok: true,
      tool: 'list_agents',
      action: 'project',
      card: {
        title: '3 sessions you can reach',
        subtitle: 'This session is main. 1 working.',
        status: 'done',
        rows: [
          { title: 'reviewer', detail: 'started by this session · @reviewer · Review the auth module', badge: 'working', href: `/projects/${PROJECT_ID}/sessions/${REVIEWER}` },
          { title: 'docs-writer', detail: 'session · Write the docs · messages wait for approval', badge: 'idle', href: `/projects/${PROJECT_ID}/sessions/${OTHER}` },
          { title: 'quiet', detail: 'session · @reviewer · Review the auth module · takes no messages', badge: 'done', href: `/projects/${PROJECT_ID}/sessions/aaaaaaaa-0000-4000-8000-000000000004` },
        ],
      },
      data: REACHABLE,
    })
    // The part's metadata is the same document: the web client renders the card from it.
    expect(state.metadata).toMatchObject({ tool: 'list_agents', card: { title: '3 sessions you can reach' } })
  })

  test('scope "mine" and another project pass through as the query', async () => {
    const { rt } = await boot([{ tool: 'list_agents', args: { scope: 'mine', project_id: 'proj-other' } }, { text: 'listed' }])
    await rt.admit({ text: 'mine', files: [] }).done
    expect(api.seen.find((s) => s.path.endsWith('/reachable'))!.query).toBe('?scope=mine&project_id=proj-other')
  })
})

describe('pi send_message', () => {
  test('delivered: the body goes to the sender route, and the card says where it went', async () => {
    const { rt, frames } = await boot([
      { tool: 'send_message', args: { to: '@reviewer', message: 'The schema migration finished; tenant_id is the new column.', summary: 'Migration finished', notify_when_idle: true } },
      { text: 'sent' },
    ])
    await rt.admit({ text: 'tell the reviewer', files: [] }).done
    const call = api.seen.find((s) => s.path.endsWith('/peer-messages'))!
    expect(call).toMatchObject({ method: 'POST', path: `/v1/projects/${PROJECT_ID}/sessions/${SELF}/peer-messages`, auth: 'Bearer box-token' })
    expect(call.body).toEqual({ to: '@reviewer', message: 'The schema migration finished; tenant_id is the new column.', summary: 'Migration finished', notify_when_idle: true })
    const { result } = lastResult(frames, 'send_message')
    expect(result).toMatchObject({
      ok: true,
      tool: 'send_message',
      action: 'message',
      card: { title: 'Message sent to reviewer', subtitle: 'You get one notice when reviewer finishes its turn.', status: 'done', rows: [{ title: 'reviewer', badge: 'working' }] },
      data: { status: 'delivered', to: { handle: 'reviewer' }, message: { id: 'm_7Kq2' } },
    })
  })

  test('held, refused and dropped are results with plain-words cards, never errors', async () => {
    const answers: Array<PeerMessageSendResult['status']> = ['held', 'refused', 'dropped']
    let n = 0
    api.onSend((body) => ({ status: 200, body: sendResult(answers[n++]!, body, n === 2 ? 'Not sent: reviewer refuses messages.' : '') }))
    const { rt, frames } = await boot([
      { tool: 'send_message', args: { to: 'reviewer', message: 'one' } },
      { tool: 'send_message', args: { to: 'reviewer', message: 'two' } },
      { tool: 'send_message', args: { to: 'reviewer', message: 'three' } },
      { text: 'done' },
    ])
    await rt.admit({ text: 'send three', files: [] }).done
    const cards = frames.filter((f) => f.tool === 'send_message' && f.state.status === 'completed').map((f) => JSON.parse(f.state.output!))
    expect(cards.map((c) => [c.ok, c.card.status, c.card.title, c.card.subtitle])).toEqual([
      [true, 'running', 'Message to reviewer waits for approval', 'The person of reviewer approves it first. It expires after 5 minutes.'],
      [false, 'denied', 'Not sent to reviewer', 'Not sent: reviewer refuses messages.'],
      [false, 'done', 'Not sent again to reviewer', 'The same message went to this session less than a minute ago.'],
    ])
    expect(cards.every((c) => c.error === undefined)).toBe(true)
  })

  test('an ambiguous name is a 409 result that lists the candidates; a refused call carries the API reason', async () => {
    let n = 0
    api.onSend(() =>
      n++ === 0
        ? { status: 409, body: { error: true, code: 'ambiguous_recipient', message: '"reviewer" names 2 sessions.', candidates: [REACHABLE.agents[0], { ...REACHABLE.agents[0], session_id: OTHER, short_id: OTHER.slice(0, 8) }] } }
        : { status: 403, body: { error: 'You may not prompt that session.' } },
    )
    const { rt, frames } = await boot([{ tool: 'send_message', args: { to: 'reviewer', message: 'hi' } }, { tool: 'send_message', args: { to: OTHER, message: 'hi' } }, { text: 'done' }])
    await rt.admit({ text: 'send', files: [] }).done
    const [ambiguous, denied] = frames.filter((f) => f.tool === 'send_message' && f.state.status === 'completed').map((f) => JSON.parse(f.state.output!))
    expect(ambiguous).toMatchObject({
      ok: false,
      card: { title: 'Not sent: "reviewer" names 2 sessions', status: 'error', rows: [{ title: 'reviewer' }, { title: 'reviewer' }] },
      error: { kind: 'invalid', message: '"reviewer" names 2 sessions. Send again with one session id as `to`.' },
      data: { code: 'ambiguous_recipient' },
    })
    expect(denied).toMatchObject({ ok: false, card: { title: `Not sent to ${OTHER}`, status: 'denied' }, error: { kind: 'denied', message: 'You may not prompt that session.' } })
  })

  test('a message over the cap, an empty one and approve without shutdown_response are refused before any call', async () => {
    const { rt, frames } = await boot([
      { tool: 'send_message', args: { to: 'reviewer', message: 'x'.repeat(16_001) } },
      { tool: 'send_message', args: { to: 'reviewer', message: '   ' } },
      { tool: 'send_message', args: { to: 'reviewer', message: 'ok', approve: true } },
      { text: 'done' },
    ])
    await rt.admit({ text: 'send', files: [] }).done
    expect(api.seen.some((s) => s.path.endsWith('/peer-messages'))).toBe(false)
    const errors = frames.filter((f) => f.tool === 'send_message' && f.state.status === 'completed').map((f) => JSON.parse(f.state.output!).error.message)
    expect(errors).toEqual([
      'The message is 16001 characters; one message takes at most 16000. Send the essentials, or split it.',
      'The message is empty.',
      'approve goes only with type "shutdown_response".',
    ])
  })

  test('a person steering the turn while send_message runs reaches the next step; the tool never blocks the steer', async () => {
    api.hold(400)
    const { rt } = await boot([{ tool: 'send_message', args: { to: 'reviewer', message: 'status?' } }, { text: 'read the steer' }])
    const turn = rt.admit({ text: 'ask the reviewer', files: [] })
    await waitFor(() => api.seen.some((s) => s.path.endsWith('/peer-messages')))
    const id = rt.activeTurnMessageId()!
    const started = performance.now()
    expect(await rt.steer({ messageID: id.slice(0, -1) + (id.endsWith('z') ? 'Z' : 'z'), text: 'STEER: also mention the docs', files: [] })).toBe('steered')
    // The steer is accepted while the tool's call is still in flight (the fake API holds it 400 ms).
    expect(performance.now() - started).toBeLessThan(300)
    expect(await turn.done).toBe('completed')
    expect(JSON.stringify(model.bodies.at(-1))).toContain('STEER: also mention the docs')
  })
})

describe('pi messaging availability', () => {
  test('a box with a control plane advertises session.messaging; one without has neither the tools nor the capability', async () => {
    const online = await boot([])
    expect(online.rt.multiAgentCapabilities()).toEqual(['session.messaging'])
    expect(await online.service.diagnostics.capabilities()).toEqual(expect.arrayContaining(['session.subagents', 'session.messaging']))
    expect(await online.service.diagnostics.capabilities()).not.toContain('session.team_tasks')

    const offline = await boot([], { KORTIX_API_URL: '' })
    expect(offline.rt.multiAgentCapabilities()).toEqual([])
    expect(offline.rt.toolNames()).not.toContain('send_message')
    expect(offline.rt.toolNames()).not.toContain('list_agents')
    expect(offline.rt.toolNames()).not.toContain('task_stop')
  })

  test('an agent whose tools deny `agent` gets no messaging tools either; naming send_message grants it alone', async () => {
    const config = (tools: Record<string, boolean>) =>
      JSON.stringify({ agent: { builder: { mode: 'primary', prompt: 'You build.', tools } } })
    const denied = await boot([], { KORTIX_COMPILED_AGENT_CONFIG: config({ agent: false, task: false }), KORTIX_AGENT_NAME: 'builder' })
    expect(denied.rt.toolNames()).not.toContain('send_message')
    expect(denied.rt.toolNames()).not.toContain('workflow')
    const named = await boot([], { KORTIX_COMPILED_AGENT_CONFIG: config({ agent: false, task: false, send_message: true }), KORTIX_AGENT_NAME: 'builder' })
    expect(named.rt.toolNames()).toContain('send_message')
    expect(named.rt.toolNames()).not.toContain('list_agents')
  })
})

describe('pi agent tool background default', () => {
  test('at depth 0 a separate subagent runs in the background unless the call says false; deeper it waits', async () => {
    const top = await boot([{ tool: 'agent', args: { description: 'Audit logs', prompt: 'audit the logs', subagent_type: 'general', name: 'auditor' } }, { text: 'started' }])
    await top.rt.admit({ text: 'audit', files: [] }).done
    const create = api.seen.find((s) => s.method === 'POST' && s.path === `/v1/projects/${PROJECT_ID}/sessions`)!
    expect(create.body.metadata).toEqual({ notify_parent: true, agent_handle: 'auditor' })
    expect(create.body.runtime_context).toMatchObject({ 'kortix.subagent.depth': 1, 'kortix.agent.handle': 'auditor' })
    const part = top.frames.filter((f) => f.tool === 'agent' && f.state.status === 'completed').at(-1)!.state
    expect(part.output).toContain('<task_started>')
    expect(part.output).toContain('send_message({ to: "auditor" })')
    expect(part.metadata).toMatchObject({ sessionId: 'child-1', background: true, name: 'auditor' })
  })
})
