/**
 * Subagents: the `agent` tool for pi (OpenCode called it `task`).
 *
 * The tool spawns one subagent, either a named agent declared in the project
 * (`subagent_type`) or an inline ephemeral agent defined in the call (`agent`,
 * no manifest entry). It keeps OpenCode's contract end to end, because the
 * product already renders it: input `{ description, prompt, subagent_type?,
 * agent?, task_id? }`, the child session id in the tool part's
 * `metadata.sessionId` (the web client's `getChildSessionId` → `TaskTool`
 * preview and full view), and an output that starts `task_id: <id>` so the
 * model can resume the same child.
 *
 * It registers under two names with one handler: `agent` (the name to use) and
 * `task` (a deprecated alias, kept so prompts and sessions written for OpenCode
 * keep working). Both are callable and behave identically.
 *
 * A child is an in-process pi agent in a child session of this session (see
 * `PiRuntime.spawnSession`), not a second process: no boot cost, no port.
 *
 * Named subagent types: `general` (every workspace tool), `explore` (read-only
 * search), and every compiled agent whose `mode` is `subagent` or `all`. A
 * compiled agent with a built-in's name replaces it. kortix.yaml v3 has no
 * built-in: only declared agents. The calling agent's `permission.task` rule
 * filters the list: a denied type is not offered, and a call to it is refused.
 * An inline agent has no name to deny; the session's tool rules still gate every
 * call its child makes, so delegating never unlocks a denied call.
 * Children get no `agent`/`task` (no nesting) and no `question` (nobody answers a child).
 */
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import type { CompiledAgent } from '@kortix/api-contract/runtime-relay'
import { Type } from 'typebox'

/** What the subagents extension needs from the runtime that hosts it. */
export interface KortixHost {
  /** The compiled agent config's `agent` map (`KORTIX_COMPILED_AGENT_CONFIG`). */
  compiledAgents(): Record<string, CompiledAgent>
  /** False for kortix.yaml v3: no built-in `general`/`explore`. */
  builtInSubagents(): boolean
  /** The calling agent's `permission.task` rule for this subagent name is not `deny`. */
  subagentAllowed(name: string): boolean
  /** Run one prompt in a child session of this session and return its final answer. */
  spawnSession(input: SpawnSessionInput): Promise<SpawnSessionResult>
}

export interface SpawnSessionInput {
  /** Continue this existing child session instead of creating one. */
  sessionId?: string
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
  /** OpenCode permission config for the child's tools. */
  permission?: unknown
  prompt: string
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
}

interface SubagentType {
  description: string
  prompt: string
  model?: string
  variant?: string
  tools?: string[]
  permission?: unknown
}

const SUBAGENT_PROMPT = [
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
  task_id: Type.Optional(Type.String({ description: 'Set only to resume a previous task: the task_id a previous task output returned' })),
})

type SubagentParams = { description: string; prompt: string; subagent_type?: string; agent?: InlineAgent; task_id?: string }
interface InlineAgent {
  instructions: string
  description?: string
  model?: string
  tools?: string[]
}

function describe(types: Map<string, SubagentType>): string {
  return [
    'Launch a subagent to handle a complex, multi-step task on its own, with a fresh context. The subagent returns one final report.',
    'Pick a named agent type below, or define an inline ephemeral agent in the call.',
    '',
    'Available agent types:',
    ...[...types].map(([name, type]) => `- ${name}: ${type.description}`),
    '',
    'Usage:',
    '- Set subagent_type to one of the types above, OR pass an inline `agent` spec ({ instructions, model?, tools?, description? }) to define one on the fly.',
    '- Write a complete prompt: the subagent sees nothing of this conversation.',
    '- Launch several subagents in one message when their work is independent.',
    '- The result is not shown to the user; summarize what matters in your own reply.',
    '- To continue a previous task with its context, pass the task_id its output returned.',
  ].join('\n')
}

/** The extension, bound to the runtime that hosts it. */
export function subagents(host: KortixHost): InlineExtension {
  return { name: 'kortix-subagents', factory: (pi) => register(pi, host) }
}

/** The child agent name an inline ephemeral spec runs under; labels the child's messages. */
const INLINE_AGENT = 'inline'

function register(pi: ExtensionAPI, host: KortixHost): void {
  // Registered on session_start (and again on reload): the description lists
  // the compiled agents, which change with a live agent-config update.
  pi.on('session_start', () => {
    const description = describe(subagentTypes(host))
    // Several calls in one message run their subagents at the same time, like OpenCode.
    const tool = (name: string, toolDescription: string) => ({
      name,
      label: name,
      description: toolDescription,
      parameters,
      executionMode: 'parallel' as const,
      async execute(_toolCallId: string, params: SubagentParams, signal: AbortSignal | undefined, onUpdate?: (update: { content: never[]; details: unknown }) => void) {
        const spawn = resolveSpawn(params, host)
        const result = await host.spawnSession({
          ...(params.task_id ? { sessionId: params.task_id } : {}),
          ...spawn,
          prompt: params.prompt,
          signal,
          // The running part carries the child id at once, so the product links the child while it works.
          onSession: (session) => onUpdate?.({ content: [], details: session }),
        })
        if (result.status === 'aborted') throw new Error(`The subagent was aborted. task_id: ${result.sessionId}`)
        const body = result.status === 'error' ? `<task_error>\n${result.error ?? 'The subagent failed.'}\n</task_error>` : `<task_result>\n${result.text}\n</task_result>`
        return {
          content: [{ type: 'text' as const, text: `task_id: ${result.sessionId} (for resuming to continue this task if needed)\n\n${body}` }],
          details: { sessionId: result.sessionId, model: result.model },
        }
      },
    })
    pi.registerTool(tool('agent', description))
    // Deprecated alias: OpenCode's name. Same handler, so old prompts and sessions keep working.
    pi.registerTool(tool('task', `Deprecated alias of \`agent\`; prefer \`agent\`. ${description}`))
  })
}

/** The spawn input for a call: an inline ephemeral agent, else the named subagent type. */
function resolveSpawn(params: SubagentParams, host: KortixHost): Omit<SpawnSessionInput, 'prompt' | 'signal' | 'onSession' | 'sessionId'> {
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
  if (!params.subagent_type) throw new Error('Set subagent_type to a named agent, or pass an inline `agent` spec.')
  const type = types.get(params.subagent_type)
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
