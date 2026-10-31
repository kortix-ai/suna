/**
 * The `workflow` tool, through the
 * production pi runtime: pi boots against a local fake model gateway, and a
 * `Bun.serve` fake of the Kortix API on a real port answers the routes the box
 * calls: the child-session routes (`POST …/sessions`, `GET …/sessions/:id`,
 * `POST …/prompts`, `GET …/transcript`, `POST …/stop`) and the project files
 * (`GET …/files/content`). Each `agent()` of a script is a
 * child session of that fake API, exactly as on a real box. A person's answer
 * to the run approval goes through the runtime's question broker, as the
 * product's reply route sends it.
 *
 * Where a run executes: a top-level session hands every workflow to a runner
 * session (the "background" rows: a parent box, then the runner's own box
 * with the runner's context and first prompt). A session that cannot start a
 * runner (depth 1 here: its runner and agents would pass the depth cap) runs
 * the script inline, and most mechanics rows run there ({@link INLINE}).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkflowRunMetadata } from '@kortix/api-contract/kortix-tool-card'
import type { RuntimeQuestionRequest } from '@kortix/api-contract/transcript'
import { loadConfig } from '@/harness/harness'
import { requirePiConfig } from '@/harness/pi/config'
import type { PiRuntime } from '@/harness/pi/runtime'
import { createPiHarnessService, type PiHarnessService } from '@/harness/pi/service'
import { resetKortixEventBusForTests } from '@/services/event-bus/kortix-event-bus'
import { createRuntimeRouter } from '@/routes/kortix/runtime'
import { peerMessagePromptText } from '@kortix/shared/peer-message-prompt'
import { roomPromptText } from '@kortix/shared/room-prompt'
import { startFakeModel, type Step } from './helpers/fake-model'

const MODEL_ID = 'test-model'
const PROJECT_ID = 'proj-pi-workflow'
const PARENT_SESSION = 'sess-parent'

type ToolState = { status: string; output?: string; error?: string; metadata?: Record<string, unknown> }
type ToolFrame = { at: number; tool: string; state: ToolState }

/** How one child behaves, decided per read from its first prompt and its turn (1 = the create). */
interface ChildBehavior {
  /** The session row reports `failed`. */
  fail?: boolean
  /** The session row reports `stopped` (stopped from outside). */
  stop?: boolean
  /** The child keeps working with no new output; each row read moves the clock 16 min ahead. */
  stall?: boolean
  /** The answer of this turn. Default: `answer: <first prompt>`. */
  answer?: string
  /** How the API's turn ledger says its last turn ended (`GET …/turn` `last_ended`); absent = no row. */
  lastEnd?: { reason: string; error?: string }
}

interface FakeChild {
  id: string
  body: Record<string, any>
  prompts: string[]
}

function startFakeApi(parent = PARENT_SESSION) {
  const creates: Array<Record<string, any>> = []
  const stops: string[] = []
  const reads: string[] = []
  const followUps: Array<{ id: string; text: string }> = []
  const children = new Map<string, FakeChild>()
  const files = new Map<string, string>()
  let behave: (prompt: string, turn: number, child: FakeChild) => ChildBehavior = () => ({})
  let settled = true
  const busy = new Set<string>()
  let delayMs = 0
  const behavior = (child: FakeChild) => behave(child.prompts[0]!, child.prompts.length, child)
  const since = (turn: number) => new Date(Date.UTC(2026, 9, 30, 10, 0, turn)).toISOString()
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      const project = `/v1/projects/${PROJECT_ID}`
      const base = `${project}/sessions`
      if (req.method === 'GET' && path === `${project}/files/content`) {
        const file = url.searchParams.get('path')!
        return files.has(file) ? Response.json({ path: file, ref: 'main', content: files.get(file) }) : Response.json({ error: 'File not found' }, { status: 404 })
      }
      if (req.method === 'POST' && path === base) {
        const body = (await req.json()) as Record<string, any>
        creates.push(body)
        const id = `child-${creates.length}`
        children.set(id, { id, body, prompts: [String(body.initial_prompt)] })
        return Response.json({ session_id: id }, { status: 201 })
      }
      const id = path.slice(base.length + 1).split('/')[0]!
      const child = children.get(id)
      if (req.method === 'POST' && path.endsWith('/stop')) {
        stops.push(id)
        return Response.json({ ok: true })
      }
      if (!child) return new Response('not found', { status: 404 })
      if (req.method === 'POST' && path.endsWith('/prompts')) {
        const body = (await req.json()) as { parts: Array<{ text: string }> }
        followUps.push({ id, text: body.parts[0]!.text })
        child.prompts.push(body.parts[0]!.text)
        return Response.json({ ok: true }, { status: 202 })
      }
      if (delayMs) await Bun.sleep(delayMs)
      const now = behavior(child)
      if (path.endsWith('/turn')) {
        const end = now.lastEnd
        return Response.json({ turns: [], ...(end ? { last_ended: { turn_token: 't1', end_reason: end.reason, ended_at: null, ...(end.error ? { error: { name: 'WorkflowError', message: end.error } } : {}) } } : {}) })
      }
      if (path.endsWith('/transcript')) {
        const user = { role: 'user', text: child.prompts.at(-1) }
        if (now.stall) return Response.json({ messages: [user] })
        return Response.json({ messages: [user, { role: 'assistant', text: now.answer ?? `answer: ${child.prompts[0]}` }] })
      }
      if (req.method === 'GET' && path === `${base}/${id}`) {
        reads.push(id)
        const row = { parent_session_id: parent, metadata: child.body.metadata ?? null }
        if (now.fail) return Response.json({ ...row, status: 'failed' })
        if (now.stop) return Response.json({ ...row, status: 'stopped' })
        if (now.stall) {
          // No real time passes: the box's stall clock reads the jumped system time.
          setSystemTime(new Date(Date.now() + 16 * 60_000))
          return Response.json({ ...row, status: 'running', working: { state: 'working', since: since(child.prompts.length), pending_delivery: false } })
        }
        return Response.json(
          settled && !busy.has(id)
            ? { ...row, status: 'running', working: { state: 'idle', since: since(child.prompts.length), pending_delivery: false } }
            : { ...row, status: 'running', working: { state: 'working', since: null, pending_delivery: false } },
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
    followUps,
    files,
    behave: (fn: typeof behave) => void (behave = fn),
    hold: (ms: number) => void (delayMs = ms),
    childrenWork: () => void (settled = false),
    childrenSettle: () => void (settled = true),
    /** This child keeps working whatever `childrenSettle` says. */
    keepWorking: (id: string) => void busy.add(id),
    stop: () => server.stop(true),
  }
}

let model: ReturnType<typeof startFakeModel>
let api: ReturnType<typeof startFakeApi>
/** Fake APIs of runner boxes, stopped after each test. */
const runnerApis: Array<ReturnType<typeof startFakeApi>> = []
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
  setSystemTime()
  for (const service of services.splice(0)) await service.lifecycle.stop().catch(() => {})
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  api.stop()
  for (const extra of runnerApis.splice(0)) extra.stop()
  resetKortixEventBusForTests()
})

/** A booted pi runtime whose control plane is the fake API, and every tool-part frame it publishes. */
async function boot(
  steps: Step[],
  env: Record<string, string> = {},
  opts: { checkout?: boolean; files?: Record<string, string>; apiUrl?: string } = {},
): Promise<{ rt: PiRuntime; frames: ToolFrame[]; workspace: string; service: PiHarnessService }> {
  const workspace = mkdtempSync(join(tmpdir(), 'pi-workflow-box-'))
  dirs.push(workspace)
  if (opts.checkout) mkdirSync(join(workspace, '.git'))
  for (const [file, content] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(workspace, file, '..'), { recursive: true })
    writeFileSync(join(workspace, file), content)
  }
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
    KORTIX_TOKEN: 'dummy-box-token',
    KORTIX_SESSION_ID: PARENT_SESSION,
    KORTIX_PROJECT_ID: PROJECT_ID,
    KORTIX_API_URL: opts.apiUrl ?? api.url,
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
  return { rt: service.runtime()!, frames, workspace, service }
}

const runWorkflow = (script: string, args?: unknown, extra: Record<string, unknown> = {}): Step => ({
  tool: 'workflow',
  args: { description: 'Research two topics', script, ...(args === undefined ? {} : { args }), ...extra },
})
/** A child session (depth 1): it cannot start a runner, so its workflows run inline, and nobody approves them. */
const INLINE = { KORTIX_SESSION_CONTEXT: JSON.stringify({ 'kortix.subagent.depth': 1 }) }
const INLINE_NOTE = 'It ran inline in this session, because a runner session and its agents need two more session levels, and this session is level 1 of at most 2.'
/** One turn on an inline box. */
const inlineTurn = (rt: PiRuntime, text = 'run it') => rt.admit({ text, files: [] }).done
/** The workflow document of every live update, then of the final part. */
const workflowDocs = (frames: ToolFrame[]) =>
  frames.filter((f) => f.tool === 'workflow' && f.state.metadata?.runId).map((f) => ({ at: f.at, status: f.state.status, doc: f.state.metadata as unknown as WorkflowRunMetadata, output: f.state.output }))
const lastWorkflowPart = (frames: ToolFrame[]) => frames.filter((f) => f.tool === 'workflow').at(-1)!.state

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

/** The person answers the open run approval with `label`, as the product's question reply does. */
async function answer(rt: PiRuntime, label: string): Promise<RuntimeQuestionRequest> {
  await waitFor(() => rt.questions.list().length === 1)
  const request = rt.questions.list()[0]!
  expect(rt.questions.reply(request.id, [[label]])).toBe(true)
  return request
}

/** One turn whose workflow calls the person approves with "Run it". */
async function approvedTurn(rt: PiRuntime, text = 'run it', approvals = 1): Promise<string> {
  const turn = rt.admit({ text, files: [] })
  for (let i = 0; i < approvals; i++) await answer(rt, 'Run it')
  return turn.done
}

describe('pi workflow tool', () => {
  test('approval at depth 0: the card lists the plan and says the run goes to the background', async () => {
    const script = [
      "export const meta = { name: 'two-topics', description: 'Research two topics', phases: [{ title: 'Research' }, { title: 'Summarize', detail: 'never reached' }] }",
      "phase('Research')",
      "return parallel([() => agent('Research topic A'), () => agent('Research topic B')])",
    ].join('\n')
    const { rt, frames } = await boot([{ tool: 'workflow', args: { script, max_agents: 2 } }, { text: 'parent done' }])
    const turn = rt.admit({ text: 'research both', files: [] })
    // Before any session exists, the card already lists the declared phases as pending, and the person is asked.
    const request = await answer(rt, 'Run it')
    expect(request.questions).toEqual([
      {
        header: 'Workflow',
        question: [
          'Run the workflow "Research two topics"?',
          'Phases: 1. Research, 2. Summarize.',
          'Agents: up to 2. Each agent is its own session with its own computer.',
          'It runs in the background: this chat stays free, and the result arrives here when the run ends.',
        ].join('\n'),
        options: [
          { label: 'Run it', description: 'Start this run now.' },
          { label: "Run it, and don't ask again in this session", description: 'Start it, and start later workflows in this session without asking.' },
          { label: 'Cancel', description: 'Start no agent.' },
        ],
      },
    ])
    expect(request.tool?.callID).toBeTruthy()
    expect(workflowDocs(frames)[0]!.doc).toMatchObject({ title: 'Research two topics', name: 'two-topics', status: 'running', maxAgents: 2, agents: [], phases: [{ title: 'Research', status: 'pending' }, { title: 'Summarize', status: 'pending' }] })
    expect(await turn.done).toBe('completed')
    // ONE session: the runner. The agents are its children, never this session's.
    expect(api.creates).toHaveLength(1)
    expect(api.creates[0]).toMatchObject({ metadata: { notify_parent: true }, name: 'Research two topics (workflow)' })
  })

  test('inline (a session that cannot start a runner): phases, two parallel agents stream live, the script value is the result, and it says it ran inline', async () => {
    // Each child read waits 300 ms, so the run outlasts one 250 ms update window.
    api.hold(300)
    const script = [
      "export const meta = { name: 'two-topics', description: 'Research two topics', phases: [{ title: 'Research' }, { title: 'Summarize', detail: 'never reached' }] }",
      "phase('Research')",
      "const [a, b] = await parallel([() => agent('Research topic A', { label: 'Topic A' }), () => agent('Research topic B', { label: 'Topic B' })])",
      "log('both done')",
      'return { a, b, n: args.n }',
    ].join('\n')
    const { rt, frames } = await boot([{ tool: 'workflow', args: { script, args: { n: 2 }, max_agents: 2 } }, { text: 'parent done' }], INLINE)
    expect(await inlineTurn(rt, 'research both')).toBe('completed')
    // Nobody to ask at depth 1.
    expect(rt.questions.list()).toHaveLength(0)

    // Two real child sessions, each linked to this box's session through its token, one level deeper.
    expect(api.creates.map((c) => [c.initial_prompt, c.name, c.runtime_context['kortix.subagent.depth']])).toEqual([
      ['Research topic A', 'Topic A (Research two topics workflow)', 2],
      ['Research topic B', 'Topic B (Research two topics workflow)', 2],
    ])
    for (const create of api.creates) expect(create).not.toHaveProperty('metadata')

    const docs = workflowDocs(frames)
    const final = docs.at(-1)!
    expect(final.status).toBe('completed')
    expect(final.doc).toMatchObject({
      title: 'Research two topics',
      status: 'done',
      maxAgents: 2,
      logs: ['both done'],
      phases: [{ title: 'Research', status: 'done' }, { title: 'Summarize', status: 'pending' }],
      agents: [
        { id: 'a1', label: 'Topic A', phase: 'Research', status: 'done', sessionId: 'child-1', summary: 'answer: Research topic A', attempt: 1 },
        { id: 'a2', label: 'Topic B', phase: 'Research', status: 'done', sessionId: 'child-2', summary: 'answer: Research topic B', attempt: 1 },
      ],
    })
    for (const agent of final.doc.agents) expect(agent.endedAt!).toBeGreaterThanOrEqual(agent.startedAt!)
    expect(final.doc).not.toHaveProperty('large')
    expect(final.doc.endedAt).toBeGreaterThanOrEqual(final.doc.startedAt)
    expect(final.output).toBe(
      [
        '<workflow_result>',
        JSON.stringify({ a: 'answer: Research topic A', b: 'answer: Research topic B', n: 2 }, null, 2),
        '</workflow_result>',
        'agents: 2 (2 done)',
        INLINE_NOTE,
        `run_id: ${final.doc.runId} (resume_run_id resumes it)`,
      ].join('\n'),
    )

    // Live: a running document named both children while they worked, and updates came at most 4 per second.
    const live = docs.filter((d) => d.status === 'running')
    expect(live.some((d) => d.doc.status === 'running' && d.doc.agents.length === 2 && d.doc.agents.every((a) => a.status === 'running' && a.sessionId))).toBe(true)
    for (let i = 1; i < live.length; i++) expect(live[i]!.at - live[i - 1]!.at).toBeGreaterThanOrEqual(200)
    expect(live.every((d) => d.doc.runId === final.doc.runId)).toBe(true)
  })

  test('approval: Cancel starts no session; "don\'t ask again" hands this and every later workflow of the session to a runner without a question', async () => {
    // The runners stay at work: nothing here is a run to resume.
    api.childrenWork()
    const script = "return agent('one task')"
    const { rt, frames } = await boot([runWorkflow(script), { text: 'cancelled' }, runWorkflow(script), runWorkflow(script), { text: 'done' }])

    const first = rt.admit({ text: 'run it', files: [] })
    await answer(rt, 'Cancel')
    expect(await first.done).toBe('completed')
    expect(api.creates).toHaveLength(0)
    const cancelled = lastWorkflowPart(frames)
    expect(cancelled.status).toBe('completed')
    expect(cancelled.output).toStartWith('<workflow_cancelled>\nThe person cancelled this workflow. No agent started.')
    expect(cancelled.metadata).toMatchObject({ status: 'stopped', error: 'The person cancelled the run before it started.', agents: [] })

    const second = rt.admit({ text: 'run it twice', files: [] })
    await answer(rt, "Run it, and don't ask again in this session")
    expect(await second.done).toBe('completed')
    // The second workflow call of that turn asked nothing: two runners, one per run.
    expect(api.creates).toHaveLength(2)
    expect(api.creates.every((c) => c.metadata?.notify_parent === true)).toBe(true)
    const outputs = frames.filter((f) => f.tool === 'workflow' && f.state.status === 'completed').map((f) => f.state.output!)
    expect(outputs.slice(1).every((output) => output.startsWith('<workflow_started>'))).toBe(true)
    expect(rt.questions.list()).toHaveLength(0)
  })

  test('the approved max_agents is a hard cap: the next agent() is refused in the script; a large plan is flagged', async () => {
    const script = [
      'const results = []',
      'for (let i = 1; i <= 4; i++) {',
      "  try { results.push(await agent('task ' + i)) } catch (error) { results.push('refused: ' + error.message) }",
      '}',
      'return results.slice(2)',
    ].join('\n')
    const { rt, frames } = await boot([runWorkflow(script, undefined, { max_agents: 3 }), runWorkflow("return agent('big')", undefined, { max_agents: 30, fresh: true }), { text: 'parent done' }], {
      ...INLINE,
      KORTIX_WORKFLOW_MAX_AGENTS: '26',
    })
    expect(await inlineTurn(rt)).toBe('completed')
    expect(api.creates.map((c) => c.initial_prompt)).toEqual(['task 1', 'task 2', 'task 3', 'big'])
    const [capped, large] = frames.filter((f) => f.tool === 'workflow' && f.state.status === 'completed')
    expect(capped!.state.metadata).toMatchObject({ maxAgents: 3 })
    expect(capped!.state.metadata).not.toHaveProperty('large')
    expect(capped!.state.output).toContain(
      JSON.stringify(['answer: task 3', 'refused: agent() refused: this run may start at most 3 agents (the approved count), and it started 3. Give each agent more of the work, or run another workflow for the rest.'], null, 2),
    )
    // 30 asked, the box allows 26: the cap is 26, and more than 25 planned is a large run.
    expect(large!.state.metadata).toMatchObject({ maxAgents: 26, large: true })
  })

  test('parallel() and pipeline() reject more than 4,096 items before any agent starts', async () => {
    const script = "return parallel(Array.from({ length: 4097 }, () => () => agent('x')))"
    const { rt, frames } = await boot([runWorkflow(script), { text: 'parent done' }], INLINE)
    expect(await inlineTurn(rt)).toBe('completed')
    expect(api.creates).toHaveLength(0)
    const part = lastWorkflowPart(frames)
    expect(part.metadata).toMatchObject({ status: 'failed', agents: [] })
    expect(part.output).toStartWith('<workflow_error>\nparallel() takes at most 4096 items, and this call has 4097. Split the list.')
  })

  test('a failed agent is null inside parallel(); a stopped one resolves null; a failed one awaited directly ends the run with its error', async () => {
    api.behave((prompt) => ({ fail: prompt.startsWith('bad'), stop: prompt.startsWith('stopped') }))
    const script = [
      "const pair = await parallel([() => agent('bad one'), () => agent('good one')])",
      "log('pair: ' + JSON.stringify(pair))",
      "log('stopped: ' + JSON.stringify(await agent('stopped from outside')))",
      "await agent('bad two')",
      "return 'never reached'",
    ].join('\n')
    const { rt, frames } = await boot([runWorkflow(script), { text: 'parent done' }], INLINE)
    expect(await inlineTurn(rt)).toBe('completed')
    expect(api.creates.map((c) => c.initial_prompt)).toEqual(['bad one', 'good one', 'stopped from outside', 'bad two'])
    const part = lastWorkflowPart(frames)
    const doc = part.metadata as unknown as WorkflowRunMetadata
    expect(doc.status).toBe('failed')
    expect(doc.error).toBe('child session failed')
    expect(doc.logs).toEqual(['parallel item 0: child session failed', 'pair: [null,"answer: good one"]', 'stopped: null'])
    expect(doc.agents.map((a) => [a.label, a.status])).toEqual([
      ['bad one', 'failed'],
      ['good one', 'done'],
      ['stopped from outside', 'stopped'],
      ['bad two', 'failed'],
    ])
    expect(part.output).toStartWith('<workflow_error>\nchild session failed\n</workflow_error>\nagents: 4 (2 failed, 1 done, 1 stopped)')
    expect(part.output).toContain('To retry, launch the workflow again (an edited script or script ""): it resumes this run by itself')
  })

  test('structured output: JSON in a fence parses, a corrective follow-up fixes a bad answer, 5 bad answers return { schema_error, text } and the run goes on, strict: true throws, a contradictory schema starts no agent', async () => {
    const LONG_FILES = Array.from({ length: 300 }, (_, i) => `src/routes/file-${i}.ts`)
    api.behave((prompt, turn) => {
      if (prompt.startsWith('json ok')) return { answer: '```json\n{ "files": ["a.ts"] }\n```' }
      if (prompt.startsWith('json fixed')) return { answer: turn === 1 ? 'Here are the files: a.ts' : JSON.stringify({ files: LONG_FILES }) }
      return { answer: '{"files": 3}' }
    })
    const schema = { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } }
    const contradictory = { type: 'object', required: ['files'], additionalProperties: false, properties: {} }
    const script = [
      "const ok = await agent('json ok', { schema: args.schema })",
      "const fixed = await agent('json fixed', { schema: args.schema })",
      // Awaited directly, and the run still goes on to the next line.
      "const never = await agent('json never', { schema: args.schema })",
      "let strict; try { await agent('json strict', { schema: args.schema, strict: true }) } catch (error) { strict = error.message }",
      "let refused; try { await agent('json bad schema', { schema: args.contradictory }) } catch (error) { refused = error.message }",
      'return { ok, fixed, never, strict, refused }',
    ].join('\n')
    const { rt, frames } = await boot([runWorkflow(script, { schema, contradictory }), { text: 'parent done' }], INLINE)
    expect(await inlineTurn(rt)).toBe('completed')

    // Four children: the contradictory schema never started one. Each prompt asks for JSON matching the schema.
    expect(api.creates).toHaveLength(4)
    for (const create of api.creates) {
      expect(create.initial_prompt).toContain('Answer format: your final message must be ONLY one JSON value that matches this JSON Schema.')
      expect(create.initial_prompt).toContain(JSON.stringify(schema, null, 2))
    }
    // The fixes went to the SAME child session: 1 for "json fixed", 4 each for "json never" and "json strict" (5 attempts in all).
    expect(api.followUps.map((f) => f.id)).toEqual(['child-2', ...Array(4).fill('child-3'), ...Array(4).fill('child-4')])
    expect(api.followUps[0]!.text).toStartWith('Your last answer does not match the required JSON Schema: the answer is not valid JSON.')
    expect(api.followUps[1]!.text).toStartWith('Your last answer does not match the required JSON Schema: $.files: expected array, got integer.')

    const part = lastWorkflowPart(frames)
    const doc = part.metadata as unknown as WorkflowRunMetadata
    expect(doc.status).toBe('done')
    const result = JSON.parse(part.output!.split('\n</workflow_result>')[0]!.slice('<workflow_result>\n'.length))
    const lastError = 'structured output failed validation on all 5 attempts; the last: $.files: expected array, got integer'
    expect(result).toEqual({
      ok: { files: ['a.ts'] },
      fixed: { files: LONG_FILES },
      never: { schema_error: lastError, text: '{"files": 3}' },
      strict: lastError,
      refused:
        'agent() refused: the schema can never be met ($: the required key "files" is not in `properties`, and `additionalProperties: false` rules it out). The agent did not start.',
    })
    expect(doc.agents.map((a) => [a.label, a.status, a.structured])).toEqual([
      ['json ok', 'done', true],
      ['json fixed', 'done', true],
      ['json never', 'done', true],
      ['json strict', 'failed', true],
    ])
    expect(doc.logs).toContain('json never: its answer never matched the schema; agent() returns { schema_error, text }.')
    // A structured summary is the whole JSON, up to 4,000 characters, so the card can parse it; longer is cut there.
    expect(doc.agents[0]!.summary).toBe('{"files":["a.ts"]}')
    expect(JSON.stringify({ files: LONG_FILES }).length).toBeGreaterThan(4_000)
    expect(doc.agents[1]!.summary).toBe(JSON.stringify({ files: LONG_FILES }).slice(0, 4_000))
    expect(JSON.parse(doc.agents[2]!.summary!)).toEqual({ schema_error: lastError, text: '{"files": 3}' })

    // A resume asks the schema-failed agent again; the agents that matched keep their answers.
    api.behave((prompt) => ({ answer: prompt.startsWith('json ok') ? '{ "files": ["a.ts"] }' : JSON.stringify({ files: ['b.ts'] }) }))
    model.script([{ tool: 'workflow', args: { script: '', resume_run_id: doc.runId } }, { text: 'again' }])
    expect(await inlineTurn(rt, 'again')).toBe('completed')
    expect(api.creates.slice(4).map((c) => c.initial_prompt.split('\n')[0])).toEqual(['json never', 'json strict'])
  })

  test('resume, per call: an edited, reordered script reuses every completed agent() in any order and runs only the failed and the new ones; fresh: true reuses nothing', async () => {
    let bFails = true
    api.behave((prompt) => ({ fail: prompt === 'B' && bFails }))
    // B awaited directly: its failure fails the run.
    const first = "const r = await parallel(['A', 'C', 'D'].map((p) => () => agent(p)))\nawait agent('B')\nreturn r"
    const { rt, frames } = await boot([runWorkflow(first), { text: 'first done' }], INLINE)
    expect(await inlineTurn(rt)).toBe('completed')
    const ran = lastWorkflowPart(frames).metadata as unknown as WorkflowRunMetadata
    expect(ran.status).toBe('failed')
    expect(ran.agents.map((a) => [a.label, a.status])).toEqual([['A', 'done'], ['C', 'done'], ['D', 'done'], ['B', 'failed']])
    expect(api.creates.map((c) => c.initial_prompt).sort()).toEqual(['A', 'B', 'C', 'D'])

    // The next workflow names no run: the latest one did not finish, so it resumes by itself, with an edited script.
    bFails = false
    const edited = "const tail = await agent('E')\nreturn [...(await parallel(['D', 'C', 'B', 'A'].map((p) => () => agent(p)))), tail]"
    model.script([runWorkflow(edited), { text: 'second done' }])
    expect(await inlineTurn(rt, 'retry it')).toBe('completed')
    expect(api.creates.slice(4).map((c) => c.initial_prompt).sort()).toEqual(['B', 'E'])
    const part = lastWorkflowPart(frames)
    const second = part.metadata as unknown as WorkflowRunMetadata
    // A resume keeps the run id.
    expect(second.runId).toBe(ran.runId)
    expect(second.resumedFrom).toBe(ran.runId)
    expect(second.agents.map((a) => [a.label, a.status, a.cached ?? false])).toEqual([
      ['E', 'done', false],
      ['D', 'done', true],
      ['C', 'done', true],
      ['B', 'done', false],
      ['A', 'done', true],
    ])
    expect(part.output).toContain('agents: 5 (5 done; 3 reused from the earlier run)')
    expect(part.output).toContain(`Resumed run ${ran.runId}: 3 finished agents reused, 2 ran.`)
    expect(part.output).toContain(JSON.stringify(['answer: D', 'answer: C', 'answer: B', 'answer: A', 'answer: E'], null, 2))

    // That run finished: the next workflow is a new run. fresh: true starts one even after a failure.
    bFails = true
    model.script([runWorkflow(first), runWorkflow(first, undefined, { fresh: true }), { text: 'third and fourth' }])
    expect(await inlineTurn(rt, 'once more')).toBe('completed')
    const [third, fourth] = frames.filter((f) => f.tool === 'workflow' && f.state.status === 'completed').slice(-2).map((f) => f.state.metadata as unknown as WorkflowRunMetadata)
    expect(third!.runId).not.toBe(ran.runId)
    expect(third!.agents.some((a) => a.cached)).toBe(false)
    expect(fourth!.runId).not.toBe(third!.runId)
    expect(fourth!).not.toHaveProperty('resumedFrom')
    expect(api.creates).toHaveLength(6 + 8)

    // A run id this computer never saw: nothing to resume.
    model.script([{ tool: 'workflow', args: { script: '', resume_run_id: 'no-such-run-0000' } }, { text: 'fifth done' }])
    expect(await inlineTurn(rt, 'retry the other one')).toBe('completed')
    expect(lastWorkflowPart(frames).error).toContain('nothing to resume: no run no-such-run-0000 is saved on this computer.')
  })

  test('a stalled agent starts over in a new session (attempt 2); one that stalls on all 6 attempts fails the call', async () => {
    api.behave((prompt, _turn, child) => ({ stall: prompt === 'always stalls' || (prompt === 'stalls once' && child.id === 'child-1') }))
    const script = [
      "const first = await agent('stalls once', { label: 'Once' })",
      "let error; try { await agent('always stalls', { label: 'Always' }) } catch (e) { error = e.message }",
      'return { first, error }',
    ].join('\n')
    const { rt, frames } = await boot([runWorkflow(script), { text: 'parent done' }], INLINE)
    expect(await inlineTurn(rt)).toBe('completed')

    // 2 sessions for the first agent, 6 for the second; every stalled one was stopped.
    expect(api.creates.map((c) => [c.initial_prompt, c.name])).toEqual([
      ['stalls once', 'Once (Research two topics workflow)'],
      ['stalls once', 'Once (retry 1) (Research two topics workflow)'],
      ...[0, 1, 2, 3, 4, 5].map((n) => ['always stalls', `Always${n ? ` (retry ${n})` : ''} (Research two topics workflow)`]),
    ])
    expect(api.stops).toEqual(['child-1', 'child-3', 'child-4', 'child-5', 'child-6', 'child-7', 'child-8'])
    const part = lastWorkflowPart(frames)
    expect(part.output).toContain(
      JSON.stringify({ first: 'answer: stalls once', error: 'agent stalled on all 6 attempts: no new output for 15 min each. If its work keeps it silent that long, pass a longer stallMs.' }, null, 2),
    )
    const doc = part.metadata as unknown as WorkflowRunMetadata
    expect(doc.agents.map((a) => [a.label, a.status, a.attempt, a.sessionId])).toEqual([
      ['Once', 'done', 2, 'child-2'],
      ['Always', 'failed', 6, 'child-8'],
    ])
  })

  test('an inline run: stopping its own turn stops every child the run started', async () => {
    api.childrenWork()
    const script = "return parallel([() => agent('slow one'), () => agent('slow two')])"
    const { rt, frames } = await boot([runWorkflow(script), { text: 'never reached' }], INLINE)
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
    const part = lastWorkflowPart(frames)
    expect(part.status).toBe('error')
    expect(part.error).toContain('Separate subagent sessions nest at most 2 levels and this session is level 2, so it cannot run a workflow.')
  })
})

/** A second fake API: the runner box's own, whose children are the run's agents. */
function runnerApi() {
  const extra = startFakeApi('sess-runner')
  runnerApis.push(extra)
  return extra
}

/** Boot the runner box the parent's create `index` started, with that create's context, as the API boots it. */
async function bootRunner(create: Record<string, any>, steps: Step[], runnerSide: ReturnType<typeof startFakeApi>) {
  return boot(steps, { KORTIX_SESSION_ID: 'sess-runner', KORTIX_SESSION_CONTEXT: JSON.stringify(create.runtime_context) }, { apiUrl: runnerSide.url })
}

/** The runner model's call: `{ script: "" }`, plus what a model sent live (a name and the removed `background`). */
const RUNNER_CALL: Step = { tool: 'workflow', args: { script: '', name: 'research-notion', background: true, description: 'whatever' } }

describe('pi workflow tool, always in the background from a top-level session', () => {
  test('the call returns within seconds and the turn ends before any agent works; a new message gets a normal turn; stopping a later turn or the box never touches the runner; a 120 KB script reaches the runner whole', async () => {
    // The runner never settles: anything that waited on it would hang.
    api.childrenWork()
    const filler = `// ${'x'.repeat(118)}\n`.repeat(1_000)
    const script = [
      "export const meta = { name: 'research-notion', description: 'Two lookups', phases: [{ title: 'Look' }] }",
      filler,
      "phase('Look')",
      "return parallel(args.topics.map((t) => () => agent('Look up ' + t, { label: t })))",
    ].join('\n')
    expect(script.length).toBeGreaterThan(120_000)
    // `background: false` is what a model sent before the parameter went away: it is ignored.
    const parent = await boot([
      { tool: 'workflow', args: { script, args: { topics: ['x', 'y'] }, background: false, max_agents: 2 } },
      { text: '⏳ running in the background' },
      { text: 'yes, I am here' },
      // A later turn that waits on the person, so it is still open when it is stopped.
      { tool: 'question', args: { questions: [{ question: 'Which way?', header: 'Pick', options: [{ label: 'A', description: 'a' }] }] } },
      { text: 'never reached' },
    ])
    const started = performance.now()
    const turn = parent.rt.admit({ text: 'start it', files: [] })
    await answer(parent.rt, 'Run it')
    expect(await turn.done).toBe('completed')
    expect(performance.now() - started).toBeLessThan(5_000)

    // ONE runner session, a background subagent; nobody polls it, nobody stops it.
    expect(api.creates).toHaveLength(1)
    const runner = api.creates[0]!
    expect(runner).toMatchObject({ metadata: { notify_parent: true }, name: 'Two lookups (workflow)' })
    expect(runner.initial_prompt).toStartWith('Run the workflow "Two lookups" this message hands over: call the workflow tool with { "script": "" }.\n\n<workflow_handoff chars="')
    expect(runner.initial_context).toContain('Call the workflow tool once with { "script": "" }: it reads the workflow from your message')
    const part = lastWorkflowPart(parent.frames)
    const doc = part.metadata as unknown as WorkflowRunMetadata
    // The context only marks the runner: the script rides in the prompt, so no 12 KiB cap applies.
    expect(runner.runtime_context).toEqual({ 'kortix.workflow.run_id': doc.runId, 'kortix.workflow.title': 'Two lookups', 'kortix.workflow.max_agents': 2, 'kortix.workflow.planned': 2, 'kortix.subagent.depth': 1 })
    expect(api.reads).toEqual([])
    expect(part.status).toBe('completed')
    expect(doc).toMatchObject({ status: 'running', background: { sessionId: 'child-1' }, agents: [], phases: [{ title: 'Look', status: 'pending' }] })
    expect(part.output).toStartWith('<workflow_started>\nThe workflow runs in the background in its runner session child-1.')
    expect(part.output).toContain('stopping your turn does not stop the run')
    expect(part.output).toContain('End your turn now')
    expect(part.output).toContain('(background is no longer a parameter: every workflow runs in the background.)')
    expect(part.output).toContain(`run_id: ${doc.runId}`)
    // The turn ended while the runner had not even been read: the parent's turn finished before any agent did.

    // The person keeps talking: an ordinary turn, at once.
    expect(await parent.rt.admit({ text: 'are you there?', files: [] }).done).toBe('completed')
    // A later turn is stopped, then the box goes away: the runner is never stopped.
    const later = parent.rt.admit({ text: 'something long', files: [] })
    await waitFor(() => parent.rt.questions.list().length === 1)
    await parent.rt.abort()
    expect(await later.done).toBe('aborted')
    await parent.service.lifecycle.stop()
    expect(api.stops).toEqual([])

    // The runner box: its context and first prompt, as the API boots it. Its model sends extra keys; the hand-off wins.
    const runnerSide = runnerApi()
    const box = await bootRunner(runner, [RUNNER_CALL, { text: 'runner done' }], runnerSide)
    expect(await box.rt.admit({ text: runner.initial_prompt, files: [] }).done).toBe('completed')
    expect(box.rt.questions.list()).toHaveLength(0)
    expect(runnerSide.creates.map((c) => [c.initial_prompt, c.runtime_context['kortix.subagent.depth']])).toEqual([
      ['Look up x', 2],
      ['Look up y', 2],
    ])
    const ran = lastWorkflowPart(box.frames)
    expect(ran.metadata).toMatchObject({ runId: doc.runId, title: 'Two lookups', status: 'done', maxAgents: 2, phases: [{ title: 'Look', status: 'done' }] })
    expect(ran.output).toStartWith(`<workflow_result>\n${JSON.stringify(['answer: Look up x', 'answer: Look up y'], null, 2)}\n</workflow_result>`)
  })

  test('the result arrives later as a notice that starts a new turn, and the parent lists the run done from then on', async () => {
    api.childrenWork()
    const { rt, service, frames } = await boot([runWorkflow("return agent('x')"), { text: 'started' }, { text: '✅ the run is done' }])
    expect(await approvedTurn(rt)).toBe('completed')
    const doc = lastWorkflowPart(frames).metadata as unknown as WorkflowRunMetadata
    const http = routes(service)
    expect((await http.list()).runs).toMatchObject([{ runId: doc.runId, status: 'running', background: { sessionId: 'child-1' } }])

    // The runner ends its turn with the tool output; the API delivers it into this session as a new turn.
    // Past the 5 s recheck window of the list's own read.
    setSystemTime(new Date(Date.now() + 10_000))
    const report = `<workflow_result>\n"answer: x"\n</workflow_result>\nagents: 1 (1 done)\nrun_id: ${doc.runId} (resume_run_id resumes it)`
    api.behave(() => ({ answer: report }))
    api.childrenSettle()
    expect(await rt.admit({ text: `A background subagent you started has finished.\n${report}`, files: [] }).done).toBe('completed')
    await waitFor(() => rt.workflowList()[0]?.status === 'done')
    expect((await http.list()).runs).toMatchObject([{ runId: doc.runId, status: 'done', background: { sessionId: 'child-1' } }])
  })

  test('a runner that cannot run its workflow fails its turn with the reason, never `completed`; one that ran it completes', async () => {
    const runnerSide = runnerApi()
    const context = { 'kortix.workflow.run_id': 'run-fails-00000001', 'kortix.workflow.title': 'Broken', 'kortix.workflow.max_agents': 2, 'kortix.subagent.depth': 1 }
    const handoff = (script: string) => {
      const json = JSON.stringify({ run_id: 'run-fails-00000001', mode: 'start', title: 'Broken', script, max_agents: 2 })
      return `Run the workflow "Broken" this message hands over: call the workflow tool with { "script": "" }.\n\n<workflow_handoff chars="${json.length}">\n${json}\n</workflow_handoff>`
    }
    const box = await bootRunner({ runtime_context: context }, [RUNNER_CALL, { text: 'it did not run' }, RUNNER_CALL, { text: 'it ran' }], runnerSide)
    // The model ends its turn normally, but the workflow never ran: the turn is an error, which the API reports as failed.
    expect(await box.rt.admit({ text: handoff("export const meta = { name: 'broken' }\n"), files: [] }).done).toBe('error')
    expect(lastWorkflowPart(box.frames).error).toBe('The workflow script has no body after its meta block.')
    expect(runnerSide.creates).toHaveLength(0)
    expect(await box.rt.admit({ text: handoff("return agent('fine')"), files: [] }).done).toBe('completed')
    expect(runnerSide.creates.map((c) => c.initial_prompt)).toEqual(['fine'])
  })

  test('resume of a background run: the next workflow resumes it by itself in its own runner session, with the edited script; the runner reuses every finished call; a run still at work refuses resume_run_id', async () => {
    let bFails = true
    const runnerSide = runnerApi()
    runnerSide.behave((prompt) => ({ fail: prompt === 'B' && bFails }))
    // B awaited directly: its failure fails the run.
    const first = "const ac = await parallel([() => agent('A'), () => agent('C')])\nawait agent('B')\nreturn ac"
    const parent = await boot([runWorkflow(first), { text: 'started' }])
    expect(await approvedTurn(parent.rt)).toBe('completed')
    const runner = api.creates[0]!

    // The runner runs it: B fails, so the run fails, and so does the runner's turn.
    const box = await bootRunner(runner, [RUNNER_CALL, { text: 'reported' }], runnerSide)
    expect(await box.rt.admit({ text: runner.initial_prompt, files: [] }).done).toBe('error')
    const firstOutput = lastWorkflowPart(box.frames).output!
    expect(firstOutput).toStartWith('<workflow_error>\nchild session failed')

    // The parent reads the runner's last answer: the run did not finish.
    api.behave(() => ({ answer: firstOutput }))
    expect(firstOutput).toContain('agents: 3 (2 done, 1 failed)')
    bFails = false
    const edited = "return parallel(['C', 'B', 'A', 'D'].map((p) => () => agent(p)))"
    model.script([runWorkflow(edited), { text: 'resumed' }])
    expect(await approvedTurn(parent.rt, 'retry it')).toBe('completed')
    // No new runner: a follow-up prompt to the same runner session, which hands over the edited script.
    expect(api.creates).toHaveLength(1)
    expect(api.followUps).toHaveLength(1)
    expect(api.followUps[0]!.id).toBe('child-1')
    const followUp = api.followUps[0]!.text
    expect(followUp).toStartWith(`Resume the workflow "Research two topics" this message hands over: call the workflow tool with { "script": "" }.`)
    expect(followUp).toContain('"mode":"resume"')
    expect(followUp).toContain(JSON.stringify(edited).slice(1, -1))
    const handed = lastWorkflowPart(parent.frames)
    const runId = (handed.metadata as unknown as WorkflowRunMetadata).runId
    // The same workflow (its title): a resume, not a new run.
    expect(handed.output).toContain(`Resumed run ${runId} in its runner session: 2 finished agents reused when their calls are unchanged; every other call runs.`)

    // The runner's next turn: A and C come from its records, B and D run.
    model.script([RUNNER_CALL, { text: 'reported again' }])
    expect(await box.rt.admit({ text: followUp, files: [] }).done).toBe('completed')
    expect(runnerSide.creates.slice(3).map((c) => c.initial_prompt).sort()).toEqual(['B', 'D'])
    const resumed = lastWorkflowPart(box.frames)
    expect(resumed.metadata).toMatchObject({ runId, status: 'done' })
    expect(resumed.output).toContain(`Resumed run ${runId}: 2 finished agents reused, 2 ran.`)

    // While the runner works, resume_run_id refuses, and names the way out.
    api.childrenWork()
    model.script([{ tool: 'workflow', args: { script: '', resume_run_id: runId } }, { text: 'refused' }])
    expect(await approvedTurn(parent.rt, 'again')).toBe('completed')
    expect(lastWorkflowPart(parent.frames).error).toContain(`Run ${runId} still runs in its runner session child-1. Stop it first`)
  })

  test('a finished run, then a different workflow: a new runner and a new run id, and the finished record stays done (the notice says completed; the runner\'s words do not count)', async () => {
    const parent = await boot([
      { tool: 'workflow', args: { description: 'Three cities, one paragraph', script: "return parallel(['Rome', 'Oslo'].map((c) => () => agent(c)))" } },
      { text: 'started' },
      { text: '✅ Done' },
      { tool: 'workflow', args: { description: 'Fruit sentences', script: "return agent('apple')" } },
      { text: 'started again' },
    ])
    expect(await approvedTurn(parent.rt)).toBe('completed')
    const firstId = (lastWorkflowPart(parent.frames).metadata as unknown as WorkflowRunMetadata).runId
    // The runner paraphrased its result: its last words carry no <workflow_result>.
    api.behave(() => ({ answer: '✅ Done — 2 agents, all finished.' }))
    // The API's notice: the runner's turn completed, which it does only when its workflow ended done.
    expect(await parent.rt.admit({ text: 'A background subagent you started has finished. This message is from the platform, not from the user.\ntask_id: child-1\nstatus: completed\n', files: [] }).done).toBe('completed')
    expect(parent.rt.workflowList()[0]).toMatchObject({ runId: firstId, status: 'done' })

    expect(await approvedTurn(parent.rt, 'now fruit')).toBe('completed')
    expect(api.creates).toHaveLength(2)
    expect(api.followUps).toHaveLength(0)
    const second = lastWorkflowPart(parent.frames).metadata as unknown as WorkflowRunMetadata
    expect(second.runId).not.toBe(firstId)
    expect(second).not.toHaveProperty('resumedFrom')
    expect(second.background).toEqual({ sessionId: 'child-2' })
    api.keepWorking('child-2')
    const runs = (await routes(parent.service).list()).runs
    expect(runs.map((run) => [run.title, run.status])).toEqual([
      ['Fruit sentences', 'running'],
      ['Three cities, one paragraph', 'done'],
    ])
  })

  test('without a notice, the runner\'s turn end in the API ledger decides: completed is done, whatever the runner wrote', async () => {
    api.childrenWork()
    const parent = await boot([runWorkflow("return agent('x')"), { text: 'started' }])
    expect(await approvedTurn(parent.rt)).toBe('completed')
    api.behave(() => ({ answer: 'All good, here is a summary.', lastEnd: { reason: 'completed' } }))
    api.childrenSettle()
    expect((await routes(parent.service).list()).runs).toMatchObject([{ status: 'done' }])
  })

  test('an unfinished run, then a different workflow: a new run in a new runner; the unfinished record stays as it was', async () => {
    const parent = await boot([
      { tool: 'workflow', args: { script: "export const meta = { name: 'cities', description: 'Three cities' }\nreturn agent('Rome')" } },
      { text: 'started' },
      { tool: 'workflow', args: { script: "export const meta = { name: 'fruit', description: 'Fruit sentences' }\nreturn agent('apple')" } },
      { text: 'started again' },
    ])
    expect(await approvedTurn(parent.rt)).toBe('completed')
    const firstId = (lastWorkflowPart(parent.frames).metadata as unknown as WorkflowRunMetadata).runId
    // The runner failed its workflow.
    api.behave(() => ({ answer: '<workflow_error>\nchild session failed\n</workflow_error>', lastEnd: { reason: 'failed', error: 'child session failed' } }))
    expect(await approvedTurn(parent.rt, 'now fruit')).toBe('completed')
    expect(api.creates).toHaveLength(2)
    expect(api.followUps).toHaveLength(0)
    const second = lastWorkflowPart(parent.frames).metadata as unknown as WorkflowRunMetadata
    expect(second.runId).not.toBe(firstId)
    api.keepWorking('child-2')
    const runs = (await routes(parent.service).list()).runs
    expect(runs.map((run) => [run.name, run.status])).toEqual([
      ['fruit', 'running'],
      ['cities', 'failed'],
    ])
    expect(runs[1]!.error).toBe('child session failed')
  })

  test('a runner whose model never calls the workflow tool fails its turn', async () => {
    const runnerSide = runnerApi()
    const context = { 'kortix.workflow.run_id': 'run-skipped-000001', 'kortix.workflow.title': 'Skipped', 'kortix.workflow.max_agents': 1, 'kortix.subagent.depth': 1 }
    const json = JSON.stringify({ run_id: 'run-skipped-000001', mode: 'start', title: 'Skipped', script: "return agent('x')", max_agents: 1 })
    const box = await bootRunner({ runtime_context: context }, [{ text: 'I did it myself.' }], runnerSide)
    expect(await box.rt.admit({ text: `Run it.\n\n<workflow_handoff chars="${json.length}">\n${json}\n</workflow_handoff>`, files: [] }).done).toBe('error')
    expect(runnerSide.creates).toHaveLength(0)
  })

  test('fresh: true starts a new runner even though the latest run did not finish', async () => {
    const parent = await boot([runWorkflow("return agent('x')"), runWorkflow("return agent('x')", undefined, { fresh: true }), { text: 'two started' }])
    // The first runner's last answer is a failure.
    api.behave(() => ({ answer: '<workflow_error>\nchild session failed\n</workflow_error>' }))
    expect(await approvedTurn(parent.rt, 'run it', 2)).toBe('completed')
    expect(api.creates).toHaveLength(2)
    expect(api.followUps).toHaveLength(0)
    const [one, two] = parent.frames.filter((f) => f.tool === 'workflow' && f.state.status === 'completed').map((f) => f.state.metadata as unknown as WorkflowRunMetadata)
    expect(one!.runId).not.toBe(two!.runId)
  })

  test('a run recorded on the parent box (before every run went to a runner) resumes in a new runner that gets its finished records', async () => {
    const parent = await boot([runWorkflow("const r = await parallel(['A', 'B'].map((p) => () => agent(p)))\nreturn [...r, await agent('C')]"), { text: 'resumed' }])
    // The record a foreground run of the parent left behind: A done, B failed, C never started.
    const runId = 'legacy-run-0000001'
    const key = (prompt: string) => new Bun.CryptoHasher('sha256').update(JSON.stringify([prompt, null, null, null])).digest('hex')
    const dir = join(parent.workspace, '.runtime-state', 'workflows', 'runs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${runId}.json`),
      JSON.stringify({
        runId,
        // The same workflow: its title is the new call's.
        title: 'Research two topics',
        script: "return parallel(['A', 'B'].map((p) => () => agent(p)))",
        maxAgents: 3,
        startedAt: Date.now() - 60_000,
        agents: [
          { key: key('A'), label: 'A', status: 'done', result: 'saved A' },
          { key: key('B'), label: 'B', status: 'failed' },
        ],
        doc: { runId, title: 'Research two topics', status: 'stopped', phases: [], agents: [], startedAt: Date.now() - 60_000 },
      }),
    )
    expect(await approvedTurn(parent.rt, 'go on')).toBe('completed')
    expect(api.creates).toHaveLength(1)
    const runner = api.creates[0]!
    expect(runner.runtime_context['kortix.workflow.run_id']).toBe(runId)
    expect(lastWorkflowPart(parent.frames).output).toContain(`Resumed run ${runId}: 1 finished agent reused when their calls are unchanged; every other call runs.`)

    const runnerSide = runnerApi()
    const box = await bootRunner(runner, [RUNNER_CALL, { text: 'done' }], runnerSide)
    expect(await box.rt.admit({ text: runner.initial_prompt, files: [] }).done).toBe('completed')
    // A comes from the hand-over; B and C run.
    expect(runnerSide.creates.map((c) => c.initial_prompt).sort()).toEqual(['B', 'C'])
    expect(lastWorkflowPart(box.frames).output).toContain(JSON.stringify(['saved A', 'answer: B', 'answer: C'], null, 2))
  })

  test('the parent heals stale states: a run whose runner stopped, failed or ended without running it is no longer listed running; one whose runner works still is', async () => {
    api.childrenWork()
    const { rt, service } = await boot([runWorkflow("return agent('x')"), runWorkflow("return agent('y')", undefined, { fresh: true }), runWorkflow("return agent('z')", undefined, { fresh: true }), { text: 'three started' }])
    expect(await approvedTurn(rt, 'run three', 3)).toBe('completed')
    expect(api.creates).toHaveLength(3)
    const http = routes(service)
    expect((await http.list()).runs.map((run) => run.status)).toEqual(['running', 'running', 'running'])

    // child-1 was stopped; child-2 ended its turn without running the workflow; child-3 still works.
    api.behave((_prompt, _turn, child) =>
      child.id === 'child-1' ? { stop: true } : child.id === 'child-2' ? { answer: 'No saved workflow "research-notion": there is no research-notion.js.' } : {},
    )
    api.childrenSettle()
    api.keepWorking('child-3')
    // Past the 5 s recheck window of the first list.
    setSystemTime(new Date(Date.now() + 10_000))
    const runs = (await http.list()).runs
    const byRunner = Object.fromEntries(runs.map((run) => [run.background!.sessionId, run]))
    expect(byRunner['child-1']).toMatchObject({ status: 'stopped', error: 'The runner session was stopped before the run ended.' })
    expect(byRunner['child-2']).toMatchObject({ status: 'failed', error: 'The runner ended without running the workflow: No saved workflow "research-notion": there is no research-notion.js.' })
    expect(byRunner['child-3']).toMatchObject({ status: 'running' })
    expect(runs.filter((run) => run.status === 'running')).toHaveLength(1)
  })

  test('the parent lists a handed-off run with its runner session and refers controls there', async () => {
    api.childrenWork()
    const { rt, frames, service } = await boot([{ tool: 'workflow', args: { script: "return agent('x')", max_agents: 1 } }, { text: 'started' }])
    expect(await approvedTurn(rt)).toBe('completed')
    expect(api.creates).toHaveLength(1)
    expect(api.creates[0]).toMatchObject({ metadata: { notify_parent: true }, runtime_context: { 'kortix.subagent.depth': 1 } })
    const part = lastWorkflowPart(frames)
    const doc = part.metadata as unknown as WorkflowRunMetadata
    expect(doc.background).toEqual({ sessionId: 'child-1' })
    expect(part.output).toContain('runner_session_id: child-1')
    const http = routes(service)
    expect((await http.list()).runs).toMatchObject([{ runId: doc.runId, status: 'running', background: { sessionId: 'child-1' } }])
    expect(await http.control(doc.runId, { action: 'pause' })).toEqual({
      status: 409,
      body: { error: 'this run runs in its runner session: send the control to that session', code: 'run_in_runner', runner_session_id: 'child-1' },
    })
  })
})

describe('pi workflow tool, its call shape', () => {
  test('the schema requires script and has no save, list or runner field; a call without script, or with an empty one and nothing to run, starts nothing', async () => {
    const before = model.bodies.length
    const { rt, frames } = await boot([
      // The shape a model sent live: a save with no script.
      { tool: 'workflow', args: { save_as: 'notion-competitors', background: true, max_agents: 3, description: 'Save it', from_context: false } },
      { tool: 'workflow', args: { script: '' } },
      { tool: 'workflow', args: { script: '   ', background: true } },
      { text: 'done' },
    ])
    expect(await rt.admit({ text: 'save it', files: [] }).done).toBe('completed')
    const tool = (model.bodies[before]!.tools as Array<{ function: { name: string; description: string; parameters: { required?: string[]; properties: Record<string, unknown> } } }>).find((t) => t.function.name === 'workflow')!
    expect(tool.function.parameters.required).toEqual(['script'])
    expect(Object.keys(tool.function.parameters.properties)).toEqual(['script', 'description', 'args', 'max_agents', 'resume_run_id', 'fresh', 'name'])
    expect(tool.function.description).toContain('To save a workflow, the person asks; hand that file change to an agent with access to the project files.')
    expect(tool.function.description).not.toMatch(/save_as|list_saved|from_context|background:|foreground/)
    expect(tool.function.description).toContain('Every workflow runs in the background, in its own runner session: the call returns within seconds')

    const [missing, empty, blank] = frames.filter((f) => f.tool === 'workflow' && f.state.status === 'error').map((f) => f.state.error!)
    expect(missing).toContain('Validation failed for tool "workflow"')
    expect(missing).toContain('script')
    expect(empty).toBe('The workflow has no script: pass script, or name, or resume_run_id.')
    expect(blank).toBe('The workflow has no script: pass script, or name, or resume_run_id.')
    expect(api.creates).toHaveLength(0)
    expect(rt.questions.list()).toHaveLength(0)
  })
})

describe('pi workflow tool, saved workflows', () => {
  const audit = [
    "export const meta = { name: 'audit', description: 'Audit the given files', phases: [{ title: 'Audit' }] }",
    "phase('Audit')",
    "return parallel(args.files.map((f) => () => agent('Audit ' + f)))",
  ].join('\n')

  test('a project checkout: the description lists the saved names, name with script "" runs one with args, an unknown name names the folder', async () => {
    const before = model.bodies.length
    const { rt, frames } = await boot(
      [
        { tool: 'workflow', args: { script: '', name: 'audit', args: { files: ['a.ts'] } } },
        { tool: 'workflow', args: { script: '', name: 'missing' } },
        { tool: 'workflow', args: { script: "return agent('x')", name: 'audit' } },
        { text: 'done' },
      ],
      INLINE,
      { checkout: true, files: { '.kortix/workflows/audit.js': audit, '.kortix/workflows/triage.js': "return 'ok'" } },
    )
    expect(await inlineTurn(rt)).toBe('completed')
    const tool = (model.bodies[before]!.tools as Array<{ function: { name: string; description: string } }>).find((t) => t.function.name === 'workflow')!
    expect(tool.function.description).toContain('runs the saved workflow .kortix/workflows/<name>.js. Saved: audit, triage.')
    const ran = frames.filter((f) => f.tool === 'workflow' && f.state.status === 'completed').at(-1)!.state
    expect(ran.metadata).toMatchObject({ name: 'audit', title: 'Audit the given files', status: 'done', phases: [{ title: 'Audit', status: 'done' }] })
    expect(api.creates.map((c) => c.initial_prompt)).toEqual(['Audit a.ts'])
    const [unknown, both] = frames.filter((f) => f.tool === 'workflow' && f.state.status === 'error').map((f) => f.state.error!)
    expect(unknown).toBe(`No saved workflow "missing": there is no missing.js in .kortix/workflows/ in this session's project checkout.`)
    expect(both).toBe('Pass either a script or a name, not both: with name, pass script "".')
  })

  test('no checkout (My Kortix): name with script "" reads the saved workflow through the API; an unknown name names the default branch folder', async () => {
    api.files.set('.kortix/workflows/audit.js', audit)
    const { rt, frames, workspace } = await boot(
      [
        { tool: 'workflow', args: { script: '', name: 'audit', args: { files: ['b.ts'] } } },
        { tool: 'workflow', args: { script: '', name: 'audit-2' } },
        { text: 'ran' },
      ],
      { ...INLINE, KORTIX_META_AGENT: '1' },
    )
    expect(await inlineTurn(rt)).toBe('completed')
    expect(api.creates.map((c) => c.initial_prompt)).toEqual(['Audit b.ts'])
    expect(frames.filter((f) => f.tool === 'workflow' && f.state.status === 'completed').at(-1)!.state.metadata).toMatchObject({ name: 'audit', status: 'done' })
    expect(lastWorkflowPart(frames).error).toBe(`No saved workflow "audit-2": there is no audit-2.js in .kortix/workflows/ on the project's default branch.`)
    // The tool never writes a saved workflow, here or through another session.
    expect(await Bun.file(join(workspace, '.kortix/workflows/audit-2.js')).exists()).toBe(false)
  })
})

/** The box's own runtime routes (`routes/kortix/runtime.ts`) over the booted service's turn verbs, with the box token. */
function routes(service: PiHarnessService) {
  const app = createRuntimeRouter({ sandboxToken: 'dummy-box-token' } as Parameters<typeof createRuntimeRouter>[0], {} as Parameters<typeof createRuntimeRouter>[1], { turns: service.turns })
  const headers = { authorization: 'Bearer dummy-box-token', 'content-type': 'application/json' }
  return {
    list: async () => (await (await app.request('/workflows', { headers })).json()) as { runs: WorkflowRunMetadata[] },
    control: async (runId: string, body: unknown) => {
      const res = await app.request(`/workflows/${runId}/control`, { method: 'POST', headers, body: JSON.stringify(body) })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    },
  }
}

describe('pi workflow tool, run controls', () => {
  const TWO = "const a = await agent('first task', { label: 'First' })\nconst b = await agent('second task', { label: 'Second' })\nreturn [a, b]"

  test('pause: the running agent finishes and no new agent starts until resume; the list shows paused; resume runs the rest', async () => {
    api.childrenWork()
    const { rt, service } = await boot([runWorkflow(TWO), { text: 'parent done' }], INLINE)
    const http = routes(service)
    const turn = inlineTurn(rt)
    // The run records the child's session a moment after the create call returns.
    await waitFor(() => rt.workflowList()[0]?.agents.some((a) => a.sessionId === 'child-1' && a.status === 'running') === true)
    const [live] = (await http.list()).runs
    expect(live).toMatchObject({ status: 'running', agents: [{ id: 'a1', status: 'running', sessionId: 'child-1' }] })
    expect(await http.control(live!.runId, { action: 'pause' })).toEqual({ status: 200, body: { ok: true, paused: true } })
    expect((await http.list()).runs[0]).toMatchObject({ paused: true, logs: ['Paused: no new agent starts until the run resumes.'] })

    api.childrenSettle()
    await waitFor(() => rt.workflowList()[0]!.agents[0]!.status === 'done', 15_000)
    await Bun.sleep(300)
    expect(api.creates).toHaveLength(1)

    expect(await http.control(live!.runId, { action: 'resume' })).toEqual({ status: 200, body: { ok: true, paused: false } })
    expect(await turn).toBe('completed')
    expect(api.creates.map((c) => c.initial_prompt)).toEqual(['first task', 'second task'])
    // The finished run stays listed from its saved document.
    const [done] = (await http.list()).runs
    expect(done).toMatchObject({ runId: live!.runId, status: 'done', agents: [{ status: 'done' }, { status: 'done' }] })
    expect(done).not.toHaveProperty('paused')
  })

  test('restart_agent stops that child and starts it again with the same prompt; the run goes on', async () => {
    api.childrenWork()
    const { rt, frames, service } = await boot([runWorkflow("return agent('slow task', { label: 'Slow' })"), { text: 'parent done' }], INLINE)
    const http = routes(service)
    const turn = inlineTurn(rt)
    // The run records the child's session a moment after the create call returns.
    await waitFor(() => rt.workflowList()[0]?.agents.some((a) => a.sessionId === 'child-1' && a.status === 'running') === true)
    const runId = rt.workflowList()[0]!.runId
    expect(await http.control(runId, { action: 'restart_agent', session_id: 'child-404' })).toEqual({ status: 409, body: { error: 'no agent of this run is running in that session', code: 'agent_not_running' } })
    expect((await http.control(runId, { action: 'restart_agent' })).status).toBe(400)
    expect(await http.control(runId, { action: 'restart_agent', session_id: 'child-1' })).toEqual({ status: 200, body: { ok: true, paused: false } })
    await waitFor(() => api.creates.length === 2)
    expect(api.stops).toContain('child-1')
    expect(api.creates.map((c) => [c.initial_prompt, c.name])).toEqual([
      ['slow task', 'Slow (Research two topics workflow)'],
      ['slow task', 'Slow (retry 1) (Research two topics workflow)'],
    ])
    api.childrenSettle()
    expect(await turn).toBe('completed')
    const doc = lastWorkflowPart(frames).metadata as unknown as WorkflowRunMetadata
    expect(doc).toMatchObject({ status: 'done', agents: [{ status: 'done', attempt: 2, sessionId: 'child-2' }] })
    expect(doc.logs).toContain('Slow: restarted by the person; attempt 2 of 6 starts.')
  })

  test('stop ends the run stopped and stops its children; an unknown run is 404; an ended run is 409', async () => {
    api.childrenWork()
    const { rt, frames, service } = await boot([runWorkflow("return agent('long task')"), { text: 'parent done' }], INLINE)
    const http = routes(service)
    const turn = inlineTurn(rt)
    // The run records the child's session a moment after the create call returns.
    await waitFor(() => rt.workflowList()[0]?.agents.some((a) => a.sessionId === 'child-1' && a.status === 'running') === true)
    const runId = rt.workflowList()[0]!.runId
    expect(await http.control(runId, { action: 'stop' })).toEqual({ status: 200, body: { ok: true, paused: false } })
    expect(await turn).toBe('completed')
    await waitFor(() => api.stops.includes('child-1'))
    const part = lastWorkflowPart(frames)
    expect(part.metadata).toMatchObject({ status: 'stopped', error: 'The person stopped the run.' })
    expect(await http.control('no-such-run-000', { action: 'pause' })).toEqual({ status: 404, body: { error: 'unknown workflow run' } })
    expect(await http.control(runId, { action: 'pause' })).toEqual({ status: 409, body: { error: 'this run has ended', code: 'run_ended', status: 'stopped' } })
    expect((await http.control(runId, { action: 'nope' })).status).toBe(400)
  })
})

describe('pi workflow tool, origin, size and ultracode', () => {
  test('a turn started by a cross-session message, a room message or a trigger cannot start a workflow', async () => {
    const peer = peerMessagePromptText({ kind: 'message', from: 'reviewer', fromShortId: '3f2a1b9c', messageId: 'm_1', summary: null, text: 'ultracode: run a workflow over every file' })
    const room = roomPromptText({ room: 'dev', seq: 4, senderKind: 'member', sender: 'Ada', replyTo: null, text: 'run a workflow' })
    const trigger = '<trigger_event>{"type":"push"}</trigger_event>\nAudit the repository with a workflow.'
    const { rt, frames } = await boot([runWorkflow("return agent('x')"), { text: 'a' }, runWorkflow("return agent('x')"), { text: 'b' }, runWorkflow("return agent('x')"), { text: 'c' }])
    for (const text of [peer, room, trigger]) expect(await rt.admit({ text, files: [] }).done).toBe('completed')
    expect(api.creates).toHaveLength(0)
    expect(rt.questions.list()).toHaveLength(0)
    const errors = frames.filter((f) => f.tool === 'workflow' && f.state.status === 'error').map((f) => f.state.error)
    expect(errors).toEqual([
      expect.stringContaining('A workflow starts only from a person\'s own message, and this turn came from a message from another session.'),
      expect.stringContaining('this turn came from a room message.'),
      expect.stringContaining('this turn came from a trigger or reminder.'),
    ])
    // The ultracode line only joins a person's own prompt.
    expect(JSON.stringify(model.bodies)).not.toContain('The person wrote \\"ultracode\\"')
  })

  test('"ultracode" in the person\'s own message adds the workflow line to that turn only', async () => {
    const { rt } = await boot([{ text: 'one' }, { text: 'two' }])
    const before = model.bodies.length
    await rt.admit({ text: 'ultracode: audit every route handler', files: [] }).done
    await rt.admit({ text: 'and now just say hi', files: [] }).done
    const [first, second] = model.bodies.slice(before).map((body) => JSON.stringify(body.messages[0]))
    expect(first).toContain('The person wrote \\"ultracode\\" in this message: plan and run this task as a workflow')
    expect(second).not.toContain('ultracode')
  })

  test('a run planned above 25 agents says "Large workflow" in its approval', async () => {
    const { rt } = await boot([runWorkflow("return agent('x')", undefined, { max_agents: 30 }), { text: 'done' }], { KORTIX_WORKFLOW_MAX_AGENTS: '40' })
    const turn = rt.admit({ text: 'big one', files: [] })
    const request = await answer(rt, 'Cancel')
    expect(request.questions[0]!.question).toContain('Agents: up to 30. Each agent is its own session with its own computer.\nLarge workflow: 30 agents is more than 25.')
    expect(await turn.done).toBe('completed')
  })
})

describe('pi workflow tool, workflows as commands', () => {
  test('the bundled deep-research and a saved workflow are /name commands; a saved one of the same name wins', async () => {
    const { rt } = await boot([], {}, { checkout: true, files: { '.kortix/workflows/audit.js': "return agent('audit')", '.kortix/workflows/deep-research.js': "return agent('mine')" } })
    const workflows = rt.commandList().filter((command) => command.source === 'workflow')
    expect(workflows.map((command) => [command.name, command.description])).toEqual([
      ['audit', 'Run the saved workflow audit'],
      ['deep-research', 'Run the saved workflow deep-research'],
    ])
    const prompt = rt.commandPrompt({ command: 'audit', arguments: '["a.ts"]' })
    expect(prompt.text).toStartWith('/audit ["a.ts"]\n\nRun the workflow "audit" now: call the workflow tool with script "", name "audit", args the JSON value the workflow reads, built from: "[\\"a.ts\\"]".')
  })

  test('/deep-research runs the bundled script by name when the project has none', async () => {
    const { rt, frames } = await boot([{ tool: 'workflow', args: { script: '', name: 'deep-research', args: { question: '' } } }, { text: 'done' }], INLINE)
    expect(rt.commandList().find((command) => command.name === 'deep-research')).toMatchObject({ source: 'workflow', description: 'Research a question across many sources, cross-check every claim, and write a cited report' })
    expect(rt.commandPrompt({ command: 'deep-research', arguments: 'What changed in v22?' }).text).toContain('args {"question":"What changed in v22?"} and max_agents 20')
    expect(await inlineTurn(rt)).toBe('completed')
    // The bundled script ran: an empty question is its own refusal, before any agent.
    expect(lastWorkflowPart(frames).metadata).toMatchObject({ name: 'deep-research', status: 'failed', error: 'deep-research needs a question: pass args: { question: "..." }.' })
    expect(api.creates).toHaveLength(0)
  })
})
