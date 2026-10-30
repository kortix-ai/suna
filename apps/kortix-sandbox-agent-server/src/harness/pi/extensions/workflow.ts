/**
 * Workflows: the `workflow` tool for pi.
 *
 * The model passes a JavaScript script that orchestrates subagents
 * deterministically: `agent(prompt, opts?)` starts one child, `parallel(thunks)`
 * and `pipeline(items, ...stages)` fan out, `phase(title)` and `log(text)`
 * report progress, `args` is the call's `args`. The script's return value is
 * the tool output. Input `{ description, script, args? }`.
 *
 * Every `agent()` is one child through the same spawn as the `agent` tool
 * (`KortixHost.spawnSession`, `session: "separate"`): a REAL Kortix child
 * session with its own sandbox, linked to this session (`../cloud-subagent.ts`).
 * A box with no control plane runs it in this session, as the `agent` tool
 * does. A named agent (`opts.agent`) must be one the `agent` tool offers
 * (`subagentTypes`: the `permission.task` rule filters it); without one the
 * child runs as an inline agent, which a separate session runs as this
 * session's own agent.
 *
 * The script runs in a QuickJS sandbox of its own (`ownScriptSandbox`), not
 * in pi's shared codemode pool: a workflow waits on children for minutes to
 * hours. `parallel` and `pipeline` are script code (the prelude below); only
 * `agent`, `phase`, `log` and `args` cross into the host.
 *
 * The tool runs in the foreground of the turn: the turn stays active while the
 * children work, which keeps this box alive (apps/api
 * `sandbox-deadline-policy.ts`), and pi drops a part update sent after the call
 * returned. Live progress is the part metadata: `WorkflowRunMetadata`
 * (`@kortix/api-contract/kortix-tool-card`) through `onUpdate`, at most 4
 * updates per second, and the same document as the final `details`.
 *
 * Limits: at most {@link MAX_WORKFLOW_AGENTS} `agent()` calls per run (the next
 * one rejects in the script), {@link WORKFLOW_DEADLINE_MS} per run, and at most
 * `maxParallel` children at once (the box's separate-session cap; the rest
 * wait). A turn abort, the deadline, or the script ending stops every child
 * still running. A session at the subagent depth cap cannot run a workflow.
 * A codemode script cannot call this tool (runtime.ts `nestedCallGate`).
 */
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { CodemodeResult, CodemodeTool } from '@earendil-works/pi-codemode'
import type { WorkflowAgentStatus, WorkflowRunAgent, WorkflowRunMetadata, WorkflowRunStatus } from '@kortix/api-contract/kortix-tool-card'
import { Type } from 'typebox'
import { ownScriptSandbox } from '../codemode'
import { INLINE_AGENT, SUBAGENT_PROMPT, subagentTypes, type KortixHost, type SpawnSessionInput } from './subagents'

export const WORKFLOW_TOOL = 'workflow'
/** `agent()` calls one run may make. */
export const MAX_WORKFLOW_AGENTS = 16
/** One run's wall-clock limit, children included. */
export const WORKFLOW_DEADLINE_MS = 2 * 60 * 60_000
/** At most 4 live updates per second. */
const UPDATE_INTERVAL_MS = 250
/**
 * While a run is live, its document is sent again at least this often. A page
 * opened mid-run reads the session log, where a running call carries no
 * details, and then sees only new updates: a run whose agents are all busy
 * changes nothing for minutes, so without this the card would stay empty.
 */
const REFRESH_INTERVAL_MS = 10_000
/** The tool output keeps this much of the script's return value. */
const MAX_RESULT_CHARS = 50_000
/** Characters of an answer or error kept as an agent's `summary`. */
const SUMMARY_CHARS = 200
/** `log()` lines the live output shows. */
const LOG_LINES = 20
const LABEL_CHARS = 60

const parameters = Type.Object({
  description: Type.String({ description: 'A short (3-6 words) title of the workflow, shown to the user as the card title.' }),
  script: Type.String({ description: 'The JavaScript body of the workflow (plain JavaScript, top-level await works). Its return value is the tool result.' }),
  args: Type.Optional(Type.Any({ description: 'Any JSON value; the script reads it as `args`. Pass arrays and objects as JSON values, not as a JSON string.' })),
})

type WorkflowParams = { description: string; script: string; args?: unknown }

/** A part update or the final result: the live text and the run document. */
type WorkflowUpdate = { content: Array<{ type: 'text'; text: string }>; details: WorkflowRunMetadata }

function describe(agentNames: string[]): string {
  return [
    'Run a workflow: a JavaScript script that orchestrates several subagents deterministically, with loops, fan-out and stages. Each agent() is its own new Kortix session with its own computer, linked to this session and visible in the sidebar. The user watches the run live.',
    'Use it for work that splits into independent units (review many files, research several questions, compare approaches, then synthesize). For one subagent, use the agent tool.',
    '',
    'Script API (plain JavaScript, not TypeScript; top-level await works):',
    '- agent(prompt, { label?, agent?, phase? }): starts one subagent and resolves to its final answer as a string, or null when it failed or was stopped (the script keeps going). The prompt must be complete: the subagent sees nothing of this conversation. `label` names it in the progress view; `agent` is a named agent type' +
      (agentNames.length > 0 ? ` (${agentNames.join(', ')})` : '') +
      '; without one it runs as the current agent.',
    '- parallel([() => agent(...), ...]): runs the functions concurrently and resolves to their results in order. A function that throws gives null; parallel itself never rejects.',
    '- pipeline(items, stage1, stage2, ...): sends each item through the stages; each item moves to its next stage as soon as its current stage finishes. A stage gets (previousResult, item, index). A stage that throws turns that item into null.',
    '- phase(title): starts a named phase; later agents are grouped under it. log(text): a progress line for the user. args: the call\'s `args` value.',
    '- There is no fetch, file system, timer, Date.now() or Math.random(). Subagents do the work; the script only routes it.',
    '',
    `Limits: at most ${MAX_WORKFLOW_AGENTS} agent() calls per run (the next one throws), at most ${WORKFLOW_DEADLINE_MS / 3_600_000} hours per run. Extra concurrent agents wait for a free slot. Stopping the turn stops every subagent of the run.`,
    '',
    'Example:',
    '```js',
    "phase('Review')",
    'const reviews = await parallel(args.files.map((file) => () =>',
    "  agent(`Review ${file} for bugs. Report each bug as one line: line number, problem.`, { label: `Review ${file}` })))",
    "phase('Summarize')",
    "return agent(`Merge these reviews into one prioritized list:\\n\\n${reviews.filter(Boolean).join('\\n\\n')}`, { label: 'Summarize' })",
    '```',
  ].join('\n')
}

/** The extension, bound to the runtime that hosts it. */
export function workflow(host: KortixHost): InlineExtension {
  return { name: 'kortix-workflow', factory: (pi) => register(pi, host) }
}

function register(pi: ExtensionAPI, host: KortixHost): void {
  // Registered on session_start (and again on reload): the description lists the named agents.
  pi.on('session_start', () => {
    pi.registerTool({
      name: WORKFLOW_TOOL,
      label: WORKFLOW_TOOL,
      description: describe(host.anyProjectAgent?.() === true ? ['any agent of this project, by name (kortix_agents list)'] : [...subagentTypes(host).keys()]),
      parameters,
      // Alone in its batch: its children take the box's separate-session slots, which a parallel `agent` call would contend for.
      executionMode: 'sequential' as const,
      // A script may not call it (nestedCallGate), so with codemode `only` the model calls it directly, like `agent`.
      ...(host.codemodeOnly?.() ? { exposure: 'model-only' as const } : {}),
      execute: (_toolCallId: string, params: WorkflowParams, signal: AbortSignal | undefined, onUpdate?: (update: WorkflowUpdate) => void) =>
        runWorkflow(host, params, signal, onUpdate),
    })
  })
}

/**
 * The script's view of the run. `parallel` and `pipeline` run in the VM: a
 * function cannot cross into the host. `agent` adds the current phase in the
 * VM, so the phase an agent belongs to never depends on host-call order. The
 * user script runs inside its own async function, so it may declare any of
 * these names again.
 */
const PRELUDE = `const args = await __workflow.args();
let __phase;
const phase = (title) => { __phase = String(title); __workflow.phase(__phase); };
const log = (text) => { __workflow.log(String(text)); };
const agent = (prompt, opts) => __workflow.agent(prompt, { ...(opts || {}), phase: (opts && opts.phase) || __phase });
const __failed = (where, error) => { log(where + ': ' + (error && error.message ? error.message : String(error))); return null; };
const parallel = async (thunks) => {
  if (!Array.isArray(thunks)) throw new TypeError('parallel() takes an array of functions');
  return Promise.all(thunks.map(async (thunk, index) => {
    try { return await (typeof thunk === 'function' ? thunk() : thunk); } catch (error) { return __failed('parallel item ' + index, error); }
  }));
};
const pipeline = async (items, ...stages) => {
  if (!Array.isArray(items)) throw new TypeError('pipeline() takes an array of items first');
  return Promise.all(items.map(async (item, index) => {
    let value = item;
    for (let stage = 0; stage < stages.length; stage++) {
      try { value = await stages[stage](value, item, index); } catch (error) { return __failed('pipeline item ' + index + ' stage ' + (stage + 1), error); }
    }
    return value;
  }));
};
`

/** One `workflow` call: refuse it, or run the script to its end and report. */
async function runWorkflow(host: KortixHost, params: WorkflowParams, signal: AbortSignal | undefined, onUpdate?: (update: WorkflowUpdate) => void) {
  const script = typeof params.script === 'string' ? params.script.trim() : ''
  if (!script) throw new Error('The workflow script is empty.')
  const limits = host.workflowLimits()
  if (limits.refusal) throw new Error(limits.refusal)
  const deadline = AbortSignal.timeout(WORKFLOW_DEADLINE_MS)
  const runSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  const run = new WorkflowRun(host, params.description?.trim() || 'Workflow', Math.max(1, limits.maxParallel), runSignal, onUpdate)
  try {
    run.publish()
    const sandbox = await ownScriptSandbox({ globals: run.globals(params.args), timeoutMs: WORKFLOW_DEADLINE_MS })
    let result: CodemodeResult
    try {
      result = await sandbox.execute(`${PRELUDE}return await (async () => {\n${script}\n})();`, { signal: runSignal })
    } finally {
      await sandbox.close()
    }
    // The script ended: wait for the stops of children it left running (each saw the call's signal abort).
    await run.settled()
    // Only the caller's abort (the turn stopped) is `stopped`; the deadline is a failure.
    const status: WorkflowRunStatus = result.ok ? 'done' : result.error.kind === 'aborted' && !deadline.aborted ? 'stopped' : 'failed'
    const error = result.ok ? undefined : deadline.aborted ? `The workflow ran past its ${WORKFLOW_DEADLINE_MS / 3_600_000} h deadline.` : result.error.message
    return run.finish(status, error, result.ok ? result.value : undefined)
  } finally {
    run.dispose()
  }
}

/** Waiting room for at most `size` children at once. */
class Slots {
  private free: number
  private readonly waiting: Array<() => void> = []

  constructor(size: number) {
    this.free = size
  }

  /** Resolves true with a slot, or false when `signal` aborted first. */
  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false)
    if (this.free > 0) {
      this.free -= 1
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const grant = () => {
        signal.removeEventListener('abort', onAbort)
        resolve(true)
      }
      const onAbort = () => {
        this.waiting.splice(this.waiting.indexOf(grant), 1)
        resolve(false)
      }
      this.waiting.push(grant)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  release(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.free += 1
  }
}

/** The run's state: the metadata document, the children, and the throttled updates. */
class WorkflowRun {
  private readonly meta: WorkflowRunMetadata
  private readonly logs: string[] = []
  private readonly running = new Set<Promise<unknown>>()
  private readonly slots: Slots
  private lastUpdate = 0
  private pending: ReturnType<typeof setTimeout> | null = null
  private readonly refresh: ReturnType<typeof setInterval> | null

  constructor(
    private readonly host: KortixHost,
    title: string,
    maxParallel: number,
    private readonly signal: AbortSignal,
    private readonly onUpdate: ((update: WorkflowUpdate) => void) | undefined,
  ) {
    this.meta = { runId: crypto.randomUUID(), title, status: 'running', phases: [], agents: [], startedAt: Date.now() }
    this.slots = new Slots(maxParallel)
    this.refresh = onUpdate ? setInterval(() => this.publish(), REFRESH_INTERVAL_MS) : null
  }

  /** The host side of the script API, as `__workflow.<name>`. */
  globals(args: unknown): CodemodeTool[] {
    return [
      { name: '__workflow.args', execute: () => args ?? null },
      { name: '__workflow.phase', execute: (title) => void this.phase(String(title)) },
      { name: '__workflow.log', execute: (text) => void this.log(String(text)) },
      { name: '__workflow.agent', spread: true, execute: (call, context) => this.agent(call as unknown[], context.signal) },
    ]
  }

  private phase(title: string): void {
    for (const phase of this.meta.phases) if (phase.status === 'running' && phase.title !== title) phase.status = 'done'
    const known = this.meta.phases.find((phase) => phase.title === title)
    if (known) known.status = 'running'
    else this.meta.phases.push({ title, status: 'running' })
    this.publish()
  }

  private log(text: string): void {
    this.logs.push(text.slice(0, 500))
    this.publish()
  }

  /**
   * One `agent(prompt, opts)`: a child through the host's spawn, its answer as
   * a string, or null when it failed or stopped. Rejects only for a call the
   * run refuses (input, an unknown agent, the agent limit), before any child.
   */
  private agent(call: unknown[], scriptSignal: AbortSignal): Promise<string | null> {
    const [prompt, rawOpts] = call
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('agent() needs a prompt string as its first argument.')
    const opts = rawOpts && typeof rawOpts === 'object' ? (rawOpts as Record<string, unknown>) : {}
    const named = typeof opts.agent === 'string' && opts.agent.trim() ? opts.agent.trim() : undefined
    const spec = this.spec(named)
    if (this.meta.agents.length >= MAX_WORKFLOW_AGENTS) {
      const refusal = `agent() refused: one workflow runs at most ${MAX_WORKFLOW_AGENTS} agents, and this run started ${MAX_WORKFLOW_AGENTS}. Give each agent more of the work, or run another workflow for the rest.`
      this.log(refusal)
      throw new Error(refusal)
    }
    const label = (typeof opts.label === 'string' && opts.label.trim() ? opts.label.trim() : prompt.trim().split('\n')[0]!).slice(0, LABEL_CHARS)
    const phase = typeof opts.phase === 'string' && opts.phase ? opts.phase : undefined
    const entry: WorkflowRunAgent = { id: `a${this.meta.agents.length + 1}`, label, ...(named ? { agent: named } : {}), ...(phase ? { phase } : {}), status: 'starting' }
    this.meta.agents.push(entry)
    this.publish()
    const done = this.runChild(entry, { ...spec, title: `${label} (${this.meta.title} workflow)`, prompt }, AbortSignal.any([this.signal, scriptSignal]))
    this.running.add(done)
    void done.finally(() => this.running.delete(done))
    return done
  }

  /** The spawn input of a named agent, else of an inline one. Throws for a name the `agent` tool would refuse. */
  private spec(named: string | undefined): Omit<SpawnSessionInput, 'title' | 'prompt'> {
    if (!named) return { session: 'separate', agent: INLINE_AGENT, systemPrompt: SUBAGENT_PROMPT }
    const types = subagentTypes(this.host)
    const type = types.get(named)
    // My Kortix's box: any project agent, by name; the API authorizes it when it creates the session.
    if (!type && this.host.anyProjectAgent?.() === true) return { session: 'separate', agent: named, systemPrompt: SUBAGENT_PROMPT }
    if (!type) throw new Error(`agent() refused: unknown agent "${named}". Available: ${[...types.keys()].join(', ') || 'none'}. Omit \`agent\` to run as the current agent.`)
    return {
      session: 'separate',
      agent: named,
      systemPrompt: type.prompt,
      ...(type.model ? { model: type.model } : {}),
      ...(type.variant ? { variant: type.variant } : {}),
      ...(type.tools ? { tools: type.tools } : {}),
      ...(type.permission !== undefined ? { permission: type.permission } : {}),
    }
  }

  private async runChild(entry: WorkflowRunAgent, input: SpawnSessionInput, signal: AbortSignal): Promise<string | null> {
    if (!(await this.slots.acquire(signal))) return this.settle(entry, 'stopped')
    try {
      const result = await this.host.spawnSession({
        ...input,
        signal,
        onSession: ({ sessionId }) => {
          entry.sessionId = sessionId
          entry.status = 'running'
          this.publish()
        },
      })
      if (result.sessionId) entry.sessionId = result.sessionId
      if (result.status === 'completed') return this.settle(entry, 'done', result.text, result.text)
      if (result.status === 'aborted') return this.settle(entry, 'stopped')
      return this.settle(entry, 'failed', result.error ?? 'The subagent failed.')
    } catch (err) {
      // A spawn gate refused (depth, the box's live cap, an invalid spec): this agent fails, the script goes on.
      return this.settle(entry, signal.aborted ? 'stopped' : 'failed', err instanceof Error ? err.message : String(err))
    } finally {
      this.slots.release()
    }
  }

  private settle(entry: WorkflowRunAgent, status: WorkflowAgentStatus, summary?: string, answer?: string): string | null {
    entry.status = status
    const line = summary?.trim().split('\n')[0]
    if (line) entry.summary = line.slice(0, SUMMARY_CHARS)
    this.publish()
    return status === 'done' ? (answer ?? '') : null
  }

  /** Every child call has returned (each sends its stop before it does). */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.running])
  }

  /** Push the document now, or at the end of the current 250 ms window. */
  publish(): void {
    if (!this.onUpdate || this.pending) return
    const wait = this.lastUpdate + UPDATE_INTERVAL_MS - Date.now()
    if (wait <= 0) return this.emit()
    this.pending = setTimeout(() => this.emit(), wait)
  }

  private emit(): void {
    this.pending = null
    this.lastUpdate = Date.now()
    this.onUpdate?.({ content: [{ type: 'text', text: this.logs.slice(-LOG_LINES).join('\n') }], details: structuredClone(this.meta) })
  }

  /** The final result: the run document as `details`, the script's value (or error) and the agents' outcomes as text. */
  /** Stop every timer: the refresh and a pending update. Safe to call twice. */
  dispose(): void {
    if (this.refresh) clearInterval(this.refresh)
    if (this.pending) clearTimeout(this.pending)
    this.pending = null
  }

  finish(status: WorkflowRunStatus, error: string | undefined, value: unknown): WorkflowUpdate {
    this.dispose()
    for (const phase of this.meta.phases) if (phase.status === 'running') phase.status = status
    this.meta.status = status
    this.meta.endedAt = Date.now()
    if (error) this.meta.error = error
    const body = status === 'done' ? `<workflow_result>\n${resultText(value)}\n</workflow_result>` : `<workflow_error>\n${error ?? `The workflow ${status}.`}\n</workflow_error>`
    return { content: [{ type: 'text', text: [body, ...agentLines(this.meta.agents)].join('\n') }], details: structuredClone(this.meta) }
  }
}

/** The script's return value as tool output: a string as is, anything else as JSON. */
function resultText(value: unknown): string {
  const text = value === undefined ? '(the script returned nothing)' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (${text.length - MAX_RESULT_CHARS} more characters cut)` : text
}

/** One line per agent that did not finish, after a count line. */
function agentLines(agents: WorkflowRunAgent[]): string[] {
  if (agents.length === 0) return ['agents: 0']
  const counts = new Map<string, number>()
  for (const agent of agents) counts.set(agent.status, (counts.get(agent.status) ?? 0) + 1)
  const header = `agents: ${agents.length} (${[...counts].map(([status, count]) => `${count} ${status}`).join(', ')})`
  const problems = agents
    .filter((agent) => agent.status !== 'done')
    .map((agent) => `- ${agent.id} "${agent.label}" ${agent.status}${agent.summary ? `: ${agent.summary}` : ''}${agent.sessionId ? ` (session ${agent.sessionId})` : ''}`)
  return [header, ...problems]
}
