/**
 * Subagents: the `agent` tool for pi (`task` is the same tool under its older name).
 *
 * The tool spawns one subagent, either a named agent declared in the project
 * (`subagent_type`) or an inline ephemeral agent defined in the call (`agent`,
 * no manifest entry). It keeps the `task` contract end to end, because the
 * product renders it: input `{ description, prompt, subagent_type?,
 * agent?, task_id?, session? }`, the child session id in the tool part's
 * `metadata.sessionId` (the web client's `getChildSessionId` → `TaskTool`
 * preview and full view), and an output that starts `task_id: <id>` so the
 * model can resume the same child.
 *
 * It registers under two names with one handler: `agent` (the name to use) and
 * `task` (a deprecated alias, kept so prompts and sessions written for OpenCode
 * keep working). Both are callable and behave identically.
 *
 * `session` picks where the child runs, per call:
 *  - `separate` (the default): its own new Kortix session with its own
 *    sandbox, linked to this session as its parent, listed in the sidebar, and
 *    it outlives this turn (`../cloud-subagent.ts`).
 *  - `same`: an in-process pi agent in a child session of this session (see
 *    `PiRuntime.spawnSession`): no boot, no extra sandbox.
 * A separate call the box cannot serve (no control plane) runs in this
 * session, and the result says so.
 * A `task_id` resumes the child in the session mode it was created in.
 * `background: true` (a new separate session only) returns as soon as the child
 * exists: the API wakes this session with the child's answer when its turn ends
 * (`notify_parent_on_turn_end`, apps/api `subagent-notice.ts`). The part
 * metadata carries `{ sessionId, background: true }`.
 *
 * Named subagent types: `general` (every workspace tool), `explore` (read-only
 * search), and every compiled agent whose `mode` is `subagent` or `all`. A
 * compiled agent with a built-in's name replaces it. kortix.yaml v3 has no
 * built-in: only declared agents. The calling agent's `permission.task` rule
 * filters the list: a denied type is not offered, and a call to it is refused.
 * An inline agent has no name to deny; the session's tool rules still gate every
 * call its child makes, so delegating never unlocks a denied call.
 * A `same` child gets no `agent`/`task` (no nesting) and no `question` (nobody answers a
 * child). A `separate` child runs its own pi, so it may delegate again, up to the depth cap.
 */
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { CompiledAgent } from '@kortix/api-contract/runtime-relay'
import type { RuntimeQuestion } from '@kortix/api-contract/transcript'
import { Type } from 'typebox'

/** What the subagents extension needs from the runtime that hosts it. */
export interface KortixHost {
  /** The compiled agent config's `agent` map (`KORTIX_COMPILED_AGENT_CONFIG`). */
  compiledAgents(): Record<string, CompiledAgent>
  /** False for kortix.yaml v3: no built-in `general`/`explore`. */
  builtInSubagents(): boolean
  /** The calling agent's `permission.task` rule for this subagent name is not `deny`. */
  subagentAllowed(name: string): boolean
  /**
   * True with codemode `only`: `agent` is then declared to the model beside
   * codemode (`model-only` exposure). A script may not call it (the runtime's
   * nested-call gate), so without this a codemode-only agent could not delegate.
   */
  codemodeOnly?(): boolean
  /**
   * True when a separate session may name ANY project agent, declared here or
   * not: the API authorizes the name when it creates the session. My Kortix's
   * compiled config declares only itself, so its hand-offs to project agents
   * would otherwise have no type to name.
   */
  anyProjectAgent?(): boolean
  /** Run one prompt in a child (separate or same session, see `session`) and return its final answer. */
  spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult>
  /** The `workflow` tool's limits on this box (`extensions/workflow.ts`). */
  workflowLimits(): WorkflowLimits
  /**
   * Ask the person in this session (the question broker the `question` tool
   * uses), attached to the tool call `toolCallId`. Resolves with the answers,
   * or null when the question was dismissed or the turn ended.
   */
  ask(questions: RuntimeQuestion[], toolCallId: string): Promise<string[][] | null>
  /** This session's `runtime_context` (`KORTIX_SESSION_CONTEXT`), parsed; `{}` when absent or malformed. */
  sessionContext(): Record<string, unknown>
  /** Where the workflow tool keeps its run records: `$KORTIX_RUNTIME_STATE_DIR/workflows`. */
  workflowStateDir(): string
  /** The project checkout this session works in (a git working tree), or null (My Kortix's box has none). */
  projectCheckout(): string | null
  /** The Kortix API with this session's token, or null without a control plane. */
  projectApi(): { apiUrl: string; projectId: string; token: string } | null
}

/** What bounds a workflow run on this box. */
export interface WorkflowLimits {
  /** Children one run keeps working at once: the workflow cap, never above the box's separate-session cap. */
  maxParallel: number
  /** `agent()` calls one run may make (`KORTIX_WORKFLOW_MAX_AGENTS`). */
  maxAgents: number
  /** Why this session cannot run a workflow (it is at the subagent depth cap). */
  refusal?: string
  /** This session's subagent depth (0 for a session a person started) and the cap. */
  depth: number
  maxDepth: number
  /** The box can start separate child sessions (a runner, a saver). */
  controlPlane: boolean
}

/** Where a subagent runs: its own new Kortix session (`separate`), or inside this session (`same`). */
export type SubagentSession = 'separate' | 'same'

export interface SpawnSessionInput {
  /** Continue this existing child session instead of creating one. */
  sessionId?: string
  /** The session the call asks for; `separate` when absent. Ignored on a resume (`sessionId`). */
  session?: SubagentSession
  title: string
  /** The agent name the child's messages carry. */
  agent: string
  /** Base system prompt; the runtime appends the workspace, skills and tool list. */
  systemPrompt: string
  /** `provider/model` ref; the parent's model when absent. */
  model?: string
  variant?: string
  /** Workspace tool names the child may use; all of them when absent. */
  tools?: string[]
  /** The compiled `permission` block for the child's tools. */
  permission?: unknown
  prompt: string
  /**
   * A new separate session that runs on its own: the spawn returns once the
   * child exists, and the API notifies this session when the child's turn
   * ends. Ignored for `same` and for a resume.
   */
  background?: boolean
  /** More `runtime_context` keys for a new separate session (the workflow runner's script). The subagent keys win. */
  runtimeContext?: Record<string, string | number | boolean>
  /**
   * A separate session whose transcript shows no progress for this long is
   * stopped, and the result is an error with `stalled: true`. A tool call the
   * child is still running counts as progress.
   */
  stallMs?: number
  /** The most this call waits for a separate child's turn; 30 min when absent. */
  waitMs?: number
  signal?: AbortSignal
  /** Called once the child exists, before its model runs. */
  onSession?: (session: { sessionId: string; model: { providerID: string; modelID: string } }) => void
}

export interface SpawnSessionResult {
  sessionId: string
  status: 'completed' | 'error' | 'aborted'
  text: string
  error?: string
  model: { providerID: string; modelID: string }
  /** Where the child ran. */
  session?: SubagentSession
  /** Why the child ran somewhere other than the call asked for. */
  notice?: string
  /** The child runs on; its answer arrives later as a notification (`SpawnSessionInput.background`). */
  background?: boolean
  /** The child made no progress for `SpawnSessionInput.stallMs` and was stopped. */
  stalled?: true
}

interface SubagentType {
  description: string
  prompt: string
  model?: string
  variant?: string
  tools?: string[]
  permission?: unknown
}

export const SUBAGENT_PROMPT = [
  'You are a subagent working inside a Kortix sandbox. Another agent delegated one task to you.',
  'Complete the task end to end with the tools you have. Your final message is returned to that agent, not shown to the user: make it a concise, complete report of what you did and found.',
].join('\n')

const BUILT_IN: Record<string, SubagentType> = {
  general: {
    description: 'General-purpose agent for researching complex questions and executing multi-step tasks. Use it to run independent units of work.',
    prompt: SUBAGENT_PROMPT,
  },
  explore: {
    description: 'Fast read-only agent for exploring the workspace: find files by pattern, search code, and answer questions about the codebase. It cannot edit files.',
    prompt: `${SUBAGENT_PROMPT}\nYou are read-only: search and read, never change files.`,
    tools: ['bash', 'read', 'glob', 'grep'],
  },
}

export function subagentTypes(host: KortixHost): Map<string, SubagentType> {
  const types = new Map(host.builtInSubagents() ? Object.entries(BUILT_IN) : [])
  for (const [name, agent] of Object.entries(host.compiledAgents())) {
    if (agent.disable === true || (agent.mode !== 'subagent' && agent.mode !== 'all')) continue
    types.set(name, {
      description: agent.description ?? `The ${name} agent.`,
      prompt: agent.prompt?.trim() || SUBAGENT_PROMPT,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.variant ? { variant: agent.variant } : {}),
      ...(agent.permission !== undefined ? { permission: agent.permission } : {}),
    })
  }
  for (const name of types.keys()) if (!host.subagentAllowed(name)) types.delete(name)
  return types
}

/** An inline, ephemeral agent defined in the call, with no manifest entry. */
const inlineAgent = Type.Object(
  {
    instructions: Type.String({ description: 'The system prompt for this ephemeral agent: who it is and how it works.' }),
    description: Type.Optional(Type.String({ description: 'A short description of this ephemeral agent.' })),
    model: Type.Optional(Type.String({ description: 'A `provider/model` ref for this ephemeral agent; the parent model when absent.' })),
    tools: Type.Optional(Type.Array(Type.String(), { description: 'Workspace tool names this ephemeral agent may use; all of them when absent.' })),
  },
  { description: 'An inline, ephemeral agent defined here instead of a named subagent_type. When set, subagent_type is ignored.' },
)

const parameters = Type.Object({
  description: Type.String({ description: 'A short (3-5 words) description of the task' }),
  prompt: Type.String({ description: 'The task for the agent to perform' }),
  subagent_type: Type.Optional(Type.String({ description: 'The named agent to use for this task. Omit it when you pass an inline `agent` spec.' })),
  agent: Type.Optional(inlineAgent),
  task_id: Type.Optional(Type.String({ description: 'Set only to resume a previous task: the task_id a previous task output returned. The task resumes in the session it was created in.' })),
  session: Type.Optional(
    Type.Union([Type.Literal('separate'), Type.Literal('same')], {
      description:
        'Where the subagent runs. "separate" (default): its own new Kortix session with its own computer, linked to this session, visible in the sidebar, and it keeps running after your turn. Use it for real tasks, long or parallel work, or a whole job handed to another agent. "same": inside this session, instant and with no extra computer. Use it for quick lookups and small sub-steps.',
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        'true: start the subagent in its own new session and return at once, without its result. Its final answer arrives later in this session as a <task-notification> message. Only for a new separate session; ignored with session "same" and with task_id.',
    }),
  ),
})

type SubagentParams = { description: string; prompt: string; subagent_type?: string; agent?: InlineAgent; task_id?: string; session?: SubagentSession; background?: boolean }
interface InlineAgent {
  instructions: string
  description?: string
  model?: string
  tools?: string[]
}

function describe(types: Map<string, SubagentType>, anyProjectAgent = false): string {
  return [
    'Launch a subagent to handle a complex, multi-step task on its own, with a fresh context. The subagent returns one final report.',
    'Pick a named agent type below, or define an inline ephemeral agent in the call.',
    '',
    ...(anyProjectAgent
      ? ["Agent types: any agent of this project, by its name (kortix_agents `list` shows them). It runs in its own new session as that agent, with that agent's instructions and access."]
      : ['Available agent types:', ...[...types].map(([name, type]) => `- ${name}: ${type.description}`)]),
    '',
    'Usage:',
    '- Set subagent_type to one of the types above, OR pass an inline `agent` spec ({ instructions, model?, tools?, description? }) to define one on the fly.',
    '- Write a complete prompt: the subagent sees nothing of this conversation.',
    '- Launch several subagents in one message when their work is independent.',
    '- The result is not shown to the user; summarize what matters in your own reply.',
    '- To continue a previous task with its context, pass the task_id its output returned.',
    '',
    'Session (where the subagent runs):',
    '- session: "separate" (default): the subagent gets its own new Kortix session with its own computer. It is linked to this session as its parent, the user sees it in the sidebar, and it keeps running after your turn ends. Use it for real tasks, long or parallel work, and any whole job you hand to another agent.',
    '- session: "same": the subagent runs inside this session, on this computer. It starts instantly and costs no extra computer. Use it for quick lookups and small sub-steps.',
    '- If a separate session is not possible here, the subagent runs in this session and the result says so.',
    '',
    'Background (background: true):',
    '- The subagent starts in its own new session and the call returns at once with its task_id. Its final answer arrives later in this session as a <task-notification> message, also after your turn has ended. Do not poll or wait for it.',
    '- Use it for long work you do not need before you answer. Without it, the call waits for the subagent\'s result.',
  ].join('\n')
}

/** The extension, bound to the runtime that hosts it. */
export function subagents(host: KortixHost): InlineExtension {
  return { name: 'kortix-subagents', factory: (pi) => register(pi, host) }
}

/** The child agent name an inline ephemeral spec runs under; labels the child's messages. */
export const INLINE_AGENT = 'inline'

function register(pi: ExtensionAPI, host: KortixHost): void {
  // Registered on session_start (and again on reload): the description lists
  // the compiled agents, which change with a live agent-config update.
  pi.on('session_start', () => {
    const description = describe(subagentTypes(host), host.anyProjectAgent?.() === true)
    // Several calls in one message run their subagents at the same time.
    const tool = (name: string, toolDescription: string) => ({
      name,
      label: name,
      description: toolDescription,
      parameters,
      executionMode: 'parallel' as const,
      ...(name === 'agent' && host.codemodeOnly?.() ? { exposure: 'model-only' as const } : {}),
      async execute(_toolCallId: string, params: SubagentParams, signal: AbortSignal | undefined, onUpdate?: (update: { content: never[]; details: unknown }) => void) {
        const spawn = resolveSpawn(params, host)
        const background = params.background === true && params.session !== 'same' && !params.task_id
        const result = await host.spawnSession({
          ...(params.task_id ? { sessionId: params.task_id } : {}),
          ...(params.session ? { session: params.session } : {}),
          ...spawn,
          prompt: params.prompt,
          ...(background ? { background: true } : {}),
          signal,
          // The running part carries the child id at once, so the product links the child while it works.
          onSession: (session) => onUpdate?.({ content: [], details: { ...session, ...(background ? { background: true } : {}) } }),
        })
        if (result.status === 'aborted') throw new Error(`The subagent was aborted. task_id: ${result.sessionId}`)
        const where = result.session ? `\nsession: ${result.session}${result.notice ? ` (${result.notice})` : ''}` : ''
        return {
          content: [{ type: 'text' as const, text: `task_id: ${result.sessionId} (for resuming to continue this task if needed)${where}\n\n${resultBody(result)}` }],
          details: {
            sessionId: result.sessionId,
            model: result.model,
            ...(result.session ? { session: result.session } : {}),
            ...(result.background ? { background: true } : {}),
          },
        }
      },
    })
    pi.registerTool(tool('agent', description))
    // Deprecated alias: OpenCode's name. Same handler, so old prompts and sessions keep working.
    pi.registerTool(tool('task', `Deprecated alias of \`agent\`; prefer \`agent\`. ${description}`))
  })
}

/** The tool output after the `task_id` line: the child's report, its error, or the background hand-off. */
function resultBody(result: SpawnSessionResult): string {
  if (result.status === 'error') return `<task_error>\n${result.error ?? 'The subagent failed.'}\n</task_error>`
  if (result.background) {
    return [
      '<task_started>',
      'The subagent runs in the background in its own session. Its final answer arrives in this session as a <task-notification> message when its turn ends, also after your turn has ended.',
      'Do not poll or wait for it. Continue with other work, or end your turn.',
      '</task_started>',
    ].join('\n')
  }
  return `<task_result>\n${result.text}\n</task_result>`
}

/** The spawn input for a call: an inline ephemeral agent, else the named subagent type. */
function resolveSpawn(params: SubagentParams, host: KortixHost): Omit<SpawnSessionInput, 'prompt' | 'signal' | 'onSession' | 'sessionId' | 'session' | 'background'> {
  const inline = params.agent
  if (inline) {
    return {
      title: `${params.description} (inline agent)`,
      agent: INLINE_AGENT,
      systemPrompt: inline.instructions?.trim() || SUBAGENT_PROMPT,
      ...(inline.model ? { model: inline.model } : {}),
      ...(inline.tools ? { tools: inline.tools } : {}),
    }
  }
  const types = subagentTypes(host)
  const anyProjectAgent = host.anyProjectAgent?.() === true
  if (!params.subagent_type) {
    throw new Error(anyProjectAgent ? "Set subagent_type to a project agent's name (kortix_agents list shows them), or pass an inline `agent` spec." : 'Set subagent_type to a named agent, or pass an inline `agent` spec.')
  }
  const type = types.get(params.subagent_type)
  // A project agent this box does not compile: the API authorizes the name and the child runs as it.
  if (!type && anyProjectAgent && params.session !== 'same') {
    return { title: `${params.description} (@${params.subagent_type} subagent)`, agent: params.subagent_type, systemPrompt: SUBAGENT_PROMPT }
  }
  if (!type) throw new Error(`Unknown subagent_type "${params.subagent_type}". Available: ${[...types.keys()].join(', ')}.`)
  return {
    title: `${params.description} (@${params.subagent_type} subagent)`,
    agent: params.subagent_type,
    systemPrompt: type.prompt,
    ...(type.model ? { model: type.model } : {}),
    ...(type.variant ? { variant: type.variant } : {}),
    ...(type.tools ? { tools: type.tools } : {}),
    ...(type.permission !== undefined ? { permission: type.permission } : {}),
  }
}
