/**
 * Workflows: the `workflow` tool for pi, Kortix's version of Claude Code's
 * dynamic workflows (https://code.claude.com/docs/en/workflows).
 *
 * The model passes a JavaScript script that orchestrates subagents
 * deterministically. An optional first statement `export const meta = { name,
 * description, phases }` (a pure literal, `workflow-script.ts`) names the run
 * and lists its phases, which the card shows as `pending` until `phase(title)`
 * starts each one. `agent(prompt, opts?)` starts one child, `parallel(thunks)`
 * and `pipeline(items, ...stages)` fan out (at most {@link MAX_ITEMS} items per
 * call), `phase(title)` and `log(text)` report progress, `args` is the call's
 * `args`. The script's return value is the tool output.
 *
 * Every `agent()` is one child through the same spawn as the `agent` tool
 * (`KortixHost.spawnSession`, `session: "separate"`): a REAL Kortix child
 * session with its own sandbox, linked to this session (`../cloud-subagent.ts`).
 * A box with no control plane runs it in this session, as the `agent` tool
 * does. A named agent (`opts.agent`) must be one the `agent` tool offers
 * (`subagentTypes`: the `permission.task` rule filters it); without one the
 * child runs as an inline agent, which a separate session runs as this
 * session's own agent. On My Kortix's box (`anyProjectAgent`) any project
 * agent may be named, and a background runner it starts inherits that
 * (`kortix.workflow.any_agent`); the API authorizes the name either way.
 *
 * Agent options: `label`, `phase`, `agent`, `model` (the child create's
 * model), `schema` (structured output: the child is asked for JSON, the answer
 * is parsed and validated, and a corrective follow-up goes to the same child
 * session, {@link STRUCTURED_ATTEMPTS} attempts in all; a schema that
 * contradicts itself is refused before the child starts), and `stallMs` (a
 * child whose transcript shows no progress that long is stopped and started
 * again with the same prompt in a new session, {@link STALL_ATTEMPTS} attempts
 * in all; default {@link DEFAULT_STALL_MS}).
 *
 * Failure, as Claude Code: an `agent()` resolves to null when its session was
 * stopped (from outside, or because the run stops). It rejects when it
 * failed: the child session failed, the JSON never validated, every attempt
 * stalled, or the run refused the call. Awaited directly, a rejection ends the
 * run with its error; `parallel()` and `pipeline()` turn it into null.
 *
 * Approval: before the first agent starts, a session at depth 0 asks the
 * person through the question broker (`KortixHost.ask`, the `question` card):
 * the title, the planned phases and the agent count (`max_agents`, which
 * becomes the run's hard cap). "Run it, and don't ask again in this session"
 * is kept in the run store. A child session (depth > 0, a runner included)
 * has nobody to ask and does not ask.
 *
 * Background (`background: true`): the call starts ONE runner child session
 * (`notify_parent_on_turn_end`) whose `runtime_context` carries the script,
 * args, title, run id and approved cap (`kortix.workflow.*`, chunked to the
 * API's 4,096-character strings). The runner's model calls this tool with
 * `from_context: true`, which reads them from `KORTIX_SESSION_CONTEXT`; its
 * turn keeps its own box alive, and its answer reaches this session as a
 * `<task-notification>` (apps/api `subagent-notice.ts`). This call returns at
 * once with `background: { sessionId }`. Depth: a session at depth d runs
 * agents at d + 2 in the background, so the API's cap must allow it.
 *
 * Resume (`resume_run_id`): each run's agents are recorded in start order
 * (`workflow-store.ts`, `RunStore`) under the runtime state dir. A relaunch
 * returns saved results (`cached: true`, no session) until the first agent
 * whose prompt changed or that failed; that one and every later one run again
 * (`Replay`). A background run's records live on its runner's box, so its
 * relaunch is a follow-up prompt to the runner session, and this call waits.
 *
 * Saved workflows: `.kortix/workflows/<name>.js` in the project (`name` runs
 * one, `save_as` saves a script, `list_saved` lists them). A box with a
 * checkout uses its working tree; My Kortix's box reads through the API and
 * saves through a session that has the checkout, which opens a change request.
 *
 * The script runs in a QuickJS sandbox of its own (`ownScriptSandbox`), not
 * in pi's shared codemode pool: a workflow waits on children for minutes to
 * hours. `parallel` and `pipeline` are script code (the prelude below); only
 * `agent`, `phase`, `log` and `args` cross into the host.
 *
 * A foreground run holds the turn: the turn stays active while the children
 * work, which keeps this box alive (apps/api `sandbox-deadline-policy.ts`).
 * Live progress is the part metadata: `WorkflowRunMetadata`
 * (`@kortix/api-contract/kortix-tool-card`) through `onUpdate`, at most 4
 * updates per second plus a refresh every 10 s, and the same document as the
 * final `details`.
 *
 * Limits: `KORTIX_WORKFLOW_MAX_AGENTS` (50) `agent()` calls per run, capped by
 * the approved `max_agents`; `KORTIX_WORKFLOW_MAX_CONCURRENT` (8) children at
 * once, never above the box's separate-session cap; {@link WORKFLOW_DEADLINE_MS}
 * per run. A turn abort, the deadline, or the script ending stops every child
 * still running. A session at the subagent depth cap cannot run a workflow. A
 * codemode script cannot call this tool (runtime.ts `nestedCallGate`).
 */
import { randomUUID } from 'node:crypto'
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { CodemodeResult, CodemodeTool } from '@earendil-works/pi-codemode'
import type { WorkflowAgentStatus, WorkflowRunAgent, WorkflowRunMetadata, WorkflowRunStatus } from '@kortix/api-contract/kortix-tool-card'
import type { RuntimeQuestion } from '@kortix/api-contract/transcript'
import { Type } from 'typebox'
import { ownScriptSandbox } from '../codemode'
import { INLINE_AGENT, SUBAGENT_PROMPT, subagentTypes, type KortixHost, type SpawnSessionInput, type SpawnSessionResult, type WorkflowLimits } from './subagents'
import { parseJsonAnswer, schemaContradiction, schemaCorrection, schemaInstruction, splitMeta, validateJson, type WorkflowMeta } from './workflow-script'
import {
  agentKey,
  apiWorkflows,
  checkoutWorkflows,
  checkSavedName,
  listCheckout,
  Replay,
  RunStore,
  SAVED_WORKFLOWS_DIR,
  type RecordedAgent,
  type RecordedStatus,
  type RunRecord,
  type SavedWorkflows,
} from './workflow-store'

export const WORKFLOW_TOOL = 'workflow'
/** One run's wall-clock limit, children included. */
export const WORKFLOW_DEADLINE_MS = 2 * 60 * 60_000
/** Items one `parallel()` or `pipeline()` call takes; a longer list is rejected, never cut. */
export const MAX_ITEMS = 4_096
/** Attempts a structured agent gets to answer JSON that matches its schema. */
export const STRUCTURED_ATTEMPTS = 5
/** Attempts a stalled agent gets: the first and 5 restarts. */
export const STALL_ATTEMPTS = 6
/** No new output for this long: the agent stalled. */
export const DEFAULT_STALL_MS = 15 * 60_000
/** Above this many agents planned or started, the card warns (Claude Code's "Large workflow"). */
const LARGE_RUN_AGENTS = 25
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
/** A structured agent's `summary` is its whole answer as JSON up to this length, so the card can parse it; longer is cut. */
const STRUCTURED_SUMMARY_CHARS = 4_000
/** `log()` lines the live output shows, and the newest ones the document keeps. */
const LOG_LINES = 20
const DOC_LOG_LINES = 5
const LABEL_CHARS = 60
/** Bytes of `kortix.workflow.*` context a runner gets; the rest of the API's 16 KiB is the subagent keys. */
const RUNNER_CONTEXT_BUDGET = 12 * 1024
const CONTEXT_STRING_MAX = 4_096

/** The runner's `runtime_context` keys. `script` and `args` (JSON) are chunked: `<key>.0`, `<key>.1`, … */
const CONTEXT = {
  runId: 'kortix.workflow.run_id',
  title: 'kortix.workflow.title',
  name: 'kortix.workflow.name',
  maxAgents: 'kortix.workflow.max_agents',
  planned: 'kortix.workflow.planned',
  anyAgent: 'kortix.workflow.any_agent',
  script: 'kortix.workflow.script',
  args: 'kortix.workflow.args',
} as const

const RUN_ONCE = 'Run it'
const RUN_ALWAYS = "Run it, and don't ask again in this session"
const CANCEL = 'Cancel'

const parameters = Type.Object({
  description: Type.Optional(Type.String({ description: "A short (3-6 words) title of the run, shown as the card title. Default: the script's meta.description." })),
  script: Type.Optional(
    Type.String({
      description: 'The workflow: plain JavaScript with top-level await, optionally starting with `export const meta = { name, description, phases }`. Its return value is the tool result. Omit it with name, from_context, or resume_run_id alone.',
    }),
  ),
  args: Type.Optional(Type.Any({ description: 'Any JSON value; the script reads it as `args`. Pass arrays and objects as JSON values, not as a JSON string.' })),
  max_agents: Type.Optional(
    Type.Integer({ minimum: 1, description: 'The number of agent() calls the script makes. The person approves this number, and the run refuses any agent() past it. Default: the limit.' }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        'true: run it in its own runner session and return at once; the result arrives in this session as a <task-notification> message. Use it for runs you expect to take long (many agents, or more than a few minutes). Default false: the call waits for the result.',
    }),
  ),
  resume_run_id: Type.Optional(
    Type.String({ description: "Relaunch an earlier run (the run_id its result names): completed agents return their saved results. Without script, the earlier run's script runs again." }),
  ),
  name: Type.Optional(Type.String({ description: `Run the saved workflow ${SAVED_WORKFLOWS_DIR}/<name>.js (pass args as usual).` })),
  save_as: Type.Optional(
    Type.String({ description: `Save the script (or the script of resume_run_id) as ${SAVED_WORKFLOWS_DIR}/<save_as>.js. It does not run it.` }),
  ),
  list_saved: Type.Optional(Type.Boolean({ description: 'true: list the saved workflows with their descriptions. It runs nothing.' })),
  from_context: Type.Optional(Type.Boolean({ description: 'Only in a workflow runner session: run the workflow this session was started with.' })),
})

interface WorkflowParams {
  description?: string
  script?: string
  args?: unknown
  max_agents?: number
  background?: boolean
  resume_run_id?: string
  name?: string
  save_as?: string
  list_saved?: boolean
  from_context?: boolean
}

/** A part update or the final result: the live text and the run document. */
type WorkflowUpdate = { content: Array<{ type: 'text'; text: string }>; details: WorkflowRunMetadata | undefined }

function describe(agentNames: string[], limits: WorkflowLimits, saved: string[]): string {
  return [
    'Run a workflow: a JavaScript script that orchestrates many subagents deterministically, with loops, fan-out and stages. Each agent() is its own new Kortix session with its own computer, linked to this session. The script holds the plan and the intermediate results; you receive only its return value. The person watches the run live in its card.',
    'Use it for work that splits into independent units: review many files, research several questions, draft from several angles, then cross-check and synthesize. For one subagent, use the agent tool.',
    '',
    'Script (plain JavaScript with top-level await, not TypeScript):',
    '- Optional first statement: `export const meta = { name, description, phases: [{ title, detail? }] }`, a plain literal. The phases show as pending until phase(title) starts each one; give each the exact title you pass to phase().',
    '- agent(prompt, { label?, phase?, agent?, model?, schema?, stallMs? }) starts one subagent and resolves to its final answer as a string. With `schema` (a JSON Schema object) it resolves to the parsed JSON that matches it: the subagent is told to answer JSON and is corrected up to 5 times. The prompt must be complete: the subagent sees nothing of this conversation. ' +
      `\`agent\` is a named agent type${agentNames.length > 0 ? ` (${agentNames.join(', ')})` : ''}; without it the subagent runs as the current agent. \`model\` is a model id for this one agent. A subagent with no new output for \`stallMs\` (default ${DEFAULT_STALL_MS / 60_000} min) starts over in a new session, up to 6 attempts.`,
    '- agent() resolves to null when its session was stopped. It throws when it failed (its session failed, its JSON never matched, it stalled 6 times, or a limit refused it): awaited directly, that ends the run with the error; inside parallel() or pipeline() it becomes null and the run goes on.',
    `- parallel([() => agent(...), ...]) runs the functions at once and resolves to their results in order. pipeline(items, stage1, stage2, ...) sends each item through the stages, each item on its own; a stage gets (previousResult, item, index). At most ${MAX_ITEMS} items per call.`,
    '- phase(title) groups the agents that follow. log(text) shows a progress line. args is the call\'s `args` value.',
    '- No fetch, files, timers, Date.now() or Math.random(): subagents do the work, the script only routes it.',
    '',
    'Running it:',
    '- The person approves each run before any agent starts: the title, the phases and the agent count. Set max_agents to the number of agent() calls your script makes; it is the hard cap they approve. Say in one line what will run before you call it.',
    '- background: true for a run you expect to take long (many agents, or more than a few minutes): it runs in its own runner session, the call returns at once, and the result arrives later in this session as a <task-notification> message. Do not poll for it. Without it, the call waits for the result, up to 2 hours.',
    '- resume_run_id relaunches an earlier run (its result names the run_id): completed agents return their saved results, and the first agent whose prompt changed or that failed runs again, with every agent after it. Pass script to relaunch an edited version.',
    `- Saved workflows are ${SAVED_WORKFLOWS_DIR}/<name>.js in the project: name runs one (with args), save_as: "<name>" saves the script without running it, list_saved: true lists them.${saved.length > 0 ? ` Saved now: ${saved.join(', ')}.` : ''}`,
    `- Limits: ${limits.maxAgents} agent() calls per run, ${Math.max(1, limits.maxParallel)} at once (the rest wait), 2 hours per run. Stopping the turn stops every subagent of a run that waits in this turn.`,
    '',
    'Example:',
    '```js',
    "export const meta = { name: 'audit-routes', description: 'Audit route handlers for missing auth', phases: [{ title: 'Find' }, { title: 'Audit' }] }",
    "phase('Find')",
    "const found = await agent('List every .ts file under src/routes/.', {",
    "  schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },",
    '})',
    "phase('Audit')",
    'const audits = await pipeline(found.files, (file) =>',
    '  agent(`Audit ${file} for missing authentication checks. Report each problem with its line.`, { label: file }))',
    'return audits.filter(Boolean)',
    '```',
  ].join('\n')
}

/** The extension, bound to the runtime that hosts it. */
export function workflow(host: KortixHost): InlineExtension {
  return { name: 'kortix-workflow', factory: (pi) => register(pi, host) }
}

function register(pi: ExtensionAPI, host: KortixHost): void {
  // Registered on session_start (and again on reload): the description lists the named agents and the saved workflows.
  pi.on('session_start', () => {
    const checkout = host.projectCheckout()
    pi.registerTool({
      name: WORKFLOW_TOOL,
      label: WORKFLOW_TOOL,
      description: describe(
        host.anyProjectAgent?.() === true ? ['any agent of this project, by name (kortix_agents list)'] : [...subagentTypes(host).keys()],
        host.workflowLimits(),
        checkout ? listCheckout(checkout) : [],
      ),
      parameters,
      // Alone in its batch: its children take the box's separate-session slots, which a parallel `agent` call would contend for.
      executionMode: 'sequential' as const,
      // A script may not call it (nestedCallGate), so with codemode `only` the model calls it directly, like `agent`.
      ...(host.codemodeOnly?.() ? { exposure: 'model-only' as const } : {}),
      execute: (toolCallId: string, params: WorkflowParams, signal: AbortSignal | undefined, onUpdate?: (update: WorkflowUpdate) => void) =>
        execute(host, toolCallId, params ?? {}, signal, onUpdate),
    })
  })
}

/** One `workflow` call: list, save, or plan a run, ask for it, and run it here or in a runner. */
async function execute(host: KortixHost, toolCallId: string, params: WorkflowParams, signal: AbortSignal | undefined, onUpdate?: (update: WorkflowUpdate) => void): Promise<WorkflowUpdate> {
  if (params.list_saved) return listSaved(host)
  if (params.save_as !== undefined) return save(host, params, signal)
  const store = new RunStore(host.workflowStateDir())
  const plan = await planRun(host, store, params)
  if (plan.background && !plan.limits.controlPlane) throw new Error('This session cannot start a separate session, so background: true is not possible here. Run the workflow without it.')
  if (plan.background && plan.limits.depth + 2 > plan.limits.maxDepth) {
    throw new Error(
      `A background run needs two more session levels (its runner, then its agents), and this session is level ${plan.limits.depth} of at most ${plan.limits.maxDepth}. Run the workflow without background.`,
    )
  }
  const runnerContext = plan.background ? buildRunnerContext(plan) : null
  const deadline = AbortSignal.timeout(WORKFLOW_DEADLINE_MS)
  const runSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  const run = new WorkflowRun(host, store, plan, runSignal, onUpdate)
  try {
    run.publish()
    // Approval before any agent starts. A child session has nobody to ask.
    if (plan.limits.depth === 0 && !store.consented()) {
      const answers = await host.ask([approvalQuestion(plan)], toolCallId)
      const choice = answers?.[0]?.[0]
      if (choice === RUN_ALWAYS) store.consent()
      else if (choice !== RUN_ONCE) return run.cancelled()
    }
    if (plan.previous?.background && !plan.fromContext) return await resumeInRunner(host, plan, plan.previous.background.sessionId, run, runSignal)
    if (runnerContext) return await startRunner(host, store, plan, runnerContext, run, runSignal)
    return await runHere(plan, run, runSignal, deadline)
  } finally {
    run.dispose()
  }
}

// ── the plan ──────────────────────────────────────────────────────────────

interface Plan {
  runId: string
  title: string
  /** `meta.name`, or the saved workflow's name. */
  name?: string
  /** The script came from a saved workflow (`name`). */
  saved: boolean
  /** The whole script, meta block included (what a resume or a save keeps). */
  script: string
  /** The script without its meta block: what runs. */
  body: string
  meta: WorkflowMeta | null
  args: unknown
  /** The approved hard cap. */
  maxAgents: number
  /** The count the call (or its runner context) named; absent = none given. */
  planned?: number
  background: boolean
  fromContext: boolean
  /** Any project agent may be named (My Kortix, or its runner). */
  anyAgent: boolean
  previous: RunRecord | null
  limits: WorkflowLimits
}

async function planRun(host: KortixHost, store: RunStore, params: WorkflowParams): Promise<Plan> {
  const limits = host.workflowLimits()
  if (limits.refusal) throw new Error(limits.refusal)
  const context = params.from_context ? runnerContextOf(host) : null
  if (params.script?.trim() && params.name?.trim()) throw new Error('Pass either script or name, not both.')
  if (params.background && params.from_context) throw new Error('A runner session runs its workflow in the foreground: omit background.')
  const previous = params.resume_run_id?.trim() ? store.load(params.resume_run_id.trim()) : null
  if (params.resume_run_id?.trim() && !previous) {
    throw new Error(`nothing to resume: no run ${params.resume_run_id.trim()} is saved on this computer. Start the workflow over as a new run: omit resume_run_id.`)
  }
  if (previous && params.background && !previous.background) throw new Error('This run ran in the foreground, and it resumes there: omit background.')
  if (previous?.background && (params.script?.trim() || params.name?.trim())) {
    throw new Error("A background run resumes in its runner session with its own script. Omit script and name, or start a new run without resume_run_id.")
  }
  const name = (context?.name ?? (params.name?.trim() ? checkSavedName(params.name) : undefined)) || undefined
  let script = context?.script || params.script?.trim() || ''
  if (!script && name) {
    const read = await savedWorkflows(host).read(name)
    if (read === null) throw new Error(`No saved workflow "${name}" (${SAVED_WORKFLOWS_DIR}/${name}.js). list_saved: true lists them.`)
    script = read.trim()
  }
  if (!script && previous) script = previous.script
  if (!script) throw new Error('The workflow has no script: pass script, name, or resume_run_id.')
  const { meta, body } = splitMeta(script)
  if (!body.trim()) throw new Error('The workflow script has no body after its meta block.')
  const planned = context?.planned ?? params.max_agents ?? (previous ? previous.maxAgents : undefined)
  const maxAgents = Math.max(1, Math.min(limits.maxAgents, context?.maxAgents ?? planned ?? limits.maxAgents))
  return {
    runId: context?.runId ?? randomUUID(),
    title: params.description?.trim() || context?.title || meta?.description || previous?.title || name || meta?.name || 'Workflow',
    ...(name || meta?.name || previous?.name ? { name: name ?? meta?.name ?? previous?.name } : {}),
    saved: name !== undefined,
    script,
    body,
    meta,
    args: context ? context.args : params.args !== undefined ? params.args : previous?.args,
    maxAgents,
    ...(planned !== undefined ? { planned: Math.min(planned, maxAgents) } : {}),
    background: params.background === true,
    fromContext: context !== null,
    anyAgent: host.anyProjectAgent?.() === true || context?.anyAgent === true,
    previous,
    limits,
  }
}

function approvalQuestion(plan: Plan): RuntimeQuestion {
  const phases = plan.meta?.phases ?? []
  const agents = plan.planned !== undefined ? `up to ${plan.planned}` : `no count given, at most ${plan.maxAgents} (the limit)`
  return {
    header: 'Workflow',
    question: [
      `Run the workflow "${plan.title}"${plan.saved ? ` (saved as ${plan.name})` : ''}?`,
      phases.length > 0 ? `Phases: ${phases.map((phase, index) => `${index + 1}. ${phase.title}`).join(', ')}.` : 'Phases: none declared.',
      `Agents: ${agents}. Each agent is its own session with its own computer.`,
      ...(plan.previous ? [`It relaunches run ${plan.previous.runId}: agents that completed there return their saved results.`] : []),
      ...(plan.background ? ['It runs in the background: this chat stays free, and the result arrives here when the run ends.'] : []),
    ].join('\n'),
    options: [
      { label: RUN_ONCE, description: 'Start this run now.' },
      { label: RUN_ALWAYS, description: 'Start it, and start later workflows in this session without asking.' },
      { label: CANCEL, description: 'Start no agent.' },
    ],
  }
}

// ── a run on this box ─────────────────────────────────────────────────────

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
const __items = (name, list) => {
  if (list.length > ${MAX_ITEMS}) throw new RangeError(name + '() takes at most ${MAX_ITEMS} items, and this call has ' + list.length + '. Split the list.');
};
const parallel = async (thunks) => {
  if (!Array.isArray(thunks)) throw new TypeError('parallel() takes an array of functions');
  __items('parallel', thunks);
  return Promise.all(thunks.map(async (thunk, index) => {
    try { return await (typeof thunk === 'function' ? thunk() : thunk); } catch (error) { return __failed('parallel item ' + index, error); }
  }));
};
const pipeline = async (items, ...stages) => {
  if (!Array.isArray(items)) throw new TypeError('pipeline() takes an array of items first');
  __items('pipeline', items);
  return Promise.all(items.map(async (item, index) => {
    let value = item;
    for (let stage = 0; stage < stages.length; stage++) {
      try { value = await stages[stage](value, item, index); } catch (error) { return __failed('pipeline item ' + index + ' stage ' + (stage + 1), error); }
    }
    return value;
  }));
};
`

async function runHere(plan: Plan, run: WorkflowRun, runSignal: AbortSignal, deadline: AbortSignal): Promise<WorkflowUpdate> {
  run.saveRecord()
  const sandbox = await ownScriptSandbox({ globals: run.globals(plan.args), timeoutMs: WORKFLOW_DEADLINE_MS })
  let result: CodemodeResult
  try {
    result = await sandbox.execute(`${PRELUDE}return await (async () => {\n${plan.body}\n})();`, { signal: runSignal })
  } finally {
    await sandbox.close()
  }
  // The script ended: wait for the stops of children it left running (each saw the call's signal abort).
  await run.settled()
  // Only the caller's abort (the turn stopped) is `stopped`; the deadline is a failure.
  const status: WorkflowRunStatus = result.ok ? 'done' : result.error.kind === 'aborted' && !deadline.aborted ? 'stopped' : 'failed'
  const error = result.ok ? undefined : deadline.aborted ? `The workflow ran past its ${WORKFLOW_DEADLINE_MS / 3_600_000} h deadline.` : result.error.message
  return run.finish(status, error, result.ok ? result.value : undefined)
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

/** What one agent call came to. */
type Outcome = { kind: 'done'; value: unknown; summary: string } | { kind: 'failed'; error: string } | { kind: 'stopped'; interrupted: boolean }

interface AgentWork {
  spec: Omit<SpawnSessionInput, 'title' | 'prompt'>
  label: string
  prompt: string
  schema?: unknown
  stallMs: number
}

/** The run's state: the metadata document, the record, the children, and the throttled updates. */
class WorkflowRun {
  readonly doc: WorkflowRunMetadata
  private readonly logs: string[] = []
  private readonly running = new Set<Promise<unknown>>()
  private readonly slots: Slots
  private readonly record: RunRecord
  private readonly replay: Replay | null
  private lastUpdate = 0
  private pending: ReturnType<typeof setTimeout> | null = null
  private readonly refresh: ReturnType<typeof setInterval> | null

  constructor(
    private readonly host: KortixHost,
    private readonly store: RunStore,
    private readonly plan: Plan,
    private readonly signal: AbortSignal,
    private readonly onUpdate: ((update: WorkflowUpdate) => void) | undefined,
  ) {
    const startedAt = Date.now()
    this.doc = {
      runId: plan.runId,
      title: plan.title,
      status: 'running',
      phases: (plan.meta?.phases ?? []).map((phase) => ({ title: phase.title, status: 'pending' as const })),
      agents: [],
      startedAt,
      maxAgents: plan.maxAgents,
      ...(plan.name ? { name: plan.name } : {}),
      ...(plan.previous ? { resumedFrom: plan.previous.runId } : {}),
      ...((plan.planned ?? 0) > LARGE_RUN_AGENTS ? { large: true as const } : {}),
    }
    this.record = {
      runId: plan.runId,
      title: plan.title,
      ...(plan.name ? { name: plan.name } : {}),
      script: plan.script,
      ...(plan.args !== undefined ? { args: plan.args } : {}),
      maxAgents: plan.maxAgents,
      startedAt,
      ...(plan.previous ? { resumedFrom: plan.previous.runId } : {}),
      agents: [],
    }
    this.replay = plan.previous ? new Replay(plan.previous.agents) : null
    this.slots = new Slots(Math.max(1, plan.limits.maxParallel))
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
    for (const phase of this.doc.phases) if (phase.status === 'running' && phase.title !== title) phase.status = 'done'
    const known = this.doc.phases.find((phase) => phase.title === title)
    if (known) known.status = 'running'
    else this.doc.phases.push({ title, status: 'running' })
    this.publish()
  }

  private log(text: string): void {
    this.logs.push(text.slice(0, 500))
    this.doc.logs = this.logs.slice(-DOC_LOG_LINES)
    this.publish()
  }

  /**
   * One `agent(prompt, opts)`. Resolves to the answer (a string, or the parsed
   * JSON of a structured agent), or null when the agent was stopped. Rejects
   * when the run refuses the call (before any child) or the agent failed.
   */
  private agent(call: unknown[], scriptSignal: AbortSignal): Promise<unknown> {
    const [prompt, rawOpts] = call
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('agent() needs a prompt string as its first argument.')
    const opts = rawOpts && typeof rawOpts === 'object' ? (rawOpts as Record<string, unknown>) : {}
    const named = typeof opts.agent === 'string' && opts.agent.trim() ? opts.agent.trim() : undefined
    const model = typeof opts.model === 'string' && opts.model.trim() ? opts.model.trim() : undefined
    const schema = opts.schema ?? undefined
    if (schema !== undefined) {
      const contradiction = schemaContradiction(schema)
      if (contradiction) throw new Error(`agent() refused: the schema can never be met (${contradiction}). The agent did not start.`)
    }
    const stallMs = typeof opts.stallMs === 'number' && Number.isFinite(opts.stallMs) && opts.stallMs > 0 ? opts.stallMs : DEFAULT_STALL_MS
    const spec = this.spec(named, model)
    if (this.doc.agents.length >= this.plan.maxAgents) {
      const refusal = `agent() refused: this run may start at most ${this.plan.maxAgents} agents${this.plan.planned !== undefined ? ' (the approved count)' : ''}, and it started ${this.doc.agents.length}. Give each agent more of the work, or run another workflow for the rest.`
      this.log(refusal)
      throw new Error(refusal)
    }
    const label = (typeof opts.label === 'string' && opts.label.trim() ? opts.label.trim() : prompt.trim().split('\n')[0]!).slice(0, LABEL_CHARS)
    const phase = typeof opts.phase === 'string' && opts.phase ? opts.phase : undefined
    const entry: WorkflowRunAgent = {
      id: `a${this.doc.agents.length + 1}`,
      label,
      ...(named ? { agent: named } : {}),
      ...(phase ? { phase } : {}),
      status: 'starting',
      ...(model ? { model } : {}),
      ...(schema !== undefined ? { structured: true as const } : {}),
      startedAt: Date.now(),
    }
    this.doc.agents.push(entry)
    if (this.doc.agents.length > LARGE_RUN_AGENTS) this.doc.large = true
    // Recorded in start order; a run that ends before this agent settles leaves it `interrupted`.
    const recorded: RecordedAgent = { key: agentKey({ prompt, agent: named, model, schema }), label, status: 'interrupted' }
    this.record.agents.push(recorded)
    const cached = this.replay?.take(recorded.key)
    if (cached) {
      return Promise.resolve(this.apply(entry, recorded, { kind: 'done', value: cached.result ?? null, summary: summaryOf(cached.result) }, true))
    }
    this.publish()
    const work: AgentWork = { spec, label, prompt: schema === undefined ? prompt : `${prompt}${schemaInstruction(schema)}`, schema, stallMs }
    const done = this.runAgent(entry, work, AbortSignal.any([this.signal, scriptSignal])).then((outcome) => this.apply(entry, recorded, outcome))
    this.running.add(done)
    void done.catch(() => {}).finally(() => this.running.delete(done))
    return done
  }

  /** The spawn input of a named agent, else of an inline one. Throws for a name the `agent` tool would refuse. */
  private spec(named: string | undefined, model: string | undefined): Omit<SpawnSessionInput, 'title' | 'prompt'> {
    const base = { session: 'separate' as const, waitMs: WORKFLOW_DEADLINE_MS }
    if (!named) return { ...base, agent: INLINE_AGENT, systemPrompt: SUBAGENT_PROMPT, ...(model ? { model } : {}) }
    const types = subagentTypes(this.host)
    const type = types.get(named)
    // My Kortix's box (or its runner): any project agent, by name; the API authorizes it when it creates the session.
    if (!type && this.plan.anyAgent) return { ...base, agent: named, systemPrompt: SUBAGENT_PROMPT, ...(model ? { model } : {}) }
    if (!type) throw new Error(`agent() refused: unknown agent "${named}". Available: ${[...types.keys()].join(', ') || 'none'}. Omit \`agent\` to run as the current agent.`)
    return {
      ...base,
      agent: named,
      systemPrompt: type.prompt,
      ...(model ?? type.model ? { model: model ?? type.model } : {}),
      ...(type.variant ? { variant: type.variant } : {}),
      ...(type.tools ? { tools: type.tools } : {}),
      ...(type.permission !== undefined ? { permission: type.permission } : {}),
    }
  }

  /** Slot, spawn (restarting a stalled child), then the structured-output checks. */
  private async runAgent(entry: WorkflowRunAgent, work: AgentWork, signal: AbortSignal): Promise<Outcome> {
    if (!(await this.slots.acquire(signal))) return { kind: 'stopped', interrupted: true }
    try {
      let result: SpawnSessionResult
      for (let attempt = 1; ; attempt++) {
        entry.attempt = attempt
        result = await this.spawn(entry, { ...work.spec, title: this.childTitle(work.label, attempt), prompt: work.prompt, stallMs: work.stallMs }, signal)
        if (!result.stalled) break
        if (attempt >= STALL_ATTEMPTS) {
          return { kind: 'failed', error: `agent stalled on all ${STALL_ATTEMPTS} attempts: no new output for ${minutes(work.stallMs)} each. If its work keeps it silent that long, pass a longer stallMs.` }
        }
        this.log(`${entry.label}: no new output for ${minutes(work.stallMs)}; attempt ${attempt + 1} of ${STALL_ATTEMPTS} starts.`)
        delete entry.sessionId
        entry.status = 'starting'
        this.publish()
      }
      if (result.status === 'aborted') return { kind: 'stopped', interrupted: signal.aborted }
      if (result.status === 'error') return { kind: 'failed', error: result.error ?? 'The subagent failed.' }
      if (work.schema === undefined) return { kind: 'done', value: result.text, summary: result.text }
      let text = result.text
      for (let attempt = 1; ; attempt++) {
        const checked = checkStructured(text, work.schema)
        if (checked.ok) return { kind: 'done', value: checked.value, summary: JSON.stringify(checked.value) }
        if (attempt >= STRUCTURED_ATTEMPTS) return { kind: 'failed', error: `structured output failed validation on all ${STRUCTURED_ATTEMPTS} attempts; the last: ${checked.error}` }
        const followUp = await this.spawn(
          entry,
          { ...work.spec, sessionId: entry.sessionId, title: this.childTitle(work.label, entry.attempt ?? 1), prompt: schemaCorrection(checked.error, work.schema), stallMs: work.stallMs },
          signal,
        )
        if (followUp.status === 'aborted') return { kind: 'stopped', interrupted: signal.aborted }
        if (followUp.status === 'error') return { kind: 'failed', error: followUp.error ?? 'The subagent failed.' }
        text = followUp.text
      }
    } finally {
      this.slots.release()
    }
  }

  /** A child session's name: the agent's label, its retry, and the run. */
  private childTitle(label: string, attempt: number): string {
    return `${label}${attempt > 1 ? ` (retry ${attempt - 1})` : ''} (${this.doc.title} workflow)`
  }

  private async spawn(entry: WorkflowRunAgent, input: SpawnSessionInput, signal: AbortSignal): Promise<SpawnSessionResult> {
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
      return result
    } catch (err) {
      // A spawn gate refused (depth, the box's live cap, an invalid spec).
      return { sessionId: '', status: signal.aborted ? 'aborted' : 'error', text: '', error: err instanceof Error ? err.message : String(err), model: { providerID: 'kortix', modelID: 'default' } }
    }
  }

  /** Record and show what the agent came to; resolve its value, or reject with its error. */
  private apply(entry: WorkflowRunAgent, recorded: RecordedAgent, outcome: Outcome, cached = false): unknown {
    const status: WorkflowAgentStatus = outcome.kind === 'done' ? 'done' : outcome.kind === 'failed' ? 'failed' : 'stopped'
    entry.status = status
    entry.endedAt = Date.now()
    if (cached) entry.cached = true
    if (outcome.kind === 'done' && entry.structured) {
      entry.summary = JSON.stringify(outcome.value ?? null).slice(0, STRUCTURED_SUMMARY_CHARS)
    } else {
      const line = (outcome.kind === 'done' ? outcome.summary : outcome.kind === 'failed' ? outcome.error : '').trim().split('\n')[0]
      if (line) entry.summary = line.slice(0, SUMMARY_CHARS)
    }
    const recordedStatus: RecordedStatus = outcome.kind === 'stopped' && outcome.interrupted ? 'interrupted' : status
    recorded.status = recordedStatus
    if (outcome.kind === 'done') recorded.result = outcome.value
    if (entry.sessionId) recorded.sessionId = entry.sessionId
    this.saveRecord()
    this.publish()
    if (outcome.kind === 'failed') throw new Error(outcome.error)
    return outcome.kind === 'done' ? outcome.value : null
  }

  saveRecord(): void {
    try {
      this.store.save(this.record)
    } catch {
      // A full disk loses the resume, never the run.
    }
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
    this.onUpdate?.({ content: [{ type: 'text', text: this.logs.slice(-LOG_LINES).join('\n') }], details: structuredClone(this.doc) })
  }

  /** Stop every timer: the refresh and a pending update. Safe to call twice. */
  dispose(): void {
    if (this.refresh) clearInterval(this.refresh)
    if (this.pending) clearTimeout(this.pending)
    this.pending = null
  }

  private close(status: WorkflowRunStatus, error: string | undefined): void {
    this.dispose()
    for (const phase of this.doc.phases) if (phase.status === 'running') phase.status = status
    this.doc.status = status
    this.doc.endedAt = Date.now()
    if (error) this.doc.error = error
  }

  /** The final result: the run document as `details`, the script's value (or error) and the agents' outcomes as text. */
  finish(status: WorkflowRunStatus, error: string | undefined, value: unknown): WorkflowUpdate {
    this.close(status, error)
    this.saveRecord()
    const body = status === 'done' ? `<workflow_result>\n${resultText(value)}\n</workflow_result>` : `<workflow_error>\n${error ?? `The workflow ${status}.`}\n</workflow_error>`
    const relaunch =
      status === 'done'
        ? `run_id: ${this.doc.runId} (resume_run_id relaunches it; save_as saves its script)`
        : `run_id: ${this.doc.runId}. To retry, call workflow with resume_run_id: "${this.doc.runId}": completed agents return their saved results, and the failed or stopped agent and every agent after it run again.`
    return { content: [{ type: 'text', text: [body, ...agentLines(this.doc.agents), relaunch].join('\n') }], details: structuredClone(this.doc) }
  }

  /** The person said no: no agent started. */
  cancelled(): WorkflowUpdate {
    this.close('stopped', 'The person cancelled the run before it started.')
    return {
      content: [
        {
          type: 'text',
          text: '<workflow_cancelled>\nThe person cancelled this workflow. No agent started. Do not start it again unless they ask for it; ask what they want instead, or do the work another way.\n</workflow_cancelled>',
        },
      ],
      details: structuredClone(this.doc),
    }
  }

  /** A background run started: the runner session holds it now. */
  handedOff(sessionId: string): WorkflowUpdate {
    this.dispose()
    this.doc.background = { sessionId }
    return {
      content: [
        {
          type: 'text',
          text: [
            '<workflow_started>',
            `The workflow runs in the background in its own runner session ${sessionId}. Its result arrives in this session as a <task-notification> message when the run ends, also after your turn has ended.`,
            'Do not poll or wait for it. Continue with other work, or end your turn and tell the person it runs.',
            '</workflow_started>',
            `run_id: ${this.doc.runId} (resume_run_id relaunches it in its runner session)`,
          ].join('\n'),
        },
      ],
      details: structuredClone(this.doc),
    }
  }

  /** A background run's relaunch ended in its runner: the runner's answer is the result. */
  relaunched(sessionId: string, result: SpawnSessionResult): WorkflowUpdate {
    const failed = result.status !== 'completed' || result.text.includes('<workflow_error>')
    const status: WorkflowRunStatus = result.status === 'aborted' ? 'stopped' : failed ? 'failed' : 'done'
    this.close(status, failed ? (result.error ?? 'The relaunched run failed; its runner session has the details.') : undefined)
    this.doc.background = { sessionId }
    const text = result.status === 'completed' ? result.text : `<workflow_error>\n${result.error ?? `The runner session ${result.status}.`}\n</workflow_error>`
    return { content: [{ type: 'text', text: `${text}\n(runner session ${sessionId})` }], details: structuredClone(this.doc) }
  }
}

function checkStructured(text: string, schema: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const parsed = parseJsonAnswer(text)
  if (!parsed.ok) return parsed
  const errors = validateJson(parsed.value, schema)
  return errors.length === 0 ? { ok: true, value: parsed.value } : { ok: false, error: errors.join('; ') }
}

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`)

function summaryOf(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null)
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
  const reused = agents.filter((agent) => agent.cached).length
  const header = `agents: ${agents.length} (${[...counts].map(([status, count]) => `${count} ${status}`).join(', ')}${reused ? `; ${reused} reused from the earlier run` : ''})`
  const problems = agents
    .filter((agent) => agent.status !== 'done')
    .map((agent) => `- ${agent.id} "${agent.label}" ${agent.status}${agent.summary ? `: ${agent.summary}` : ''}${agent.sessionId ? ` (session ${agent.sessionId})` : ''}`)
  return [header, ...problems]
}

// ── background: the runner session ────────────────────────────────────────

const RUNNER_PROMPT = [
  'You are a workflow runner: a Kortix session that runs one workflow for another session and reports its result.',
  'Call the workflow tool once with { "from_context": true }. It reads the script, its args and its title from this session; pass nothing else. Do not do the work yourself, and do not start other agents.',
  'When the call returns, your final message is its whole text output, unchanged, with nothing before or after it.',
].join('\n')

/** The runner's `kortix.workflow.*` context. Throws when the script and args do not fit and no saved name can stand in. */
function buildRunnerContext(plan: Plan): Record<string, string | number | boolean> {
  const base: Record<string, string | number | boolean> = {
    [CONTEXT.runId]: plan.runId,
    [CONTEXT.title]: plan.title.slice(0, 200),
    [CONTEXT.maxAgents]: plan.maxAgents,
    ...(plan.planned !== undefined ? { [CONTEXT.planned]: plan.planned } : {}),
    ...(plan.name ? { [CONTEXT.name]: plan.name } : {}),
    ...(plan.anyAgent ? { [CONTEXT.anyAgent]: true } : {}),
    ...(plan.args !== undefined ? chunked(CONTEXT.args, JSON.stringify(plan.args)) : {}),
  }
  const withScript = { ...base, ...chunked(CONTEXT.script, plan.script) }
  if (contextBytes(withScript) <= RUNNER_CONTEXT_BUDGET) return withScript
  // A saved workflow's runner reads it by name from the project's default branch.
  if (plan.name && contextBytes(base) <= RUNNER_CONTEXT_BUDGET) return base
  throw new Error(
    `The script and args are ${contextBytes(withScript)} bytes; a background run carries at most ${RUNNER_CONTEXT_BUDGET}. Run it without background, or save it with save_as, merge it, and run it by name in the background.`,
  )
}

function chunked(prefix: string, value: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0, n = 0; i < value.length; i += CONTEXT_STRING_MAX, n++) out[`${prefix}.${n}`] = value.slice(i, i + CONTEXT_STRING_MAX)
  return out
}

function unchunked(context: Record<string, unknown>, prefix: string): string | undefined {
  let out: string | undefined
  for (let n = 0; typeof context[`${prefix}.${n}`] === 'string'; n++) out = (out ?? '') + (context[`${prefix}.${n}`] as string)
  return out
}

const contextBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

interface RunnerContext {
  runId: string
  title?: string
  name?: string
  script: string
  args: unknown
  maxAgents?: number
  planned?: number
  anyAgent: boolean
}

function runnerContextOf(host: KortixHost): RunnerContext {
  const context = host.sessionContext()
  const runId = context[CONTEXT.runId]
  if (typeof runId !== 'string' || !runId) throw new Error('This session has no workflow in its context: from_context is only for a workflow runner session. Pass script or name instead.')
  const args = unchunked(context, CONTEXT.args)
  let parsedArgs: unknown
  try {
    parsedArgs = args === undefined ? undefined : JSON.parse(args)
  } catch {
    throw new Error("The workflow args in this session's context are not valid JSON.")
  }
  const number = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined)
  return {
    runId,
    ...(typeof context[CONTEXT.title] === 'string' ? { title: context[CONTEXT.title] as string } : {}),
    ...(typeof context[CONTEXT.name] === 'string' ? { name: checkSavedName(context[CONTEXT.name] as string) } : {}),
    script: unchunked(context, CONTEXT.script)?.trim() ?? '',
    args: parsedArgs,
    ...(number(context[CONTEXT.maxAgents]) ? { maxAgents: number(context[CONTEXT.maxAgents]) } : {}),
    ...(number(context[CONTEXT.planned]) ? { planned: number(context[CONTEXT.planned]) } : {}),
    anyAgent: context[CONTEXT.anyAgent] === true,
  }
}

async function startRunner(host: KortixHost, store: RunStore, plan: Plan, context: Record<string, string | number | boolean>, run: WorkflowRun, signal: AbortSignal): Promise<WorkflowUpdate> {
  const result = await host.spawnSession({
    session: 'separate',
    agent: INLINE_AGENT,
    systemPrompt: RUNNER_PROMPT,
    title: `${plan.title} (workflow)`,
    prompt: `Run the workflow "${plan.title}" from this session's context: call the workflow tool with { "from_context": true }.`,
    background: true,
    runtimeContext: context,
    signal,
    onSession: ({ sessionId }) => {
      run.doc.background = { sessionId }
      run.publish()
    },
  })
  if (result.status !== 'completed' || !result.sessionId || !result.background) {
    throw new Error(`The workflow runner session did not start: ${result.error ?? `it answered ${result.status}`}. No agent started.`)
  }
  store.save({
    runId: plan.runId,
    title: plan.title,
    ...(plan.name ? { name: plan.name } : {}),
    script: plan.script,
    ...(plan.args !== undefined ? { args: plan.args } : {}),
    maxAgents: plan.maxAgents,
    startedAt: run.doc.startedAt,
    background: { sessionId: result.sessionId },
    agents: [],
  })
  return run.handedOff(result.sessionId)
}

/** A background run's relaunch: a follow-up prompt to its runner session, which holds the records. The call waits for it. */
async function resumeInRunner(host: KortixHost, plan: Plan, runner: string, run: WorkflowRun, signal: AbortSignal): Promise<WorkflowUpdate> {
  run.doc.background = { sessionId: runner }
  run.publish()
  const result = await host.spawnSession({
    sessionId: runner,
    session: 'separate',
    agent: INLINE_AGENT,
    systemPrompt: RUNNER_PROMPT,
    title: `${plan.title} (workflow)`,
    prompt: `Relaunch the workflow: call the workflow tool with { "from_context": true, "resume_run_id": "${plan.previous!.runId}" }. Then reply with its whole text output, unchanged.`,
    waitMs: WORKFLOW_DEADLINE_MS,
    signal,
  })
  return run.relaunched(runner, result)
}

// ── saved workflows ───────────────────────────────────────────────────────

function savedWorkflows(host: KortixHost): SavedWorkflows {
  const checkout = host.projectCheckout()
  if (checkout) return checkoutWorkflows(checkout)
  const api = host.projectApi()
  if (api) return apiWorkflows(api)
  throw new Error('This session has no project checkout and no Kortix API, so it has no saved workflows.')
}

async function listSaved(host: KortixHost): Promise<WorkflowUpdate> {
  const saved = savedWorkflows(host)
  const names = (await saved.list()).slice(0, 100)
  const lines = await Promise.all(
    names.map(async (name) => {
      const script = await saved.read(name).catch(() => null)
      let description: string | undefined
      try {
        description = script ? splitMeta(script).meta?.description : undefined
      } catch {
        description = '(its meta block is not a plain literal)'
      }
      return `- ${name}${description ? `: ${description}` : ''}`
    }),
  )
  const text = names.length > 0 ? [`Saved workflows (${saved.where}):`, ...lines, 'Run one with { "name": "<name>", "args": … }.'].join('\n') : `No saved workflows in ${saved.where}.`
  return { content: [{ type: 'text', text }], details: undefined }
}

async function save(host: KortixHost, params: WorkflowParams, signal: AbortSignal | undefined): Promise<WorkflowUpdate> {
  const name = checkSavedName(params.save_as ?? '')
  const store = new RunStore(host.workflowStateDir())
  const previous = params.resume_run_id?.trim() ? store.load(params.resume_run_id.trim()) : null
  if (params.resume_run_id?.trim() && !previous) throw new Error(`No run ${params.resume_run_id.trim()} is saved on this computer, so its script cannot be saved.`)
  const script = params.script?.trim() || previous?.script
  if (!script) throw new Error('save_as needs the script to save: pass script, or resume_run_id of a run whose script to save.')
  const { meta } = splitMeta(script)
  const file = `${SAVED_WORKFLOWS_DIR}/${name}.js`
  const checkout = host.projectCheckout()
  if (checkout) {
    const path = checkoutWorkflows(checkout).save(name, script)
    const text = `Saved the workflow as ${path} in this session's project checkout. Run it with { "name": "${name}" }. Commit it and open a change request so that the project's other sessions can run it.`
    return { content: [{ type: 'text', text }], details: undefined }
  }
  if (!host.workflowLimits().controlPlane) throw new Error('This session has no project checkout and cannot start a session that has one, so it cannot save a workflow.')
  // The API commits a session's change only to its own branch: a session with the checkout writes it and opens a change request.
  const result = await host.spawnSession({
    session: 'separate',
    agent: INLINE_AGENT,
    systemPrompt: SUBAGENT_PROMPT,
    title: `Save the ${name} workflow`,
    prompt: [
      `Save a workflow script in the project repository. Create the file \`${file}\` with exactly the content between the two marker lines below (not the markers), and change nothing else.`,
      `Commit it on this session's branch, push, and open a change request titled "Add the ${name} workflow"${meta?.description ? ` with the description "${meta.description}"` : ''} (\`kortix cr open --title "…"\`).`,
      'Reply with the change request number and its link, in one line.',
      '-----BEGIN WORKFLOW-----',
      script,
      '-----END WORKFLOW-----',
    ].join('\n'),
    background: true,
    ...(signal ? { signal } : {}),
  })
  if (result.status !== 'completed' || !result.sessionId) throw new Error(`The session that saves the workflow did not start: ${result.error ?? result.status}.`)
  const text = [
    `This computer has no project files, and the Kortix API takes a new project file only through a change request. The session ${result.sessionId} writes ${file}, commits it and opens a change request. Its answer, with the change request, arrives in this session as a <task-notification> message.`,
    `Once the change request is merged, run the workflow with { "name": "${name}" }.`,
  ].join('\n')
  return { content: [{ type: 'text', text }], details: undefined }
}
