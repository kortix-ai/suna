/**
 * kortix_agents: the project's agents — list them, read one, create one,
 * change its settings, and set what it may use. A My Kortix platform tool
 * (`platform.ts`): every action is one `kortix agents …` command.
 */
import { agentHref, capRows, cliJson, diff, fail, listArg, ok, show, withJsonFile, cliArgProblem, type PlatformToolContext } from './platform'

const TOOL = 'kortix_agents' as const
const ACTIONS = ['list', 'get', 'create', 'update', 'set_access'] as const

interface ListedAgent {
  name: string
  model?: string | null
  description?: string
  builtin?: boolean
  enabled?: boolean
}

interface AgentConfig {
  agent?: string
  builtin?: string
  editable?: boolean
  block?: Record<string, unknown> | null
}

/** The settings a before → after row names, in the order a person reads them. */
const SETTING_FIELDS = ['description', 'model', 'prompt', 'connectors', 'secrets', 'apps', 'skills', 'tools', 'kortix_permissions', 'space', 'enabled']

/** One flat view of an agent block: `behavior.description`, `.prompt` and `.model` lifted to the top. */
function flat(block: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const b = block ?? {}
  const behavior = (b.behavior ?? {}) as Record<string, unknown>
  return { ...b, description: behavior.description ?? b.description, prompt: behavior.prompt ?? b.prompt, model: behavior.model ?? b.model }
}

/**
 * The keys `PUT /agents/:name/config` accepts (`AgentBlockSchema`,
 * apps/api/src/projects/routes/agent-config.ts). The GET answers more (its
 * mirror of `behavior` under its old harness name, `network_egress`), and the strict PUT
 * refuses any key it does not know.
 */
const PUT_KEYS = new Set([
  'enabled', 'tools', 'sandbox', 'space', 'connectors', 'connectors_required', 'policy_sets', 'secrets', 'skills', 'apps',
  'kortix_permissions', 'subagents', 'commands', 'extensions', 'codemode', 'repository_access', 'workspace', 'file', 'behavior',
])

async function list(context: PlatformToolContext) {
  const read = await cliJson<{ agents?: ListedAgent[] }>(['agents', 'ls', '--json'], context)
  if ('error' in read) return fail(TOOL, 'list', 'Could not list the agents', read.error, context)
  const agents = read.value.agents ?? []
  return ok(
    TOOL,
    'list',
    {
      title: agents.length === 1 ? '1 agent' : `${agents.length} agents`,
      rows: capRows(
        agents.map((agent) => ({
          title: agent.name,
          ...(agent.description ? { detail: agent.description } : {}),
          ...(agent.enabled === false ? { badge: 'off' } : agent.builtin ? { badge: 'built in' } : {}),
          // A built-in agent (My Kortix) has no agent page: the project home starts it.
          ...(agent.builtin ? {} : { href: agentHref(context.env, agent.name) }),
        })),
      ),
    },
    read.value,
  )
}

async function get(name: string, context: PlatformToolContext) {
  const read = await cliJson<AgentConfig>(['agents', 'config', name, '--json'], context)
  if ('error' in read) return fail(TOOL, 'get', `Could not read ${name}`, read.error, context)
  const settings = flat(read.value.block)
  return ok(
    TOOL,
    'get',
    {
      title: name,
      ...(typeof settings.description === 'string' ? { subtitle: settings.description } : {}),
      rows: SETTING_FIELDS.filter((field) => field !== 'description' && show(settings[field]) !== null).map((field) => ({
        title: field,
        detail: show(settings[field])!,
      })),
      ...(read.value.builtin ? {} : { links: [{ label: 'Open agent', href: agentHref(context.env, name) }] }),
    },
    read.value,
  )
}

/** The block a create or update sends: the model's fields, mapped onto the config shape. */
function blockFrom(args: Record<string, any>, base: Record<string, unknown>): Record<string, unknown> {
  const block: Record<string, unknown> = Object.fromEntries(Object.entries(base).filter(([key]) => PUT_KEYS.has(key)))
  // The description, instructions and model live in the agent's `.md` (`behavior`), not in its kortix.yaml block.
  const behavior = { ...((base.behavior ?? {}) as Record<string, unknown>) }
  if (typeof args.instructions === 'string') behavior.prompt = args.instructions
  if (typeof args.model === 'string') behavior.model = args.model
  if (typeof args.description === 'string') behavior.description = args.description
  if (Object.keys(behavior).length > 0) block.behavior = behavior
  for (const key of ['connectors', 'secrets', 'apps', 'skills', 'tools', 'kortix_permissions'] as const) {
    if (args[key] !== undefined) block[key] = args[key]
  }
  if (typeof args.space === 'string' && args.space !== 'none') block.space = args.space
  if (typeof args.enabled === 'boolean') block.enabled = args.enabled
  return block
}

async function save(action: 'create' | 'update', name: string, args: Record<string, any>, context: PlatformToolContext) {
  const current = await cliJson<AgentConfig>(['agents', 'config', name, '--json'], context)
  const exists = !('error' in current)
  if (action === 'create' && exists) {
    return fail(TOOL, action, `${name} already exists`, { kind: 'invalid', message: `An agent named ${name} already exists. Use action "update" to change it.` }, context)
  }
  if (action === 'update' && !exists) return fail(TOOL, action, `Could not read ${name}`, current.error, context)
  if (exists && current.value.builtin) {
    return fail(TOOL, action, `${name} is built in`, { kind: 'invalid', message: 'Kortix maintains this agent: its settings cannot be changed.' }, context)
  }
  const before = exists ? (current.value.block ?? {}) : {}
  const block = blockFrom(args, before)
  // The CLI reads the block from a file: its flag parser takes `-` for a missing value.
  const saved = await withJsonFile(block, (file) => cliJson<{ block?: Record<string, unknown> }>(['agents', 'config', name, '--file', file, '--json'], context))
  if ('error' in saved) return fail(TOOL, action, action === 'create' ? `Could not create ${name}` : `Could not change ${name}`, saved.error, context)
  const changes = diff(flat(before), flat(saved.value.block ?? block), SETTING_FIELDS)
  return ok(
    TOOL,
    action,
    {
      title: action === 'create' ? `Created ${name}` : changes.length > 0 ? `Changed ${name}` : `${name} is unchanged`,
      subtitle: 'Saved to the project settings.',
      changes,
      links: [{ label: 'Open agent', href: agentHref(context.env, name) }],
    },
    saved.value,
  )
}

async function setAccess(name: string, args: Record<string, any>, context: PlatformToolContext) {
  const flags: string[] = []
  for (const key of ['connectors', 'secrets', 'apps'] as const) {
    const value = listArg(args[key])
    if (value !== null) flags.push(`--${key}=${value}`)
  }
  if (flags.length === 0) {
    return fail(TOOL, 'set_access', 'Nothing to change', { kind: 'invalid', message: 'Pass connectors, secrets or apps.' }, context)
  }
  const before = await cliJson<Record<string, unknown>>(['agents', 'scope', name, '--show', '--json'], context)
  if ('error' in before) return fail(TOOL, 'set_access', `Could not read ${name}`, before.error, context)
  const set = await cliJson<Record<string, unknown>>(['agents', 'scope', name, ...flags, '--json'], context)
  if ('error' in set) return fail(TOOL, 'set_access', `Could not change what ${name} may use`, set.error, context)
  const after = await cliJson<Record<string, unknown>>(['agents', 'scope', name, '--show', '--json'], context)
  const now = 'error' in after ? set.value : after.value
  return ok(
    TOOL,
    'set_access',
    {
      title: `Changed what ${name} may use`,
      changes: diff(before.value, now, ['connectors', 'secrets', 'apps']),
      links: [{ label: 'Open agent', href: agentHref(context.env, name) }],
    },
    now,
  )
}

export default {
  description:
    "The project's agents: each one is a colleague with one job, its own instructions and model, and a limited set of connectors, secrets and apps it may use. " +
    'Actions: `list`; `get` (name); `create` (name, description, instructions, optional model, connectors, skills, tools); ' +
    '`update` (name, plus only the fields to change); `set_access` (name, connectors / secrets / apps: a list, "all" or "none"). ' +
    'Before `set_access` or an `update` that gives an agent more access, show the person what changes and ask once. ' +
    'The result shows the person a card; tell them the outcome in plain words.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: 'What to do.' },
      name: { type: 'string', description: 'The agent name (lowercase, hyphens), for every action except list.' },
      description: { type: 'string', description: 'One line: what this agent does.' },
      instructions: { type: 'string', description: "The agent's instructions: who it is, what it does, how it works." },
      model: { type: 'string', description: 'A model id; omit to follow the project default.' },
      connectors: { description: 'Connector slugs it may use, "all" or "none".', anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
      secrets: { description: 'Secret names it receives, "all" or "none".', anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
      apps: { description: 'App slugs it may open, "all" or "none".', anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
      skills: { type: 'array', items: { type: 'string' }, description: 'Skill names it may load.' },
      tools: { description: 'Tools it may use.', anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }, { type: 'object' }] },
      kortix_permissions: { description: 'Kortix actions it may take, or "all".', anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
      space: { type: 'string', description: 'The space it belongs to.' },
      enabled: { type: 'boolean', description: 'Turn the agent on or off.' },
    },
    required: ['action'],
  },
  async execute(args: Record<string, any>, context: PlatformToolContext) {
    const action = String(args.action ?? '')
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (action === 'list') return list(context)
    if (!(ACTIONS as readonly string[]).includes(action)) return fail(TOOL, action, 'Unknown action', { kind: 'invalid', message: `Use one of: ${ACTIONS.join(', ')}.` }, context)
    if (!name) return fail(TOOL, action, 'Which agent?', { kind: 'invalid', message: 'Pass the agent name.' }, context)
    const badName = cliArgProblem('name', name)
    if (badName) return fail(TOOL, action, 'Which agent?', { kind: 'invalid', message: badName }, context)
    if (action === 'get') return get(name, context)
    if (action === 'set_access') return setAccess(name, args, context)
    return save(action as 'create' | 'update', name, args, context)
  },
}
