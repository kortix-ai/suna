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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '@/harness/harness'
import { resetKortixEventBusForTests } from '@/services/event-bus/kortix-event-bus'
import { buildDaemonApp } from '@/app/server'
import { requirePiConfig } from '@/harness/pi/config'
import { createPiHarnessService, piDefinition, type PiHarnessService } from '@/harness/pi/service'
import type { PiBootState } from '@/harness/pi/boot-state'
import { extensionAgentHooks, installedPackages, parseNpmSource, systemPackageCacheDir, warmSystemPackageCache } from '@/harness/pi/extensions/host'
import { ensureProjectPackageBundle } from '@/harness/pi/extensions/bundle'
import { signTestUserContext } from './helpers/open-code-harness'
import { readHostHealth } from '@/harness/shared/host-health'
import { sanitizeRuntimeEvent } from '@/harness/shared/audit-relay'
import { AGENT_ENV_SH } from '@/harness/shared/agent-env-file'
import { logger } from '@/lib/log/logger'
import { expandCommandTemplate, type PiRuntimeHooks } from '@/harness/pi/runtime'
import { MessageIdClock } from '@/harness/pi/message-id'
import { createPiSessionLogPort, piSessionLog } from '@/harness/pi/session-log'
import { restorePiSessionLog } from '@/harness/pi/session-log-restore'
import { SESSION_LOG_EVENTS, upcast as upcastSessionLog, type SessionLogMessage } from '@kortix/api-contract/session-log'
import { encodeCompiledAgentConfigEnv } from '@kortix/api-contract/compiled-agent-config-env'
import { flushSessionLogJournal, resetSessionLogJournalForTests, startSessionLogJournal } from '@/harness/shared/session-log-journal'
import { spawnSync } from 'node:child_process'
import { registerHarnessAssets, resetHarnessAssetsForTests } from '@/services/runtime-assets/runtime-assets'
import {
  FEATURE_DISABLED,
  buildRelease,
  commitAll,
  initRepo,
  serveRelease,
  startFakeApi,
  write,
  type FakeApi,
} from './helpers/config-release-fixtures'

const TOKEN = 'pi-test-token'
const MODEL_ID = 'test-model'

type ToolCall = { tool: string; args: Record<string, unknown> }
/**
 * One scripted model reply: text, a tool call, several tool calls, or text ending on `finish`.
 * `cut` streams its text, then closes the stream with no `finish_reason` (an upstream
 * cut; pi-ai throws "Stream ended without finish_reason"). `cutMidLine` streams its text, then
 * half of the next data line, and closes (a cut inside a JSON chunk). `status` answers with that HTTP error
 * (`message` is its error text). `promptTokens` is the context size the reply reports in its usage.
 */
type Step =
  | { text: string; finish?: 'stop' | 'length'; promptTokens?: number }
  | ToolCall
  | { tools: ToolCall[] }
  | { cut: string }
  | { cutMidLine: string }
  | { status: number; message?: string }
  | { stall: true }

/**
 * An OpenAI-compatible `/chat/completions` that answers each request with the
 * next scripted step as an SSE chunk stream, and records what it was sent.
 */
function startFakeGateway() {
  let script: Step[] = []
  let calls = 0
  const requests: Array<{ path: string; auth: string | null }> = []
  /** The chat messages of each request, so a test reads what the model was sent. */
  const sent: Array<Array<{ role: string; content: unknown }>> = []
  /** The sampling fields of each request body. */
  const sampling: Array<{ temperature?: number; top_p?: number; tool_choice?: unknown; tools: number; toolNames: string[]; reasoning_effort?: string }> = []
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model: MODEL_ID, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
      const json = (await req.json()) as { messages: Array<{ role: string; content: unknown }>; temperature?: number; top_p?: number; tool_choice?: unknown; tools?: Array<{ function?: { name?: string } }>; reasoning_effort?: string }
      sent.push(json.messages)
      sampling.push({ temperature: json.temperature, top_p: json.top_p, tool_choice: json.tool_choice, tools: json.tools?.length ?? 0, toolNames: (json.tools ?? []).map((t) => String(t.function?.name)), reasoning_effort: json.reasoning_effort })
      requests.push({ path: url.pathname, auth: req.headers.get('authorization') })
      const step: Step = script.shift() ?? { text: '' }
      calls += 1
      if ('status' in step) return new Response(JSON.stringify({ error: { message: step.message ?? 'scripted failure' } }), { status: step.status })
      if ('stall' in step) return new Promise<Response>((resolve) => {
        req.signal.addEventListener('abort', () => resolve(new Response('aborted', { status: 499 })), { once: true })
      })
      let body = chunk({ role: 'assistant', content: '' })
      if ('cut' in step) {
        if (step.cut) body += chunk({ content: step.cut })
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      }
      if ('cutMidLine' in step) {
        body += chunk({ content: step.cutMidLine })
        const next = chunk({ content: ' and the rest of it' })
        body += next.slice(0, Math.floor(next.length / 2))
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      }
      if ('tool' in step || 'tools' in step) {
        const toolCalls = 'tools' in step ? step.tools : [step]
        toolCalls.forEach((call, index) => {
          const args = JSON.stringify(call.args)
          body += chunk({ tool_calls: [{ index, id: `call_${calls}_${index}`, type: 'function', function: { name: call.tool, arguments: '' } }] })
          body += chunk({ tool_calls: [{ index, function: { arguments: args.slice(0, 5) } }] })
          body += chunk({ tool_calls: [{ index, function: { arguments: args.slice(5) } }] })
        })
        body += chunk({}, 'tool_calls')
      } else {
        // Two deltas, so the stream carries more than one `message.part.delta`.
        const half = Math.ceil(step.text.length / 2)
        if (step.text) body += chunk({ content: step.text.slice(0, half) })
        if (step.text.length > half) body += chunk({ content: step.text.slice(half) })
        body += chunk({}, step.finish ?? 'stop')
      }
      const promptTokens = 'promptTokens' in step && step.promptTokens ? step.promptTokens : 1
      body += `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model: MODEL_ID, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 } })}\n\n`
      body += 'data: [DONE]\n\n'
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1/llm`,
    requests,
    sent,
    sampling,
    script: (steps: Step[]) => {
      script = [...steps]
    },
    stop: () => server.stop(true),
  }
}

let gateway: ReturnType<typeof startFakeGateway>
let catalogDir: string
let previousManagedSkills: string | undefined
beforeAll(() => {
  // The image's baked managed-skills overlay: the rigs pin exactly the skills
  // they write, never the box's set. (The /etc/pt-env leak is neutralized by
  // the runner: tests/bin/package-quality.ts sets KORTIX_PT_ENV_PATH.)
  previousManagedSkills = process.env.KORTIX_MANAGED_SKILLS_DIR
  process.env.KORTIX_MANAGED_SKILLS_DIR = join(tmpdir(), 'kortix-absent-managed-skills')
  gateway = startFakeGateway()
  catalogDir = mkdtempSync(join(tmpdir(), 'pi-catalog-'))
  writeFileSync(join(catalogDir, 'catalog.json'), JSON.stringify({ models: { [MODEL_ID]: { name: 'Test Model', limit: { context: 64_000, output: 4_096 } } } }))
})
afterAll(() => {
  if (previousManagedSkills === undefined) delete process.env.KORTIX_MANAGED_SKILLS_DIR
  else process.env.KORTIX_MANAGED_SKILLS_DIR = previousManagedSkills
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
    // Never the machine's ~/.pi or the image's /opt/kortix/pi-agent.
    KORTIX_PI_AGENT_DIR: join(workspace, '.pi-agent'),
    KORTIX_PI_PACKAGES_DIR: join(workspace, '.pi-packages'),
    KORTIX_PROJECT_AUTO_CLONE: '0',
    KORTIX_WORKSPACE: workspace,
    KORTIX_PROJECT_TARGET: workspace,
    KORTIX_TOKEN: TOKEN,
    KORTIX_SESSION_ID: 'sess-pi-test',
    KORTIX_PROJECT_ID: 'proj-pi-test',
    // Transient model errors retry on a real backoff; tests keep it short.
    KORTIX_PI_TURN_RETRY_BASE_MS: '5',
    ...env,
  }
}

async function boot(input: {
  script: Step[]
  env?: Record<string, string>
  start?: boolean
  workspace?: string
  /** Runs on the fresh workspace before the runtime starts. */
  prepare?: (workspace: string) => void
  hooks?: PiRuntimeHooks
  /** Config release store and notice paths; a rig reads no release unless its env names an API. */
  releases?: { root: string; noticePath: string }
}): Promise<Rig> {
  const workspace = input.workspace ?? mkdtempSync(join(tmpdir(), 'pi-harness-'))
  input.prepare?.(workspace)
  gateway.script(input.script)
  const env = rigEnv(workspace, input.env)
  const cfg = requirePiConfig(loadConfig(env))
  const service = createPiHarnessService(cfg, undefined, { env, hooks: input.hooks, releases: input.releases })
  const bootState: PiBootState = { repoMaterializationError: null, timeline: [], initialRuntimeSessionRequired: false }
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

/**
 * A message id the runtime has not seen: `id` with its last char set to `c`. A minted id ends in a
 * random base62 char, so a plain swap returns `id` itself once in 62 runs (then `steer` answers
 * `duplicate` and `retract` answers `read`). Upper case keeps x/y/w/z ids distinct from each other.
 */
function siblingId(id: string, c: string): string {
  return id.slice(0, -1) + (id.endsWith(c) ? c.toUpperCase() : c)
}

/**
 * pi discovers user-level skills under the home it is handed
 * (`harness/pi/service.ts` → `environment: { home: homedir() }`), and
 * `homedir()` is `$HOME`. In a sandbox that is the agent's own empty home; on a
 * developer machine it is the person's, so `GET /skill` returned their personal
 * skills alongside the two this file writes and the name-clash assertion failed
 * locally while passing in CI. A test that reads the machine it runs on is not
 * a test, so give every rig an empty home of its own.
 */
let homeDir: string
const realHome = process.env.HOME
/** The image bakes managed skills and a host env file this box really has; a
 *  rig that reads the machine is not a test, so point both at absent paths. */
const absentBoxState = join(tmpdir(), 'pi-harness-absent-box-state')
const realManagedSkillsDir = process.env.KORTIX_MANAGED_SKILLS_DIR
const realPtEnvPath = process.env.KORTIX_PT_ENV_PATH
beforeEach(() => {
  resetKortixEventBusForTests()
  homeDir = mkdtempSync(join(tmpdir(), 'pi-home-'))
  process.env.HOME = homeDir
  process.env.KORTIX_MANAGED_SKILLS_DIR = absentBoxState
  process.env.KORTIX_PT_ENV_PATH = absentBoxState
})
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.service.lifecycle.stop().catch(() => {})
    rmSync(rig.workspace, { recursive: true, force: true })
  }
  resetKortixEventBusForTests()
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  if (realManagedSkillsDir === undefined) delete process.env.KORTIX_MANAGED_SKILLS_DIR
  else process.env.KORTIX_MANAGED_SKILLS_DIR = realManagedSkillsDir
  if (realPtEnvPath === undefined) delete process.env.KORTIX_PT_ENV_PATH
  else process.env.KORTIX_PT_ENV_PATH = realPtEnvPath
  rmSync(homeDir, { recursive: true, force: true })
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
  test('a silent model stall ends with a visible error and a failed turn', async () => {
    const r = await boot({ script: [{ stall: true }], env: { KORTIX_PI_NO_PROGRESS_MS: '100' } })
    const root = r.service.runtime()!.rootId
    const messageID = 'msg_0198e2a4b0f0ABCDEFGHIJKLMN'
    const events = await r.bearer('/kortix/opencode/events?since=0')
    expect((await prompt(r, root, { messageID, parts: [{ type: 'text', text: 'answer me' }] })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy(), 3_000)
    const probe = (await r.bearer(`/kortix/health?turn=1&turn_message_id=${messageID}`).then((res) => res.json())) as Record<string, unknown>
    expect(probe.turn_end).toBe('failed')
    const text = await readSse(events, (value) => value.includes('event: session.error') && value.includes('event: session.idle'))
    expect(text).toContain('The session made no progress')
  })
  test('a synthetic prompt part reaches the transcript as harness context (KRTX-2597)', async () => {
    const r = await boot({ script: [{ text: 'done' }] })
    const root = r.service.runtime()!.rootId
    const continuation = 'msg_0198e2a4b0f0ABCDEFGHIJKLMN'
    const mixed = 'msg_0198e2a4b0f0BCDEFGHIJKLMNO'
    expect((await prompt(r, root, { messageID: continuation, parts: [{ type: 'text', text: '[auto-recovery] Continue from where you left off.', synthetic: true }] })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy(), 3_000)
    // The person's prompt mixing harness context with their own words is NOT
    // internal: the flag is a per-part mark, and only an all-synthetic text
    // body is a continuation.
    const mixedRes = await prompt(r, root, { messageID: mixed, parts: [{ type: 'text', text: 'harness note', synthetic: true }, { type: 'text', text: 'my real question' }] })
    expect(mixedRes.status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy(), 3_000)
    const rows = (await r.user(`/session/${root}/message`).then((res) => res.json())) as Array<{ info?: { id?: string; role?: string }; parts?: Array<Record<string, unknown>> }>
    expect(rows.find((row) => row.info?.id === continuation)?.parts?.[0]).toMatchObject({ type: 'text', synthetic: true })
    const mixedRow = rows.find((row) => row.info?.id === mixed)
    expect(mixedRow?.parts?.[0]).toMatchObject({ type: 'text' })
    expect(mixedRow?.parts?.[0]).not.toHaveProperty('synthetic', true)
  })
  test('health reports the pi runtime before and after start', async () => {
    const r = await boot({ script: [{ text: 'hi' }], start: false })
    const before = (await r.bearer('/kortix/health').then((res) => res.json())) as Record<string, any>
    expect(before.harness).toMatchObject({ id: 'pi', version: expect.stringContaining('pi-agent-core@'), state: 'down', ready: false })
    // E1: pi serves subagents and compaction, and none of the features its surface answers 501 for.
    expect(before.capabilities).toContain('session.subagents')
    expect(before.capabilities).toContain('session.compact')
    expect(before.capabilities).toContain('session.commands')
    expect(before.capabilities).toContain('session.log.v2')
    expect(before.capabilities).not.toContain('session.rewind')
    expect(before.capabilities).not.toContain('session.attach')
    expect(before.runtimeReady).toBe(false)
    expect(before.opencode).toBe('down')
    expect((await r.user('/session')).status).toBe(503)

    await r.service.lifecycle.start()
    const after = (await r.bearer('/kortix/health').then((res) => res.json())) as Record<string, any>
    expect(after.runtimeReady).toBe(true)
    expect(after.status).toBe('ok')
    expect(after.harness).toMatchObject({ state: 'ok', ready: true, error: null })
    expect(after.opencode).toBe('ok')
    expect(after.harness.details.model).toBe(`kortix/${MODEL_ID}`)
    // The host facts every harness reports (E19): pi's runtime_truth is the
    // pure read — identity real, components unknown until pi runs the ticker.
    const truth = after.runtime_truth as { daemon_build: unknown; components: Record<string, { state: string }> }
    expect(truth.daemon_build).toBeDefined()
    expect(Object.keys(truth.components).sort()).toEqual(['catalog', 'cli', 'config_release', 'daemon', 'managed_skills'])
    const host = await readHostHealth({ cfg: loadConfig(r.env), bootTime: Date.now(), bootState: r.bootState, staticWebPort: null, resources: () => null })
    expect(Object.keys(after)).toEqual(expect.arrayContaining(Object.keys(host)))
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

    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as {
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
    const stream = await r.bearer(`/kortix/runtime/events?since=0`)
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    const text = await readSse(stream, (t) => t.includes('event: session.idle'))
    expect(text).toContain('event: kortix.hello')
    expect(text).toContain('event: message.updated')
    expect(text).toContain('event: message.part.delta')
    expect(text).toContain('event: session.idle')

    // The state document and the turn probes the control plane polls.
    const state = (await r.bearer('/kortix/runtime/state').then((res) => res.json())) as Record<string, any>
    expect(state.schema).toBe('kortix.runtime.v1')
    expect(state.identity.runtime_session_id).toBe(root)
    expect(state.identity.harness).toBe('pi')
    expect(state.identity.harness_version).toMatch(/^pi-agent-core@/)
    // pi writes no OpenCode-named identity fields.
    expect(state.identity.opencode_session_id).toBeUndefined()
    expect(state.identity.opencode_version).toBeUndefined()
    // `/kortix/opencode/*` is the pre-W3 path of the same router, for an older API.
    const legacy = (await r.bearer('/kortix/opencode/state').then((res) => res.json())) as Record<string, any>
    expect(legacy.identity.runtime_session_id).toBe(root)
    expect(state.statuses.value[root]).toEqual({ type: 'idle' })
    expect(state.agents.value[0].name).toBe('build')
    const probe = (await r.bearer(`/kortix/health?turn=1&turn_message_id=${messageID}`).then((res) => res.json())) as Record<string, unknown>
    expect(probe.turn_in_flight).toBe(false)
    expect(probe.turn_end).toBe('completed')
    const unknown = (await r.bearer('/kortix/health?turn=1&turn_message_id=msg_000000000000zzzzzzzzzzzzzz').then((res) => res.json())) as Record<string, unknown>
    expect(unknown.turn_in_flight).toBe(false)
    expect(unknown.turn_end).toBe('abandoned')
    expect(unknown.turn_orphaned_prompt).toBe(true)

    // A repeated delivery of the same id is deduplicated, not re-run.
    const again = await r.user(`/session/${root}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID, parts: [{ type: 'text', text: 'write a note' }] }),
    })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ deduplicated: true })
  })

  // OpenCode `noReply` (the first message of a conversation with people, a
  // released Stop batch): the message joins the conversation and no turn runs.
  // Dev 2026-10-01: pi ignored it, answered an ask meant for a person, and the
  // turn was then aborted.
  test('a noReply prompt joins the conversation without a turn, and the next turn sees it', async () => {
    const r = await boot({ script: [{ text: 'Noted: green.' }] })
    const root = r.service.runtime()!.rootId
    const before = gateway.requests.length
    const ask = 'msg_0198e2a4b0c1ASKASKASKASKAS'
    expect((await prompt(r, root, { messageID: ask, noReply: true, parts: [{ type: 'text', text: 'Which color, green or blue?' }] })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy())
    expect(gateway.requests.length).toBe(before)
    const afterAsk = (await r.user(`/session/${root}/message`).then((res) => res.json())) as Array<{ info: { id: string; role: string } }>
    expect(afterAsk.map((m) => [m.info.id, m.info.role])).toEqual([[ask, 'user']])

    expect((await prompt(r, root, { messageID: 'msg_0198e2a4b0c2REPLYREPLYREPL', parts: [{ type: 'text', text: 'green' }] })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy())
    expect(gateway.requests.length).toBe(before + 1)
    const seen = (r.service.runtime() as unknown as { agent: { state: { messages: Array<{ role: string; content: unknown }> } } }).agent.state.messages
    expect(seen.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content))).toEqual([
      JSON.stringify('Which color, green or blue?'),
      expect.stringContaining('green'),
    ])
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

  test('the Kortix turn verbs start, read, refuse to remove and stop a turn, and list the agents (W5 E4)', async () => {
    const r = await boot({
      script: [{ tool: 'bash', args: { command: 'printf kortix > note.txt' } }, { tool: 'bash', args: { command: 'sleep 20' } }, { text: 'unreachable' }],
      env: { KORTIX_AGENT_NAME: 'coder', KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { coder: { description: 'Writes code', mode: 'primary' }, reviewer: { mode: 'subagent' } } }) },
    })
    const root = r.service.runtime()!.rootId
    const health = (await r.bearer('/kortix/health').then((res) => res.json())) as { capabilities: string[] }
    expect(health.capabilities).toContain('runtime.turns.v1')

    const post = (path: string, body: unknown) =>
      r.user(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await post(`/kortix/runtime/sessions/${root}/prompt`, { parts: [] })).status).toBe(400)
    expect((await post(`/kortix/runtime/sessions/${root}/prompt`, { parts: [{ type: 'text', text: 'x' }], model: 'no-slash' })).status).toBe(400)
    expect((await post('/kortix/runtime/sessions/ses_unknown/prompt', { parts: [{ type: 'text', text: 'x' }] })).status).toBe(404)

    const messageId = 'msg_0198e2a4b0c3ABCDEFGHIJKLMN'
    const accepted = await post(`/kortix/runtime/sessions/${root}/prompt`, {
      message_id: messageId,
      parts: [{ type: 'text', text: 'write a note, then wait' }],
      model: `kortix/${MODEL_ID}`,
    })
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual({ message_id: messageId })
    // The same id again is a duplicate, not a second turn.
    const again = await post(`/kortix/runtime/sessions/${root}/prompt`, { message_id: messageId, parts: [{ type: 'text', text: 'again' }] })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ deduplicated: true })

    await waitForRunningTool(r, root)
    // The first running tool can be the printf itself. The shell creates
    // note.txt empty before printf writes it, so wait for the content.
    const note = join(r.workspace, 'note.txt')
    await waitFor(() => existsSync(note) && readFileSync(note, 'utf8') === 'kortix')
    const message = (await r.user(`/kortix/runtime/messages/${root}/${messageId}`).then((res) => res.json())) as { info: { id: string; role: string } }
    expect(message.info).toMatchObject({ id: messageId, role: 'user' })
    expect((await r.user(`/kortix/runtime/messages/${root}/msg_missing`)).status).toBe(404)
    expect((await r.user(`/kortix/runtime/messages/${root}/${messageId}`, { method: 'DELETE' })).status).toBe(409)
    expect((await r.user(`/kortix/runtime/messages/${root}/msg_missing`, { method: 'DELETE' })).status).toBe(404)

    const agents = (await r.user('/kortix/runtime/agents').then((res) => res.json())) as { agents: Array<{ name: string }> }
    expect(agents.agents.map((agent) => agent.name)).toEqual(['coder', 'reviewer'])

    expect((await post(`/kortix/runtime/sessions/${root}/abort`, {})).status).toBe(200)
    await waitFor(() => !r.service.runtime()!.busy())
    // Both mounts serve the verbs; an unauthenticated call is refused.
    expect((await r.app.request(`/kortix/runtime/sessions/${root}/abort`, { method: 'POST' })).status).toBe(401)
    expect((await post(`/kortix/opencode/sessions/${root}/abort`, {})).status).toBe(200)
  })

  test('the catalogs are the project\'s: pi serves no config, agent or provider document', async () => {
    // Pickers read the API (`/detail`, `/model-picker`). The routes 404 instead
    // of answering with objects pi would have to invent. The command list is
    // pi's own prompt templates: empty for a project with none.
    const r = await boot({ script: [{ text: 'ok' }], env: { KORTIX_AGENT_NAME: 'coder', KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { coder: { prompt: 'You code.', description: 'Writes code' } } }) } })
    for (const path of ['/config', '/global/config', '/agent', '/provider', '/config/providers']) {
      expect({ path, status: (await r.user(path)).status }).toEqual({ path, status: 404 })
    }
    expect(await r.user('/command').then((res) => res.json())).toEqual([])
    const tools = (await r.user('/tool/ids').then((res) => res.json())) as string[]
    expect([...tools]).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_search', 'image_search', 'scrape_webpage', 'memory', 'show', 'question', 'codemode', 'task'])
    expect((await r.user('/session/status').then((res) => res.json()))).toEqual({})
    expect((await r.user('/lsp/diagnostics')).status).toBe(200)
    expect((await r.user('/no/such/route')).status).toBe(404)
  })

  test('the agent\'s temperature, top_p and steps reach the gateway request', async () => {
    const agent = { prompt: 'You code.', temperature: 0.3, top_p: 0.8, steps: 2 }
    const r = await boot({
      script: [{ tool: 'bash', args: { command: 'true' } }, { text: 'Done.' }],
      env: { KORTIX_AGENT_NAME: 'coder', KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { coder: agent } }) },
    })
    const root = r.service.runtime()!.rootId
    const before = gateway.sampling.length
    expect((await prompt(r, root, { parts: [{ type: 'text', text: 'go' }] })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy())
    // Step 2 of 2 is the last: the model may not call another tool.
    expect(gateway.sampling.slice(before)).toEqual([
      { temperature: 0.3, top_p: 0.8, tool_choice: undefined, tools: 14, toolNames: expect.arrayContaining(['bash', 'codemode']) },
      { temperature: 0.3, top_p: 0.8, tool_choice: 'none', tools: 14, toolNames: expect.arrayContaining(['bash', 'codemode']) },
    ])
  })

  test('an agent or prompt variant reaches the gateway as the reasoning_effort the catalog offers', async () => {
    // The gateway catalog states effort as `reasoning_options` values, not `variants` keys.
    // Prod 2026-10-19: pi read only the option's `type` ('effort'), so every variant ran with thinking off.
    const workspace = mkdtempSync(join(tmpdir(), 'pi-harness-'))
    writeFileSync(join(workspace, 'catalog.json'), JSON.stringify({ models: { [MODEL_ID]: {
      name: 'Test Model', reasoning: true, limit: { context: 64_000, output: 4_096 },
      reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high', 'max'] }],
    } } }))
    const r = await boot({
      workspace,
      script: [{ text: 'one' }, { text: 'two' }, { text: 'three' }],
      env: {
        KORTIX_LLM_CATALOG_FILE: join(workspace, 'catalog.json'),
        KORTIX_AGENT_NAME: 'lens',
        KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { lens: { prompt: 'You judge.', variant: 'high' } } }),
      },
    })
    const root = r.service.runtime()!.rootId
    const before = gateway.sampling.length
    for (const body of [{}, { variant: 'max' }, { variant: 'medium' }]) {
      expect((await prompt(r, root, { parts: [{ type: 'text', text: 'go' }], ...body })).status).toBe(204)
      await waitFor(() => !r.service.runtime()!.busy())
    }
    // `medium` is not offered by this model, so the turn runs at the provider default.
    expect(gateway.sampling.slice(before).map((s) => s.reasoning_effort)).toEqual(['high', 'max', undefined])
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
    const stateWhileAsked = (await r.bearer('/kortix/runtime/state').then((res) => res.json())) as Record<string, any>
    expect(stateWhileAsked.permissions.value).toHaveLength(1)

    const replied = await r.user(`/permission/${pending[0]!.id}/reply`, { method: 'POST', body: JSON.stringify({ reply: 'once' }) })
    expect(replied.status).toBe(200)
    await waitFor(() => !r.service.runtime()!.busy())
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as { messages: Array<{ parts: Array<Record<string, unknown>> }> }
    const tool = page.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool')!
    expect(tool.state).toMatchObject({ status: 'completed', output: expect.stringContaining('gated') })
    const stream = await r.bearer('/kortix/opencode/events?since=0')
    const text = await readSse(stream, (t) => t.includes('event: permission.replied'))
    expect(text).toContain('event: permission.asked')
    expect(text).toContain('event: permission.replied')
  })

  test('a new prompt dismisses an open question, so an unattended session never wedges behind it', async () => {
    // Prod 2026-10-09: a keyed cron session called `question`, nobody answered,
    // and every later fire queued behind the blocked turn for 5 days.
    const r = await boot({
      script: [
        { tool: 'question', args: { questions: [{ question: 'Which way?', header: 'Pick', options: [{ label: 'A', description: 'a' }] }] } },
        { text: 'went on without an answer' },
        { text: 'second prompt answered' },
      ],
    })
    const runtime = r.service.runtime()!
    const root = runtime.rootId
    expect((await prompt(r, root, { parts: [{ type: 'text', text: 'first' }] })).status).toBe(204)
    await waitFor(() => runtime.questions.list().length === 1)
    expect((await prompt(r, root, { parts: [{ type: 'text', text: 'second' }] })).status).toBe(204)
    await waitFor(() => runtime.questions.list().length === 0 && !runtime.busy() && runtime.idle())
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as { messages: Array<{ info: { role: string }; parts: Array<Record<string, any>> }> }
    const tool = page.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool' && p.tool === 'question')!
    expect(tool.state.status).not.toBe('running')
    const texts = page.messages.flatMap((m) => m.parts).filter((p) => p.type === 'text').map((p) => p.text)
    expect(texts).toContain('second prompt answered')
    const text = await readSse(await r.bearer('/kortix/opencode/events?since=0'), (t) => t.includes('event: question.rejected'))
    expect(text).toContain('event: question.rejected')
  })

  test('steers reach pi in arrival order, and a retract during image loading cancels the steer', async () => {
    const r = await boot({ script: [{ tool: 'bash', args: { command: 'sleep 1' } }, { text: 'read the steers' }] })
    const runtime = r.service.runtime()!
    const root = runtime.rootId
    expect((await prompt(r, root, { parts: [{ type: 'text', text: 'first' }] })).status).toBe(204)
    await waitForRunningTool(r, root)
    // The first steer's images load slowest: it still reaches pi first.
    const delays: Record<string, number> = { 'STEER-ONE': 200, 'STEER-GONE': 100 }
    const original = (runtime as any).images.bind(runtime)
    spyOn(runtime as any, 'images').mockImplementation(async (input: any) => (await Bun.sleep(delays[input.text] ?? 0), original(input)))
    const id = (c: string) => siblingId(runtime.activeTurnMessageId()!, c)
    const steer = (c: string, text: string) => runtime.steer({ messageID: id(c), text, files: [] })
    const one = steer('x', 'STEER-ONE')
    const two = steer('y', 'STEER-TWO')
    const gone = steer('w', 'STEER-GONE')
    expect(runtime.retract(id('w'))).toBe('retracted')
    expect(await Promise.all([one, two, gone])).toEqual(['steered', 'steered', 'duplicate'])
    const before = gateway.sent.length
    await waitFor(() => gateway.sent.length > before && runtime.idle(), 5_000)
    const sent = JSON.stringify(gateway.sent.at(-1))
    expect(sent.indexOf('STEER-ONE')).toBeGreaterThan(-1)
    expect(sent.indexOf('STEER-ONE')).toBeLessThan(sent.indexOf('STEER-TWO'))
    expect(sent).not.toContain('STEER-GONE')
  })

  test('a steered message dismisses an open question, so the turn reads it', async () => {
    const r = await boot({
      script: [
        { tool: 'question', args: { questions: [{ question: 'Which way?', header: 'Pick', options: [{ label: 'A', description: 'a' }] }] } },
        { text: 'read the steer' },
      ],
    })
    const runtime = r.service.runtime()!
    const root = runtime.rootId
    expect((await prompt(r, root, { parts: [{ type: 'text', text: 'first' }] })).status).toBe(204)
    await waitFor(() => runtime.questions.list().length === 1)
    expect(await runtime.steer({ messageID: siblingId(runtime.activeTurnMessageId()!, 'z'), text: 'STEERED while asked', parts: [] } as never)).toBe('steered')
    await waitFor(() => runtime.questions.list().length === 0 && runtime.idle())
  })

  test('a rejected permission blocks the tool and the turn still ends', async () => {
    const r = await boot({
      script: [{ tool: 'bash', args: { command: 'echo never' } }, { text: 'blocked, sorry' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { build: { permission: { '*': 'ask' } } } }) },
    })
    const root = r.service.runtime()!.rootId
    // Stop on an idle root is a no-op success.
    const idleStop = await r.user(`/session/${root}/abort`, { method: 'POST' })
    expect(idleStop.status).toBe(200)
    expect(await idleStop.json()).toBe(true)
    expect((await r.user(`/session/${root}/prompt_async`, { method: 'POST', body: JSON.stringify({ parts: [{ type: 'text', text: 'go' }] }) })).status).toBe(204)
    await waitFor(() => r.service.runtime()!.permissions.list().length === 1)
    const id = r.service.runtime()!.permissions.list()[0]!.id
    const rejected = await r.user(`/permission/${id}/reply`, { method: 'POST', body: JSON.stringify({ reply: 'reject' }) })
    expect(rejected.status).toBe(200)
    await waitFor(() => !r.service.runtime()!.busy())
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as { messages: Array<{ parts: Array<Record<string, unknown>> }> }
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
    const deniedPage = (await denied.bearer(`/kortix/runtime/messages/${deniedRoot}`).then((res) => res.json())) as { messages: Array<{ parts: Array<Record<string, unknown>> }> }
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
    const allowedPage = (await allowed.bearer(`/kortix/runtime/messages/${allowedRoot}`).then((res) => res.json())) as { messages: Array<{ parts: Array<Record<string, unknown>> }> }
    const allowedTool = allowedPage.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool')!
    expect(allowedTool.state).toMatchObject({ status: 'completed', output: expect.stringContaining('fine') })
  })

  /** The tool part of the root's first tool call, once the turn is over. */
  const firstToolPart = async (r: Rig) => {
    const root = r.service.runtime()!.rootId
    expect((await prompt(r, root, { parts: [{ type: 'text', text: 'go' }] })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy())
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as { messages: Array<{ parts: Array<Record<string, unknown>> }> }
    return page.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool')! as { state: { status: string; error?: string; output?: string } }
  }

  test('a bare "permission: deny" blocks every tool (W1 B1)', async () => {
    // The compiler emits the whole-agent string when the manifest block has no
    // `skills:` key. pi used to read it as "no rules" and allow everything.
    const r = await boot({
      script: [{ tool: 'bash', args: { command: 'rm -rf ./keep' } }, { text: 'blocked' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { build: { permission: 'deny' } } }) },
      prepare: (workspace) => {
        mkdirSync(join(workspace, 'keep'))
        writeFileSync(join(workspace, 'keep', 'sentinel'), 'still here')
      },
    })
    const tool = await firstToolPart(r)
    expect(tool.state.status).toBe('error')
    expect(tool.state.error).toContain('denies')
    expect(existsSync(join(r.workspace, 'keep', 'sentinel'))).toBe(true)
  })

  test('an "edit: deny" rule stops the write tool (W1 B2)', async () => {
    const r = await boot({
      script: [{ tool: 'write', args: { path: 'new.txt', content: 'should not exist' } }, { text: 'blocked' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { build: { permission: { edit: 'deny', bash: 'allow' } } } }) },
    })
    const tool = await firstToolPart(r)
    expect(tool.state.status).toBe('error')
    expect(tool.state.error).toContain('denies this write call')
    expect(existsSync(join(r.workspace, 'new.txt'))).toBe(false)
  })

  test('a path deny holds for every spelling of the path the read tool resolves', async () => {
    const permission = { read: { 'secrets/*': 'deny', '*': 'allow' } }
    for (const path of ['./secrets/a', 'x/../secrets/a', '@secrets/a']) {
      const r = await boot({
        script: [{ tool: 'read', args: { path } }, { text: 'blocked' }],
        env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { build: { permission } } }) },
        prepare: (workspace) => {
          mkdirSync(join(workspace, 'secrets'))
          writeFileSync(join(workspace, 'secrets', 'a'), 'sentinel-secret')
        },
      })
      const tool = await firstToolPart(r)
      expect(tool.state.status).toBe('error')
      expect(tool.state.error).toContain('denies')
      expect(JSON.stringify(tool)).not.toContain('sentinel-secret')
    }
  })

  test('the manifest skills grant hides every other skill: managed, project and pi skill dirs (W1 B3)', async () => {
    const skill = (dir: string, name: string) => {
      mkdirSync(join(dir, name), { recursive: true })
      writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill\n---\nDo ${name}.\n`)
    }
    const managed = mkdtempSync(join(tmpdir(), 'pi-managed-'))
    skill(managed, 'kortix-memory')
    const previous = process.env.KORTIX_MANAGED_SKILLS_DIR
    process.env.KORTIX_MANAGED_SKILLS_DIR = managed
    try {
      const r = await boot({
        script: [{ text: 'ok' }],
        // What compileAgentConfig emits for `skills: [deploy]`.
        env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { build: { permission: { skill: { deploy: 'allow', '*': 'deny' } } } } }) },
        prepare: (workspace) => {
          skill(join(workspace, 'skills'), 'deploy')
          skill(join(workspace, '.kortix', 'opencode', 'skills'), 'review')
          // pi's own project skill dir, read by its resource loader.
          skill(join(workspace, '.pi', 'skills'), 'secrets-dump')
        },
      })
      const skills = (await r.user('/skill').then((res) => res.json())) as Array<{ name: string }>
      expect(skills.map((s) => s.name)).toEqual(['deploy'])
      const root = r.service.runtime()!.rootId
      const before = gateway.sent.length
      expect((await prompt(r, root, { parts: [{ type: 'text', text: 'hi' }] })).status).toBe(204)
      await waitFor(() => !r.service.runtime()!.busy())
      const system = JSON.stringify(gateway.sent[before]!.filter((m) => m.role === 'system'))
      expect(system).toContain('deploy')
      for (const hidden of ['kortix-memory', 'review', 'secrets-dump']) expect(system).not.toContain(hidden)
    } finally {
      if (previous === undefined) delete process.env.KORTIX_MANAGED_SKILLS_DIR
      else process.env.KORTIX_MANAGED_SKILLS_DIR = previous
      rmSync(managed, { recursive: true, force: true })
    }
  })

  test('the kortix-genui skill is listed only while KORTIX_GENUI=1', async () => {
    const managed = mkdtempSync(join(tmpdir(), 'pi-managed-'))
    for (const name of ['kortix-memory', 'kortix-genui']) {
      mkdirSync(join(managed, name), { recursive: true })
      writeFileSync(join(managed, name, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill\n---\nDo ${name}.\n`)
    }
    const previous = process.env.KORTIX_MANAGED_SKILLS_DIR
    process.env.KORTIX_MANAGED_SKILLS_DIR = managed
    try {
      for (const [flag, listed] of [['1', true], ['0', false]] as const) {
        const r = await boot({ script: [{ text: 'ok' }], env: { KORTIX_GENUI: flag } })
        const skills = (await r.user('/skill').then((res) => res.json())) as Array<{ name: string }>
        expect(skills.map((s) => s.name).sort()).toEqual(listed ? ['kortix-genui', 'kortix-memory'] : ['kortix-memory'])
        const root = r.service.runtime()!.rootId
        const before = gateway.sent.length
        expect((await prompt(r, root, { parts: [{ type: 'text', text: 'hi' }] })).status).toBe(204)
        await waitFor(() => !r.service.runtime()!.busy())
        const system = JSON.stringify(gateway.sent[before]!.filter((m) => m.role === 'system'))
        expect(system.includes('kortix-genui')).toBe(listed)
        expect(system).not.toContain('Generative UI')
      }
    } finally {
      if (previous === undefined) delete process.env.KORTIX_MANAGED_SKILLS_DIR
      else process.env.KORTIX_MANAGED_SKILLS_DIR = previous
      rmSync(managed, { recursive: true, force: true })
    }
  })

  test('agent shells source the live agent env file through BASH_ENV (W1 B4)', async () => {
    // The egress shim's proxy + CA variables exist only in that file; a
    // non-interactive `bash -c` reads it only through BASH_ENV.
    const r = await boot({ script: [{ tool: 'bash', args: { command: 'printf "%s" "$BASH_ENV"' } }, { text: 'done' }] })
    const tool = await firstToolPart(r)
    expect(tool.state.status).toBe('completed')
    expect(tool.state.output).toContain(AGENT_ENV_SH)
  })

  test('a session with no agent chosen runs the manifest default_agent, not the first agent (W1 B5)', async () => {
    const r = await boot({
      script: [{ text: 'ok' }],
      env: {
        KORTIX_AGENT_NAME: 'default',
        KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ default_agent: 'writer', agent: { build: { prompt: 'You build.' }, writer: { prompt: 'You write docs.' } } }),
      },
    })
    expect(r.service.runtime()!.agentNameValue()).toBe('writer')
    const root = r.service.runtime()!.rootId
    const before = gateway.sent.length
    expect((await prompt(r, root, { parts: [{ type: 'text', text: 'hi' }] })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy())
    expect(JSON.stringify(gateway.sent[before]!.filter((m) => m.role === 'system'))).toContain('You write docs.')
  })

  // Over 128 KiB the guest cannot exec with the raw var, so the API sends it gzip-encoded
  // (@kortix/api-contract/compiled-agent-config-env). Platinum prod, 2026-10-14.
  test('a compiled config over the exec limit arrives gzip-encoded and pi runs it', async () => {
    const compiled = JSON.stringify({
      default_agent: 'writer',
      agent: { build: { prompt: 'You build.' }, writer: { prompt: `You write docs. ${'Keep every section short. '.repeat(6_000)}` } },
    })
    const encoded = encodeCompiledAgentConfigEnv(compiled)
    expect(encoded).not.toHaveProperty('KORTIX_COMPILED_AGENT_CONFIG')
    const r = await boot({ script: [{ text: 'ok' }], env: { KORTIX_AGENT_NAME: 'default', ...encoded } })
    expect(r.service.runtime()!.agentNameValue()).toBe('writer')
    const root = r.service.runtime()!.rootId
    const before = gateway.sent.length
    expect((await prompt(r, root, { parts: [{ type: 'text', text: 'hi' }] })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy())
    expect(JSON.stringify(gateway.sent[before]!.filter((m) => m.role === 'system'))).toContain('You write docs.')
  })

  test('a permission ask is reported for the approval push (W1 B9)', async () => {
    const asked: Array<{ id: string; sessionID: string; permission: string; patterns: string[] }> = []
    const r = await boot({
      script: [{ tool: 'bash', args: { command: 'echo gated' } }, { text: 'done' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { build: { permission: { bash: 'ask' } } } }) },
      hooks: { onPermissionAsked: (request) => asked.push(request) },
    })
    const root = r.service.runtime()!.rootId
    expect((await prompt(r, root, { parts: [{ type: 'text', text: 'go' }] })).status).toBe(204)
    await waitFor(() => r.service.runtime()!.permissions.list().length === 1)
    const pending = r.service.runtime()!.permissions.list()[0]!
    expect(asked).toEqual([expect.objectContaining({ id: pending.id, sessionID: root, permission: 'bash', patterns: ['echo gated'] })])
    r.service.runtime()!.permissions.reply(pending.id, 'once')
    await waitFor(() => !r.service.runtime()!.busy())
  })

  test('every published frame reaches the audit trail, and a tool call sanitizes to an audit event (E12)', async () => {
    const frames: Array<{ type: string; properties: Record<string, unknown> }> = []
    const r = await boot({
      script: [{ tool: 'bash', args: { command: 'echo audited' } }, { text: 'done' }],
      hooks: { onFrame: (frame) => frames.push(frame) },
    })
    const root = r.service.runtime()!.rootId
    expect((await prompt(r, root, { parts: [{ type: 'text', text: 'go' }] })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy())
    const tool = frames.find((frame) => frame.type === 'message.part.updated' && (frame.properties.part as { type?: string })?.type === 'tool')
    expect(tool).toBeDefined()
    // The shared sanitizer (the same one OpenCode's events go through) turns it into a ledger row.
    const event = sanitizeRuntimeEvent(tool!)
    expect(event).toMatchObject({ runtime_session_id: root, type: 'message.part.updated' })
    expect(event!.tool_call_id).toBeTruthy()
    expect(JSON.stringify(event)).not.toContain('audited')
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
    const state = (await r.bearer('/kortix/runtime/state').then((res) => res.json())) as Record<string, any>
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
      body: JSON.stringify({ prompt_id: 'prm_queue_1', runtime_session_id: root, turn_message_id: messageID }),
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
    ['another turn', (root: string) => ({ runtime_session_id: root, turn_message_id: 'msg_0198e2a4b0c5ABCDEFGHIJKLMN' })],
    ['another session', () => ({ runtime_session_id: 'ses_someone_else', turn_message_id: 'msg_0198e2a4b0c4ABCDEFGHIJKLMN' })],
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
      body: JSON.stringify({ prompt_id: 'prm_live', runtime_session_id: root, turn_message_id: messageID }),
    })
    const disarmed = await r.user('/kortix/abort/after-tool', { method: 'DELETE', body: JSON.stringify({ prompt_id: 'prm_live' }) })
    expect(disarmed.status).toBe(200)
    await waitFor(() => !r.service.runtime()!.busy())
    const messages = (await r.user(`/session/${root}/message`).then((res) => res.json())) as Array<{ info: any; parts: any[] }>
    const text = messages.flatMap((m) => m.parts).filter((p) => p.type === 'text').map((p) => p.text).join(' ')
    expect(text).toContain('finished normally')
  })

  test('a restarted daemon restores the transcript and turn verdicts, and leaves the title to Kortix', async () => {
    // A daemon restart is a new process: a second service on the same state
    // dir must restore what the first one persisted, not reuse its memory.
    const r = await boot({ script: [{ text: 'first answer' }] })
    const root = r.service.runtime()!.rootId
    const messageID = 'msg_0198e2a4b0c6ABCDEFGHIJKLMN'
    expect((await prompt(r, root, { messageID, parts: [{ type: 'text', text: 'remember me' }] })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy())
    const before = (await r.user(`/session/${root}/message`).then((res) => res.json())) as Array<{ info: { id: string } }>
    // The title is Kortix's to write (`metadata.name`, generated from the first
    // prompt). A runtime title of the prompt's first line outranked it in the
    // API and ended the web's wait for the real title (KRTX-2567).
    const live = (await r.user('/session').then((res) => res.json())) as Array<{ title: string }>
    expect(live[0]!.title).toBe('New session')
    await r.service.lifecycle.stop()
    // A dump an older daemon wrote carries the first prompt line as its title.
    const stateDir = join(r.workspace, '.state')
    const dumpFile = join(stateDir, readdirSync(stateDir).find((f) => f.endsWith('.json'))!)
    writeFileSync(dumpFile, JSON.stringify({ ...JSON.parse(readFileSync(dumpFile, 'utf8')), title: 'remember me' }))

    const restarted = await boot({ script: [{ text: 'second answer' }], workspace: r.workspace })
    rigs.splice(rigs.indexOf(r), 1)
    expect(restarted.service.runtime()!.rootId).toBe(root)
    const page = (await restarted.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as { messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> }
    expect(page.messages.map((m) => m.info.role)).toEqual(['user', 'assistant'])
    expect(page.messages[1]!.parts[0]).toMatchObject({ type: 'text', text: 'first answer' })
    const sessions = (await restarted.user('/session').then((res) => res.json())) as Array<{ title: string }>
    expect(sessions[0]!.title).toBe('New session')
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
    // A hosted sandbox ships a real managed-skills dir; pin it to an empty one
    // so only the two project skills below exist (same pattern as the
    // managed-overlay test above).
    const managed = mkdtempSync(join(tmpdir(), 'pi-managed-empty-'))
    const previous = process.env.KORTIX_MANAGED_SKILLS_DIR
    process.env.KORTIX_MANAGED_SKILLS_DIR = managed
    try {
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
    } finally {
      if (previous === undefined) delete process.env.KORTIX_MANAGED_SKILLS_DIR
      else process.env.KORTIX_MANAGED_SKILLS_DIR = previous
    }
  })

  test.each([
    ['a messageID outside the Kortix message id format', { messageID: 'not-a-message-id', parts: [{ type: 'text', text: 'hi' }] }],
    ['an empty parts array', { parts: [] }],
    ['an unsupported part type', { parts: [{ type: 'image', url: 'x' }] }],
    ['no content at all', { parts: [{ type: 'text', text: '   ' }] }],
  ])('a prompt with %s is refused with 400, so the API stops redelivering it', async (_name, body) => {
    const r = await boot({ script: [] })
    const root = r.service.runtime()!.rootId
    expect((await prompt(r, root, body)).status).toBe(400)
    expect(r.service.runtime()!.busy()).toBe(false)
  })

  test('a stream cut without finish_reason is retried and the turn completes', async () => {
    // Prod: a provider stream closed with no finish chunk, pi-ai threw "Stream
    // ended without finish_reason", and the whole turn stopped on it.
    const r = await boot({ script: [{ cut: 'half an ans' }, { cut: '' }, { text: 'Full answer.' }] })
    const root = r.service.runtime()!.rootId
    const calls = gateway.requests.length
    const messageID = 'msg_0198e2a4b0d1ABCDEFGHIJKLMN'
    const events = await r.bearer('/kortix/opencode/events?since=0')
    expect((await prompt(r, root, { messageID, parts: [{ type: 'text', text: 'answer me' }] })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy())
    expect(gateway.requests.length - calls).toBe(3)

    const probe = (await r.bearer(`/kortix/health?turn=1&turn_message_id=${messageID}`).then((res) => res.json())) as Record<string, unknown>
    expect(probe.turn_end).toBe('completed')
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    // No message carries the cut as a terminal error, and the answer is the last word.
    expect(page.messages.filter((m) => m.info.error)).toEqual([])
    expect(page.messages.at(-1)!.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'Full answer.' })
    // The retried request re-sends the conversation without the cut reply.
    expect(JSON.stringify(gateway.sent.at(-1))).not.toContain('half an ans')

    // The stream shows OpenCode's retry status between attempts and never a session.error.
    const text = await readSse(events, (t) => t.includes('Full answer.') && t.includes('event: session.idle'))
    expect(text).not.toContain('event: session.error')
    const statuses = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
      .filter((e) => e.type === 'session.status' && e.payload.sessionID === root)
      .map((e) => e.payload.status)
    expect(statuses.filter((s) => s.type === 'retry')).toEqual([
      { type: 'retry', attempt: 1, message: 'Stream ended without finish_reason', next: expect.any(Number) },
      { type: 'retry', attempt: 2, message: 'Stream ended without finish_reason', next: expect.any(Number) },
    ])
    expect(statuses.at(-1)).toEqual({ type: 'idle' })
  })

  test('a stream cut in the middle of a JSON data line is retried and the turn completes', async () => {
    const r = await boot({ script: [{ cutMidLine: 'half' }, { text: 'Whole answer.' }] })
    const root = r.service.runtime()!.rootId
    const calls = gateway.requests.length
    const messageID = 'msg_0198e2a4b0d5ABCDEFGHIJKLMN'
    expect((await prompt(r, root, { messageID, parts: [{ type: 'text', text: 'answer me' }] })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy())
    expect(gateway.requests.length - calls).toBe(2)
    const probe = (await r.bearer(`/kortix/health?turn=1&turn_message_id=${messageID}`).then((res) => res.json())) as Record<string, unknown>
    expect(probe.turn_end).toBe('completed')
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    expect(page.messages.filter((m) => m.info.error)).toEqual([])
    expect(page.messages.at(-1)!.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'Whole answer.' })
  })

  test('an outage longer than the in-turn retries is resumed and the turn completes', async () => {
    // Seven failures: the first attempt, all five in-turn retries (~60 s at the
    // default base) and the first resume. The second resume answers.
    const r = await boot({ script: [...Array.from({ length: 7 }, () => ({ status: 503 })), { text: 'Back online.' }] })
    const root = r.service.runtime()!.rootId
    const calls = gateway.requests.length
    const messageID = 'msg_0198e2a4b0d6ABCDEFGHIJKLMN'
    const events = await r.bearer('/kortix/opencode/events?since=0')
    expect((await prompt(r, root, { messageID, parts: [{ type: 'text', text: 'answer me' }] })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy(), 10_000)
    expect(gateway.requests.length - calls).toBe(8)
    const probe = (await r.bearer(`/kortix/health?turn=1&turn_message_id=${messageID}`).then((res) => res.json())) as Record<string, unknown>
    expect(probe.turn_end).toBe('completed')
    const text = await readSse(events, (t) => t.includes('Back online.') && t.includes('event: session.idle'))
    expect(text).not.toContain('event: session.error')
    const attempts = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
      .filter((e) => e.type === 'session.status' && e.payload.sessionID === root && e.payload.status.type === 'retry')
      .map((e) => e.payload.status.attempt)
    expect(attempts).toEqual([1, 2, 3, 4, 5, 6, 7])
  }, 20_000)

  test('a transient error that outlasts the retry budget ends the turn as failed with its reason', async () => {
    const r = await boot({ script: Array.from({ length: 12 }, () => ({ cut: '' })) })
    const root = r.service.runtime()!.rootId
    const calls = gateway.requests.length
    const messageID = 'msg_0198e2a4b0d2ABCDEFGHIJKLMN'
    expect((await prompt(r, root, { messageID, parts: [{ type: 'text', text: 'answer me' }] })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy())
    // One attempt, five in-turn retries and three resumes, then the reason reaches the product.
    expect(gateway.requests.length - calls).toBe(9)
    const probe = (await r.bearer(`/kortix/health?turn=1&turn_message_id=${messageID}`).then((res) => res.json())) as Record<string, unknown>
    expect(probe.turn_end).toBe('failed')
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    expect(page.messages.at(-1)!.info.error).toEqual({ name: 'UnknownError', data: { message: 'Stream ended without finish_reason' }, code: 'unknown' })
    const state = (await r.bearer('/kortix/runtime/state').then((res) => res.json())) as Record<string, any>
    expect(state.statuses.value[root]).toEqual({ type: 'idle' })
  })

  test('a non-transient model error is not retried', async () => {
    const r = await boot({ script: [{ status: 400 }, { text: 'unreachable' }] })
    const root = r.service.runtime()!.rootId
    const calls = gateway.requests.length
    const messageID = 'msg_0198e2a4b0d3ABCDEFGHIJKLMN'
    expect((await prompt(r, root, { messageID, parts: [{ type: 'text', text: 'answer me' }] })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy())
    expect(gateway.requests.length - calls).toBe(1)
    const probe = (await r.bearer(`/kortix/health?turn=1&turn_message_id=${messageID}`).then((res) => res.json())) as Record<string, unknown>
    expect(probe.turn_end).toBe('failed')
  })

  test('abort during a retry backoff ends the turn as aborted without another request', async () => {
    const r = await boot({ script: [{ cut: '' }, { text: 'unreachable' }], env: { KORTIX_PI_TURN_RETRY_BASE_MS: '5000' } })
    const root = r.service.runtime()!.rootId
    const calls = gateway.requests.length
    const messageID = 'msg_0198e2a4b0d4ABCDEFGHIJKLMN'
    expect((await prompt(r, root, { messageID, parts: [{ type: 'text', text: 'answer me' }] })).status).toBe(204)
    await waitFor(() => gateway.requests.length - calls === 1)
    await Bun.sleep(50)
    expect(r.service.runtime()!.busy()).toBe(true)
    expect((await r.user(`/session/${root}/abort`, { method: 'POST' })).status).toBe(200)
    await waitFor(() => !r.service.runtime()!.busy(), 2_000)
    expect(gateway.requests.length - calls).toBe(1)
    const state = (await r.bearer('/kortix/runtime/state').then((res) => res.json())) as Record<string, any>
    expect(state.statuses.value[root]).toEqual({ type: 'idle' })
    const probe = (await r.bearer(`/kortix/health?turn=1&turn_message_id=${messageID}`).then((res) => res.json())) as Record<string, unknown>
    expect(probe.turn_in_flight).toBe(false)
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
    // Nothing to compact, so pi does not recover it: the withheld error lands on the message.
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    expect(page.messages.at(-1)!.info.error).toMatchObject({ name: 'MessageOutputLengthError' })
    expect(page.messages.some((m) => m.parts.some((part) => part.type === 'compaction'))).toBe(false)
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

/** A repo extension as a project commits it: `.pi/extensions/<name>.ts`, loaded by pi's own loader. */
function repoExtension(workspace: string, name: string, source: string): string {
  const path = join(workspace, '.pi', 'extensions', `${name}.ts`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source)
  return path
}

/** The system prompt of one model request. */
function systemSent(messages: Array<{ role: string; content: unknown }>): string {
  return messages
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n')
}

describe('pi project config', () => {
  test('loads .kortix/pi native extensions and skills on the daemon HTTP surface', async () => {
    const r = await boot({
      script: [{ text: 'ok' }],
      prepare: (workspace) => {
        const dir = join(workspace, '.kortix', 'pi')
        mkdirSync(join(dir, 'extensions'), { recursive: true })
        mkdirSync(join(dir, 'skills', 'native'), { recursive: true })
        writeFileSync(join(dir, 'extensions', 'native.ts'), `export default (pi) => pi.on('before_agent_start', (event) => ({ systemPrompt: event.systemPrompt + '\\nNATIVE PI' }))`)
        writeFileSync(join(dir, 'skills', 'native', 'SKILL.md'), '---\nname: native\ndescription: Native Pi skill\n---\nDo it.\n')
      },
    })
    const skills = (await r.user('/skill').then((res) => res.json())) as Array<{ name: string }>
    expect(skills.map((skill) => skill.name)).toContain('native')
    expect(r.service.runtime()!.extensionStatus().loaded.some((name) => name.endsWith('/.kortix/pi/extensions/native.ts'))).toBe(true)
    const sentBefore = gateway.sent.length
    await promptAndSettle(r, 'hello')
    expect(gateway.sent.slice(sentBefore).map(systemSent).some((prompt) => prompt.includes('NATIVE PI'))).toBe(true)
  })
})

describe('project tools on pi', () => {
  // A harness-neutral tool module (services/tools/tool.ts): no import, a plain default export.
  const LOOKUP = `export default {
  description: 'Look up an order by id.',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  async execute(args, context) {
    return { order: args.id, status: 'shipped', agent: context.agent, directory: context.directory, session: context.sessionId }
  },
}
`
  const compiled = (projectTools: Record<string, string>, tools?: Record<string, boolean>) =>
    JSON.stringify({ agent: { build: tools ? { tools } : {} }, project_tools: projectTools })
  const write = (workspace: string, path: string, source: string) => {
    mkdirSync(dirname(join(workspace, path)), { recursive: true })
    writeFileSync(join(workspace, path), source)
  }
  const ids = async (r: Rig) => (await r.user('/tool/ids').then((res) => res.json())) as string[]
  const page = async (r: Rig) => (await r.bearer(`/kortix/runtime/messages/${r.service.runtime()!.rootId}`).then((res) => res.json())) as WirePage

  test('a tool declared in kortix.yaml runs with the call context, beside the Kortix tools', async () => {
    const r = await boot({
      script: [{ tool: 'lookup_order', args: { id: '42' } }, { text: 'done' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: compiled({ lookup_order: 'integrations/orders/lookup.ts' }) },
      prepare: (workspace) => write(workspace, 'integrations/orders/lookup.ts', LOOKUP),
    })
    expect(await ids(r)).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_search', 'image_search', 'scrape_webpage', 'memory', 'show', 'lookup_order', 'question', 'codemode', 'task'])
    await promptAndSettle(r, 'look up order 42')
    const part = toolParts(await page(r), 'lookup_order')[0]!
    expect(part.state.status).toBe('completed')
    expect(JSON.parse(part.state.output)).toEqual({ order: '42', status: 'shipped', agent: 'build', directory: r.workspace, session: 'sess-pi-test' })
  })

  test('a project tool replaces the Kortix tool of its name; a module that does not load is left out', async () => {
    const r = await boot({
      script: [{ tool: 'memory', args: { command: 'view', path: 'memory' } }, { text: 'done' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: compiled({ memory: 'tools/memory.ts', broken: 'tools/broken.ts', missing: 'tools/missing.ts' }) },
      prepare: (workspace) => {
        write(workspace, 'tools/memory.ts', `export default { description: 'Team memory.', parameters: { type: 'object', properties: {} }, execute: () => 'the project memory' }\n`)
        write(workspace, 'tools/broken.ts', `export default { description: 'No execute.' }\n`)
      },
    })
    const listed = await ids(r)
    expect(listed).toContain('memory')
    expect(listed).not.toContain('broken')
    expect(listed).not.toContain('missing')
    await promptAndSettle(r, 'view memory')
    expect(toolParts(await page(r), 'memory')[0]!.state.output).toBe('the project memory')
  })

  test('a Kortix tool the project does not list is not offered, and a call to it is refused', async () => {
    const r = await boot({
      script: [{ tool: 'show', args: { action: 'show', type: 'text', content: 'hi' } }, { tool: 'memory', args: { command: 'view', path: 'memory' } }, { text: 'done' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { build: {} }, kortix_tools: ['web_search', 'image_search', 'scrape_webpage', 'memory'] }) },
    })
    expect(await ids(r)).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_search', 'image_search', 'scrape_webpage', 'memory', 'question', 'codemode', 'task'])
    await promptAndSettle(r, 'show hi, then view memory')
    const show = toolParts(await page(r), 'show')[0]!
    expect(show.state.status).toBe('error')
    expect(String(show.state.error)).toBe('Tool show not found')
    expect(toolParts(await page(r), 'memory')[0]!.state.status).toBe('completed')
  })

  test("an agent's tool list allows only the tools it names; any other call is denied", async () => {
    const r = await boot({
      script: [{ tool: 'bash', args: { command: 'touch ran.txt' } }, { text: 'done' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: compiled({ lookup_order: 'tools/lookup.ts' }, { '*': false, read: true, lookup_order: true }) },
      prepare: (workspace) => write(workspace, 'tools/lookup.ts', LOOKUP),
    })
    expect(await ids(r)).toEqual(['read', 'lookup_order'])
    await promptAndSettle(r, 'run a command')
    expect(toolParts(await page(r), 'bash')[0]!.state.status).toBe('error')
    expect(existsSync(join(r.workspace, 'ran.txt'))).toBe(false)
  })

  test('in a channel thread an allowlist keeps the platform tools; remember: false or edit: deny removes remember only, and a call is refused', async () => {
    const saved = process.env.KORTIX_SPACE_ID
    process.env.KORTIX_SPACE_ID = 'space-1' // the box env; loadTools reads the session env, not the rig's
    try {
      const agent = (build: Record<string, unknown>) => ({ KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { build } }) })
      const allowlist = await boot({ script: [{ text: 'ok' }], env: agent({ tools: { '*': false, read: true } }) })
      expect(await ids(allowlist)).toEqual(['read', 'remember', 'memory_search'])
      const named = await boot({ script: [{ text: 'ok' }], env: agent({ tools: { '*': false, read: true, remember: false } }) })
      expect(await ids(named)).toEqual(['read', 'memory_search'])
      const readOnly = await boot({
        script: [{ tool: 'remember', args: { title: 'Priya', type: 'people', fact: 'Runs marketing' } }, { text: 'done' }],
        env: agent({ permission: { edit: 'deny' } }),
      })
      expect(await ids(readOnly)).not.toContain('remember')
      // memory_search only reads: a read-only agent keeps it.
      expect(await ids(readOnly)).toContain('memory_search')
      await promptAndSettle(readOnly, 'remember Priya')
      expect(toolParts(await page(readOnly), 'remember')[0]!.state.status).toBe('error')
    } finally {
      if (saved === undefined) delete process.env.KORTIX_SPACE_ID
      else process.env.KORTIX_SPACE_ID = saved
    }
  })
})

describe('pi extensions', () => {
  test('a tool_call handler blocks a tool and a tool_result handler patches another', async () => {
    const r = await boot({
      script: [{ tool: 'write', args: { path: 'blocked.txt', content: 'x' } }, { tool: 'bash', args: { command: 'echo real' } }, { text: 'done' }],
      prepare: (workspace) =>
        void repoExtension(
          workspace,
          'guard',
          `export default function (pi) {
  pi.on('tool_call', (event) => (event.toolName === 'write' ? { block: true, reason: 'writes are blocked by guard' } : undefined))
  pi.on('tool_result', (event) => (event.toolName === 'bash' ? { content: [{ type: 'text', text: 'patched output' }] } : undefined))
  pi.on('before_agent_start', (event) => ({ systemPrompt: event.systemPrompt + '\\n\\nGUARD ACTIVE' }))
}
`,
        ),
    })
    const sentBefore = gateway.sent.length
    await promptAndSettle(r, 'try')
    expect(existsSync(join(r.workspace, 'blocked.txt'))).toBe(false)
    const root = r.service.runtime()!.rootId
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    expect(toolParts(page, 'write')[0]!.state.status).toBe('error')
    expect(String(toolParts(page, 'write')[0]!.state.error)).toContain('writes are blocked by guard')
    expect(toolParts(page, 'bash')[0]!.state.status).toBe('completed')
    expect(toolParts(page, 'bash')[0]!.state.output).toBe('patched output')
    expect(gateway.sent.slice(sentBefore).map(systemSent).every((system) => system.includes('GUARD ACTIVE'))).toBe(true)
    const status = r.service.runtime()!.extensionStatus()
    expect(status.loaded.some((name) => name.endsWith('/.pi/extensions/guard.ts'))).toBe(true)
    expect(status.failed).toEqual([])
  })

  test('the prompt system field reaches the model for its turn only, on top of extension edits', async () => {
    const r = await boot({
      script: [{ text: 'a' }, { text: 'b' }],
      prepare: (workspace) =>
        void repoExtension(workspace, 'rule', `export default (pi) => pi.on('before_agent_start', (event) => ({ systemPrompt: event.systemPrompt + '\\n\\nEXTENSION RULE' }))\n`),
    })
    const root = r.service.runtime()!.rootId
    const sentBefore = gateway.sent.length
    expect((await r.user(`/session/${root}/prompt_async`, { method: 'POST', body: JSON.stringify({ parts: [{ type: 'text', text: 'one' }], system: 'TURN RULE' }) })).status).toBe(204)
    await waitFor(() => !r.service.runtime()!.busy())
    await promptAndSettle(r, 'two')
    const [one, two] = gateway.sent.slice(sentBefore).map(systemSent)
    expect(one).toContain('TURN RULE')
    expect(one).toContain('EXTENSION RULE')
    expect(two).not.toContain('TURN RULE')
    expect(two).toContain('EXTENSION RULE')
  })

  test('the Kortix prompt route carries system to the model for its turn only (memory P2)', async () => {
    const r = await boot({ script: [{ text: 'a' }, { text: 'b' }] })
    const root = r.service.runtime()!.rootId
    const sentBefore = gateway.sent.length
    const post = (body: unknown) =>
      r.user(`/kortix/runtime/sessions/${root}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await post({ parts: [{ type: 'text', text: 'one' }], system: '## Memory\n- Q4 launch — dates and owners' })).status).toBe(202)
    await waitFor(() => gateway.sent.length > sentBefore && !r.service.runtime()!.busy())
    expect((await post({ parts: [{ type: 'text', text: 'two' }] })).status).toBe(202)
    await waitFor(() => gateway.sent.length > sentBefore + 1 && !r.service.runtime()!.busy())
    const [one, two] = gateway.sent.slice(sentBefore).map(systemSent)
    expect(one).toContain('## Memory\n- Q4 launch — dates and owners')
    expect(two).not.toContain('## Memory')
    // pi keeps the text out of the stored transcript.
    expect(JSON.stringify(await r.user(`/session/${root}/message`).then((res) => res.json()))).not.toContain('## Memory')
  })

  test("every turn tells the model today's date, a subagent included, and a session that crosses midnight gets the new day", async () => {
    const r = await boot({
      script: [{ text: 'a' }, { tool: 'task', args: { description: 'Check', prompt: 'check it', subagent_type: 'general' } }, { text: 'child done' }, { text: 'parent done' }],
    })
    const sentBefore = gateway.sent.length
    try {
      // Noon UTC: the same calendar day in every time zone the box may run in.
      setSystemTime(new Date('2026-03-09T12:00:00Z'))
      await promptAndSettle(r, 'one')
      setSystemTime(new Date('2026-03-10T12:00:00Z'))
      await promptAndSettle(r, 'delegate it')
    } finally {
      setSystemTime()
    }
    const [one, two, child] = gateway.sent.slice(sentBefore).map(systemSent)
    expect(one).toContain("Today's date: Mon Mar 09 2026 (")
    expect(two).toContain("Today's date: Tue Mar 10 2026 (")
    expect(two).not.toContain('Mar 09 2026')
    expect(child).toContain('Working directory:')
    expect(child).toContain("Today's date: Tue Mar 10 2026 (")
  })

  test('an extension that throws is reported and skipped; lifecycle events reach the others', async () => {
    let log = ''
    const r = await boot({
      script: [{ text: 'ok' }],
      prepare(workspace) {
        log = join(workspace, 'events.log')
        repoExtension(workspace, 'broken', `export default function () {\n  throw new Error('boom')\n}\n`)
        repoExtension(
          workspace,
          'lifecycle',
          `import { appendFileSync } from 'node:fs'
const record = (line) => appendFileSync(${JSON.stringify(log)}, line + '\\n')
export default function (pi) {
  pi.on('session_start', (event) => record('start:' + event.reason))
  pi.on('session_shutdown', () => record('shutdown'))
  pi.on('turn_end', () => record('turn_end'))
}
`,
        )
      },
    })
    const status = r.service.runtime()!.extensionStatus()
    expect(status.loaded.some((name) => name.endsWith('/.pi/extensions/lifecycle.ts'))).toBe(true)
    expect(status.loaded.some((name) => name.endsWith('/.pi/extensions/broken.ts'))).toBe(false)
    expect(status.failed).toHaveLength(1)
    expect(status.failed[0]!.name).toEndWith('/.pi/extensions/broken.ts')
    expect(status.failed[0]!.error).toContain('boom')
    await promptAndSettle(r, 'hi')
    await r.service.lifecycle.stop()
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['start:startup', 'turn_end', 'shutdown'])
  })

  test('a context handler rewrites what the model receives', async () => {
    const r = await boot({
      script: [{ text: 'first' }, { text: 'second' }],
      prepare: (workspace) => void repoExtension(workspace, 'trim', `export default (pi) => pi.on('context', (event) => ({ messages: event.messages.slice(-1) }))\n`),
    })
    await promptAndSettle(r, 'one')
    await promptAndSettle(r, 'two')
    // Turn two holds user, assistant, user; the model gets only the last one.
    const conversation = gateway.sent.at(-1)!.filter((m) => m.role !== 'system' && m.role !== 'developer')
    expect(conversation).toHaveLength(1)
    expect(JSON.stringify(conversation[0]!.content)).toContain('two')
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
    const health = (await r.bearer('/kortix/health').then((res) => res.json())) as { harness: { details: { extensions: typeof status } } }
    expect(health.harness.details.extensions).toEqual(status)
    await promptAndSettle(r, 'use them')
    const page = (await r.bearer(`/kortix/runtime/messages/${r.service.runtime()!.rootId}`).then((res) => res.json())) as WirePage
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
    const page = (await r.bearer(`/kortix/runtime/messages/${r.service.runtime()!.rootId}`).then((res) => res.json())) as WirePage
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
      const page = (await r.bearer(`/kortix/runtime/messages/${r.service.runtime()!.rootId}`).then((res) => res.json())) as WirePage
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
      const page = (await r.bearer(`/kortix/runtime/messages/${r.service.runtime()!.rootId}`).then((res) => res.json())) as WirePage
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

    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    const task = toolParts(page, 'task')[0]!
    const childId = task.state.metadata.sessionId as string
    expect(childId).toMatch(/^ses_pi[0-9a-f]{24}$/)
    expect(childId).not.toBe(root)
    expect(task.state.status).toBe('completed')
    expect(task.state.output).toContain(`task_id: ${childId}`)
    expect(task.state.output).toContain('<task_result>\nchild wrote sub.txt\n</task_result>')
    expect(page.messages.at(-1)!.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'parent done' })

    // The child session, through every read the web client uses.
    const child = (await r.bearer(`/kortix/runtime/messages/${childId}`).then((res) => res.json())) as WirePage
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

    const state = (await r.bearer('/kortix/runtime/state').then((res) => res.json())) as Record<string, any>
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

  test('a subagent whose stream is cut retries and returns its answer', async () => {
    const r = await boot({ script: [TASK({}), { cut: 'partial' }, { text: 'child finished' }, { text: 'parent done' }] })
    const root = r.service.runtime()!.rootId
    await promptAndSettle(r, 'delegate it')
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    const task = toolParts(page, 'task')[0]!
    expect(task.state.status).toBe('completed')
    expect(task.state.output).toContain('<task_result>\nchild finished\n</task_result>')
    const child = (await r.bearer(`/kortix/runtime/messages/${task.state.metadata.sessionId}`).then((res) => res.json())) as WirePage
    expect(child.messages.filter((m) => m.info.error)).toEqual([])
    expect(child.messages.at(-1)!.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'child finished' })
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
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    const [explore, wizard] = toolParts(page, 'task')
    expect(explore!.state.status).toBe('completed')
    expect(wizard!.state.status).toBe('error')
    expect(wizard!.state.error).toBe('Unknown subagent_type "wizard". Available: general, explore.')
    const child = (await r.bearer(`/kortix/runtime/messages/${explore!.state.metadata.sessionId}`).then((res) => res.json())) as WirePage
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
    let page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    const childId = toolParts(page, 'task')[0]!.state.metadata.sessionId as string
    let child = (await r.bearer(`/kortix/runtime/messages/${childId}`).then((res) => res.json())) as WirePage
    expect(child.messages[1]!.info.agent).toBe('reviewer')

    gateway.script([TASK({ subagent_type: 'reviewer', prompt: 'check again', task_id: childId }), { text: 'still good' }, { text: 'second done' }])
    await r.service.lifecycle.stop()
    await r.service.lifecycle.start()
    expect((await r.user(`/session/${childId}/message`)).status).toBe(200)
    await promptAndSettle(r, 'again')
    child = (await r.bearer(`/kortix/runtime/messages/${childId}`).then((res) => res.json())) as WirePage
    expect(child.messages.map((m) => m.info.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
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
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    const tasks = toolParts(page, 'task')
    expect(tasks.map((t) => t.state.status)).toEqual(['completed', 'completed'])
    for (const task of tasks) {
      const child = (await r.bearer(`/kortix/runtime/messages/${task.state.metadata.sessionId}`).then((res) => res.json())) as WirePage
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

  test("a live agent-config change turns the agent's built-in tools off and back on", async () => {
    const compiled = (tools?: Record<string, boolean>) => JSON.stringify({ agent: { build: { tools } } })
    const r = await boot({ script: [{ text: 'ok' }], env: { KORTIX_COMPILED_AGENT_CONFIG: compiled({ bash: false }) } })
    const ids = async () => (await r.user('/tool/ids').then((res) => res.json())) as string[]
    expect(await ids()).toEqual(['read', 'write', 'edit', 'glob', 'grep', 'web_search', 'image_search', 'scrape_webpage', 'memory', 'show', 'question', 'codemode', 'task'])
    const runtime = r.service.runtime()! as unknown as { env: NodeJS.ProcessEnv; reconfigure: () => Promise<unknown> }
    runtime.env.KORTIX_COMPILED_AGENT_CONFIG = compiled()
    await runtime.reconfigure()
    expect(await ids()).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_search', 'image_search', 'scrape_webpage', 'memory', 'show', 'question', 'codemode', 'task'])
    runtime.env.KORTIX_COMPILED_AGENT_CONFIG = compiled({ grep: false })
    await runtime.reconfigure()
    expect(await ids()).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'web_search', 'image_search', 'scrape_webpage', 'memory', 'show', 'question', 'codemode', 'task'])
  })

  test('several task calls in one message run their subagents concurrently', async () => {
    const r = await boot({
      script: [
        { tools: [TASK({ description: 'A', prompt: 'a' }), TASK({ description: 'B', prompt: 'b' })] },
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
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
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

/** The project's root instructions as pi renders them: pi's own context-file format. */
const projectRules = (text: string, name = 'AGENTS.md') => `<project_instructions path="${name}">\n${text}\n</project_instructions>`
const sha12 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12)
const agentsMdOf = async (r: Rig) => ((await r.bearer('/kortix/health').then((res) => res.json())) as Record<string, any>).harness.details.agentsMd

// A rig with no API reads the working tree (releases are not in play).
describe('pi AGENTS.md', () => {
  afterEach(() => mock.restore())

  /** The system prompt of the next turn's first model request. */
  const nextSystem = async (r: Rig) => {
    const index = gateway.sent.length
    await promptAndSettle(r, 'hi')
    return systemSent(gateway.sent[index]!)
  }
  const notLoaded = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter(([message]) => message === '[pi] AGENTS.md not loaded')

  test('a task subagent gets the same AGENTS.md section as the root', async () => {
    const r = await boot({
      script: [{ tool: 'task', args: { description: 'Check', prompt: 'check it', subagent_type: 'general' } }, { text: 'child done' }, { text: 'parent done' }],
      prepare: (workspace) => writeFileSync(join(workspace, 'AGENTS.md'), 'SHARED-RULES\n'),
    })
    const index = gateway.sent.length
    await promptAndSettle(r, 'delegate it')
    const [root, child] = gateway.sent.slice(index).map(systemSent)
    expect(root).toContain(projectRules('SHARED-RULES'))
    // Only a child prompt carries the working directory as text.
    expect(child).toContain('Working directory:')
    expect(child).toContain(projectRules('SHARED-RULES'))
  })

  test('no AGENTS.md: no section, no log, and health reports null', async () => {
    const warn = spyOn(logger, 'warn')
    const r = await boot({ script: [{ text: 'ok' }] })
    expect(await nextSystem(r)).not.toContain('<project_instructions')
    expect(await agentsMdOf(r)).toBeNull()
    expect(notLoaded(warn)).toEqual([])
  })

  test('a whitespace-only AGENTS.md adds no section, and its CLAUDE.md stays unread', async () => {
    const r = await boot({
      script: [{ text: 'ok' }],
      prepare: (workspace) => {
        writeFileSync(join(workspace, 'AGENTS.md'), ' \n\t\n')
        writeFileSync(join(workspace, 'CLAUDE.md'), 'CLAUDE-RULES\n')
      },
    })
    expect(await nextSystem(r)).not.toContain('<project_instructions')
    expect(await agentsMdOf(r)).toBeNull()
  })

  test('an AGENTS.md symlink out of the root adds no section and warns once; a symlink inside the root loads', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'pi-outside-'))
    writeFileSync(join(outside, 'secret.md'), 'OUTSIDE-SECRET\n')
    const warn = spyOn(logger, 'warn')
    try {
      const r = await boot({ script: [{ text: 'one' }, { text: 'two' }], prepare: (workspace) => symlinkSync(join(outside, 'secret.md'), join(workspace, 'AGENTS.md')) })
      expect(await nextSystem(r)).not.toContain('OUTSIDE-SECRET')
      expect(await agentsMdOf(r)).toBeNull()
      expect(notLoaded(warn)).toHaveLength(1)

      mkdirSync(join(r.workspace, 'docs'))
      writeFileSync(join(r.workspace, 'docs', 'rules.md'), 'INSIDE-RULES\n')
      rmSync(join(r.workspace, 'AGENTS.md'))
      symlinkSync('docs/rules.md', join(r.workspace, 'AGENTS.md'))
      await r.service.runtime()!.reconfigure()
      expect(await nextSystem(r)).toContain(projectRules('INSIDE-RULES'))
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('an AGENTS.md that is not a regular file adds no section and warns once', async () => {
    const warn = spyOn(logger, 'warn')
    const r = await boot({ script: [{ text: 'ok' }], prepare: (workspace) => mkdirSync(join(workspace, 'AGENTS.md')) })
    expect(await nextSystem(r)).not.toContain('<project_instructions')
    expect(await agentsMdOf(r)).toBeNull()
    expect(notLoaded(warn)).toHaveLength(1)
  })

  test('an AGENTS.md FIFO adds no section, warns once, and does not block the boot', async () => {
    const warn = spyOn(logger, 'warn')
    const r = await boot({
      script: [{ text: 'ok' }],
      prepare: (workspace) => expect(spawnSync('mkfifo', [join(workspace, 'AGENTS.md')]).status).toBe(0),
    })
    expect(await nextSystem(r)).not.toContain('<project_instructions')
    expect(notLoaded(warn)).toHaveLength(1)
  })

  // root reads a mode-000 file, so the read error cannot happen there.
  test.skipIf(process.getuid?.() === 0)('an AGENTS.md that cannot be read adds no section, warns once, and the runtime still starts', async () => {
    const warn = spyOn(logger, 'warn')
    const r = await boot({
      script: [{ text: 'ok' }],
      prepare: (workspace) => {
        writeFileSync(join(workspace, 'AGENTS.md'), 'UNREADABLE\n')
        chmodSync(join(workspace, 'AGENTS.md'), 0o000)
      },
    })
    expect(r.service.runtime()!.getState()).toBe('ok')
    expect(await nextSystem(r)).not.toContain('UNREADABLE')
    expect(notLoaded(warn)).toHaveLength(1)
  })

  test('without an AGENTS.md the root CLAUDE.md loads, as on OpenCode; an AGENTS.md takes precedence', async () => {
    const r = await boot({ script: [{ text: 'one' }, { text: 'two' }], prepare: (workspace) => writeFileSync(join(workspace, 'CLAUDE.md'), 'CLAUDE-RULES\n') })
    expect(await nextSystem(r)).toContain(projectRules('CLAUDE-RULES', 'CLAUDE.md'))
    expect(await agentsMdOf(r)).toMatchObject({ source: 'workspace', path: join(r.workspace, 'CLAUDE.md') })

    writeFileSync(join(r.workspace, 'AGENTS.md'), 'AGENTS-RULES\n')
    await r.service.runtime()!.reconfigure()
    const system = await nextSystem(r)
    expect(system).toContain(projectRules('AGENTS-RULES'))
    expect(system).not.toContain('CLAUDE-RULES')
  })
})

describe('config releases on pi', () => {
  const PROVISIONED = JSON.stringify({ default_agent: 'build', agent: { build: { prompt: 'PROVISIONED: the prompt compiled at provision.' } } })
  let api: FakeApi
  let dir: string
  let repo: string
  let managedBefore: string | undefined

  beforeEach(() => {
    api = startFakeApi(TOKEN)
    dir = mkdtempSync(join(tmpdir(), 'pi-releases-'))
    repo = join(dir, 'repo')
    initRepo(repo)
    // Never the machine's /opt/kortix/managed-skills.
    managedBefore = process.env.KORTIX_MANAGED_SKILLS_DIR
    process.env.KORTIX_MANAGED_SKILLS_DIR = join(dir, 'managed')
    mkdirSync(join(dir, 'managed'))
    // A refresh schedules the runtime-assets pass; main.ts registers its harness at boot.
    registerHarnessAssets(() => piDefinition.assets)
  })
  afterEach(() => {
    resetHarnessAssetsForTests()
    api.stop()
    spawnSync('chmod', ['-R', 'u+w', dir])
    rmSync(dir, { recursive: true, force: true })
    if (managedBefore === undefined) delete process.env.KORTIX_MANAGED_SKILLS_DIR
    else process.env.KORTIX_MANAGED_SKILLS_DIR = managedBefore
  })

  /** Commit a skill to the base branch and build its release with `prompt` as the agent's prompt. */
  const releaseWith = (skill: string, prompt: string) => {
    write(repo, '.kortix/opencode/opencode.json', '{}\n')
    write(repo, `.kortix/opencode/skills/${skill}/SKILL.md`, `---\nname: ${skill}\ndescription: ${skill} from the base branch\n---\nBody.\n`)
    const commit = commitAll(repo, skill)
    return buildRelease(repo, commit, '.kortix/opencode', {
      projectId: 'proj-pi-test',
      governance: JSON.stringify({ default_agent: 'build', agent: { build: { prompt } } }),
    })
  }

  const bootOnReleases = (script: Step[], prepare?: (workspace: string) => void) =>
    boot({
      script,
      env: { KORTIX_API_URL: api.url, KORTIX_COMPILED_AGENT_CONFIG: PROVISIONED },
      releases: { root: join(dir, 'store'), noticePath: join(dir, 'notice.md') },
      prepare: (workspace) => {
        // The session's own checkout: an older copy of one skill and one that never reached the base branch.
        for (const [name, description] of [['deploy', 'working tree copy'], ['draft', 'never pushed']] as const) {
          mkdirSync(join(workspace, 'skills', name), { recursive: true })
          writeFileSync(join(workspace, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`)
        }
        prepare?.(workspace)
      },
    })

  const skillsOf = async (r: Rig) =>
    ((await r.user('/skill').then((res) => res.json())) as Array<{ name: string; description: string }>)
      .map((s) => [s.name, s.description])
      .sort()
  const systemOf = (index: number) => JSON.stringify(gateway.sent[index]!.filter((m) => m.role === 'system'))
  const ask = async (r: Rig, text: string) => {
    const root = r.service.runtime()!.rootId
    const index = gateway.sent.length
    expect((await prompt(r, root, { parts: [{ type: 'text', text }] })).status).toBe(204)
    await waitFor(() => r.service.runtime()!.idle() && gateway.sent.length > index)
    return systemOf(index)
  }

  test('the release decides the skills and the prompt; a base move reaches the running session in place', async () => {
    const one = releaseWith('deploy', 'RELEASE-ONE: the prompt on the base branch.')
    serveRelease(api, one)
    const r = await bootOnReleases([{ text: 'first' }, { text: 'second' }])
    const root = r.service.runtime()!.rootId

    const health = (await r.bearer('/kortix/health').then((res) => res.json())) as Record<string, any>
    expect(health.capabilities).toContain('config.release.v1')
    expect(health.config).toEqual({
      release_id: one.descriptor.release_id,
      desired_release_id: one.descriptor.release_id,
      source: 'release',
      mode: 'follow-base',
      proven: true,
      fallback_reason: null,
      failed_release_id: null,
    })
    expect(health.config_dir_sha).toBe(one.descriptor.source_commit)
    expect(health.runtimeReady).toBe(true)
    // The base branch's skills, not the working tree's.
    expect(await skillsOf(r)).toEqual([['deploy', 'deploy from the base branch']])

    const first = await ask(r, 'first question')
    expect(first).toContain('RELEASE-ONE')
    expect(first).not.toContain('PROVISIONED')
    expect(first).toContain("This session's agent config")
    expect(first).toContain(one.descriptor.source_commit!.slice(0, 12))
    // The platform never writes the session's checkout.
    expect(readFileSync(join(r.workspace, 'skills', 'deploy', 'SKILL.md'), 'utf8')).toContain('working tree copy')

    const two = releaseWith('review', 'RELEASE-TWO: the prompt after the merge.')
    serveRelease(api, two)
    const converged = await r.bearer('/kortix/config/converge', { method: 'POST' })
    expect(converged.status).toBe(200)
    expect(await converged.json()).toMatchObject({
      ok: true,
      outcome: 'applied',
      reload: null,
      config: { release_id: two.descriptor.release_id, source: 'release', proven: true },
    })
    // In place: the same root, the same transcript, nothing restarted.
    expect(r.service.runtime()!.rootId).toBe(root)
    expect(await skillsOf(r)).toEqual([
      ['deploy', 'deploy from the base branch'],
      ['review', 'review from the base branch'],
    ])
    const second = await ask(r, 'second question')
    expect(second).toContain('RELEASE-TWO')
    expect(second).not.toContain('RELEASE-ONE')
    expect(second).toContain(two.descriptor.source_commit!.slice(0, 12))
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    expect(page.messages.filter((m) => m.info.role === 'user')).toHaveLength(2)

    const after = (await r.bearer('/kortix/health').then((res) => res.json())) as Record<string, any>
    expect(after.config.release_id).toBe(two.descriptor.release_id)
    expect(after.config_dir_sha).toBe(two.descriptor.source_commit)
    const again = await r.bearer('/kortix/config/converge', { method: 'POST' }).then((res) => res.json())
    expect(again).toMatchObject({ ok: true, outcome: 'unchanged' })
  })

  test("the release's pi dir replaces the working tree's; a new extension reaches the session by an in-place restart", async () => {
    const extension = (marker: string) =>
      `export default (pi) => pi.on('before_agent_start', (event) => ({ systemPrompt: event.systemPrompt + '\\n${marker}' }))\n`
    write(repo, 'harnesses/pi/extensions/native.ts', extension('RELEASED-PI-V1'))
    write(repo, 'harnesses/pi/skills/released-native/SKILL.md', '---\nname: released-native\ndescription: pi skill from the base branch\n---\nDo it.\n')
    const one = releaseWith('deploy', 'RELEASE-ONE')
    serveRelease(api, one)
    const r = await boot({
      script: [{ text: 'first' }, { text: 'second' }],
      env: { KORTIX_API_URL: api.url, KORTIX_COMPILED_AGENT_CONFIG: PROVISIONED },
      releases: { root: join(dir, 'store'), noticePath: join(dir, 'notice.md') },
      prepare: (workspace) => {
        // The session's checkout has a pi dir of its own; a release must not read it.
        const own = join(workspace, '.kortix', 'pi')
        mkdirSync(join(own, 'extensions'), { recursive: true })
        mkdirSync(join(own, 'skills', 'workspace-native'), { recursive: true })
        writeFileSync(join(own, 'extensions', 'native.ts'), extension('WORKSPACE-PI'))
        writeFileSync(join(own, 'skills', 'workspace-native', 'SKILL.md'), '---\nname: workspace-native\ndescription: w\n---\nx\n')
      },
    })
    const root = r.service.runtime()!.rootId
    const names = async () => (await skillsOf(r)).map(([name]) => name)
    expect(await names()).toContain('released-native')
    expect(await names()).not.toContain('workspace-native')
    const loaded = () => r.service.runtime()!.extensionStatus().loaded
    expect(loaded().some((path) => path.startsWith(join(dir, 'store')) && path.endsWith('/harnesses/pi/extensions/native.ts'))).toBe(true)
    expect(loaded().some((path) => path.includes('/.kortix/pi/'))).toBe(false)
    const first = await ask(r, 'first question')
    expect(first).toContain('RELEASED-PI-V1')
    expect(first).not.toContain('WORKSPACE-PI')

    write(repo, 'harnesses/pi/extensions/native.ts', extension('RELEASED-PI-V2'))
    serveRelease(api, releaseWith('deploy', 'RELEASE-TWO'))
    const converged = await r.bearer('/kortix/config/converge', { method: 'POST' }).then((res) => res.json())
    expect(converged).toMatchObject({ ok: true, outcome: 'applied', reload: null })
    expect(r.service.runtime()!.rootId).toBe(root)
    const second = await ask(r, 'second question')
    expect(second).toContain('RELEASED-PI-V2')
    expect(second).not.toContain('RELEASED-PI-V1')
    expect(second).toContain('RELEASE-TWO')
    // The restart restored the transcript: both turns are still there.
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    expect(page.messages.filter((m) => m.info.role === 'user')).toHaveLength(2)
  })

  test("pi's own .pi/ and .agents/skills discovery reads the release, never the working tree", async () => {
    const extension = (marker: string) =>
      `export default (pi) => pi.on('before_agent_start', (event) => ({ systemPrompt: event.systemPrompt + '\\n${marker}' }))\n`
    write(repo, '.pi/extensions/discovered.ts', extension('RELEASED-DISCOVERY'))
    write(repo, '.agents/skills/released-agents/SKILL.md', '---\nname: released-agents\ndescription: from the release\n---\nDo it.\n')
    serveRelease(api, releaseWith('deploy', 'RELEASE-ONE'))
    const r = await boot({
      script: [{ text: 'first' }],
      env: { KORTIX_API_URL: api.url, KORTIX_COMPILED_AGENT_CONFIG: PROVISIONED },
      releases: { root: join(dir, 'store'), noticePath: join(dir, 'notice.md') },
      prepare: (workspace) => {
        // The checkout carries its own copies; while a release runs, none is config.
        mkdirSync(join(workspace, '.pi', 'extensions'), { recursive: true })
        writeFileSync(join(workspace, '.pi', 'extensions', 'discovered.ts'), extension('WORKSPACE-DISCOVERY'))
        mkdirSync(join(workspace, '.agents', 'skills', 'workspace-agents'), { recursive: true })
        writeFileSync(join(workspace, '.agents', 'skills', 'workspace-agents', 'SKILL.md'), '---\nname: workspace-agents\ndescription: w\n---\nx\n')
      },
    })
    const loaded = r.service.runtime()!.extensionStatus().loaded
    expect(loaded.some((path) => path.startsWith(join(dir, 'store')) && path.endsWith('/.pi/extensions/discovered.ts'))).toBe(true)
    expect(loaded.some((path) => !path.startsWith(join(dir, 'store')) && path.endsWith('/.pi/extensions/discovered.ts'))).toBe(false)
    const names = (await skillsOf(r)).map(([name]) => name)
    expect(names).toContain('released-agents')
    expect(names).not.toContain('workspace-agents')
    const first = await ask(r, 'first question')
    expect(first).toContain('RELEASED-DISCOVERY')
    expect(first).not.toContain('WORKSPACE-DISCOVERY')
  })

  test('a ./ pi package loads from the release, not the working tree; a change to it reaches the session by a restart', async () => {
    const extension = (marker: string) =>
      `export default (pi) => pi.on('before_agent_start', (event) => ({ systemPrompt: event.systemPrompt + '\\n${marker}' }))\n`
    // No OpenCode config dir: the release is the whole tree with `config_dir: null` (a pi-only project).
    const pinned = (prompt: string) =>
      buildRelease(repo, commitAll(repo, prompt), null, { projectId: 'proj-pi-test', governance: JSON.stringify({ default_agent: 'build', agent: { build: { prompt } } }) })
    write(repo, 'skills/deploy/SKILL.md', '---\nname: deploy\ndescription: deploy from the base branch\n---\nBody.\n')
    write(repo, 'extensions/native.ts', extension('PACKAGE-V1'))
    serveRelease(api, pinned('RELEASE-ONE'))
    const r = await boot({
      script: [{ text: 'first' }, { text: 'second' }],
      env: { KORTIX_API_URL: api.url, KORTIX_COMPILED_AGENT_CONFIG: PROVISIONED, KORTIX_PI_PACKAGES: JSON.stringify(['./extensions/native.ts']) },
      releases: { root: join(dir, 'store'), noticePath: join(dir, 'notice.md') },
      prepare: (workspace) => {
        // The session's checkout has its own copy at the same path; a release must not read it.
        mkdirSync(join(workspace, 'extensions'), { recursive: true })
        writeFileSync(join(workspace, 'extensions', 'native.ts'), extension('WORKSPACE-PACKAGE'))
      },
    })
    expect(((await r.bearer('/kortix/health').then((res) => res.json())) as Record<string, any>).config.source).toBe('release')
    expect(await skillsOf(r)).toContainEqual(['deploy', 'deploy from the base branch'])
    const loaded = () => r.service.runtime()!.extensionStatus().loaded
    expect(loaded().some((path) => path.startsWith(join(dir, 'store')) && path.endsWith('/extensions/native.ts'))).toBe(true)
    const first = await ask(r, 'first question')
    expect(first).toContain('PACKAGE-V1')
    expect(first).not.toContain('WORKSPACE-PACKAGE')

    write(repo, 'extensions/native.ts', extension('PACKAGE-V2'))
    serveRelease(api, pinned('RELEASE-TWO'))
    expect(await r.bearer('/kortix/config/converge', { method: 'POST' }).then((res) => res.json())).toMatchObject({ ok: true, outcome: 'applied' })
    const second = await ask(r, 'second question')
    expect(second).toContain('PACKAGE-V2')
    expect(second).not.toContain('PACKAGE-V1')
  })

  test('a v3 release loads its ./ extension package and registered skills from the release root, and no harness folder', async () => {
    const extension = (text: string) => `export default (pi) => pi.on('before_agent_start', (event) => ({ systemPrompt: event.systemPrompt + '\\n${text}' }))\n`
    write(repo, 'harnesses/pi/extensions/native.ts', extension('FOLDER-EXTENSION'))
    write(repo, 'harnesses/pi/skills/folder-skill/SKILL.md', '---\nname: folder-skill\ndescription: f\n---\nx\n')
    write(repo, '.pi/extensions/discovered.ts', extension('DISCOVERED'))
    write(repo, 'skills/deploy/SKILL.md', '---\nname: deploy\ndescription: not registered\n---\nx\n')
    write(repo, 'team/review/SKILL.md', '---\nname: review\ndescription: review from the release\n---\nx\n')
    write(repo, 'extensions/package.ts', extension('PACKAGE-FROM-RELEASE'))
    const governance = JSON.stringify({ schema: 3, default_agent: 'build', agent: { build: { mode: 'primary', prompt: 'V3', permission: 'allow' } }, skills: { review: 'team/review' } })
    serveRelease(api, buildRelease(repo, commitAll(repo, 'v3'), null, { projectId: 'proj-pi-test', governance }))
    const r = await boot({
      script: [{ text: 'first' }],
      env: { KORTIX_API_URL: api.url, KORTIX_COMPILED_AGENT_CONFIG: PROVISIONED, KORTIX_PI_PACKAGES: JSON.stringify(['./extensions/package.ts']) },
      releases: { root: join(dir, 'store'), noticePath: join(dir, 'notice.md') },
      prepare: (workspace) => {
        mkdirSync(join(workspace, 'extensions'), { recursive: true })
        writeFileSync(join(workspace, 'extensions', 'package.ts'), extension('PACKAGE-FROM-WORKSPACE'))
      },
    })
    expect(((await r.bearer('/kortix/health').then((res) => res.json())) as Record<string, any>).config.source).toBe('release')
    expect(await skillsOf(r)).toEqual([['review', 'review from the release']])
    const loaded = r.service.runtime()!.extensionStatus().loaded.filter((name) => name !== 'subagents')
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.startsWith(join(dir, 'store')) && loaded[0]!.endsWith('/extensions/package.ts')).toBe(true)
    const first = await ask(r, 'first question')
    expect(first).toContain('PACKAGE-FROM-RELEASE')
    for (const text of ['PACKAGE-FROM-WORKSPACE', 'FOLDER-EXTENSION', 'DISCOVERED']) expect(first).not.toContain(text)
  })

  test('a ./ pi package in a release loads by native import: host modules resolve, a restart on the same release does not re-run it', async () => {
    const evals = '__kortixTestNativeEvals'
    const warn = spyOn(logger, 'warn')
    // A helper beside the entry, and a value import of a module pi hands every extension: the release dir has no node_modules.
    write(repo, 'extensions/lib.ts', `import { Type } from 'typebox'\nexport const marker = (v: string): string => (Type.String() ? v : '')\n`)
    write(
      repo,
      'extensions/native.ts',
      `import { marker } from './lib.ts'\n(globalThis as any).${evals} = ((globalThis as any).${evals} ?? 0) + 1\n` +
        `export default (pi) => pi.on('before_agent_start', (event) => ({ systemPrompt: event.systemPrompt + '\\n' + marker('NATIVE-V1') }))\n`,
    )
    write(repo, 'extensions/broken.ts', `throw new Error('broken at import')\n`)
    serveRelease(api, buildRelease(repo, commitAll(repo, 'native'), null, { projectId: 'proj-pi-test', governance: JSON.stringify({ default_agent: 'build', agent: { build: { prompt: 'P' } } }) }))
    const r = await boot({
      script: [{ text: 'first' }, { text: 'second' }],
      env: { KORTIX_API_URL: api.url, KORTIX_COMPILED_AGENT_CONFIG: PROVISIONED, KORTIX_PI_PACKAGES: JSON.stringify(['./extensions/native.ts', './extensions/broken.ts']) },
      releases: { root: join(dir, 'store'), noticePath: join(dir, 'notice.md') },
    })
    const runtime = r.service.runtime()!
    try {
      // Only the file whose import throws goes to pi's loader, which reports it; the session runs.
      expect(warn.mock.calls.filter(([message]) => message === '[pi] project extension loads through pi').map(([, fields]) => fields)).toEqual([
        { source: './extensions/broken.ts', reason: 'broken at import' },
      ])
      expect(runtime.extensionStatus().failed).toEqual([{ name: expect.stringMatching(/\/extensions\/broken\.ts$/), error: expect.stringContaining('broken at import') }])
      expect(runtime.extensionStatus().loaded.some((path) => path.startsWith(join(dir, 'store')) && path.endsWith('/extensions/native.ts'))).toBe(true)
      expect(await ask(r, 'first question')).toContain('NATIVE-V1')
      expect((globalThis as Record<string, unknown>)[evals]).toBe(1)
      // The release dir is content-addressed, so the module Bun cached for its path is still this file.
      await runtime.restart()
      expect((globalThis as Record<string, unknown>)[evals]).toBe(1)
      expect(await ask(r, 'second question')).toContain('NATIVE-V1')
    } finally {
      warn.mockRestore()
      delete (globalThis as Record<string, unknown>)[evals]
    }
  })

  test('config releases off: pi reads the working tree, and the box still advertises the capability', async () => {
    api.respond(FEATURE_DISABLED)
    const r = await bootOnReleases([{ text: 'ok' }])
    const health = (await r.bearer('/kortix/health').then((res) => res.json())) as Record<string, any>
    expect(health.capabilities).toContain('config.release.v1')
    expect(health.config).toMatchObject({ source: 'workspace', release_id: null, proven: true })
    expect(health.runtimeReady).toBe(true)
    expect(await skillsOf(r)).toEqual([
      ['deploy', 'working tree copy'],
      ['draft', 'never pushed'],
    ])
    const system = await ask(r, 'hello')
    expect(system).toContain('PROVISIONED')
    expect(system).not.toContain("This session's agent config")
  })

  // AGENTS.md follows the skills: the release while one runs, the working tree only while releases are off.
  test('config releases off: the working tree AGENTS.md is one section after the agent prompt, re-read with the skills', async () => {
    api.respond(FEATURE_DISABLED)
    const info = spyOn(logger, 'info')
    const text = 'WORKSPACE-RULES: cite the ticket.\n'
    const r = await bootOnReleases([{ text: 'one' }, { text: 'two' }, { text: 'three' }], (workspace) => writeFileSync(join(workspace, 'AGENTS.md'), text))
    const path = join(r.workspace, 'AGENTS.md')
    const loaded = { source: 'workspace', path, bytes: Buffer.byteLength(text), sha: sha12(text) }
    try {
      await ask(r, 'first')
      expect(systemSent(gateway.sent.at(-1)!)).toContain(`PROVISIONED: the prompt compiled at provision.\n\n${projectRules('WORKSPACE-RULES: cite the ticket.')}\n\n`)
      expect(await agentsMdOf(r)).toEqual(loaded)
      expect(info.mock.calls.filter(([message]) => message === '[pi] AGENTS.md loaded')).toEqual([['[pi] AGENTS.md loaded', loaded]])

      // No read per turn: an edit waits for the next re-read of the skills (here a reconfigure).
      writeFileSync(path, 'WORKSPACE-EDIT\n')
      expect(await ask(r, 'second')).not.toContain('WORKSPACE-EDIT')
      await r.service.runtime()!.reconfigure()
      const third = await ask(r, 'third')
      expect(third).toContain('WORKSPACE-EDIT')
      expect(third).not.toContain('WORKSPACE-RULES')
    } finally {
      info.mockRestore()
    }
  })

  test("config releases on: the release's AGENTS.md is in the prompt, and the working tree's never is", async () => {
    // The root layout: agents, skills and AGENTS.md at the repository root.
    write(repo, 'harnesses/opencode/opencode.json', '{}\n')
    write(repo, 'skills/deploy/SKILL.md', '---\nname: deploy\ndescription: deploy from the base branch\n---\nBody.\n')
    write(repo, 'AGENTS.md', 'RELEASED-RULES\n')
    const one = buildRelease(repo, commitAll(repo, 'root layout'), 'harnesses/opencode', {
      projectId: 'proj-pi-test',
      governance: JSON.stringify({ default_agent: 'build', agent: { build: { prompt: 'RELEASE-ONE' } } }),
    })
    serveRelease(api, one)
    const r = await bootOnReleases([{ text: 'first' }, { text: 'second' }], (workspace) => writeFileSync(join(workspace, 'AGENTS.md'), 'WORKSPACE-RULES\n'))
    const first = await ask(r, 'first')
    expect(first).toContain('RELEASED-RULES')
    expect(first).not.toContain('WORKSPACE-RULES')
    // The session notice tells the agent its working-copy edit waits for the base branch.
    expect(first).toContain('`/workspace/skills` or `/workspace/AGENTS.md` does NOT change the config')
    expect(await agentsMdOf(r)).toEqual({
      source: 'release',
      path: join(dir, 'store', one.descriptor.release_id!, 'AGENTS.md'),
      bytes: Buffer.byteLength('RELEASED-RULES\n'),
      sha: sha12('RELEASED-RULES\n'),
    })

    // The working copy is the agent's: an edit there never reaches the prompt, not even through a reconfigure.
    writeFileSync(join(r.workspace, 'AGENTS.md'), 'WORKSPACE-EDIT\n')
    await r.service.runtime()!.reconfigure()
    const second = await ask(r, 'second')
    expect(second).toContain('RELEASED-RULES')
    expect(second).not.toContain('WORKSPACE-')
  })

  test('config releases on with no release tree (the image default): no AGENTS.md, as no working-tree skill', async () => {
    api.respond({
      status: 200,
      json: {
        format: 'config-release-v2',
        release_id: null,
        mode: 'follow-base',
        source_commit: null,
        config_dir: null,
        config_tree_id: null,
        archive: null,
        files: null,
        compiled_governance: PROVISIONED,
        compiled_governance_etag: '0123456789abcdef',
        reason: null,
      },
    })
    const r = await bootOnReleases([{ text: 'ok' }], (workspace) => writeFileSync(join(workspace, 'AGENTS.md'), 'WORKSPACE-RULES\n'))
    expect(((await r.bearer('/kortix/health').then((res) => res.json())) as Record<string, any>).config.source).toBe('image-default')
    expect(await ask(r, 'hello')).not.toContain('WORKSPACE-RULES')
    expect(await agentsMdOf(r)).toBeNull()
  })

  test('a base move that changes AGENTS.md reaches the next turn in place: same root, same transcript, no restart', async () => {
    write(repo, 'AGENTS.md', 'BASE-RULES-ONE\n')
    serveRelease(api, releaseWith('deploy', 'RELEASE-ONE'))
    const r = await bootOnReleases([{ text: 'first' }, { text: 'second' }])
    const runtime = r.service.runtime()!
    const root = runtime.rootId
    const restart = spyOn(runtime, 'restart')
    expect(await ask(r, 'first question')).toContain('BASE-RULES-ONE')

    write(repo, 'AGENTS.md', 'BASE-RULES-TWO\n')
    const two = releaseWith('deploy', 'RELEASE-ONE')
    serveRelease(api, two)
    const converged = await r.bearer('/kortix/config/converge', { method: 'POST' }).then((res) => res.json())
    expect(converged).toMatchObject({ ok: true, outcome: 'applied', reload: null, config: { release_id: two.descriptor.release_id, source: 'release' } })
    expect(restart).not.toHaveBeenCalled()
    expect(r.service.runtime()).toBe(runtime)
    expect(runtime.rootId).toBe(root)

    const second = await ask(r, 'second question')
    expect(second).toContain('BASE-RULES-TWO')
    expect(second).not.toContain('BASE-RULES-ONE')
    expect(await agentsMdOf(r)).toEqual({
      source: 'release',
      path: join(dir, 'store', two.descriptor.release_id!, 'AGENTS.md'),
      bytes: Buffer.byteLength('BASE-RULES-TWO\n'),
      sha: sha12('BASE-RULES-TWO\n'),
    })
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    expect(page.messages.filter((m) => m.info.role === 'user')).toHaveLength(2)
  })

  test('refresh with repo=0 leaves the checkout exactly as it is', async () => {
    const origin = join(dir, 'origin.git')
    spawnSync('git', ['init', '--bare', '--quiet', origin])
    write(repo, 'README.md', 'one\n')
    const firstCommit = commitAll(repo, 'one')
    spawnSync('git', ['-C', repo, 'push', '--quiet', origin, 'HEAD:refs/heads/sess-pi-test'])
    const r = await boot({
      script: [],
      env: { KORTIX_REPO_URL: `file://${origin}`, KORTIX_BRANCH_NAME: 'sess-pi-test' },
      prepare: (workspace) => {
        spawnSync('git', ['clone', '--quiet', '--branch', 'sess-pi-test', origin, workspace])
      },
    })
    write(repo, 'README.md', 'two\n')
    const secondCommit = commitAll(repo, 'two')
    spawnSync('git', ['-C', repo, 'push', '--quiet', origin, 'HEAD:refs/heads/sess-pi-test'])
    const head = () => spawnSync('git', ['-C', r.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()

    const kept = await r.bearer('/kortix/refresh?restart=0&repo=0', { method: 'POST' })
    expect(kept.status).toBe(200)
    const keptBody = (await kept.json()) as { repo: { before: { commit: string }; after: { commit: string } } }
    expect(keptBody.repo.before.commit).toBe(firstCommit)
    expect(keptBody.repo.after.commit).toBe(firstCommit)
    expect(head()).toBe(firstCommit)

    const pulled = (await r.bearer('/kortix/refresh?restart=0', { method: 'POST' }).then((res) => res.json())) as {
      repo: { after: { commit: string } }
    }
    expect(pulled.repo.after.commit).toBe(secondCommit)
    expect(head()).toBe(secondCommit)
  })
})

/**
 * pi keeps the last `keepRecentTokens` of a conversation; 1 makes every earlier turn summarizable.
 * The cut then falls inside the last turn, so one compaction asks the model twice: for the history
 * and for that turn's head. A script gives both replies (`SUMMARY`).
 */
const SUMMARY: Step[] = [{ text: 'SUMMARY-ONE' }, { text: 'SUMMARY-TWO' }]
const compactEverything = (workspace: string) => {
  mkdirSync(join(workspace, 'harnesses/pi'), { recursive: true })
  writeFileSync(join(workspace, 'harnesses/pi/settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 1 } }))
}
const summarize = (r: Rig, root: string) => r.user(`/session/${root}/summarize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
const sentText = (messages: Array<{ role: string; content: unknown }>) => JSON.stringify(messages)
const compactionTurns = (page: WirePage) =>
  page.messages.flatMap((marker) => {
    const part = marker.parts.find((p) => p.type === 'compaction')
    return part ? [{ part, summary: page.messages.find((m) => m.info.parentID === marker.info.id)! }] : []
  })

describe('pi compaction', () => {
  test('health lists session.compact', async () => {
    const r = await boot({ script: [] })
    const health = (await r.bearer('/kortix/health').then((res) => res.json())) as { capabilities: string[] }
    expect(health.capabilities).toContain('session.compact')
  })

  test('summarize compacts on demand: the wire shows the request and the summary, and the model gets the summary', async () => {
    const r = await boot({ script: [{ text: 'first answer' }, { text: 'second answer' }, ...SUMMARY, { text: 'third answer' }], prepare: compactEverything })
    const root = r.service.runtime()!.rootId
    await promptAndSettle(r, 'ALPHA question')
    await promptAndSettle(r, 'BETA question')
    const events = await r.bearer('/kortix/opencode/events?since=0')

    expect(await summarize(r, root).then((res) => res.json())).toBe(true)
    const text = await readSse(events, (t) => t.includes('event: session.compacted'))
    expect(text).toContain('event: session.compacted')
    // The session row says when a compaction runs: `time.compacting` on the first frame, gone on the second.
    const updates = text.split('\n\n').filter((frame) => frame.includes('event: session.updated')).map((frame) => frame.slice(frame.indexOf('data: ') + 6))
    expect(updates).toHaveLength(2)
    expect(updates[0]).toContain('"compacting"')
    expect(updates[1]).not.toContain('"compacting"')
    await waitFor(() => r.service.runtime()!.idle())

    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    const [turn] = compactionTurns(page)
    expect(turn!.part).toMatchObject({ type: 'compaction', auto: false })
    expect(turn!.summary.info).toMatchObject({ role: 'assistant', summary: true, time: { completed: expect.any(Number) } })
    expect(turn!.summary.info.error).toBeUndefined()
    expect(turn!.summary.parts.map((p) => p.type)).toEqual(['text'])
    expect(turn!.summary.parts[0]!.text).toContain('SUMMARY-ONE')
    expect(turn!.summary.parts[0]!.text).toContain('SUMMARY-TWO')
    // The transcript keeps every message; only the model's context is shorter.
    expect(page.messages.filter((m) => m.info.role === 'user' && m.parts.some((p) => p.type === 'text'))).toHaveLength(2)
    const session = (await r.user(`/session/${root}`).then((res) => res.json())) as { time: Record<string, unknown> }
    expect(session.time.compacting).toBeUndefined()

    await promptAndSettle(r, 'GAMMA question')
    const next = sentText(gateway.sent.at(-1)!)
    expect(next).toContain('SUMMARY-ONE')
    expect(next).toContain('GAMMA question')
    expect(next).not.toContain('ALPHA question')
  })

  test('a compacted conversation survives a daemon restart', async () => {
    const r = await boot({ script: [{ text: 'first answer' }, { text: 'second answer' }, ...SUMMARY], prepare: compactEverything })
    const root = r.service.runtime()!.rootId
    await promptAndSettle(r, 'ALPHA question')
    await promptAndSettle(r, 'BETA question')
    expect((await summarize(r, root)).status).toBe(200)
    await waitFor(() => r.service.runtime()!.idle())
    await r.service.lifecycle.stop()

    const restarted = await boot({ script: [{ text: 'after restart' }], workspace: r.workspace })
    rigs.splice(rigs.indexOf(r), 1)
    await promptAndSettle(restarted, 'GAMMA question')
    const next = sentText(gateway.sent.at(-1)!)
    expect(next).toContain('SUMMARY-ONE')
    expect(next).not.toContain('ALPHA question')
  })

  test('a dump written before pi 1.0 restores its conversation from agentMessages', async () => {
    const r = await boot({ script: [{ text: 'first answer' }] })
    await promptAndSettle(r, 'ALPHA question')
    await r.service.lifecycle.stop()
    const dumpPath = join(r.workspace, '.state', 'sess-pi-test.json')
    const { entries, ...legacy } = JSON.parse(readFileSync(dumpPath, 'utf8')) as Record<string, unknown>
    expect(Array.isArray(entries)).toBe(true)
    writeFileSync(dumpPath, JSON.stringify(legacy))

    const restarted = await boot({ script: [{ text: 'after restart' }], workspace: r.workspace })
    rigs.splice(rigs.indexOf(r), 1)
    await promptAndSettle(restarted, 'BETA question')
    const next = sentText(gateway.sent.at(-1)!)
    expect(next).toContain('ALPHA question')
    expect(next).toContain('first answer')
  })

  test('stop ends a compaction in flight: the summary message carries the abort, and the context is unchanged', async () => {
    const r = await boot({ script: [{ text: 'first answer' }, { text: 'second answer' }, { stall: true }, { stall: true }, { text: 'third answer' }], prepare: compactEverything })
    const root = r.service.runtime()!.rootId
    await promptAndSettle(r, 'ALPHA question')
    await promptAndSettle(r, 'BETA question')
    const calls = gateway.requests.length
    expect((await summarize(r, root)).status).toBe(200)
    await waitFor(() => gateway.requests.length > calls)
    const session = (await r.user(`/session/${root}`).then((res) => res.json())) as { time: Record<string, unknown> }
    expect(session.time.compacting).toEqual(expect.any(Number))
    expect((await r.user(`/session/${root}/abort`, { method: 'POST' })).status).toBe(200)
    await waitFor(() => r.service.runtime()!.idle())

    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    expect(compactionTurns(page)[0]!.summary.info.error).toMatchObject({ name: 'MessageAbortedError' })
    gateway.script([{ text: 'third answer' }])
    await promptAndSettle(r, 'GAMMA question')
    expect(sentText(gateway.sent.at(-1)!)).toContain('ALPHA question')
  })

  /** The turn relays a boot would send: begins by message id, ends whole. */
  const compactionRelays = () => {
    const seen = { begins: [] as string[], ends: [] as Array<Parameters<NonNullable<PiRuntimeHooks['onTurnEnd']>>[0]> }
    const hooks: PiRuntimeHooks = { onTurnBegin: ({ messageId }) => void seen.begins.push(messageId), onTurnEnd: (end) => void seen.ends.push(end) }
    return { seen, hooks }
  }

  test('a /summarize is a turn named by its compaction marker: begin and end relay its id, and the log stores the compaction under it', async () => {
    const { seen, hooks } = compactionRelays()
    const r = await boot({ script: [{ text: 'first answer' }, { text: 'second answer' }, ...SUMMARY], prepare: compactEverything, hooks })
    const rt = r.service.runtime()!
    await promptAndSettle(r, 'ALPHA question')
    await promptAndSettle(r, 'BETA question')
    const prompts = [...seen.begins]
    expect((await summarize(r, rt.rootId)).status).toBe(200)
    await waitFor(() => seen.ends.length === prompts.length + 1)

    const page = (await r.bearer(`/kortix/runtime/messages/${rt.rootId}`).then((res) => res.json())) as WirePage
    const marker = page.messages.find((m) => m.parts.some((p) => p.type === 'compaction'))!.info.id as string
    expect(seen.begins).toEqual([...prompts, marker])
    expect(seen.ends.at(-1)).toEqual({ rootId: rt.rootId, messageId: marker, status: 'idle' })
    const stored = piSessionLog(rt.sessionLogSnapshot()!).log.threads[0]!.messages.filter((m) => m.kind === 'compaction')
    expect(stored.map((m) => m.message_id)).toEqual([marker])
  })

  test('pi refuses a /summarize on a short context: the turn ends idle, and the wire and the log line keep the reason', async () => {
    const { seen, hooks } = compactionRelays()
    const warn = spyOn(logger, 'warn')
    const r = await boot({ script: [{ text: 'first answer' }], hooks })
    const rt = r.service.runtime()!
    await promptAndSettle(r, 'ALPHA question')
    expect((await summarize(r, rt.rootId)).status).toBe(200)
    await waitFor(() => seen.ends.length === 2)

    const [refused] = compactionTurns((await r.bearer(`/kortix/runtime/messages/${rt.rootId}`).then((res) => res.json())) as WirePage)
    const marker = refused!.part.messageID as string
    expect(refused!.summary.info.error).toMatchObject({ name: 'UnknownError', data: { message: 'Compaction failed: Nothing to compact (session too small)' } })
    expect(seen.begins.at(-1)).toBe(marker)
    expect(seen.ends.at(-1)).toEqual({ rootId: rt.rootId, messageId: marker, status: 'idle' })
    expect(piSessionLog(rt.sessionLogSnapshot()!).log.threads[0]!.messages.filter((m) => m.kind === 'compaction')).toEqual([])
    await waitFor(() => warn.mock.calls.some(([line, data]) => line === '[pi] compaction failed' && JSON.stringify(data).includes('Nothing to compact')))
    warn.mockRestore()
  })

  test('a second /summarize right after a compaction is refused as already compacted: the turn ends idle', async () => {
    const { seen, hooks } = compactionRelays()
    const r = await boot({ script: [{ text: 'first answer' }, { text: 'second answer' }, ...SUMMARY], prepare: compactEverything, hooks })
    const rt = r.service.runtime()!
    await promptAndSettle(r, 'ALPHA question')
    await promptAndSettle(r, 'BETA question')
    expect((await summarize(r, rt.rootId)).status).toBe(200)
    await waitFor(() => seen.ends.length === 3)
    expect((await summarize(r, rt.rootId)).status).toBe(200)
    await waitFor(() => seen.ends.length === 4)
    const turns = compactionTurns((await r.bearer(`/kortix/runtime/messages/${rt.rootId}`).then((res) => res.json())) as WirePage)
    expect(turns).toHaveLength(2)
    expect(turns[0]!.summary.info.error).toBeUndefined()
    expect(turns[1]!.summary.info.error).toMatchObject({ data: { message: 'Compaction failed: Already compacted' } })
    expect(seen.ends.slice(2)).toEqual([
      { rootId: rt.rootId, messageId: turns[0]!.part.messageID, status: 'idle' },
      { rootId: rt.rootId, messageId: turns[1]!.part.messageID, status: 'idle' },
    ])
  })

  test('a /summarize whose model call fails ends its turn error with the reason', async () => {
    const { seen, hooks } = compactionRelays()
    const r = await boot({ script: [{ text: 'first answer' }, { text: 'second answer' }, { status: 400, message: 'SUMMARY-REFUSED-BY-MODEL' }, { status: 400, message: 'SUMMARY-REFUSED-BY-MODEL' }], prepare: compactEverything, hooks })
    const rt = r.service.runtime()!
    await promptAndSettle(r, 'ALPHA question')
    await promptAndSettle(r, 'BETA question')
    expect((await summarize(r, rt.rootId)).status).toBe(200)
    await waitFor(() => seen.ends.length === 3)
    const end = seen.ends.at(-1)!
    expect(end).toEqual({ rootId: rt.rootId, messageId: seen.begins.at(-1)!, status: 'error', error: { name: 'UnknownError', message: end.error!.message } })
    expect(end.error!.message).toStartWith('Compaction failed: Summarization failed: 400')
    expect(end.error!.message).toContain('SUMMARY-REFUSED-BY-MODEL')
  })

  test('a compaction kortixd did not start for /summarize (an extension ctx.compact()) relays no turn', async () => {
    const { seen, hooks } = compactionRelays()
    const r = await boot({ script: [{ text: 'first answer' }, { text: 'second answer' }, ...SUMMARY], prepare: compactEverything, hooks })
    const rt = r.service.runtime()!
    await promptAndSettle(r, 'ALPHA question')
    await promptAndSettle(r, 'BETA question')
    // What pi's extension `ctx.compact()` calls: the session's own compact, reason `manual`.
    await (rt as unknown as { pi: { session: { compact(): Promise<unknown> } } }).pi.session.compact()
    const page = (await r.bearer(`/kortix/runtime/messages/${rt.rootId}`).then((res) => res.json())) as WirePage
    expect(compactionTurns(page)).toHaveLength(1)
    expect(seen.begins).toHaveLength(2)
    expect(seen.ends).toHaveLength(2)
  })

  test('Stop before a queued /summarize starts drops it: no model call, no turn', async () => {
    const { seen, hooks } = compactionRelays()
    const r = await boot({ script: [{ text: 'first answer' }, { tool: 'bash', args: { command: 'sleep 20' } }, { text: 'never' }], prepare: compactEverything, hooks })
    const rt = r.service.runtime()!
    await promptAndSettle(r, 'ALPHA question')
    expect((await prompt(r, rt.rootId, { parts: [{ type: 'text', text: 'wait' }] })).status).toBe(204)
    await waitForRunningTool(r, rt.rootId)
    expect((await summarize(r, rt.rootId)).status).toBe(200)
    const calls = gateway.requests.length
    expect((await r.user(`/session/${rt.rootId}/abort`, { method: 'POST' })).status).toBe(200)
    await waitFor(() => rt.idle())
    expect(gateway.requests.length).toBe(calls)
    expect(compactionTurns((await r.bearer(`/kortix/runtime/messages/${rt.rootId}`).then((res) => res.json())) as WirePage)).toEqual([])
    expect(seen.begins).toHaveLength(2)
  })

  test('a stopped /summarize ends its turn idle, like a stopped prompt', async () => {
    const { seen, hooks } = compactionRelays()
    const r = await boot({ script: [{ text: 'first answer' }, { text: 'second answer' }, { stall: true }, { stall: true }], prepare: compactEverything, hooks })
    const rt = r.service.runtime()!
    await promptAndSettle(r, 'ALPHA question')
    await promptAndSettle(r, 'BETA question')
    const calls = gateway.requests.length
    expect((await summarize(r, rt.rootId)).status).toBe(200)
    await waitFor(() => gateway.requests.length > calls)
    expect((await r.user(`/session/${rt.rootId}/abort`, { method: 'POST' })).status).toBe(200)
    await waitFor(() => seen.ends.length === 3)
    expect(seen.ends.at(-1)).toEqual({ rootId: rt.rootId, messageId: seen.begins.at(-1)!, status: 'idle' })
  })

  test('an auto compaction inside a prompt turn relays no turn of its own', async () => {
    const { seen, hooks } = compactionRelays()
    const r = await boot({ script: [{ text: 'first answer' }, { text: 'big answer', promptTokens: 60_000 }, ...SUMMARY], prepare: compactEverything, hooks })
    await promptAndSettle(r, 'ALPHA question')
    await promptAndSettle(r, 'BETA question')
    await waitFor(() => r.service.runtime()!.idle())
    const page = (await r.bearer(`/kortix/runtime/messages/${r.service.runtime()!.rootId}`).then((res) => res.json())) as WirePage
    expect(compactionTurns(page)).toHaveLength(1)
    expect(seen.begins).toHaveLength(2)
    expect(seen.ends.map((e) => e.messageId)).toEqual(seen.begins)
  })

  test('a context past the model threshold compacts by itself after the turn', async () => {
    // The catalog window is 64,000 and pi reserves 16,384: a reply that reports 60,000 is over.
    const r = await boot({ script: [{ text: 'first answer' }, { text: 'big answer', promptTokens: 60_000 }, ...SUMMARY], prepare: compactEverything })
    const root = r.service.runtime()!.rootId
    await promptAndSettle(r, 'ALPHA question')
    await promptAndSettle(r, 'BETA question')
    await waitFor(() => r.service.runtime()!.idle())
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    const [turn] = compactionTurns(page)
    expect(turn!.part).toMatchObject({ type: 'compaction', auto: true })
    expect(turn!.summary.parts[0]!.text).toContain('SUMMARY-ONE')
    expect(page.messages.filter((m) => m.info.error)).toEqual([])
  })

  test('a context overflow compacts and retries: the turn completes with no error on the wire', async () => {
    const overflow = { status: 400, message: "This model's maximum context length is 64000 tokens. However, your messages resulted in 70000 tokens." }
    const r = await boot({ script: [{ text: 'first answer' }, overflow, ...SUMMARY, { text: 'answer after compaction' }], prepare: compactEverything })
    const root = r.service.runtime()!.rootId
    await promptAndSettle(r, 'ALPHA question')
    const events = await r.bearer('/kortix/opencode/events?since=0')
    const messageID = 'msg_0198e2a4b0e1ABCDEFGHIJKLMN'
    expect((await prompt(r, root, { messageID, parts: [{ type: 'text', text: 'BETA question' }] })).status).toBe(204)
    await waitFor(() => r.service.runtime()!.idle())

    const probe = (await r.bearer(`/kortix/health?turn=1&turn_message_id=${messageID}`).then((res) => res.json())) as Record<string, unknown>
    expect(probe.turn_end).toBe('completed')
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    expect(page.messages.filter((m) => m.info.error)).toEqual([])
    expect(compactionTurns(page)[0]!.part).toMatchObject({ type: 'compaction', auto: true, overflow: true })
    expect(page.messages.at(-1)!.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'answer after compaction' })
    const text = await readSse(events, (t) => t.includes('answer after compaction') && t.includes('event: session.idle'))
    expect(text).not.toContain('event: session.error')
  })

  test('an overflow with nothing to compact fails the turn with ContextOverflowError', async () => {
    const overflow = { status: 400, message: "This model's maximum context length is 64000 tokens. However, your messages resulted in 70000 tokens." }
    const r = await boot({ script: [overflow] })
    const root = r.service.runtime()!.rootId
    const events = await r.bearer('/kortix/opencode/events?since=0')
    const messageID = 'msg_0198e2a4b0e2ABCDEFGHIJKLMN'
    expect((await prompt(r, root, { messageID, parts: [{ type: 'text', text: 'ALPHA question' }] })).status).toBe(204)
    await waitFor(() => r.service.runtime()!.idle())
    const probe = (await r.bearer(`/kortix/health?turn=1&turn_message_id=${messageID}`).then((res) => res.json())) as Record<string, unknown>
    expect(probe.turn_end).toBe('failed')
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    expect(page.messages.filter((m) => m.info.error).map((m) => m.info.error.name)).toContain('ContextOverflowError')
    const text = await readSse(events, (t) => t.includes('event: session.error') && t.includes('event: session.idle'))
    expect(text).toContain('ContextOverflowError')
  })

  test('stop during the compaction before a prompt ends the turn without a model call', async () => {
    // The retried step skips pi's post-run check, so the 60,000-token reply is compacted before the next prompt.
    const r = await boot({ script: [{ text: 'first answer' }, { cut: '' }, { text: 'big answer', promptTokens: 60_000 }, { stall: true }, { text: 'must not be asked' }], prepare: compactEverything })
    const root = r.service.runtime()!.rootId
    await promptAndSettle(r, 'ALPHA question')
    await promptAndSettle(r, 'BETA question')
    const calls = gateway.requests.length
    const messageID = 'msg_0198e2a4b0e3ABCDEFGHIJKLMN'
    expect((await prompt(r, root, { messageID, parts: [{ type: 'text', text: 'GAMMA question' }] })).status).toBe(204)
    await waitFor(() => gateway.requests.length > calls)
    expect((await r.user(`/session/${root}/abort`, { method: 'POST' })).status).toBe(200)
    await waitFor(() => r.service.runtime()!.idle())
    // One request: the stalled summary. Neither the turn's model call nor a compaction after the stop goes out.
    expect(gateway.requests.length - calls).toBe(1)
    expect(gateway.sent.slice(calls).map(sentText).filter((sent) => sent.includes('GAMMA question'))).toEqual([])
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    expect(page.messages.at(-1)!.info).toMatchObject({ role: 'assistant', error: { name: 'MessageAbortedError' } })
  })

  test('an overflow after a transient retry fails at once: pi does not compact a retried step', async () => {
    const overflow = { status: 400, message: "This model's maximum context length is 64000 tokens. However, your messages resulted in 70000 tokens." }
    const r = await boot({ script: [{ text: 'first answer' }, { cut: '' }, overflow], prepare: compactEverything })
    const root = r.service.runtime()!.rootId
    await promptAndSettle(r, 'ALPHA question')
    const events = await r.bearer('/kortix/opencode/events?since=0')
    expect((await prompt(r, root, { messageID: 'msg_0198e2a4b0e4ABCDEFGHIJKLMN', parts: [{ type: 'text', text: 'BETA question' }] })).status).toBe(204)
    await waitFor(() => r.service.runtime()!.idle())
    const text = await readSse(events, (t) => t.includes('ContextOverflowError') && t.includes('event: session.idle'))
    expect(text).not.toContain('Compacting the conversation')
  })
})

describe('pi slash commands', () => {
  const TEMPLATE = 'Review the change named $1 and list its risks.\n\nFocus: $ARGUMENTS'
  const withReviewCommand = (workspace: string) => {
    mkdirSync(join(workspace, 'harnesses/pi/prompts'), { recursive: true })
    writeFileSync(join(workspace, 'harnesses/pi/prompts/review.md'), `---\ndescription: Review a change\n---\n${TEMPLATE}\n`)
  }
  const command = (r: Rig, root: string, body: Record<string, unknown>) =>
    r.user(`/session/${root}/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('the command list is the prompt templates of the pi config directory', async () => {
    const r = await boot({ script: [], prepare: withReviewCommand })
    expect(await r.user('/command').then((res) => res.json())).toEqual([
      { name: 'review', description: 'Review a change', source: 'command', template: TEMPLATE, hints: ['$1', '$ARGUMENTS'] },
    ])
    const state = (await r.bearer('/kortix/runtime/state').then((res) => res.json())) as { commands: { known: boolean; value: unknown[] } }
    expect(state.commands).toEqual({
      known: true,
      value: [{ name: 'review', description: 'Review a change', agent: null, model: null, source: 'command', subtask: null, hints: ['$1', '$ARGUMENTS'], template_bytes: TEMPLATE.length }],
    })
  })

  test('a command runs its template: the model and the transcript get the expanded text', async () => {
    const r = await boot({ script: [{ text: 'Two risks.' }], prepare: withReviewCommand })
    const root = r.service.runtime()!.rootId
    const messageID = 'msg_0198e2a4b0e3ABCDEFGHIJKLMN'
    const res = await command(r, root, { command: 'review', arguments: 'auth-fix', messageID })
    expect(res.status).toBe(200)
    const reply = (await res.json()) as WirePage['messages'][number]
    expect(reply.info).toMatchObject({ role: 'assistant', parentID: messageID })
    expect(reply.parts.find((p) => p.type === 'text')!.text).toBe('Two risks.')

    const expanded = 'Review the change named auth-fix and list its risks.\n\nFocus: auth-fix'
    expect(sentText(gateway.sent.at(-1)!)).toContain(JSON.stringify(expanded).slice(1, -1))
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    const user = page.messages.find((m) => m.info.id === messageID)!
    expect(user.parts.map((p) => p.text)).toEqual([expanded])
  })

  const withDeploySkill = (workspace: string) => {
    withReviewCommand(workspace)
    for (const name of ['deploy', 'review']) {
      mkdirSync(join(workspace, 'skills', name), { recursive: true })
      writeFileSync(join(workspace, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill\n---\nSKILL-BODY-${name}\n`)
    }
  }

  test('the command list carries the granted skills after the commands; a command keeps its name', async () => {
    const r = await boot({ script: [], prepare: withDeploySkill })
    expect(await r.user('/command').then((res) => res.json())).toEqual([
      { name: 'review', description: 'Review a change', source: 'command', template: TEMPLATE, hints: ['$1', '$ARGUMENTS'] },
      { name: 'deploy', description: 'The deploy skill', source: 'skill', template: '', hints: [] },
    ])
  })

  test('a skill runs as its SKILL.md body plus the arguments', async () => {
    const r = await boot({ script: [{ text: 'Deployed.' }], prepare: withDeploySkill })
    const root = r.service.runtime()!.rootId
    const res = await command(r, root, { command: 'deploy', arguments: 'to staging' })
    expect(res.status).toBe(200)
    const sent = sentText(gateway.sent.at(-1)!)
    expect(sent).toContain('<skill name=\\"deploy\\"')
    expect(sent).toContain('SKILL-BODY-deploy')
    expect(sent).toContain('to staging')
  })

  test('a command pi does not have is refused with 400 and runs no turn', async () => {
    const r = await boot({ script: [{ text: 'never' }], prepare: withReviewCommand })
    const root = r.service.runtime()!.rootId
    const calls = gateway.requests.length
    const res = await command(r, root, { command: 'deploy', arguments: '' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('deploy')
    expect(gateway.requests.length).toBe(calls)
    expect((await command(r, root, { arguments: 'x' })).status).toBe(400)
  })
})

describe('pi steering', () => {
  const post = (r: Rig, path: string, body: unknown) =>
    r.user(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  /** As apps/api sends it: the service bearer plus the service-call mark the user proxy strips. */
  const service = (r: Rig, path: string, body: unknown) =>
    r.bearer(path, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Kortix-Service-Call': '1' }, body: JSON.stringify(body) })
  const steer = (r: Rig, messageId: string, text: string) =>
    service(r, `/kortix/runtime/sessions/${r.service.runtime()!.rootId}/steer`, { message_id: messageId, parts: [{ type: 'text', text }] })
  const page = async (r: Rig) =>
    (await r.bearer(`/kortix/runtime/messages/${r.service.runtime()!.rootId}`).then((res) => res.json())) as WirePage
  /** An id the client mints at send time: above every id it has seen, as the SDK does. */
  const sendTimeId = async (r: Rig) => {
    const clock = new MessageIdClock()
    for (const message of (await page(r)).messages) clock.observe(String(message.info.id))
    return clock.mint(Date.now())
  }
  const sentText = (index: number) => JSON.stringify(gateway.sent[index])
  /** Hooks that record the turn and steer relays the boot would send. */
  const relays = () => {
    const seen = { begins: [] as string[], ends: [] as string[], reads: [] as string[] }
    const hooks: PiRuntimeHooks = {
      onTurnBegin: ({ messageId }) => void seen.begins.push(messageId),
      onTurnEnd: ({ messageId }) => void seen.ends.push(messageId),
      onSteerRead: ({ messageId }) => void seen.reads.push(messageId),
    }
    return { seen, hooks }
  }
  const TURN = 'msg_0198e2a4b0c3STEERTURN00001'

  test('health lists session.steer', async () => {
    const r = await boot({ script: [] })
    const health = (await r.bearer('/kortix/health').then((res) => res.json())) as { capabilities: string[] }
    expect(health.capabilities).toContain('session.steer')
  })

  test('a message steered during a tool call is read at the next step of the same turn', async () => {
    const { seen, hooks } = relays()
    const r = await boot({ script: [{ tool: 'bash', args: { command: 'sleep 0.6; echo tool-done' } }, { text: 'Checked the note too.' }], hooks })
    const root = r.service.runtime()!.rootId
    const before = gateway.sent.length
    expect((await post(r, `/kortix/runtime/sessions/${root}/prompt`, { message_id: TURN, parts: [{ type: 'text', text: 'run the tool' }] })).status).toBe(202)
    await waitForRunningTool(r, root)
    const steered = await sendTimeId(r)
    const accepted = await steer(r, steered, 'STEER-ONE also check the note')
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual({ message_id: steered, steered: true })
    // Not on the wire before the turn reads it.
    expect((await page(r)).messages.some((m) => m.info.id === steered)).toBe(false)
    await waitFor(() => seen.ends.length === 1)

    // One turn, two model requests; the second carries the steered text, the first does not.
    expect(seen.begins).toEqual([TURN])
    expect(seen.ends).toEqual([TURN])
    expect(gateway.sent.length - before).toBe(2)
    expect(sentText(before)).not.toContain('STEER-ONE')
    expect(sentText(before + 1)).toContain('STEER-ONE')
    expect(seen.reads).toEqual([steered])

    // The wire shows it after the tool step, and the reply answers it.
    const messages = (await page(r)).messages
    expect(messages.map((m) => [m.info.role, m.info.parentID ?? null])).toEqual([
      ['user', null],
      ['assistant', TURN],
      ['user', null],
      ['assistant', steered],
    ])
    expect(messages[2]!.info.id).toBe(steered)
    expect(messages[2]!.parts[0]).toMatchObject({ type: 'text', text: 'STEER-ONE also check the note' })
    expect(messages[1]!.parts.find((p) => p.type === 'tool')!.state.status).toBe('completed')

    // pi's session store holds it, so the dump a restart restores has it.
    const dump = JSON.parse(readFileSync(join(r.workspace, '.state', 'sess-pi-test.json'), 'utf8')) as { entries: unknown[] }
    expect(JSON.stringify(dump.entries)).toContain('STEER-ONE')
    // Read: it cannot be withdrawn any more.
    const removed = await r.user(`/kortix/runtime/messages/${root}/${steered}`, { method: 'DELETE' })
    expect(removed.status).toBe(409)
    expect(await removed.json()).toEqual({ code: 'message_read', error: 'a model call read this message' })
  })

  test('two messages steered before one boundary arrive together, in send order', async () => {
    const { seen, hooks } = relays()
    const r = await boot({ script: [{ tool: 'bash', args: { command: 'sleep 0.6' } }, { text: 'Both handled.' }], hooks })
    const root = r.service.runtime()!.rootId
    const before = gateway.sent.length
    expect((await post(r, `/kortix/runtime/sessions/${root}/prompt`, { message_id: TURN, parts: [{ type: 'text', text: 'go' }] })).status).toBe(202)
    await waitForRunningTool(r, root)
    const first = await sendTimeId(r)
    expect((await steer(r, first, 'STEER-A')).status).toBe(202)
    await Bun.sleep(2)
    const second = await sendTimeId(r)
    expect((await steer(r, second, 'STEER-B')).status).toBe(202)
    await waitFor(() => seen.ends.length === 1)
    expect(gateway.sent.length - before).toBe(2)
    const next = sentText(before + 1)
    expect(next.indexOf('STEER-A')).toBeGreaterThan(-1)
    expect(next.indexOf('STEER-B')).toBeGreaterThan(next.indexOf('STEER-A'))
    expect(seen.reads).toEqual([first, second])
    expect((await page(r)).messages.map((m) => m.info.role)).toEqual(['user', 'assistant', 'user', 'user', 'assistant'])
  })

  test('a steered message withdrawn before the boundary never reaches the model', async () => {
    const { seen, hooks } = relays()
    const r = await boot({ script: [{ tool: 'bash', args: { command: 'sleep 0.6' } }, { text: 'Only one.' }], hooks })
    const root = r.service.runtime()!.rootId
    const before = gateway.sent.length
    expect((await post(r, `/kortix/runtime/sessions/${root}/prompt`, { message_id: TURN, parts: [{ type: 'text', text: 'go' }] })).status).toBe(202)
    await waitForRunningTool(r, root)
    const withdrawn = await sendTimeId(r)
    expect((await steer(r, withdrawn, 'STEER-GONE')).status).toBe(202)
    await Bun.sleep(2)
    const kept = await sendTimeId(r)
    expect((await steer(r, kept, 'STEER-KEPT')).status).toBe(202)
    const removed = await r.user(`/kortix/runtime/messages/${root}/${withdrawn}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    await waitFor(() => seen.ends.length === 1)
    expect(sentText(before + 1)).toContain('STEER-KEPT')
    expect(sentText(before + 1)).not.toContain('STEER-GONE')
    expect(seen.reads).toEqual([kept])
    expect((await page(r)).messages.some((m) => m.info.id === withdrawn)).toBe(false)
    expect((await r.user(`/kortix/runtime/messages/${root}/${withdrawn}`, { method: 'DELETE' })).status).toBe(404)
  })

  test('a message steered after the last step starts the next turn when the turn ends', async () => {
    const { seen, hooks } = relays()
    const r = await boot({
      script: [{ text: 'first reply' }, { text: 'second reply' }],
      hooks,
      // Holds the turn open after its last model step: the window a late steer lands in.
      prepare: (workspace) =>
        void repoExtension(workspace, 'settle-late', `export default function (pi) {\n  pi.on('agent_settled', () => new Promise((resolve) => setTimeout(resolve, 800)))\n}\n`),
    })
    const rt = r.service.runtime()!
    const before = gateway.sent.length
    expect((await post(r, `/kortix/runtime/sessions/${rt.rootId}/prompt`, { message_id: TURN, parts: [{ type: 'text', text: 'go' }] })).status).toBe(202)
    await waitFor(() => !rt.busy() && rt.activeTurnMessageId() === TURN && gateway.sent.length - before === 1)
    await Bun.sleep(100)
    const late = await sendTimeId(r)
    expect((await steer(r, late, 'STEER-LATE')).status).toBe(202)
    await waitFor(() => seen.ends.length === 2)
    expect(seen.begins).toEqual([TURN, late])
    expect(seen.ends).toEqual([TURN, late])
    expect(seen.reads).toEqual([late])
    expect(gateway.sent.length - before).toBe(2)
    expect(sentText(before + 1)).toContain('STEER-LATE')
    const messages = (await page(r)).messages
    expect(messages.map((m) => [m.info.role, m.info.parentID ?? null])).toEqual([
      ['user', null],
      ['assistant', TURN],
      ['user', null],
      ['assistant', late],
    ])
    expect(messages[2]!.info.id).toBe(late)
  })

  test('a stopped turn drops its unread steered messages and starts nothing', async () => {
    const { seen, hooks } = relays()
    const r = await boot({ script: [{ tool: 'bash', args: { command: 'sleep 20' } }, { text: 'unreachable' }, { text: 'next turn' }], hooks })
    const root = r.service.runtime()!.rootId
    expect((await post(r, `/kortix/runtime/sessions/${root}/prompt`, { message_id: TURN, parts: [{ type: 'text', text: 'wait' }] })).status).toBe(202)
    await waitForRunningTool(r, root)
    const dropped = await sendTimeId(r)
    expect((await steer(r, dropped, 'STEER-DROPPED')).status).toBe(202)
    expect((await post(r, `/kortix/runtime/sessions/${root}/abort`, {})).status).toBe(200)
    await waitFor(() => seen.ends.length === 1)
    await Bun.sleep(150)
    expect(seen.begins).toEqual([TURN])
    expect(seen.reads).toEqual([])
    expect((await page(r)).messages.some((m) => m.info.id === dropped)).toBe(false)
    // Nothing is left in pi's queue: the next turn's model does not get it.
    const before = gateway.sent.length
    expect((await post(r, `/kortix/runtime/sessions/${root}/prompt`, { message_id: await sendTimeId(r), parts: [{ type: 'text', text: 'again' }] })).status).toBe(202)
    await waitFor(() => seen.ends.length === 2)
    expect(sentText(before)).not.toContain('STEER-DROPPED')
  })

  test('an idle session refuses a steer with no_active_turn and stores nothing; a repeated id is deduplicated', async () => {
    const { seen, hooks } = relays()
    const r = await boot({ script: [{ tool: 'bash', args: { command: 'sleep 0.6' } }, { text: 'done' }, { text: 'idle prompt' }], hooks })
    const root = r.service.runtime()!.rootId
    expect((await service(r, `/kortix/runtime/sessions/${root}/steer`, { parts: [{ type: 'text', text: 'no id' }] })).status).toBe(400)
    // Only the platform may steer (D9.3 is checked there): a user through the
    // proxy, and the bearer without the service-call mark, are refused.
    const body = { message_id: await sendTimeId(r), parts: [{ type: 'text', text: 'around admission' }] }
    expect((await post(r, `/kortix/runtime/sessions/${root}/steer`, body)).status).toBe(403)
    const unmarked = await r.bearer(`/kortix/runtime/sessions/${root}/steer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(unmarked.status).toBe(403)
    expect(await unmarked.json()).toMatchObject({ code: 'STEER_SERVICE_ONLY' })

    const idle = await sendTimeId(r)
    const refused = await steer(r, idle, 'nobody reads this')
    expect(refused.status).toBe(409)
    expect(refused.headers.get('X-Kortix-Turn-Verb')).toBe('1')
    expect(await refused.json()).toEqual({ code: 'no_active_turn' })
    expect((await page(r)).messages).toEqual([])

    expect((await post(r, `/kortix/runtime/sessions/${root}/prompt`, { message_id: TURN, parts: [{ type: 'text', text: 'go' }] })).status).toBe(202)
    await waitForRunningTool(r, root)
    // The running turn's own id, a steered id twice, and a prompt under a steered id.
    expect(await steer(r, TURN, 'dup').then((res) => res.json())).toEqual({ deduplicated: true })
    const steered = await sendTimeId(r)
    expect((await steer(r, steered, 'STEER-ONCE')).status).toBe(202)
    const again = await steer(r, steered, 'STEER-ONCE')
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ deduplicated: true })
    const asPrompt = await post(r, `/kortix/runtime/sessions/${root}/prompt`, { message_id: steered, parts: [{ type: 'text', text: 'STEER-ONCE' }] })
    expect(asPrompt.status).toBe(200)
    await waitFor(() => seen.ends.length === 1)
    expect(seen.reads).toEqual([steered])
    // The refused id stored nothing, so it may now be sent as a prompt.
    expect((await post(r, `/kortix/runtime/sessions/${root}/prompt`, { message_id: idle, parts: [{ type: 'text', text: 'now a prompt' }] })).status).toBe(202)
    await waitFor(() => seen.ends.length === 2)
  })
})

describe('pi retract (R7.1)', () => {
  const post = (r: Rig, path: string, body: unknown) =>
    r.user(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const root = (r: Rig) => r.service.runtime()!.rootId
  const send = (r: Rig, messageId: string, text: string, extra: Record<string, unknown> = {}) =>
    post(r, `/kortix/runtime/sessions/${root(r)}/prompt`, { message_id: messageId, parts: [{ type: 'text', text }], ...extra })
  const retract = (r: Rig, messageId: string) => post(r, `/kortix/runtime/messages/${root(r)}/${messageId}/retract`, {})
  const page = async (r: Rig) =>
    (await r.bearer(`/kortix/runtime/messages/${root(r)}`).then((res) => res.json())) as WirePage
  const sendTimeId = async (r: Rig) => {
    const clock = new MessageIdClock()
    for (const message of (await page(r)).messages) clock.observe(String(message.info.id))
    return clock.mint(Date.now())
  }
  const turnRelays = () => {
    const seen = { begins: [] as string[], ends: [] as string[] }
    const hooks: PiRuntimeHooks = {
      onTurnBegin: ({ messageId }) => void seen.begins.push(messageId),
      onTurnEnd: ({ messageId }) => void seen.ends.push(messageId),
    }
    return { seen, hooks }
  }
  const TURN = 'msg_0198e2a4b0c3RETRACTTURN001'

  test('health lists runtime.retract.v1', async () => {
    const r = await boot({ script: [] })
    const health = (await r.bearer('/kortix/health').then((res) => res.json())) as { capabilities: string[] }
    expect(health.capabilities).toContain('runtime.retract.v1')
  })

  test('a prompt queued behind the running turn is retracted: it leaves the wire, never runs, and may be sent again', async () => {
    const { seen, hooks } = turnRelays()
    const r = await boot({ script: [{ tool: 'bash', args: { command: 'sleep 0.6; echo done' } }, { text: 'first done' }, { text: 'resent answer' }], hooks })
    const before = gateway.sent.length
    expect((await send(r, TURN, 'run the tool')).status).toBe(202)
    await waitForRunningTool(r, root(r))
    const queued = await sendTimeId(r)
    expect((await send(r, queued, 'QUEUED-GONE')).status).toBe(202)
    expect((await page(r)).messages.some((m) => m.info.id === queued)).toBe(true)

    const retracted = await retract(r, queued)
    expect(retracted.status).toBe(200)
    expect(retracted.headers.get('X-Kortix-Turn-Verb')).toBe('1')
    expect(await retracted.json()).toEqual({ retracted: true })
    expect((await page(r)).messages.some((m) => m.info.id === queued)).toBe(false)
    expect((await retract(r, queued)).status).toBe(404)

    await waitFor(() => seen.ends.length === 1)
    await Bun.sleep(150)
    // Only the running turn ran, and no model request carried the retracted text.
    expect(seen.begins).toEqual([TURN])
    expect(gateway.sent.slice(before).some((messages) => JSON.stringify(messages).includes('QUEUED-GONE'))).toBe(false)

    // A retracted id is not on record: a release may send it again.
    expect((await send(r, queued, 'QUEUED-AGAIN')).status).toBe(202)
    await waitFor(() => seen.ends.length === 2)
    expect(seen.begins).toEqual([TURN, queued])
  })

  test('the running turn and an answered message are read; an unknown id is 404', async () => {
    const { seen, hooks } = turnRelays()
    const r = await boot({ script: [{ tool: 'bash', args: { command: 'sleep 0.6; echo done' } }, { text: 'done' }], hooks })
    expect((await send(r, TURN, 'run the tool')).status).toBe(202)
    await waitForRunningTool(r, root(r))
    const running = await retract(r, TURN)
    expect(running.status).toBe(409)
    expect(await running.json()).toEqual({ code: 'message_read', error: 'a model call read this message' })
    await waitFor(() => seen.ends.length === 1)
    expect((await retract(r, TURN)).status).toBe(409)
    expect((await retract(r, 'msg_0198e2a4b0c3UNKNOWNMSG0001')).status).toBe(404)
    expect((await page(r)).messages.some((m) => m.info.id === TURN)).toBe(true)
  })

  test('a no_reply message starts no turn; retracted before a turn reads it, no model call ever gets it', async () => {
    const { seen, hooks } = turnRelays()
    const r = await boot({ script: [{ text: 'answered the second' }, { text: 'answered the third' }], hooks })
    const silent = await sendTimeId(r)
    expect((await send(r, silent, 'NOREPLY-GONE', { no_reply: true })).status).toBe(202)
    await waitFor(() => (r.service.runtime()!.idle()))
    expect((await page(r)).messages.some((m) => m.info.id === silent)).toBe(true)
    // `no_reply` on the Kortix route persists the message and runs nothing.
    await Bun.sleep(100)
    expect(seen.begins).toEqual([])

    expect(await retract(r, silent).then((res) => res.json())).toEqual({ retracted: true })
    expect((await page(r)).messages.some((m) => m.info.id === silent)).toBe(false)

    const kept = await sendTimeId(r)
    expect((await send(r, kept, 'NOREPLY-KEPT', { no_reply: true })).status).toBe(202)
    const before = gateway.sent.length
    const next = await sendTimeId(r)
    expect((await send(r, next, 'the second')).status).toBe(202)
    await waitFor(() => seen.ends.length === 1)
    const sent = JSON.stringify(gateway.sent[before])
    expect(sent).toContain('NOREPLY-KEPT')
    expect(sent).not.toContain('NOREPLY-GONE')
    // The turn read the kept one: it can no longer be taken back.
    expect((await retract(r, kept)).status).toBe(409)
  })

  test('the DELETE verb an older API sends retracts a queued prompt too', async () => {
    const { seen, hooks } = turnRelays()
    const r = await boot({ script: [{ tool: 'bash', args: { command: 'sleep 0.6; echo done' } }, { text: 'first done' }], hooks })
    expect((await send(r, TURN, 'run the tool')).status).toBe(202)
    await waitForRunningTool(r, root(r))
    const queued = await sendTimeId(r)
    expect((await send(r, queued, 'QUEUED-DELETED')).status).toBe(202)
    expect((await r.user(`/kortix/runtime/messages/${root(r)}/${queued}`, { method: 'DELETE' })).status).toBe(200)
    const legacy = await sendTimeId(r)
    expect((await send(r, legacy, 'QUEUED-LEGACY')).status).toBe(202)
    expect((await r.user(`/session/${root(r)}/message/${legacy}`, { method: 'DELETE' })).status).toBe(200)
    await waitFor(() => seen.ends.length === 1)
    await Bun.sleep(150)
    expect(seen.begins).toEqual([TURN])
  })
})

describe('pi per-prompt agent (R7.2)', () => {
  const post = (r: Rig, path: string, body: unknown) =>
    r.user(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const root = (r: Rig) => r.service.runtime()!.rootId
  const page = async (r: Rig) =>
    (await r.bearer(`/kortix/runtime/messages/${root(r)}`).then((res) => res.json())) as WirePage
  const sendTimeId = async (r: Rig) => {
    const clock = new MessageIdClock()
    for (const message of (await page(r)).messages) clock.observe(String(message.info.id))
    return clock.mint(Date.now())
  }
  const send = async (r: Rig, text: string, agent?: string) => {
    const messageId = await sendTimeId(r)
    const res = await post(r, `/kortix/runtime/sessions/${root(r)}/prompt`, { message_id: messageId, parts: [{ type: 'text', text }], ...(agent ? { agent } : {}) })
    expect(res.status).toBe(202)
    return messageId
  }
  /** The system text the model was sent on request `index`: every system message, in order. */
  const systemOf = (index: number) =>
    gateway.sent[index]!.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
  const agents = {
    default_agent: 'coder',
    agent: {
      coder: { mode: 'primary', prompt: 'PROMPT-OF-CODER' },
      writer: { mode: 'primary', prompt: 'PROMPT-OF-WRITER', permission: { bash: 'deny' } },
      reviewer: { mode: 'subagent', prompt: 'PROMPT-OF-REVIEWER' },
      retired: { mode: 'primary', disable: true, prompt: 'PROMPT-OF-RETIRED' },
    },
  }

  test('a prompt that picks an agent runs on that agent; one that picks none runs on the session agent', async () => {
    const ends: string[] = []
    const r = await boot({
      script: [{ tool: 'bash', args: { command: 'echo writer-ran-bash' } }, { text: 'writer done' }, { text: 'coder done' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify(agents) },
      hooks: { onTurnEnd: ({ messageId }) => void ends.push(messageId) },
    })
    const first = gateway.sent.length
    const writerTurn = await send(r, 'as the writer, run a command', 'writer')
    await waitFor(() => ends.length === 1)
    // The writer's prompt reached the model, and its `bash: deny` refused the call.
    expect(systemOf(first)).toContain('PROMPT-OF-WRITER')
    let messages = (await page(r)).messages
    const writerMessages = messages.filter((m) => m.info.id === writerTurn || m.info.parentID === writerTurn)
    expect(writerMessages.map((m) => m.info.agent)).toEqual(['writer', 'writer', 'writer'])
    const tool = writerMessages.flatMap((m) => m.parts).find((p) => p.type === 'tool')!
    expect(tool.state.status).toBe('error')
    expect(existsSync(join(r.workspace, 'writer-ran-bash'))).toBe(false)

    const before = gateway.sent.length
    const coderTurn = await send(r, 'and now with no pick')
    await waitFor(() => ends.length === 2)
    const system = systemOf(before)
    expect(system.lastIndexOf('PROMPT-OF-CODER')).toBeGreaterThan(system.lastIndexOf('PROMPT-OF-WRITER'))
    messages = (await page(r)).messages
    expect(messages.filter((m) => m.info.id === coderTurn || m.info.parentID === coderTurn).map((m) => m.info.agent)).toEqual(['coder', 'coder'])
    // The state document still names the session's agent as the default.
    const state = (await r.bearer('/kortix/runtime/state').then((res) => res.json())) as { config: { value: { default_agent: string } } }
    expect(state.config.value.default_agent).toBe('coder')
  })

  // #9410's per-agent tool access follows the turn's agent, not the boot agent.
  test('a picked agent\'s tool list governs its turn; the next unpicked turn has the session agent\'s tools again', async () => {
    const ends: string[] = []
    const r = await boot({
      script: [
        { tool: 'bash', args: { command: 'touch picked-ran.txt' } }, { text: 'reader done' },
        { tool: 'bash', args: { command: 'touch session-ran.txt' } }, { text: 'coder done' },
      ],
      env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ default_agent: 'coder', agent: { coder: { mode: 'primary' }, reader: { mode: 'primary', tools: { '*': false, read: true } } } }) },
      hooks: { onTurnEnd: ({ messageId }) => void ends.push(messageId) },
    })
    const first = gateway.sent.length
    await send(r, 'run a command', 'reader')
    await waitFor(() => ends.length === 1)
    expect(existsSync(join(r.workspace, 'picked-ran.txt'))).toBe(false)
    // The reader's request offers `read` alone.
    expect(gateway.sampling[first]!.tools).toBe(1)
    const second = gateway.sampling.length
    await send(r, 'run a command')
    await waitFor(() => ends.length === 2)
    expect(gateway.sampling[second]!.tools).toBeGreaterThan(1)
    expect(existsSync(join(r.workspace, 'session-ran.txt'))).toBe(true)
  })

  // Strix finding on #9391 (CWE-863): `__proto__` and `constructor` resolve
  // through the prototype chain, and their undefined `permission` compiled to an
  // empty policy that allows every tool.
  test('a pick named after an Object prototype key keeps the session agent and its permission policy', async () => {
    for (const pick of ['__proto__', 'constructor']) {
      const ends: string[] = []
      const marker = `proto-${pick.replace(/_/g, '')}-ran.txt`
      const r = await boot({
        script: [{ tool: 'bash', args: { command: `touch ${marker}` } }, { text: 'done' }],
        env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ default_agent: 'locked', agent: { locked: { mode: 'primary', prompt: 'PROMPT-OF-LOCKED', permission: { bash: 'deny' } } } }) },
        hooks: { onTurnEnd: ({ messageId }) => void ends.push(messageId) },
      })
      const id = await send(r, 'run the command', pick)
      await waitFor(() => ends.length === 1)
      const messages = (await page(r)).messages.filter((m) => m.info.id === id || m.info.parentID === id)
      expect({ pick, agents: messages.map((m) => m.info.agent) }).toEqual({ pick, agents: ['locked', 'locked', 'locked'] })
      const tool = messages.flatMap((m) => m.parts).find((p) => p.type === 'tool')!
      expect({ pick, status: tool.state.status }).toEqual({ pick, status: 'error' })
      expect({ pick, ran: existsSync(join(r.workspace, marker)) }).toEqual({ pick, ran: false })
    }
  })

  test('a subagent, a disabled agent and an unknown name are not run as the session agent', async () => {
    const ends: string[] = []
    const r = await boot({
      script: [{ text: 'one' }, { text: 'two' }, { text: 'three' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify(agents) },
      hooks: { onTurnEnd: ({ messageId }) => void ends.push(messageId) },
    })
    for (const [index, pick] of ['reviewer', 'retired', 'nobody'].entries()) {
      const before = gateway.sent.length
      const id = await send(r, `pick ${pick}`, pick)
      await waitFor(() => ends.length === index + 1)
      const system = systemOf(before)
      expect({ pick, coder: system.includes('PROMPT-OF-CODER'), other: /PROMPT-OF-(REVIEWER|RETIRED)/.test(system) }).toEqual({ pick, coder: true, other: false })
      expect((await page(r)).messages.find((m) => m.info.id === id)!.info.agent).toBe('coder')
    }
  })
})

describe('pi session-log export (P2.5)', () => {
  // A real 1x1 PNG: pi drops an image it cannot decode ("[Image omitted: …]").
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
  const TASK = { tool: 'task', args: { description: 'Write the note', prompt: 'write sub.txt', subagent_type: 'general' } }
  /** The model reads images, so the attachment reaches pi as image content. */
  const imageCatalog = (workspace: string) => {
    writeFileSync(join(workspace, 'image-catalog.json'), JSON.stringify({ models: { [MODEL_ID]: { name: 'Test Model', attachment: true, limit: { context: 64_000, output: 4_096 } } } }))
    compactEverything(workspace)
  }

  test('a real session exports with Kortix ids and v1 part ids, and its hashes survive a restart', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pi-harness-'))
    const r = await boot({
      workspace,
      prepare: imageCatalog,
      env: { KORTIX_LLM_CATALOG_FILE: join(workspace, 'image-catalog.json') },
      script: [
        { text: 'an image' },
        { tool: 'bash', args: { command: 'printf a > a.txt && ls' } }, { text: 'listed' },
        TASK, { tool: 'bash', args: { command: 'printf sub > sub.txt' } }, { text: 'child wrote sub.txt' }, { text: 'parent done' },
        ...SUMMARY,
        { tool: 'bash', args: { command: 'sleep 20' } },
        { text: 'after the stop' },
      ],
    })
    const rt = r.service.runtime()!
    const root = rt.rootId
    const imageId = 'msg_0198e2a4b0f1ABCDEFGHIJKLMN'
    expect((await prompt(r, root, { messageID: imageId, parts: [{ type: 'text', text: 'what is this' }, { type: 'file', mime: 'image/png', url: PNG, filename: 'shot.png' }] })).status).toBe(204)
    await waitFor(() => !rt.busy())
    await promptAndSettle(r, 'list the files')
    await promptAndSettle(r, 'spawn a helper')
    expect((await summarize(r, root)).status).toBe(200)
    await waitFor(() => rt.idle())
    expect((await prompt(r, root, { parts: [{ type: 'text', text: 'wait' }] })).status).toBe(204)
    await waitForRunningTool(r, root)
    expect((await r.user(`/session/${root}/abort`, { method: 'POST' })).status).toBe(200)
    await waitFor(() => !rt.busy())
    await promptAndSettle(r, 'after')

    const { log, hashes } = piSessionLog(rt.sessionLogSnapshot()!)
    expect(() => upcastSessionLog(log)).not.toThrow()
    const [thread, child] = log.threads
    // The seq rule (session-log.ts): strictly increasing per thread.
    for (const t of log.threads) for (let i = 1; i < t.messages.length; i++) expect(t.messages[i]!.seq).toBeGreaterThan(t.messages[i - 1]!.seq)
    const transcript = new Map(rt.transcript.all().map((m) => [m.info.id as string, m]))
    // Every root message carries its Kortix id; every block id is a part of that v1 message.
    // pi's system prompt entry has no Kortix message: a position id.
    for (const m of thread!.messages.filter((x) => x.kind !== 'context')) {
      const row = transcript.get(m.message_id)
      expect(row, m.message_id).toBeDefined()
      const partIds = new Set(row!.parts.map((p) => p.id))
      for (const b of m.blocks) expect(partIds.has(b.id), `${m.message_id} ${b.type} ${b.id}`).toBe(true)
    }
    expect(thread!.messages.map((m) => `${m.role}:${m.kind}`)).toEqual([
      'system:context',
      'user:turn', 'assistant:turn',
      'user:turn', 'assistant:turn', 'assistant:turn',
      'user:turn', 'assistant:turn', 'assistant:turn',
      'user:compaction',
      'user:turn', 'assistant:turn', 'assistant:turn',
      'user:turn', 'assistant:turn',
    ])
    expect((thread!.messages[0]!.blocks[0] as { text: string }).text).toContain('You are a coding agent')
    const image = thread!.messages.find((m) => m.message_id === imageId)!
    expect(image.blocks.map((b) => b.type)).toEqual(['text', 'attachment'])
    expect(image.blocks[1]).toMatchObject({ mime: 'image/png', name: 'shot.png', ref: expect.stringMatching(/^blob:[0-9a-f]{64}$/) })
    const compaction = thread!.messages[9]!
    expect(compaction.blocks[0]).toMatchObject({ type: 'compaction', summary: expect.stringContaining('SUMMARY-ONE'), trigger: 'manual' })
    // The bash call stopped mid-run: pi records its own error result. The reply cut after it is out of context.
    expect(thread!.messages[11]!.blocks[0]).toMatchObject({ type: 'tool_call', name: 'bash', status: 'error', result: { content: [{ type: 'text', text: 'Command aborted' }], is_error: true } })
    expect(thread!.messages[12]).toMatchObject({ role: 'assistant', status: 'aborted', in_context: false, hidden_reason: 'aborted' })
    expect(child).toMatchObject({ parent_thread_id: root, spawned_by: { message_id: thread!.messages[7]!.message_id, call_id: expect.any(String) } })
    expect(child!.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'assistant'])
    for (const m of child!.messages.slice(1)) expect(m.message_id.startsWith('msg_')).toBe(true)

    // A daemon restart restores the id maps and the header: every native hash is the same.
    await r.service.lifecycle.stop()
    rigs.splice(rigs.indexOf(r), 1)
    const restarted = await boot({ workspace, script: [], env: { KORTIX_LLM_CATALOG_FILE: join(workspace, 'image-catalog.json') } })
    const again = piSessionLog(restarted.service.runtime()!.sessionLogSnapshot()!)
    expect(again.hashes).toEqual(hashes)
  })
})

describe('pi prompt images', () => {
  // A real 2x1 PNG, red then blue: apps/api writes it to the inbox and leaves a `<file>` tag (prompt-attachment-materializer.ts).
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGO4IycnZ3MHAAfrAk9bJYxoAAAAAElFTkSuQmCC', 'base64')
  for (const [name, catalog, image] of [['reads images', { attachment: true }, true], ['does not read images', {}, false]] as const) {
    test(`a prompt's inbox image tag reaches a model that ${name} ${image ? 'as image content, tag kept' : 'as the tag alone'}`, async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'pi-harness-'))
      writeFileSync(join(workspace, 'catalog.json'), JSON.stringify({ models: { [MODEL_ID]: { name: 'Test Model', ...catalog, limit: { context: 64_000, output: 4_096 } } } }))
      mkdirSync(join(workspace, 'uploads/.kortix-inbox/cmd_1'), { recursive: true })
      writeFileSync(join(workspace, 'uploads/.kortix-inbox/cmd_1/1-swatch.png'), PNG)
      const r = await boot({ workspace, script: [{ text: 'seen' }], env: { KORTIX_LLM_CATALOG_FILE: join(workspace, 'catalog.json') } })
      const rt = r.service.runtime()!
      const tag = `<file path="${join(workspace, 'uploads/.kortix-inbox/cmd_1/1-swatch.png')}" mime="image/png" filename="swatch.png">\nThis file has been uploaded and is available at the path above.\n</file>`
      const before = gateway.sent.length
      const messageID = 'msg_0198e2a4b0f1ABCDEFGHIJKLMN'
      expect((await prompt(r, rt.rootId, { messageID, parts: [{ type: 'text', text: `what colours? ${tag}` }] })).status).toBe(204)
      await waitFor(() => gateway.sent.length > before && !rt.busy())
      const user = JSON.stringify(gateway.sent[before]!.filter((m) => m.role === 'user').at(-1))
      expect(user).toContain('mime=\\"image/png\\"')
      expect(user.includes(`data:image/png;base64,${PNG.toString('base64')}`)).toBe(image)
      // The session log holds what pi saw: an attachment block beside the text (P2.13 uploads its bytes).
      const message = piSessionLog(rt.sessionLogSnapshot()!).log.threads[0]!.messages.find((m) => m.message_id === messageID)!
      expect(message.blocks.map((b) => b.type)).toEqual(image ? ['text', 'attachment'] : ['text'])
      if (!image) return
      const path = join(workspace, 'uploads/.kortix-inbox/cmd_1/1-swatch.png')
      expect(structuredClone(message.blocks[1])).toMatchObject({ mime: 'image/png', ref: `blob:${createHash('sha256').update(PNG).digest('hex')}`, source_path: path })

      // A fresh box restored from the log: pi has the image again; the transcript shows it through its tag alone, as live.
      const { log } = piSessionLog(rt.sessionLogSnapshot()!)
      const fresh = mkdtempSync(join(tmpdir(), 'pi-harness-'))
      writeFileSync(join(fresh, 'catalog.json'), JSON.stringify({ models: { [MODEL_ID]: { name: 'Test Model', ...catalog, limit: { context: 64_000, output: 4_096 } } } }))
      await restorePiSessionLog(log, { stateDir: join(fresh, '.state'), sessionId: log.session_id, cwd: fresh, readAttachment: async () => PNG })
      const restored = await boot({ workspace: fresh, script: [{ text: 'still seen' }], env: { KORTIX_LLM_CATALOG_FILE: join(fresh, 'catalog.json') } })
      const wire = (await restored.bearer(`/kortix/runtime/messages/${restored.service.runtime()!.rootId}`).then((res) => res.json())) as WirePage
      const shown = wire.messages.find((m) => m.info.id === messageID)!
      expect(shown.parts.map((p) => p.type)).toEqual(['text'])
      const after = gateway.sent.length
      await promptAndSettle(restored, 'what colours were they?')
      expect(JSON.stringify(gateway.sent[after]!)).toContain(`data:image/png;base64,${PNG.toString('base64')}`)
      const again = piSessionLog(restored.service.runtime()!.sessionLogSnapshot()!).log.threads[0]!.messages.find((m) => m.message_id === messageID)!
      expect(again.blocks).toEqual(message.blocks)
    })
  }
})

/**
 * The `log.*` frames of a v2 stream capture, after checking the whole stream: dense seqs, valid
 * `log.*` payloads, the run's `session.status` frames, and no `message.*` frame (P4.3b).
 */
function v2Frames(raw: string) {
  const all = raw.split('\n\n').filter((f) => /^id: /m.test(f)).map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)) as { seq: number; type: string; payload: any })
  expect(all.map((f) => f.seq)).toEqual(all.map((_, i) => i + 1))
  expect(all.filter((f) => f.type.startsWith('message.'))).toEqual([])
  expect(all.filter((f) => f.type === 'session.status').map((f) => f.payload.status.type)).toContain('busy')
  const frames = all.filter((f) => f.type.startsWith('log.')) as Array<{ seq: number; type: keyof typeof SESSION_LOG_EVENTS; payload: any }>
  for (const f of frames) expect(SESSION_LOG_EVENTS[f.type].safeParse(f.payload).success, f.type).toBe(true)
  return frames
}

describe('pi session log on the v2 stream (P4.3)', () => {
  const KEYS = ['KORTIX_PROJECT_ID', 'KORTIX_SESSION_ID', 'KORTIX_TOKEN', 'KORTIX_API_URL', 'KORTIX_SESSION_LOG_DUMP_DIR'] as const
  let saved: Record<string, string | undefined> = {}
  let dump: string
  beforeEach(() => {
    resetSessionLogJournalForTests()
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
    dump = mkdtempSync(join(tmpdir(), 'pi-log-dump-'))
    Object.assign(process.env, { KORTIX_PROJECT_ID: 'proj-pi-test', KORTIX_SESSION_ID: 'sess-pi-test', KORTIX_TOKEN: TOKEN, KORTIX_API_URL: 'http://127.0.0.1:9', KORTIX_SESSION_LOG_DUMP_DIR: dump })
  })
  afterEach(() => {
    resetSessionLogJournalForTests()
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(dump, { recursive: true, force: true })
  })

  test('two turns: state and thread first, text deltas under the block ids the records store, then the turn as log.message', async () => {
    const r = await boot({ script: [{ text: 'First answer here.' }, { text: 'Second answer here.' }] })
    const rt = r.service.runtime()!
    const root = rt.rootId
    expect(startSessionLogJournal(createPiSessionLogPort(() => r.service.runtime()?.sessionLogSnapshot() ?? null), { generation: 0 })).not.toBeNull()
    const stream = await r.bearer('/kortix/runtime/events?schema=v2&since=0')
    for (const text of ['first question', 'second question']) {
      expect((await prompt(r, root, { parts: [{ type: 'text', text }] })).status).toBe(204)
      await waitFor(() => rt.idle())
      expect(await flushSessionLogJournal()).toBe(true)
    }
    const raw = await readSse(stream, (t) => t.includes('Second answer here.') && t.split('event: log.message').length > 4)
    const frames = v2Frames(raw)
    // The journal start: the session and its root thread, before any turn streams.
    expect(frames.slice(0, 2).map((f) => f.type)).toEqual(['log.state', 'log.thread'])
    expect(frames[1]!.payload.thread_id).toBe(root)

    // The last put of each message: the turn end's record (P4.3b live puts precede it).
    const messages = [...new Map(frames.filter((f) => f.type === 'log.message').map((f) => [f.payload.message.message_id, f.payload.message as SessionLogMessage])).values()]
    const answers = messages.filter((m) => m.role === 'assistant' && m.kind === 'turn')
    expect(answers).toHaveLength(2)
    for (const [i, answer] of answers.entries()) {
      const block = answer.blocks.find((b) => b.type === 'text') as { id: string; text: string }
      const deltas = frames.filter((f) => f.type === 'log.block.delta' && f.payload.block_id === block.id)
      // The fake model streams each answer in two chunks; each lands under the record's own ids.
      expect(deltas.length).toBe(2)
      for (const d of deltas) expect(d.payload).toMatchObject({ thread_id: root, message_id: answer.message_id })
      expect(deltas.map((d) => d.payload.delta).join('')).toBe(block.text)
      expect(block.text).toBe(['First answer here.', 'Second answer here.'][i]!)
      // Deltas stream before the turn end's record.
      const recordSeq = frames.findLast((f) => f.type === 'log.message' && f.payload.message?.message_id === answer.message_id)!.seq
      expect(Math.max(...deltas.map((d) => d.seq))).toBeLessThan(recordSeq)
    }
    // Every record in a batch the journal wrote is on the stream, at the same rev; the stream's other puts are live puts (P4.3b) at lower revs.
    const batches = readdirSync(dump).map((f) => JSON.parse(readFileSync(join(dump, f), 'utf8')) as { puts: Array<{ rev: number; message: SessionLogMessage }> })
    const onStream = new Map(frames.filter((x) => x.type === 'log.message').map((f) => [`${f.payload.message.message_id}@${f.payload.rev}`, f.payload.message]))
    for (const p of batches.flatMap((b) => b.puts)) expect(onStream.get(`${p.message.message_id}@${p.rev}`)).toEqual(p.message)
  })

  test('a live turn (P4.3b): the user put, a streaming put before the first delta, a put for each new block, then the final put at a higher rev', async () => {
    const r = await boot({ script: [{ tool: 'bash', args: { command: 'echo live-turn' } }, { text: 'Ran it for you.' }] })
    const rt = r.service.runtime()!
    const root = rt.rootId
    expect(startSessionLogJournal(createPiSessionLogPort(() => r.service.runtime()?.sessionLogSnapshot() ?? null), { generation: 0 })).not.toBeNull()
    const stream = await r.bearer('/kortix/runtime/events?schema=v2&since=0')
    expect((await prompt(r, root, { parts: [{ type: 'text', text: 'run the command' }] })).status).toBe(204)
    await waitFor(() => rt.idle())
    expect(await flushSessionLogJournal()).toBe(true)
    const raw = await readSse(stream, (t) => t.includes('Ran it for you.'))
    const frames = v2Frames(raw)

    const batches = readdirSync(dump).map((f) => JSON.parse(readFileSync(join(dump, f), 'utf8')) as { puts: Array<{ rev: number; message: SessionLogMessage }> })
    const finals = new Map(batches.flatMap((b) => b.puts).map((p) => [p.message.message_id, p]))
    const puts = frames.filter((f) => f.type === 'log.message' && f.payload.message)
    const putsOf = (id: string) => puts.filter((f) => f.payload.message.message_id === id)
    const user = [...finals.values()].find((p) => p.message.role === 'user' && p.message.kind === 'turn')!.message
    const answers = [...finals.values()].filter((p) => p.message.role === 'assistant').map((p) => p.message)
    expect(answers).toHaveLength(2)

    // The user put: complete, at the seq the API receives, before the first assistant put.
    const userLive = putsOf(user.message_id)[0]!
    expect(userLive.payload.rev).toBeLessThan(finals.get(user.message_id)!.rev)
    expect(userLive.payload.message).toMatchObject({ status: 'complete', seq: user.seq, thread_id: root })
    expect(userLive.seq).toBeLessThan(putsOf(answers[0]!.message_id)[0]!.seq)

    for (const answer of answers) {
      const own = putsOf(answer.message_id)
      const final = own.at(-1)!
      // The API receives one record per message: the turn end's, the last put on the stream.
      expect(final.payload).toEqual(finals.get(answer.message_id))
      expect(final.payload.message.status).toBe('complete')
      const live = own.slice(0, -1)
      expect(live.length).toBeGreaterThan(0)
      expect(live[0]!.payload.message).toMatchObject({ status: 'streaming', role: 'assistant', reply_to: user.message_id, completed_at: null })
      // Seq stability: every streaming put carries the seq, thread and created_at of the turn end's record.
      for (const f of live) {
        expect(f.payload.message).toMatchObject({ message_id: answer.message_id, seq: answer.seq, thread_id: root, created_at: answer.created_at })
        expect(f.payload.rev).toBeLessThan(final.payload.rev)
      }
      // Each block is on the stream before its first delta.
      for (const d of frames.filter((f) => f.type === 'log.block.delta' && f.payload.message_id === answer.message_id)) {
        const holder = live.find((f) => f.payload.message.blocks.some((b: { id: string }) => b.id === d.payload.block_id))
        expect(holder, d.payload.block_id).toBeDefined()
        expect(holder!.seq).toBeLessThan(d.seq)
      }
    }
    // The tool call: a streaming put carries its block while it runs.
    const call = answers[0]!.blocks.find((b) => b.type === 'tool_call')!
    expect(putsOf(answers[0]!.message_id).some((f) => f.payload.message.status === 'streaming' && f.payload.message.blocks.some((b: { id: string }) => b.id === call.id))).toBe(true)
    // The answer's text block: on the stream before any of its text.
    const text = answers[1]!.blocks.find((b) => b.type === 'text')!
    expect(frames.some((f) => f.type === 'log.block.delta' && f.payload.block_id === text.id)).toBe(true)
    // No streaming record reaches the API.
    for (const p of batches.flatMap((b) => b.puts)) expect(p.message.status).not.toBe('streaming')
  })
})

describe('pi codemode', () => {
  const script = (code: string) => ({ tool: 'codemode', args: { code } })
  type Part = Record<string, any>
  /** Run one prompt, then the root's tool parts. */
  const run = async (r: Rig, text = 'go'): Promise<Part[]> => {
    await promptAndSettle(r, text)
    const page = (await r.bearer(`/kortix/runtime/messages/${r.service.runtime()!.rootId}`).then((res) => res.json())) as { messages: Array<{ parts: Part[] }> }
    return page.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool')
  }

  test('on by default: one script runs two tools, and the model sees only its output', async () => {
    const r = await boot({
      script: [
        // Kortix's bash declares no output schema: a script gets its text.
        script("const a = await tools.bash({ command: 'echo one' }); const b = await tools.bash({ command: 'echo two' }); return a.trim() + '+' + b.trim()"),
        { text: 'done' },
      ],
    })
    const first = gateway.sampling.length
    const parts = await run(r)
    // The other tools stay declared beside codemode.
    expect(gateway.sampling[first]!.toolNames).toEqual(expect.arrayContaining(['bash', 'read', 'codemode']))
    expect(String(gateway.sent[first]!.find((m) => m.role === 'system')?.content)).toContain('Use codemode to batch independent tool calls')
    // One part, for the script: its nested calls are metadata, never parts of their own.
    expect(parts.map((p) => p.tool)).toEqual(['codemode'])
    expect(parts[0]!.state).toMatchObject({ status: 'completed', output: expect.stringContaining('one+two') })
    expect(parts[0]!.state.metadata.calls.map((c: Part) => [c.name, c.status])).toEqual([['bash', 'ok'], ['bash', 'ok']])
    // The model's next request carries one tool result: the script's output.
    const results = gateway.sent[first + 1]!.filter((m) => m.role === 'tool')
    expect(results).toHaveLength(1)
    expect(String(results[0]!.content)).toContain('one+two')
  })

  test('off removes codemode; only declares codemode alone and still runs every tool through it', async () => {
    const off = await boot({ script: [{ text: 'hi' }], env: { KORTIX_PI_CODEMODE: 'off' } })
    let first = gateway.sampling.length
    await run(off)
    expect(gateway.sampling[first]!.toolNames).toContain('bash')
    expect(gateway.sampling[first]!.toolNames).not.toContain('codemode')

    const only = await boot({ script: [script("return await tools.bash({ command: 'echo only' })"), { text: 'done' }], env: { KORTIX_PI_CODEMODE: 'only' } })
    first = gateway.sampling.length
    const parts = await run(only)
    expect(gateway.sampling[first]!.toolNames).toEqual(['codemode'])
    expect(String(gateway.sent[first]!.find((m) => m.role === 'system')?.content)).toContain('Every tool runs from a codemode script')
    expect(parts[0]!.state).toMatchObject({ status: 'completed', output: expect.stringContaining('only') })
  })

  test('the project policy denies a script\'s call like a direct one', async () => {
    const r = await boot({
      script: [script("return await tools.bash({ command: 'rm -rf ./keep' })"), { text: 'blocked' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { build: { permission: { bash: { 'rm -rf *': 'deny', '*': 'allow' } } } } }) },
    })
    mkdirSync(join(r.workspace, 'keep'))
    writeFileSync(join(r.workspace, 'keep', 'sentinel'), 'still here')
    const [part] = await run(r)
    expect(existsSync(join(r.workspace, 'keep', 'sentinel'))).toBe(true)
    expect(r.service.runtime()!.permissions.list()).toHaveLength(0)
    // The call rejects inside the script, so the script fails with the policy's reason.
    expect(part!.state.status).toBe('error')
    expect(part!.state.error).toContain('Script failed')
    expect(part!.state.error).toContain('The project policy denies this bash call.')
  })

  test('an ask from a script pauses it on the codemode part until the product replies', async () => {
    const r = await boot({
      script: [script("return await tools.bash({ command: 'echo gated' })"), { text: 'done' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { build: { permission: { bash: 'ask' } } } }) },
    })
    const rt = r.service.runtime()!
    expect((await prompt(r, rt.rootId, { parts: [{ type: 'text', text: 'go' }] })).status).toBe(204)
    await waitFor(() => rt.permissions.list().length === 1)
    const [pending] = (await r.user('/permission').then((res) => res.json())) as Array<Record<string, any>>
    expect(pending).toMatchObject({ permission: 'bash', patterns: ['echo gated'] })
    const page = (await r.bearer(`/kortix/runtime/messages/${rt.rootId}`).then((res) => res.json())) as { messages: Array<{ parts: Part[] }> }
    const codemode = page.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool' && p.tool === 'codemode')!
    expect(pending!.tool).toEqual({ messageID: codemode.messageID, callID: codemode.callID })
    expect((await r.user(`/permission/${pending!.id}/reply`, { method: 'POST', body: JSON.stringify({ reply: 'once' }) })).status).toBe(200)
    await waitFor(() => !rt.busy())
    const after = (await r.bearer(`/kortix/runtime/messages/${rt.rootId}`).then((res) => res.json())) as { messages: Array<{ parts: Part[] }> }
    expect(after.messages.flatMap((m) => m.parts).find((p) => p.tool === 'codemode')!.state).toMatchObject({ status: 'completed', output: expect.stringContaining('gated') })
  })

  test('a script cannot spawn a subagent or ask a question', async () => {
    const r = await boot({
      script: [
        script("const out = await Promise.allSettled([tools.task({ description: 'x', prompt: 'x', subagent_type: 'general' }), tools.question({ questions: [{ question: 'Which way?', header: 'Pick', options: [{ label: 'A', description: 'a' }] }] })]); return out.map((o) => o.status + ':' + (o.reason?.message ?? ''))"),
        { text: 'done' },
      ],
    })
    const [part] = await run(r)
    expect(part!.state.output).toContain('rejected:Call task directly, not from a script.')
    expect(part!.state.output).toContain('rejected:Call question directly, not from a script.')
    expect(r.service.runtime()!.questions.list()).toHaveLength(0)
  })

  test('the session log keeps one code call with its nested calls, and a restore brings back the store', async () => {
    const r = await boot({
      script: [
        script("store('cursor', 7); await tools.bash({ command: 'echo logged' }); return 'stored'"),
        { text: 'done' },
      ],
    })
    await run(r)
    const { log } = piSessionLog(r.service.runtime()!.sessionLogSnapshot()!)
    expect(() => upcastSessionLog(log)).not.toThrow()
    const block = log.threads[0]!.messages.flatMap((m) => m.blocks).find((b) => b.type === 'tool_call' && b.name === 'codemode')!
    // A copy: Bun's toMatchObject writes its asymmetric matchers into the object it reads.
    expect(structuredClone(block)).toMatchObject({ kind: 'code', status: 'complete', input: { code: expect.stringContaining("store('cursor', 7)") } })
    expect((block as { result: { details: unknown } }).result.details).toEqual({
      calls: [{ call_id: expect.any(String), name: 'bash', kind: 'shell', status: 'complete', input: { command: 'echo logged' }, duration_ms: expect.any(Number) }],
      complete: true,
    })
    expect((log.threads[0]!.ext?.pi?.data as { codemode_store?: unknown } | undefined)?.codemode_store).toEqual({ cursor: 7 })

    // A fresh box restored from the log: `load()` reads what the old box stored, and the export is unchanged.
    const workspace = mkdtempSync(join(tmpdir(), 'pi-harness-'))
    await restorePiSessionLog(log, { stateDir: join(workspace, '.state'), sessionId: log.session_id, cwd: workspace })
    const restored = await boot({ workspace, script: [script("return 'loaded:' + load('cursor')"), { text: 'done' }] })
    const again = piSessionLog(restored.service.runtime()!.sessionLogSnapshot()!).log
    const before = log.threads[0]!.messages.flatMap((m) => m.blocks).filter((b) => b.type === 'tool_call')
    expect(again.threads[0]!.messages.flatMap((m) => m.blocks).filter((b) => b.type === 'tool_call')).toEqual(before)
    const parts = await run(restored)
    expect(parts.at(-1)!.state.output).toContain('loaded:7')
  })
})

// kortix.yaml v3: the compiled set (`schema: 3`) is the only config input. Every
// behavior is per agent: skills, subagents, commands and codemode.
describe('kortix.yaml v3 on pi', () => {
  const marker = (text: string) => `export default (pi) => pi.on('before_agent_start', (event) => ({ systemPrompt: event.systemPrompt + '\\n${text}' }))\n`
  const skill = (workspace: string, path: string, name: string) => {
    mkdirSync(join(workspace, path), { recursive: true })
    writeFileSync(join(workspace, path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\nBody.\n`)
  }
  /** Every harness folder and discovery path a v2 project could use, each with a skill, an extension, a prompt and a setting. */
  const harnessFolders = (workspace: string) => {
    for (const dir of ['harnesses/pi', '.kortix/pi']) {
      mkdirSync(join(workspace, dir, 'extensions'), { recursive: true })
      mkdirSync(join(workspace, dir, 'prompts'), { recursive: true })
      writeFileSync(join(workspace, dir, 'extensions', 'native.ts'), marker(`FOLDER-${dir}`))
      writeFileSync(join(workspace, dir, 'prompts', 'folder-prompt.md'), '---\ndescription: from a folder\n---\nDo it.\n')
      writeFileSync(join(workspace, dir, 'settings.json'), JSON.stringify({ packages: ['./extensions/native.ts'] }))
      skill(workspace, `${dir}/skills/folder-${dir.replaceAll(/[/.]/g, '')}`, `folder-${dir.replaceAll(/[/.]/g, '')}`)
    }
    repoExtension(workspace, 'discovered', marker('DISCOVERED'))
    skill(workspace, '.agents/skills/agents-dir', 'agents-dir')
    skill(workspace, '.pi/skills/pi-dir', 'pi-dir')
    skill(workspace, 'skills/unregistered', 'unregistered')
    skill(workspace, 'skills/deploy', 'deploy')
    skill(workspace, 'team/review', 'review')
  }
  const v3 = (set: Record<string, unknown>) => JSON.stringify({ schema: 3, ...set })
  const skillNames = async (r: Rig) => ((await r.user('/skill').then((res) => res.json())) as Array<{ name: string }>).map((s) => s.name).sort()

  test('v3 reads no harness folder and no discovery path: only the registered skill folders and the managed skills load', async () => {
    const r = await boot({
      script: [{ text: 'ok' }],
      prepare: harnessFolders,
      env: {
        KORTIX_COMPILED_AGENT_CONFIG: v3({
          default_agent: 'build',
          agent: { build: { mode: 'primary', prompt: 'You build.', permission: 'allow' } },
          skills: { deploy: 'skills/deploy', review: 'team/review' },
        }),
      },
    })
    expect(await skillNames(r)).toEqual(['deploy', 'review'])
    // `subagents` is the runtime's own task tool, not a project extension.
    expect(r.service.runtime()!.extensionStatus()).toEqual({ loaded: ['subagents'], failed: [] })
    // No prompt template from a harness folder: the registered skills are the only rows.
    const rows = (await r.user('/command').then((res) => res.json())) as Array<{ name: string; source: string }>
    expect(rows.map((c) => [c.source, c.name])).toEqual([['skill', 'deploy'], ['skill', 'review']])
    const before = gateway.sent.length
    await promptAndSettle(r, 'hello')
    const system = systemSent(gateway.sent[before]!)
    for (const text of ['FOLDER-harnesses/pi', 'FOLDER-.kortix/pi', 'DISCOVERED', 'unregistered', 'agents-dir', 'pi-dir']) expect(system).not.toContain(text)
    expect(system).toContain('deploy')
  })

  test('a disabled compiled agent is not listed: the built-ins v3 disables never reach a picker', async () => {
    const r = await boot({
      script: [],
      env: {
        KORTIX_COMPILED_AGENT_CONFIG: v3({
          default_agent: 'lead',
          agent: { lead: { mode: 'primary', prompt: 'Lead.' }, off: { mode: 'subagent', prompt: 'Off.', disable: true }, build: { disable: true }, general: { disable: true } },
        }),
      },
    })
    const agents = (r.service.runtime()!.stateDoc().agents as { value: Array<{ name: string }> }).value.map((agent) => agent.name)
    expect(agents).toEqual(['lead'])
  })

  test('v2 with the same tree keeps reading the harness folder and the skills/ dir', async () => {
    const r = await boot({ script: [], prepare: harnessFolders })
    const names = await skillNames(r)
    expect(names).toContain('folder-harnessespi')
    expect(names).toContain('unregistered')
    expect(names).not.toContain('review')
    const rows = (await r.user('/command').then((res) => res.json())) as Array<{ name: string; source: string }>
    expect(rows.filter((c) => c.source === 'command').map((c) => c.name)).toEqual(['folder-prompt'])
    expect(rows.filter((c) => c.source === 'skill').map((c) => c.name).sort()).toEqual([...names].sort())
  })

  test('the per-agent skill grant still filters the registered skills', async () => {
    const r = await boot({
      script: [],
      prepare: harnessFolders,
      env: {
        KORTIX_COMPILED_AGENT_CONFIG: v3({
          agent: { build: { mode: 'primary', permission: { skill: { review: 'allow', '*': 'deny' } } } },
          skills: { deploy: 'skills/deploy', review: 'team/review' },
        }),
      },
    })
    expect(await skillNames(r)).toEqual(['review'])
  })

  const TASK = (subagent_type: string) => ({ tool: 'task', args: { description: 'Delegate', prompt: 'do it', subagent_type } })
  const SUBAGENTS = v3({
    default_agent: 'build',
    agent: {
      build: { mode: 'primary', prompt: 'You build.', permission: { '*': 'allow', task: { reviewer: 'allow', '*': 'deny' } } },
      reviewer: { mode: 'subagent', description: 'Reviews one change', prompt: 'You review.', permission: { '*': 'allow', task: 'deny' } },
      auditor: { mode: 'subagent', description: 'Audits the books', prompt: 'You audit.', permission: { '*': 'allow', task: 'deny' } },
    },
  })

  test('an agent with subagents: [reviewer] offers and starts only reviewer; no built-in general or explore exists', async () => {
    const r = await boot({
      script: [TASK('auditor'), TASK('general'), TASK('reviewer'), { text: 'reviewed' }, { text: 'parent done' }],
      env: { KORTIX_COMPILED_AGENT_CONFIG: SUBAGENTS },
    })
    const described = ((await r.user('/tool').then((res) => res.json())) as Array<{ id: string; description: string }>).find((t) => t.id === 'task')!.description
    expect(described).toContain('- reviewer: Reviews one change')
    for (const name of ['auditor', 'general', 'explore']) expect(described).not.toContain(`- ${name}:`)

    await promptAndSettle(r, 'delegate')
    const root = r.service.runtime()!.rootId
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    const [auditor, general, reviewer] = toolParts(page, 'task')
    expect(auditor!.state.status).toBe('error')
    expect(String(auditor!.state.error)).toContain('denies')
    // `general` is not declared, and the allowlist denies every name but reviewer.
    expect(general!.state.status).toBe('error')
    expect(String(general!.state.error)).toContain('denies')
    expect(reviewer!.state.status).toBe('completed')
    expect(((await r.user(`/session/${root}/children`).then((res) => res.json())) as unknown[]).length).toBe(1)
  })

  test('with every subagent granted, general is still unknown in v3', async () => {
    const set = v3({ agent: { build: { mode: 'primary', permission: 'allow' }, reviewer: { mode: 'subagent', description: 'Reviews', permission: 'allow' } } })
    const r = await boot({ script: [TASK('general'), { text: 'done' }], env: { KORTIX_COMPILED_AGENT_CONFIG: set } })
    await promptAndSettle(r, 'delegate')
    const page = (await r.bearer(`/kortix/runtime/messages/${r.service.runtime()!.rootId}`).then((res) => res.json())) as WirePage
    expect(toolParts(page, 'task')[0]!.state.error).toBe('Unknown subagent_type "general". Available: reviewer.')
  })

  test('v2 keeps the built-in general and explore subagents', async () => {
    const r = await boot({ script: [], env: { KORTIX_COMPILED_AGENT_CONFIG: JSON.stringify({ agent: { build: { mode: 'primary' } } }) } })
    const described = ((await r.user('/tool').then((res) => res.json())) as Array<{ id: string; description: string }>).find((t) => t.id === 'task')!.description
    expect(described).toContain('- general:')
    expect(described).toContain('- explore:')
  })

  const COMMANDS = v3({
    default_agent: 'build',
    agent: { build: { mode: 'primary', prompt: 'You build.', permission: 'allow' }, reviewer: { mode: 'all', prompt: 'You review.', permission: 'allow' } },
    commands: {
      audit: { description: 'Audit a module', template: 'Audit $1 for $ARGUMENTS.', agents: ['reviewer'] },
      ship: { template: 'Ship it.', agents: ['build', 'reviewer'] },
    },
  })
  const command = (r: Rig, root: string, body: Record<string, unknown>) =>
    r.user(`/session/${root}/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('GET /command lists every compiled command with its agents; no folder prompt is a command', async () => {
    const r = await boot({ script: [], prepare: harnessFolders, env: { KORTIX_COMPILED_AGENT_CONFIG: COMMANDS } })
    expect(await r.user('/command').then((res) => res.json())).toEqual([
      { name: 'audit', description: 'Audit a module', source: 'command', template: 'Audit $1 for $ARGUMENTS.', hints: ['$1', '$ARGUMENTS'], agents: ['reviewer'] },
      { name: 'ship', description: '', source: 'command', template: 'Ship it.', hints: [], agents: ['build', 'reviewer'] },
    ])
  })

  test('a command on an agent that does not enable it is refused with 403; on one that does, its expanded template runs', async () => {
    const r = await boot({ script: [{ text: 'Audited.' }], env: { KORTIX_COMPILED_AGENT_CONFIG: COMMANDS } })
    const root = r.service.runtime()!.rootId
    const calls = gateway.requests.length
    const refused = await command(r, root, { command: 'audit', arguments: 'billing' })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'command_not_enabled', command: 'audit', agent: 'build' })
    const named = await command(r, root, { command: 'audit', arguments: 'billing', agent: 'build' })
    expect(named.status).toBe(403)
    expect(await named.json()).toEqual({ error: 'command_not_enabled', command: 'audit', agent: 'build' })
    expect(gateway.requests.length).toBe(calls)

    const messageID = 'msg_0198e2a4b0e3ABCDEFGHIJKLAB'
    expect((await command(r, root, { command: 'audit', arguments: 'billing "the ledger"', agent: 'reviewer', messageID })).status).toBe(200)
    const sent = JSON.stringify(gateway.sent.at(-1))
    // `$1` is the last placeholder: it takes every word, unquoted. `$ARGUMENTS` is the raw text.
    expect(sent).toContain('Audit billing the ledger for billing \\"the ledger\\".')
    expect(sent).toContain('You review.')
    const page = (await r.bearer(`/kortix/runtime/messages/${root}`).then((res) => res.json())) as WirePage
    expect(page.messages.find((m) => m.info.id === messageID)!.parts.map((p) => p.text)).toEqual(['Audit billing the ledger for billing "the ledger".'])
  })

  test('codemode follows the session agent when KORTIX_PI_CODEMODE is absent; the env still wins', async () => {
    const set = v3({ default_agent: 'build', agent: { build: { mode: 'primary', permission: 'allow', codemode: 'off' } } })
    const off = await boot({ script: [], env: { KORTIX_COMPILED_AGENT_CONFIG: set } })
    expect((await off.user('/tool/ids').then((res) => res.json())) as string[]).not.toContain('codemode')
    const env = await boot({ script: [], env: { KORTIX_COMPILED_AGENT_CONFIG: set, KORTIX_PI_CODEMODE: 'on' } })
    expect((await env.user('/tool/ids').then((res) => res.json())) as string[]).toContain('codemode')
  })
})

describe('command template expansion', () => {
  test.each([
    ['$ARGUMENTS takes all of them', 'Fix $ARGUMENTS now', 'a b  c', 'Fix a b  c now'],
    ['the last placeholder takes the rest', 'From $1 to $2', 'x y z', 'From x to y z'],
    ['a quoted argument is one word without its quotes', 'A=$1 B=$2', '"one two" three', 'A=one two B=three'],
    ['a missing argument is empty', 'A=$1 B=$2', 'only', 'A=only B='],
    ['a template with no placeholder gets the arguments appended', 'Ship it.', 'now please', 'Ship it.\n\nnow please'],
    ['no arguments leave a plain template alone', 'Ship it.', '', 'Ship it.'],
  ])('%s', (_name, template, args, expected) => {
    expect(expandCommandTemplate(template, args)).toBe(expected)
  })
})

describe('pi Changes surface (/project/current vcs, /vcs/diff)', () => {
  const sh = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }

  test('a non-git workspace reports no vcs and an empty diff', async () => {
    const r = await boot({ script: [] })
    const project = (await r.user('/project/current').then((res) => res.json())) as Record<string, unknown>
    expect(project.worktree).toBe(r.workspace)
    expect(project).not.toHaveProperty('vcs')
    expect(await r.user('/vcs/diff?mode=branch').then((res) => res.json())).toEqual([])
  })

  test('a git workspace reports vcs git and lists committed, modified, deleted and new files against the base', async () => {
    const r = await boot({
      script: [],
      env: { KORTIX_DEFAULT_BRANCH: 'main' },
      prepare: (ws) => {
        writeFileSync(join(ws, '.gitignore'), '.state/\n.pi-agent/\n.pi-packages/\n')
        writeFileSync(join(ws, 'kept.txt'), 'one\ntwo\n')
        writeFileSync(join(ws, 'gone.txt'), 'bye\n')
        sh(ws, 'init', '-q', '-b', 'main')
        sh(ws, 'add', '.')
        sh(ws, 'commit', '-q', '-m', 'base')
        sh(ws, 'checkout', '-q', '-b', 'kortix/session')
        writeFileSync(join(ws, 'committed.txt'), 'a\n')
        sh(ws, 'add', 'committed.txt')
        sh(ws, 'commit', '-q', '-m', 'session work')
        writeFileSync(join(ws, 'kept.txt'), 'one\nTWO\nthree\n')
        rmSync(join(ws, 'gone.txt'))
        writeFileSync(join(ws, 'new file.txt'), 'x\ny\n')
      },
    })
    const project = (await r.user('/project/current').then((res) => res.json())) as Record<string, unknown>
    expect(project.vcs).toBe('git')

    const branch = (await r.user('/vcs/diff?mode=branch').then((res) => res.json())) as Array<Record<string, any>>
    expect(branch.map(({ file, status, additions, deletions }) => ({ file, status, additions, deletions }))).toEqual([
      { file: 'committed.txt', status: 'added', additions: 1, deletions: 0 },
      { file: 'gone.txt', status: 'deleted', additions: 0, deletions: 1 },
      { file: 'kept.txt', status: 'modified', additions: 2, deletions: 1 },
      { file: 'new file.txt', status: 'added', additions: 2, deletions: 0 },
    ])
    expect(branch.find((f) => f.file === 'kept.txt')!.patch).toContain('diff --git a/kept.txt b/kept.txt')
    expect(branch.find((f) => f.file === 'kept.txt')!.patch).toContain('+TWO')
    expect(branch.find((f) => f.file === 'new file.txt')!.patch).toContain('+++ b/new file.txt')

    // `git` mode is the working tree only: the committed file is not in it.
    const working = (await r.user('/vcs/diff?mode=git').then((res) => res.json())) as Array<{ file: string }>
    expect(working.map((f) => f.file)).toEqual(['gone.txt', 'kept.txt', 'new file.txt'])
  })
})
