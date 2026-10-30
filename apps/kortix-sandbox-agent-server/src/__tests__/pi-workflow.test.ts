/**
 * The `workflow` tool and the `agent` tool's `background: true`, through the
 * production pi runtime: pi boots against a local fake model gateway, and a
 * `Bun.serve` fake of the Kortix API on a real port answers the child-session
 * routes the box calls (`POST …/sessions`, `GET …/sessions/:id`,
 * `GET …/transcript`, `POST …/stop`). Each `agent()` of a script is a child
 * session of that fake API, exactly as on a real box.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkflowRunMetadata } from '@kortix/api-contract/kortix-tool-card'
import { loadConfig } from '@/harness/harness'
import { requirePiConfig } from '@/harness/pi/config'
import type { PiRuntime } from '@/harness/pi/runtime'
import { createPiHarnessService, type PiHarnessService } from '@/harness/pi/service'
import { resetKortixEventBusForTests } from '@/services/event-bus/kortix-event-bus'
import { startFakeModel, type Step } from './helpers/fake-model'

const MODEL_ID = 'test-model'
const PROJECT_ID = 'proj-pi-workflow'

type ToolState = { status: string; output?: string; error?: string; metadata?: Record<string, unknown> }
type ToolFrame = { at: number; tool: string; state: ToolState }

/**
 * The child-session routes. `settled` decides whether a child's GET reports
 * its turn ended (idle with a new `since`) or still working; `delayMs` holds
 * each GET, so a run lasts long enough to stream live updates.
 */
function startFakeApi() {
  const creates: Array<Record<string, any>> = []
  const stops: string[] = []
  const reads: string[] = []
  const prompts = new Map<string, string>()
  let settled = true
  let delayMs = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname
      const base = `/v1/projects/${PROJECT_ID}/sessions`
      if (req.method === 'POST' && path === base) {
        const body = (await req.json()) as Record<string, any>
        creates.push(body)
        const id = `child-${creates.length}`
        prompts.set(id, String(body.initial_prompt))
        return Response.json({ session_id: id }, { status: 201 })
      }
      const id = path.slice(base.length + 1).split('/')[0]!
      if (req.method === 'POST' && path.endsWith('/stop')) {
        stops.push(id)
        return Response.json({ ok: true })
      }
      if (delayMs) await Bun.sleep(delayMs)
      if (path.endsWith('/transcript')) {
        return Response.json({ messages: [{ role: 'user', text: prompts.get(id) }, { role: 'assistant', text: `answer: ${prompts.get(id)}` }] })
      }
      if (req.method === 'GET' && path === `${base}/${id}`) {
        reads.push(id)
        return Response.json(
          settled
            ? { status: 'running', working: { state: 'idle', since: '2026-10-30T10:00:00.000Z', pending_delivery: false } }
            : { status: 'running', working: { state: 'working', since: null, pending_delivery: false } },
        )
      }
      return new Response('not found', { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    creates,
    stops,
    reads,
    hold: (ms: number) => void (delayMs = ms),
    childrenWork: () => void (settled = false),
    stop: () => server.stop(true),
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
  const home = mkdtempSync(join(tmpdir(), 'pi-workflow-home-'))
  dirs.push(home)
  const absent = join(tmpdir(), 'pi-workflow-absent-box-state')
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

/** A booted pi runtime whose control plane is the fake API, and every tool-part frame it publishes. */
async function boot(steps: Step[], env: Record<string, string> = {}): Promise<{ rt: PiRuntime; frames: ToolFrame[] }> {
  const workspace = mkdtempSync(join(tmpdir(), 'pi-workflow-box-'))
  dirs.push(workspace)
  const frames: ToolFrame[] = []
  const boxEnv: NodeJS.ProcessEnv = {
    KORTIX_HARNESS: 'pi',
    KORTIX_LLM_BASE_URL: model.url,
    KORTIX_PI_STATE_DIR: join(workspace, '.state'),
    KORTIX_PI_AGENT_DIR: join(workspace, '.pi-agent'),
    KORTIX_PI_PACKAGES_DIR: join(workspace, '.pi-packages'),
    KORTIX_PROJECT_AUTO_CLONE: '0',
    KORTIX_WORKSPACE: workspace,
    KORTIX_PROJECT_TARGET: workspace,
    KORTIX_TOKEN: 'dummy-box-token',
    KORTIX_SESSION_ID: 'sess-parent',
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
        if (frame.type === 'message.part.updated' && part?.type === 'tool' && part.tool && part.state) frames.push({ at: Date.now(), tool: part.tool, state: part.state })
      },
    },
  })
  services.push(service)
  await service.lifecycle.start()
  return { rt: service.runtime()!, frames }
}

const runWorkflow = (script: string, args?: unknown): Step => ({ tool: 'workflow', args: { description: 'Research two topics', script, ...(args === undefined ? {} : { args }) } })
/** The workflow document of every live update, then of the final part. */
const workflowDocs = (frames: ToolFrame[]) =>
  frames.filter((f) => f.tool === 'workflow' && f.state.metadata?.runId).map((f) => ({ at: f.at, status: f.state.status, doc: f.state.metadata as unknown as WorkflowRunMetadata, output: f.state.output }))

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await Bun.sleep(10)
  }
}

describe('pi workflow tool', () => {
  test('two parallel agents under a phase: each is a child session, the run streams live metadata, and the script value is the result', async () => {
    // Each child read waits 300 ms, so the run outlasts one 250 ms update window.
    api.hold(300)
    const script = [
      "phase('Research')",
      "const [a, b] = await parallel([() => agent('Research topic A', { label: 'Topic A' }), () => agent('Research topic B', { label: 'Topic B' })])",
      "log('both done')",
      'return { a, b, n: args.n }',
    ].join('\n')
    const { rt, frames } = await boot([runWorkflow(script, { n: 2 }), { text: 'parent done' }])
    expect(await rt.admit({ text: 'research both', files: [] }).done).toBe('completed')

    // Two real child sessions, each linked to this box's session through its token, one level deep.
    expect(api.creates.map((c) => [c.initial_prompt, c.name, c.runtime_context['kortix.subagent.depth']])).toEqual([
      ['Research topic A', 'Topic A (Research two topics workflow)', 1],
      ['Research topic B', 'Topic B (Research two topics workflow)', 1],
    ])
    for (const create of api.creates) expect(create).not.toHaveProperty('notify_parent_on_turn_end')

    const docs = workflowDocs(frames)
    const final = docs.at(-1)!
    expect(final.status).toBe('completed')
    expect(final.doc).toMatchObject({
      title: 'Research two topics',
      status: 'done',
      phases: [{ title: 'Research', status: 'done' }],
      agents: [
        { id: 'a1', label: 'Topic A', phase: 'Research', status: 'done', sessionId: 'child-1', summary: 'answer: Research topic A' },
        { id: 'a2', label: 'Topic B', phase: 'Research', status: 'done', sessionId: 'child-2', summary: 'answer: Research topic B' },
      ],
    })
    expect(final.doc.endedAt).toBeGreaterThanOrEqual(final.doc.startedAt)
    expect(final.output).toBe(
      ['<workflow_result>', JSON.stringify({ a: 'answer: Research topic A', b: 'answer: Research topic B', n: 2 }, null, 2), '</workflow_result>', 'agents: 2 (2 done)'].join('\n'),
    )

    // Live: a running document named both children while they worked, and updates came at most 4 per second.
    const live = docs.filter((d) => d.status === 'running')
    expect(live.some((d) => d.doc.status === 'running' && d.doc.agents.length === 2 && d.doc.agents.every((a) => a.status === 'running' && a.sessionId))).toBe(true)
    for (let i = 1; i < live.length; i++) expect(live[i]!.at - live[i - 1]!.at).toBeGreaterThanOrEqual(200)
    expect(live.every((d) => d.doc.runId === final.doc.runId)).toBe(true)
  })

  test('the 17th agent() is refused in the script; 16 child sessions exist', async () => {
    const script = [
      'const results = []',
      'for (let i = 1; i <= 17; i++) {',
      "  try { results.push(await agent('task ' + i)) } catch (error) { results.push('refused: ' + error.message) }",
      '}',
      'return results.slice(15)',
    ].join('\n')
    const { rt, frames } = await boot([runWorkflow(script), { text: 'parent done' }])
    expect(await rt.admit({ text: 'run it', files: [] }).done).toBe('completed')
    expect(api.creates).toHaveLength(16)
    const final = workflowDocs(frames).at(-1)!
    expect(final.doc.agents).toHaveLength(16)
    expect(final.output).toContain(
      JSON.stringify(['answer: task 16', 'refused: agent() refused: one workflow runs at most 16 agents, and this run started 16. Give each agent more of the work, or run another workflow for the rest.'], null, 2),
    )
  })

  test('stopping the turn stops every child the run started', async () => {
    api.childrenWork()
    const script = "return parallel([() => agent('slow one'), () => agent('slow two')])"
    const { rt, frames } = await boot([runWorkflow(script), { text: 'never reached' }])
    const turn = rt.admit({ text: 'run it', files: [] })
    // Both children exist and were polled once (each then waits 2 s before its next poll).
    await waitFor(() => api.reads.includes('child-1') && api.reads.includes('child-2'))
    await rt.abort()
    expect(await turn.done).toBe('aborted')
    await waitFor(() => api.stops.length === 2)
    expect(api.stops.sort()).toEqual(['child-1', 'child-2'])
    const final = workflowDocs(frames).at(-1)!
    expect(final.doc.status).toBe('stopped')
    expect(final.doc.agents.map((a) => a.status)).toEqual(['stopped', 'stopped'])
  })

  test('a session at the subagent depth cap cannot run a workflow, and starts no child', async () => {
    const { rt, frames } = await boot([runWorkflow("return agent('x')"), { text: 'parent done' }], {
      KORTIX_SESSION_CONTEXT: JSON.stringify({ 'kortix.subagent.depth': 2 }),
    })
    expect(await rt.admit({ text: 'run it', files: [] }).done).toBe('completed')
    expect(api.creates).toHaveLength(0)
    const part = frames.filter((f) => f.tool === 'workflow').at(-1)!
    expect(part.state.status).toBe('error')
    expect(part.state.error).toContain('Separate subagent sessions nest at most 2 levels and this session is level 2, so it cannot run a workflow.')
  })
})

describe('pi agent tool, background: true', () => {
  test('returns at once with the child id, never waits on the child, and asks the API to notify this session', async () => {
    // The child never settles: a waiting call would hang until the test times out.
    api.childrenWork()
    const call: Step = { tool: 'agent', args: { description: 'Long research', prompt: 'research it all', subagent_type: 'general', background: true } }
    const { rt, frames } = await boot([call, { text: 'parent done' }])
    expect(await rt.admit({ text: 'start it', files: [] }).done).toBe('completed')
    expect(api.creates).toHaveLength(1)
    expect(api.creates[0]).toMatchObject({ initial_prompt: 'research it all', notify_parent_on_turn_end: true })
    expect(api.reads).toEqual([])
    const part = frames.filter((f) => f.tool === 'agent').at(-1)!
    expect(part.state.status).toBe('completed')
    expect(part.state.metadata).toMatchObject({ sessionId: 'child-1', background: true, session: 'separate' })
    expect(part.state.output).toStartWith('task_id: child-1 (for resuming to continue this task if needed)\nsession: separate\n\n<task_started>\n')
    expect(part.state.output).toContain('arrives in this session as a <task-notification> message')
    // The running part named the child while the call ran.
    expect(frames.some((f) => f.tool === 'agent' && f.state.status === 'running' && f.state.metadata?.sessionId === 'child-1' && f.state.metadata?.background === true)).toBe(true)
  })
})
