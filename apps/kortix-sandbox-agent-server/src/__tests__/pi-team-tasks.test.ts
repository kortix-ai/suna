/**
 * Agent teams on pi (flag `agent_teams`): the shared task list tools
 * (`task_create`, `task_list`, `task_get`, `task_update`) and the teammate
 * spawn, through the production pi runtime against a fake model gateway and a
 * `Bun.serve` fake of the Kortix API that keeps one task list per lead
 * (`/v1/projects/:id/sessions/:lead/tasks`, `@kortix/api-contract/multi-agent`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionTask } from '@kortix/api-contract/multi-agent'
import { loadConfig } from '@/harness/harness'
import { requirePiConfig } from '@/harness/pi/config'
import type { PiRuntime } from '@/harness/pi/runtime'
import { createPiHarnessService, type PiHarnessService } from '@/harness/pi/service'
import { resetKortixEventBusForTests } from '@/services/event-bus/kortix-event-bus'
import { startFakeModel, type Step } from './helpers/fake-model'

const MODEL_ID = 'test-model'
const PROJECT_ID = 'proj-pi-teams'
const LEAD = '1e2d3c4b-0000-4000-8000-000000000001'
const MATE = '5a6b7c8d-0000-4000-8000-000000000002'

type ToolState = { status: string; output?: string; metadata?: Record<string, any> }
type ToolFrame = { tool: string; state: ToolState }
type Seen = { method: string; path: string; auth: string | null; body: any }

/** One task list per lead; a claim takes only a pending, unowned, unblocked task, as the API does. */
function startFakeApi() {
  const seen: Seen[] = []
  const lists = new Map<string, SessionTask[]>()
  const creates: any[] = []
  const at = '2026-10-30T10:00:00.000Z'
  const blocked = (list: SessionTask[], task: SessionTask) => task.blocked_by.some((seq) => list.find((t) => t.seq === seq)?.status !== 'completed')
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const body: any = req.method === 'GET' ? null : await req.json().catch(() => null)
      seen.push({ method: req.method, path: url.pathname, auth: req.headers.get('authorization'), body })
      const base = `/v1/projects/${PROJECT_ID}/sessions`
      if (req.method === 'GET' && url.pathname === base) return Response.json([])
      if (req.method === 'POST' && url.pathname === base) {
        creates.push(body)
        return Response.json({ session_id: `child-${creates.length}` }, { status: 201 })
      }
      const match = new RegExp(`^${base}/([^/]+)/tasks(?:/(\\d+))?$`).exec(url.pathname)
      if (!match) return new Response('not found', { status: 404 })
      const lead = match[1]!
      const list = lists.get(lead) ?? []
      lists.set(lead, list)
      const view = (task: SessionTask) => ({ ...task, blocked: blocked(list, task) })
      if (req.method === 'GET') return Response.json({ tasks: list.map(view) })
      if (req.method === 'POST') {
        const task: SessionTask = {
          seq: list.length + 1,
          lead_session_id: lead,
          subject: body.subject,
          description: body.description ?? '',
          status: 'pending',
          owner_handle: body.owner ?? null,
          owner_session_id: body.owner ? MATE : null,
          blocked_by: body.blocked_by ?? [],
          blocked: false,
          created_by_session_id: null,
          created_at: at,
          updated_at: at,
        }
        list.push(task)
        return Response.json(view(task), { status: 201 })
      }
      const task = list.find((t) => t.seq === Number(match[2]))
      if (!task) return Response.json({ error: 'no such task' }, { status: 404 })
      if (body.claim) {
        if (blocked(list, task)) return Response.json({ error: 'blocked', code: 'task_blocked' }, { status: 409 })
        if (task.status !== 'pending' || task.owner_session_id) return Response.json({ error: 'taken', code: 'task_taken' }, { status: 409 })
        task.owner_handle = 'researcher'
        task.owner_session_id = MATE
        task.status = 'in_progress'
      }
      if (body.status) task.status = body.status
      return Response.json(view(task))
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, seen, lists, creates, stop: () => server.stop(true) }
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
  const home = mkdtempSync(join(tmpdir(), 'pi-teams-home-'))
  dirs.push(home)
  const absent = join(tmpdir(), 'pi-teams-absent-box-state')
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

const TEAMS = { KORTIX_FEATURE_FLAGS: 'agent_rooms,agent_teams' }
/** A teammate box: one level deep, its lead in its runtime context. */
const TEAMMATE = {
  ...TEAMS,
  KORTIX_SESSION_ID: MATE,
  KORTIX_SESSION_CONTEXT: JSON.stringify({ 'kortix.subagent.depth': 1, 'kortix.team.lead': LEAD, 'kortix.agent.handle': 'researcher' }),
}

async function boot(steps: Step[], env: Record<string, string> = {}): Promise<{ rt: PiRuntime; frames: ToolFrame[]; service: PiHarnessService }> {
  const workspace = mkdtempSync(join(tmpdir(), 'pi-teams-box-'))
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
    KORTIX_SESSION_ID: LEAD,
    KORTIX_PROJECT_ID: PROJECT_ID,
    KORTIX_API_URL: api.url,
    KORTIX_PI_TURN_RETRY_BASE_MS: '5',
    ...env,
  }
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

const results = (frames: ToolFrame[], tool: string) => frames.filter((f) => f.tool === tool && f.state.status === 'completed').map((f) => JSON.parse(f.state.output!))
const TASK_TOOLS = ['task_create', 'task_list', 'task_get', 'task_update']

describe('pi team tasks: who has them', () => {
  test('flag off: no task tools and no session.team_tasks, also at depth 0', async () => {
    const { rt, service } = await boot([], { KORTIX_FEATURE_FLAGS: 'agent_rooms' })
    for (const tool of TASK_TOOLS) expect(rt.toolNames()).not.toContain(tool)
    expect(await service.diagnostics.capabilities()).not.toContain('session.team_tasks')
  })

  test('flag on: a lead (depth 0) and a teammate have them; a plain subagent one level deep does not', async () => {
    const lead = await boot([], TEAMS)
    expect(lead.rt.toolNames()).toEqual(expect.arrayContaining(TASK_TOOLS))
    expect(lead.rt.multiAgentCapabilities()).toEqual(['session.messaging', 'session.team_tasks'])

    const mate = await boot([], TEAMMATE)
    expect(mate.rt.toolNames()).toEqual(expect.arrayContaining([...TASK_TOOLS, 'send_message']))

    const plain = await boot([], { ...TEAMS, KORTIX_SESSION_CONTEXT: JSON.stringify({ 'kortix.subagent.depth': 1 }) })
    for (const tool of TASK_TOOLS) expect(plain.rt.toolNames()).not.toContain(tool)
    expect(plain.rt.multiAgentCapabilities()).toEqual(['session.messaging'])
  })
})

describe('pi team tasks: the list', () => {
  test('the lead creates, lists and reads tasks on its own list; the cards name each task', async () => {
    const { rt, frames } = await boot(
      [
        { tool: 'task_create', args: { subject: 'Review the auth module', description: 'Token handling and sessions.' } },
        { tool: 'task_create', args: { subject: 'Write the summary', blocked_by: [1], owner: '@researcher' } },
        { tool: 'task_list', args: {} },
        { tool: 'task_get', args: { seq: 2 } },
        { tool: 'task_get', args: { seq: 9 } },
        { text: 'planned' },
      ],
      TEAMS,
    )
    expect(await rt.admit({ text: 'plan the review', files: [] }).done).toBe('completed')
    const posts = api.seen.filter((s) => s.method === 'POST' && s.path.endsWith('/tasks'))
    expect(posts.map((p) => [p.path, p.auth, p.body])).toEqual([
      [`/v1/projects/${PROJECT_ID}/sessions/${LEAD}/tasks`, 'Bearer box-token', { subject: 'Review the auth module', description: 'Token handling and sessions.' }],
      [`/v1/projects/${PROJECT_ID}/sessions/${LEAD}/tasks`, 'Bearer box-token', { subject: 'Write the summary', blocked_by: [1], owner: 'researcher' }],
    ])
    expect(results(frames, 'task_create').map((r) => r.card.title)).toEqual(['Added task #1: Review the auth module', 'Added task #2: Write the summary'])
    const [list] = results(frames, 'task_list')
    expect(list.card).toEqual({
      title: '2 tasks',
      subtitle: '0 done, 0 in progress, 2 to do (1 free to claim).',
      status: 'done',
      rows: [
        { title: '#1 Review the auth module', detail: 'no owner', badge: 'to do' },
        { title: '#2 Write the summary', detail: 'owner researcher · waits for #1', badge: 'blocked' },
      ],
    })
    expect(list.data.tasks.map((t: SessionTask) => t.seq)).toEqual([1, 2])
    const [found, missing] = results(frames, 'task_get')
    expect(found).toMatchObject({ ok: true, card: { title: 'Task #2: Write the summary' }, data: { seq: 2, blocked: true } })
    expect(missing).toMatchObject({ ok: false, card: { title: 'No task #9' }, error: { kind: 'not_found' } })
  })

  test("a teammate claims on its lead's list; a taken or blocked claim is a result that says what to do", async () => {
    const at = '2026-10-30T10:00:00.000Z'
    const task = (seq: number, over: Partial<SessionTask> = {}): SessionTask => ({
      seq, lead_session_id: LEAD, subject: `Task ${seq}`, description: '', status: 'pending', owner_handle: null, owner_session_id: null,
      blocked_by: [], blocked: false, created_by_session_id: null, created_at: at, updated_at: at, ...over,
    })
    api.lists.set(LEAD, [task(1), task(2, { blocked_by: [1] })])
    const { rt, frames } = await boot(
      [
        { tool: 'task_update', args: { seq: 1, claim: true } },
        { tool: 'task_update', args: { seq: 1, claim: true } },
        { tool: 'task_update', args: { seq: 2, claim: true } },
        { tool: 'task_update', args: { seq: 1, status: 'completed' } },
        { tool: 'task_update', args: { seq: 1 } },
        { text: 'done' },
      ],
      TEAMMATE,
    )
    expect(await rt.admit({ text: 'work the list', files: [] }).done).toBe('completed')
    const patches = api.seen.filter((s) => s.method === 'PATCH')
    expect(patches.every((p) => p.path.startsWith(`/v1/projects/${PROJECT_ID}/sessions/${LEAD}/tasks/`))).toBe(true)
    expect(patches.map((p) => p.body)).toEqual([{ claim: true }, { claim: true }, { claim: true }, { status: 'completed' }])
    const updates = results(frames, 'task_update')
    expect(updates.map((u) => [u.ok, u.action, u.card.title])).toEqual([
      [true, 'claim', 'Claimed task #1: Task 1'],
      [false, 'claim', 'Task #1 is taken'],
      [false, 'claim', 'Task #2 is blocked'],
      [true, 'completed', 'Completed task #1: Task 1'],
      [false, 'update', 'Task #1 unchanged'],
    ])
    expect(updates[1].error.message).toBe('Task #1 is already taken or no longer pending. Run task_list and claim another free task.')
    expect(updates[2].error.message).toBe('Task #2 waits for tasks that are not completed yet. Claim a free task instead.')
  })
})

describe('pi agent teams: the teammate spawn', () => {
  test('a named spawn at depth 0 starts a background teammate that knows its lead, its name and the task list', async () => {
    const { rt, frames } = await boot([{ tool: 'agent', args: { description: 'Research', prompt: 'Research the auth flows.', subagent_type: 'general', name: 'researcher', run_in_background: false } }, { text: 'started' }], TEAMS)
    await rt.admit({ text: 'start a researcher teammate', files: [] }).done
    const [create] = api.creates
    expect(create.metadata).toEqual({ notify_parent: true, agent_handle: 'researcher', team_lead: LEAD })
    expect(create.runtime_context).toMatchObject({ 'kortix.subagent.depth': 1, 'kortix.agent.handle': 'researcher', 'kortix.team.lead': LEAD })
    expect(create.initial_context).toContain('You are "researcher", a teammate in an agent team. Your lead is session 1e2d3c4b')
    expect(create.initial_context).toContain('task_update({ seq, claim: true })')
    const part = frames.filter((f) => f.tool === 'agent' && f.state.status === 'completed').at(-1)!.state
    expect(part.output).toContain('Teammate "researcher" started in its own session (child-1).')
    expect(part.metadata).toMatchObject({ background: true, name: 'researcher', teammate: true })
  })

  test('a fork is never a teammate, and a teammate starts no teammates of its own', async () => {
    const lead = await boot([{ tool: 'agent', args: { description: 'Try B', prompt: 'Try approach B.', name: 'branch-b', fork: true } }, { text: 'forked' }], TEAMS)
    await lead.rt.admit({ text: 'fork', files: [] }).done
    expect(api.creates[0]).toMatchObject({ fork_from_session_id: LEAD, metadata: { notify_parent: true, agent_handle: 'branch-b' } })
    expect(api.creates[0].metadata).not.toHaveProperty('team_lead')

    const mate = await boot([{ tool: 'agent', args: { description: 'Help', prompt: 'Look up X.', subagent_type: 'general', name: 'helper' } }, { text: 'done' }], TEAMMATE)
    await mate.rt.admit({ text: 'get help', files: [] }).done
    expect(api.creates[1].metadata ?? {}).not.toHaveProperty('team_lead')
  })
})
