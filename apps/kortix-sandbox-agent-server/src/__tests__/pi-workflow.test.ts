/**
 * The `workflow` tool and the `agent` tool's `background: true`, through the
 * production pi runtime: pi boots against a local fake model gateway, and a
 * `Bun.serve` fake of the Kortix API on a real port answers the routes the box
 * calls: the child-session routes (`POST …/sessions`, `GET …/sessions/:id`,
 * `POST …/prompts`, `GET …/transcript`, `POST …/stop`) and the project files
 * (`GET …/files`, `GET …/files/content`). Each `agent()` of a script is a
 * child session of that fake API, exactly as on a real box. A person's answer
 * to the run approval goes through the runtime's question broker, as the
 * product's reply route sends it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkflowRunMetadata } from '@kortix/api-contract/kortix-tool-card'
import type { RuntimeQuestionRequest } from '@kortix/api-contract/transcript'
import { loadConfig } from '@/harness/harness'
import { requirePiConfig } from '@/harness/pi/config'
import type { PiRuntime } from '@/harness/pi/runtime'
import { createPiHarnessService, type PiHarnessService } from '@/harness/pi/service'
import { resetKortixEventBusForTests } from '@/services/event-bus/kortix-event-bus'
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
}

interface FakeChild {
  id: string
  body: Record<string, any>
  prompts: string[]
}

function startFakeApi() {
  const creates: Array<Record<string, any>> = []
  const stops: string[] = []
  const reads: string[] = []
  const followUps: Array<{ id: string; text: string }> = []
  const children = new Map<string, FakeChild>()
  const files = new Map<string, string>()
  let behave: (prompt: string, turn: number, child: FakeChild) => ChildBehavior = () => ({})
  let settled = true
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
      if (req.method === 'GET' && path === `${project}/files`) {
        const dir = `${url.searchParams.get('path')}/`
        const entries = [...files.keys()].filter((file) => file.startsWith(dir)).map((file) => ({ path: file, type: 'file' }))
        return entries.length > 0 ? Response.json({ entries, truncated: false, next_cursor: null }) : Response.json({ error: 'Not found' }, { status: 404 })
      }
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
      if (path.endsWith('/transcript')) {
        const user = { role: 'user', text: child.prompts.at(-1) }
        if (now.stall) return Response.json({ messages: [user] })
        return Response.json({ messages: [user, { role: 'assistant', text: now.answer ?? `answer: ${child.prompts[0]}` }] })
      }
      if (req.method === 'GET' && path === `${base}/${id}`) {
        reads.push(id)
        const row = { parent_session_id: PARENT_SESSION }
        if (now.fail) return Response.json({ ...row, status: 'failed' })
        if (now.stop) return Response.json({ ...row, status: 'stopped' })
        if (now.stall) {
          // No real time passes: the box's stall clock reads the jumped system time.
          setSystemTime(new Date(Date.now() + 16 * 60_000))
          return Response.json({ ...row, status: 'running', working: { state: 'working', since: since(child.prompts.length), pending_delivery: false } })
        }
        return Response.json(
          settled
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
  setSystemTime()
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
async function boot(steps: Step[], env: Record<string, string> = {}, opts: { checkout?: boolean } = {}): Promise<{ rt: PiRuntime; frames: ToolFrame[]; workspace: string }> {
  const workspace = mkdtempSync(join(tmpdir(), 'pi-workflow-box-'))
  dirs.push(workspace)
  if (opts.checkout) mkdirSync(join(workspace, '.git'))
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
  return { rt: service.runtime()!, frames, workspace }
}

const runWorkflow = (script: string, args?: unknown, extra: Record<string, unknown> = {}): Step => ({
  tool: 'workflow',
  args: { description: 'Research two topics', script, ...(args === undefined ? {} : { args }), ...extra },
})
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
  test('meta phases are pre-listed, the person approves the plan, two parallel agents stream live, and the script value is the result', async () => {
    // Each child read waits 300 ms, so the run outlasts one 250 ms update window.
    api.hold(300)
    const script = [
      "export const meta = { name: 'two-topics', description: 'Research two topics', phases: [{ title: 'Research' }, { title: 'Summarize', detail: 'never reached' }] }",
      "phase('Research')",
      "const [a, b] = await parallel([() => agent('Research topic A', { label: 'Topic A' }), () => agent('Research topic B', { label: 'Topic B' })])",
      "log('both done')",
      'return { a, b, n: args.n }',
    ].join('\n')
    const { rt, frames } = await boot([{ tool: 'workflow', args: { script, args: { n: 2 }, max_agents: 2 } }, { text: 'parent done' }])
    const turn = rt.admit({ text: 'research both', files: [] })

    // Before any child exists, the card already lists the declared phases as pending, and the person is asked.
    const request = await answer(rt, 'Run it')
    expect(request.questions).toEqual([
      {
        header: 'Workflow',
        question: [
          'Run the workflow "Research two topics"?',
          'Phases: 1. Research, 2. Summarize.',
          'Agents: up to 2. Each agent is its own session with its own computer.',
        ].join('\n'),
        options: [
          { label: 'Run it', description: 'Start this run now.' },
          { label: "Run it, and don't ask again in this session", description: 'Start it, and start later workflows in this session without asking.' },
          { label: 'Cancel', description: 'Start no agent.' },
        ],
      },
    ])
    expect(request.tool?.callID).toBeTruthy()
    const docs0 = workflowDocs(frames)
    expect(docs0[0]!.doc).toMatchObject({ title: 'Research two topics', name: 'two-topics', status: 'running', maxAgents: 2, agents: [], phases: [{ title: 'Research', status: 'pending' }, { title: 'Summarize', status: 'pending' }] })
    expect(await turn.done).toBe('completed')

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
        `run_id: ${final.doc.runId} (resume_run_id relaunches it; save_as saves its script)`,
      ].join('\n'),
    )

    // Live: a running document named both children while they worked, and updates came at most 4 per second.
    const live = docs.filter((d) => d.status === 'running')
    expect(live.some((d) => d.doc.status === 'running' && d.doc.agents.length === 2 && d.doc.agents.every((a) => a.status === 'running' && a.sessionId))).toBe(true)
    for (let i = 1; i < live.length; i++) expect(live[i]!.at - live[i - 1]!.at).toBeGreaterThanOrEqual(200)
    expect(live.every((d) => d.doc.runId === final.doc.runId)).toBe(true)
  })

  test('approval: Cancel starts no agent; "don\'t ask again" runs this and every later workflow of the session without a question', async () => {
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
    // The second workflow call of that turn asked nothing.
    expect(api.creates.map((c) => c.initial_prompt)).toEqual(['one task', 'one task'])
    const outputs = frames.filter((f) => f.tool === 'workflow' && f.state.status === 'completed').map((f) => f.state.output!)
    expect(outputs.slice(1).every((output) => output.startsWith('<workflow_result>\nanswer: one task\n</workflow_result>'))).toBe(true)
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
    const { rt, frames } = await boot([runWorkflow(script, undefined, { max_agents: 3 }), runWorkflow("return agent('big')", undefined, { max_agents: 30 }), { text: 'parent done' }], {
      KORTIX_WORKFLOW_MAX_AGENTS: '26',
    })
    expect(await approvedTurn(rt, 'run it', 2)).toBe('completed')
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
    const { rt, frames } = await boot([runWorkflow(script), { text: 'parent done' }])
    expect(await approvedTurn(rt)).toBe('completed')
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
    const { rt, frames } = await boot([runWorkflow(script), { text: 'parent done' }])
    expect(await approvedTurn(rt)).toBe('completed')
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
    expect(part.output).toContain(`To retry, call workflow with resume_run_id: "${doc.runId}"`)
  })

  test('structured output: JSON in a fence parses, a corrective follow-up fixes a bad answer, 5 bad answers fail, a contradictory schema starts no agent', async () => {
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
      "let failed; try { await agent('json never', { schema: args.schema }) } catch (error) { failed = error.message }",
      "let refused; try { await agent('json bad schema', { schema: args.contradictory }) } catch (error) { refused = error.message }",
      'return { ok, fixed, failed, refused }',
    ].join('\n')
    const { rt, frames } = await boot([runWorkflow(script, { schema, contradictory }), { text: 'parent done' }])
    expect(await approvedTurn(rt)).toBe('completed')

    // Three children: the contradictory schema never started one. Each prompt asks for JSON matching the schema.
    expect(api.creates).toHaveLength(3)
    for (const create of api.creates) {
      expect(create.initial_prompt).toContain('Answer format: your final message must be ONLY one JSON value that matches this JSON Schema.')
      expect(create.initial_prompt).toContain(JSON.stringify(schema, null, 2))
    }
    // The fixes went to the SAME child session: 1 for "json fixed", 4 for "json never" (5 attempts in all).
    expect(api.followUps.map((f) => f.id)).toEqual(['child-2', 'child-3', 'child-3', 'child-3', 'child-3'])
    expect(api.followUps[0]!.text).toStartWith('Your last answer does not match the required JSON Schema: the answer is not valid JSON.')
    expect(api.followUps[1]!.text).toStartWith('Your last answer does not match the required JSON Schema: $.files: expected array, got integer.')

    const part = lastWorkflowPart(frames)
    const result = JSON.parse(part.output!.split('\n</workflow_result>')[0]!.slice('<workflow_result>\n'.length))
    expect(result).toEqual({
      ok: { files: ['a.ts'] },
      fixed: { files: LONG_FILES },
      failed: 'structured output failed validation on all 5 attempts; the last: $.files: expected array, got integer',
      refused:
        'agent() refused: the schema can never be met ($: the required key "files" is not in `properties`, and `additionalProperties: false` rules it out). The agent did not start.',
    })
    const doc = part.metadata as unknown as WorkflowRunMetadata
    expect(doc.agents.map((a) => [a.label, a.status, a.structured])).toEqual([
      ['json ok', 'done', true],
      ['json fixed', 'done', true],
      ['json never', 'failed', true],
    ])
    // A structured summary is the whole JSON, up to 4,000 characters, so the card can parse it; longer is cut there.
    expect(doc.agents[0]!.summary).toBe('{"files":["a.ts"]}')
    expect(JSON.stringify({ files: LONG_FILES }).length).toBeGreaterThan(4_000)
    expect(doc.agents[1]!.summary).toBe(JSON.stringify({ files: LONG_FILES }).slice(0, 4_000))
  })

  test('resume: with A, B, C, D started and B failed, a relaunch returns A from the saved run and runs B, C and D again', async () => {
    let bFails = true
    api.behave((prompt) => ({ fail: prompt === 'B' && bFails }))
    const script = "return parallel(['A', 'B', 'C', 'D'].map((p) => () => agent(p)))"
    const { rt, frames } = await boot([runWorkflow(script), { text: 'first done' }])
    expect(await approvedTurn(rt)).toBe('completed')
    const first = lastWorkflowPart(frames).metadata as unknown as WorkflowRunMetadata
    expect(first.agents.map((a) => a.status)).toEqual(['done', 'failed', 'done', 'done'])
    expect(api.creates.map((c) => c.initial_prompt)).toEqual(['A', 'B', 'C', 'D'])

    // The relaunch names only the run: its saved script runs again.
    bFails = false
    model.script([{ tool: 'workflow', args: { resume_run_id: first.runId } }, { text: 'second done' }])
    const request = rt.admit({ text: 'retry it', files: [] })
    const asked = await answer(rt, 'Run it')
    expect(asked.questions[0]!.question).toContain(`It relaunches run ${first.runId}: agents that completed there return their saved results.`)
    expect(await request.done).toBe('completed')

    expect(api.creates.map((c) => c.initial_prompt)).toEqual(['A', 'B', 'C', 'D', 'B', 'C', 'D'])
    const part = lastWorkflowPart(frames)
    const second = part.metadata as unknown as WorkflowRunMetadata
    expect(second.runId).not.toBe(first.runId)
    expect(second.resumedFrom).toBe(first.runId)
    expect(second.title).toBe('Research two topics')
    expect(second.agents.map((a) => [a.label, a.status, a.cached ?? false, a.sessionId ?? null])).toEqual([
      ['A', 'done', true, null],
      ['B', 'done', false, 'child-5'],
      ['C', 'done', false, 'child-6'],
      ['D', 'done', false, 'child-7'],
    ])
    expect(part.output).toContain('agents: 4 (4 done; 1 reused from the earlier run)')
    expect(part.output).toContain(JSON.stringify(['answer: A', 'answer: B', 'answer: C', 'answer: D'], null, 2))

    // A run id this computer never saw: nothing to resume.
    model.script([{ tool: 'workflow', args: { resume_run_id: 'no-such-run-0000' } }, { text: 'third done' }])
    expect(await rt.admit({ text: 'retry the other one', files: [] }).done).toBe('completed')
    expect(lastWorkflowPart(frames).error).toContain('nothing to resume: no run no-such-run-0000 is saved on this computer.')
  })

  test('a stalled agent starts over in a new session (attempt 2); one that stalls on all 6 attempts fails the call', async () => {
    api.behave((prompt, _turn, child) => ({ stall: prompt === 'always stalls' || (prompt === 'stalls once' && child.id === 'child-1') }))
    const script = [
      "const first = await agent('stalls once', { label: 'Once' })",
      "let error; try { await agent('always stalls', { label: 'Always' }) } catch (e) { error = e.message }",
      'return { first, error }',
    ].join('\n')
    const { rt, frames } = await boot([runWorkflow(script), { text: 'parent done' }])
    expect(await approvedTurn(rt)).toBe('completed')

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

  test('stopping the turn stops every child the run started', async () => {
    api.childrenWork()
    const script = "return parallel([() => agent('slow one'), () => agent('slow two')])"
    const { rt, frames } = await boot([runWorkflow(script), { text: 'never reached' }])
    const turn = rt.admit({ text: 'run it', files: [] })
    await answer(rt, 'Run it')
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

describe('pi workflow tool, background: true', () => {
  test('the call returns at once with the runner session; the runner runs the workflow from its context without asking', async () => {
    // The runner never settles here: a waiting call would hang until the test times out.
    api.childrenWork()
    const script = [
      "export const meta = { description: 'Two lookups', phases: [{ title: 'Look' }] }",
      "phase('Look')",
      "return parallel(args.topics.map((t) => () => agent('Look up ' + t, { label: t })))",
    ].join('\n')
    const parent = await boot([{ tool: 'workflow', args: { script, args: { topics: ['x', 'y'] }, background: true, max_agents: 2 } }, { text: 'parent done' }])
    const turn = parent.rt.admit({ text: 'start it', files: [] })
    const request = await answer(parent.rt, 'Run it')
    expect(request.questions[0]!.question).toContain('It runs in the background: this chat stays free, and the result arrives here when the run ends.')
    expect(await turn.done).toBe('completed')

    // ONE runner session, created to notify this session, with the run in its context. Nobody waits on it.
    expect(api.creates).toHaveLength(1)
    const runner = api.creates[0]!
    expect(runner).toMatchObject({ notify_parent_on_turn_end: true, name: 'Two lookups (workflow)' })
    expect(runner.initial_prompt).toBe('Run the workflow "Two lookups" from this session\'s context: call the workflow tool with { "from_context": true }.')
    expect(runner.initial_context).toContain('Call the workflow tool once with { "from_context": true }.')
    const part = lastWorkflowPart(parent.frames)
    const doc = part.metadata as unknown as WorkflowRunMetadata
    expect(runner.runtime_context).toEqual({
      'kortix.workflow.run_id': doc.runId,
      'kortix.workflow.title': 'Two lookups',
      'kortix.workflow.max_agents': 2,
      'kortix.workflow.planned': 2,
      'kortix.workflow.args.0': JSON.stringify({ topics: ['x', 'y'] }),
      'kortix.workflow.script.0': script,
      'kortix.subagent.depth': 1,
    })
    expect(api.reads).toEqual([])
    expect(part.status).toBe('completed')
    expect(doc).toMatchObject({ status: 'running', background: { sessionId: 'child-1' }, agents: [], phases: [{ title: 'Look', status: 'pending' }] })
    expect(part.output).toStartWith('<workflow_started>\nThe workflow runs in the background in its own runner session child-1.')
    expect(part.output).toContain(`run_id: ${doc.runId}`)

    // The runner: a child session (depth 1) that boots with that context and calls the tool with from_context alone.
    api.stop()
    api = startFakeApi()
    const runnerBox = await boot([{ tool: 'workflow', args: { from_context: true } }, { text: 'runner done' }], {
      KORTIX_SESSION_ID: 'sess-runner',
      KORTIX_SESSION_CONTEXT: JSON.stringify(runner.runtime_context),
    })
    expect(await runnerBox.rt.admit({ text: runner.initial_prompt, files: [] }).done).toBe('completed')
    expect(runnerBox.rt.questions.list()).toHaveLength(0)
    expect(api.creates.map((c) => [c.initial_prompt, c.runtime_context['kortix.subagent.depth']])).toEqual([
      ['Look up x', 2],
      ['Look up y', 2],
    ])
    const ran = lastWorkflowPart(runnerBox.frames)
    expect(ran.metadata).toMatchObject({ runId: doc.runId, title: 'Two lookups', status: 'done', maxAgents: 2, phases: [{ title: 'Look', status: 'done' }] })
    expect(ran.output).toStartWith(`<workflow_result>\n${JSON.stringify(['answer: Look up x', 'answer: Look up y'], null, 2)}\n</workflow_result>`)
  })

  test('resume_run_id of a background run is a follow-up prompt to its runner session, and the call waits for its answer', async () => {
    api.behave((_prompt, turn) => ({ answer: turn === 1 ? 'first run' : '<workflow_result>\n"relaunched"\n</workflow_result>\nagents: 1 (1 done)' }))
    const { rt, frames } = await boot([runWorkflow("return agent('x')", undefined, { background: true }), { text: 'started' }])
    expect(await approvedTurn(rt)).toBe('completed')
    const started = lastWorkflowPart(frames).metadata as unknown as WorkflowRunMetadata
    expect(started.background).toEqual({ sessionId: 'child-1' })

    model.script([{ tool: 'workflow', args: { resume_run_id: started.runId } }, { text: 'relaunched' }])
    expect(await approvedTurn(rt, 'relaunch it')).toBe('completed')
    expect(api.creates).toHaveLength(1)
    expect(api.followUps).toEqual([
      {
        id: 'child-1',
        text: `Relaunch the workflow: call the workflow tool with { "from_context": true, "resume_run_id": "${started.runId}" }. Then reply with its whole text output, unchanged.`,
      },
    ])
    const part = lastWorkflowPart(frames)
    expect(part.metadata).toMatchObject({ status: 'done', resumedFrom: started.runId, background: { sessionId: 'child-1' } })
    expect(part.output).toBe('<workflow_result>\n"relaunched"\n</workflow_result>\nagents: 1 (1 done)\n(runner session child-1)')
  })

  test('a session one level below the cap refuses background, because the runner\'s agents would be past it', async () => {
    const { rt, frames } = await boot([runWorkflow("return agent('x')", undefined, { background: true }), { text: 'parent done' }], {
      KORTIX_SESSION_CONTEXT: JSON.stringify({ 'kortix.subagent.depth': 1 }),
    })
    expect(await rt.admit({ text: 'run it', files: [] }).done).toBe('completed')
    expect(api.creates).toHaveLength(0)
    expect(lastWorkflowPart(frames).error).toContain('A background run needs two more session levels (its runner, then its agents), and this session is level 1 of at most 2.')
  })
})

describe('pi workflow tool, saved workflows', () => {
  const audit = [
    "export const meta = { name: 'audit', description: 'Audit the given files', phases: [{ title: 'Audit' }] }",
    "phase('Audit')",
    "return parallel(args.files.map((f) => () => agent('Audit ' + f)))",
  ].join('\n')

  test('a project checkout: save_as writes .kortix/workflows/<name>.js, list_saved lists it, name runs it with args', async () => {
    const { rt, frames, workspace } = await boot(
      [
        { tool: 'workflow', args: { script: audit, save_as: 'audit' } },
        { tool: 'workflow', args: { list_saved: true } },
        { tool: 'workflow', args: { name: 'audit', args: { files: ['a.ts'] } } },
        { text: 'done' },
      ],
      {},
      { checkout: true },
    )
    expect(await approvedTurn(rt)).toBe('completed')
    expect(readFileSync(join(workspace, '.kortix/workflows/audit.js'), 'utf8')).toBe(`${audit}\n`)
    const [saved, listed, ran] = frames.filter((f) => f.tool === 'workflow' && f.state.status === 'completed').map((f) => f.state)
    expect(saved!.output).toStartWith('Saved the workflow as .kortix/workflows/audit.js in this session\'s project checkout. Run it with { "name": "audit" }.')
    expect(listed!.output).toBe(`Saved workflows (.kortix/workflows/ in this session's project checkout):\n- audit: Audit the given files\nRun one with { "name": "<name>", "args": … }.`)
    expect(ran!.metadata).toMatchObject({ name: 'audit', title: 'Audit the given files', status: 'done', phases: [{ title: 'Audit', status: 'done' }] })
    expect(api.creates.map((c) => c.initial_prompt)).toEqual(['Audit a.ts'])
  })

  test('no checkout (My Kortix): saved workflows are read through the API, and save_as hands the file to a session that opens a change request', async () => {
    api.files.set('.kortix/workflows/audit.js', audit)
    api.childrenWork()
    const { rt, frames, workspace } = await boot(
      [
        { tool: 'workflow', args: { list_saved: true } },
        { tool: 'workflow', args: { script: audit, save_as: 'audit-2' } },
        { text: 'done' },
      ],
      { KORTIX_META_AGENT: '1' },
    )
    expect(await rt.admit({ text: 'list and save', files: [] }).done).toBe('completed')
    const [listed, saved] = frames.filter((f) => f.tool === 'workflow' && f.state.status === 'completed').map((f) => f.state)
    expect(listed!.output).toBe(`Saved workflows (.kortix/workflows/ on the project's default branch):\n- audit: Audit the given files\nRun one with { "name": "<name>", "args": … }.`)
    // The save: one background session with the file in its prompt; nothing written on this box.
    expect(api.creates).toHaveLength(1)
    expect(api.creates[0]).toMatchObject({ notify_parent_on_turn_end: true, name: 'Save the audit-2 workflow' })
    expect(api.creates[0]!.initial_prompt).toContain(`Create the file \`.kortix/workflows/audit-2.js\` with exactly the content between the two marker lines below`)
    expect(api.creates[0]!.initial_prompt).toContain(`-----BEGIN WORKFLOW-----\n${audit}\n-----END WORKFLOW-----`)
    expect(saved!.output).toContain('The session child-1 writes .kortix/workflows/audit-2.js, commits it and opens a change request.')
    expect(existsSync(join(workspace, '.kortix'))).toBe(false)

    // Run the saved one by name: read through the API.
    api.stop()
    api = startFakeApi()
    api.files.set('.kortix/workflows/audit.js', audit)
    const box = await boot([{ tool: 'workflow', args: { name: 'audit', args: { files: ['b.ts'] } } }, { text: 'ran' }], { KORTIX_META_AGENT: '1' })
    expect(await approvedTurn(box.rt)).toBe('completed')
    expect(api.creates.map((c) => c.initial_prompt)).toEqual(['Audit b.ts'])
    expect(lastWorkflowPart(box.frames).metadata).toMatchObject({ name: 'audit', status: 'done' })
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
