/**
 * kortix_schedules: work that starts by itself — a schedule that starts a new
 * session of an agent ("every Monday at 9, the Researcher sends a summary"),
 * or a reminder that brings THIS session back later ("in 2 hours, check the
 * report"). Both are runtime triggers: they apply at once, with no change to
 * the project files. A My Kortix platform tool (`platform.ts`): every action is
 * one `kortix triggers …` command.
 */
import { adminHref, capRows, cliJson, cliRun, fail, ok, cliArgProblem, type PlatformToolContext } from './platform'

const TOOL = 'kortix_schedules' as const
const ACTIONS = ['list', 'create', 'pause', 'resume', 'delete', 'run_now'] as const

interface TriggerRow {
  slug?: string
  id?: string
  name?: string | null
  prompt?: string | null
  enabled?: boolean
  paused?: boolean
  schedule?: string | null
  cron?: string | null
  every?: string | null
  agent?: string | null
  on?: unknown
  run?: unknown
  source?: unknown
  next_run_at?: string | null
}

function triggerId(row: TriggerRow): string {
  return row.slug ?? row.id ?? ''
}

/** The schedule in plain text, when the row names one. */
function when(row: TriggerRow): string | undefined {
  const on = (row.on ?? row.source ?? {}) as Record<string, unknown>
  const value = row.schedule ?? row.cron ?? row.every ?? on.cron ?? on.every ?? on.at ?? on.schedule
  return typeof value === 'string' && value ? value : undefined
}

function rowsOf(value: unknown): TriggerRow[] {
  if (Array.isArray(value)) return value as TriggerRow[]
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  return [...(Array.isArray(record.triggers) ? record.triggers : []), ...(Array.isArray(record.runtime) ? record.runtime : [])] as TriggerRow[]
}

async function list(context: PlatformToolContext) {
  const read = await cliJson(['triggers', 'ls', '--json'], context)
  if ('error' in read) return fail(TOOL, 'list', 'Could not list the schedules', read.error, context)
  const rows = rowsOf(read.value)
  return ok(
    TOOL,
    'list',
    {
      title: rows.length === 1 ? '1 schedule' : `${rows.length} schedules`,
      rows: capRows(
        rows.map((row) => {
          const schedule = when(row)
          const label = row.name || row.prompt || triggerId(row)
          return {
            title: label.length > 80 ? `${label.slice(0, 77)}…` : label,
            ...(schedule ? { detail: schedule } : {}),
            badge: row.enabled === false || row.paused ? 'paused' : 'on',
          }
        }),
      ),
      links: [{ label: 'Triggers', href: adminHref(context.env, 'triggers') }],
    },
    read.value,
  )
}

/** The `--every` / `--cron` / `--at` / `--in` flags of a create, or why there are none. */
function scheduleFlags(args: Record<string, any>): string[] | string {
  const flags: string[] = []
  if (typeof args.every === 'string' && args.every) flags.push('--every', args.every)
  else if (typeof args.cron === 'string' && args.cron) flags.push('--cron', args.cron)
  else if (typeof args.at === 'string' && args.at) flags.push('--at', args.at)
  else if (typeof args.in === 'string' && args.in) flags.push('--in', args.in)
  else return 'Pass one of: every ("1h", "1d"), cron ("0 9 * * 1"), at (an ISO time) or in ("2h").'
  if (typeof args.timezone === 'string' && args.timezone && flags[0] === '--cron') flags.push('--timezone', args.timezone)
  return flags
}

async function create(args: Record<string, any>, context: PlatformToolContext) {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!prompt) {
    return fail(TOOL, 'create', 'What should it do?', { kind: 'invalid', message: 'Missing `prompt`. Call create again with prompt set to the message each run starts with, e.g. prompt: "Remind me to review the draft".' }, context)
  }
  const badPrompt = cliArgProblem('prompt', prompt, 'text')
  if (badPrompt) return fail(TOOL, 'create', 'What should it do?', { kind: 'invalid', message: badPrompt }, context)
  const schedule = scheduleFlags(args)
  if (typeof schedule === 'string') return fail(TOOL, 'create', 'When should it run?', { kind: 'invalid', message: schedule }, context)
  const agent = typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : null
  // No agent: the trigger wakes this session (a reminder). An agent: each run is a new session of it.
  const badAgent = agent ? cliArgProblem('agent', agent) : null
  if (badAgent) return fail(TOOL, 'create', 'Which agent?', { kind: 'invalid', message: badAgent }, context)
  const target = agent ? [`--agent=${agent}`] : []
  const made = await cliRun(['triggers', 'add', prompt, '--runtime', ...schedule, ...target], context)
  if ('error' in made) return fail(TOOL, 'create', 'Could not create the schedule', made.error, context)
  const id = made.text.match(/trigger\.[0-9a-f]+/)?.[0] ?? made.text.split('\n').pop() ?? ''
  const spoken = schedule.slice(1).join(' ')
  return ok(
    TOOL,
    'create',
    {
      title: agent ? `${agent} runs ${schedule[0] === '--in' ? `in ${spoken}` : schedule[0] === '--at' ? `at ${spoken}` : spoken}` : `Reminder set: ${spoken}`,
      subtitle: prompt.length > 140 ? `${prompt.slice(0, 137)}…` : prompt,
      links: [{ label: 'Triggers', href: adminHref(context.env, 'triggers') }],
    },
    { id, agent, prompt, schedule: spoken },
  )
}

const VERB: Record<string, { args: string; title: string }> = {
  pause: { args: 'pause', title: 'Paused' },
  resume: { args: 'resume', title: 'Running again' },
  delete: { args: 'rm', title: 'Deleted' },
  run_now: { args: 'run', title: 'Ran it now' },
}

async function change(action: string, id: string, context: PlatformToolContext) {
  const verb = VERB[action]!
  // A runtime trigger (`trigger.<hex>`) is removed as it is; a project-file trigger needs `--apply` to change the live project.
  const apply = action === 'delete' && !id.startsWith('trigger.') ? ['--apply'] : []
  const done = await cliRun(['triggers', verb.args, id, ...apply], context)
  if ('error' in done) return fail(TOOL, action, `Could not ${action.replace('_', ' ')} it`, done.error, context)
  return ok(TOOL, action, { title: verb.title, subtitle: id, links: [{ label: 'Triggers', href: adminHref(context.env, 'triggers') }] })
}

export default {
  description:
    'Work that starts by itself. ' +
    '`create` needs `prompt` (the message each run starts with) and exactly ONE of every ("30m", "1h", "1d"), cron ("0 9 * * 1" = Mondays 9:00, plus timezone like "Europe/Berlin"), at (an ISO time) or in ("2h"). ' +
    'With `agent`, each run starts a new session of that agent; without it, the run is a reminder that brings THIS session back. ' +
    'Other actions: `list`; `pause`, `resume`, `delete`, `run_now` (each needs `id`, as list shows it).',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: 'What to do.' },
      prompt: { type: 'string', description: 'Required for create: the message each run starts with.' },
      agent: { type: 'string', description: 'For create: the agent each run starts a session of. Omit for a reminder to this session.' },
      every: { type: 'string', description: 'For create: repeat interval, e.g. "1h", "1d".' },
      cron: { type: 'string', description: 'For create: a cron expression, e.g. "0 9 * * 1".' },
      timezone: { type: 'string', description: 'For create with cron: an IANA time zone.' },
      at: { type: 'string', description: 'For create: one time, ISO 8601.' },
      in: { type: 'string', description: 'For create: once, after this long, e.g. "2h".' },
      id: { type: 'string', description: 'For pause, resume, delete, run_now: the schedule id.' },
    },
    required: ['action'],
  },
  async execute(args: Record<string, any>, context: PlatformToolContext) {
    const action = String(args.action ?? '')
    if (action === 'list') return list(context)
    if (action === 'create') return create(args, context)
    if (!(ACTIONS as readonly string[]).includes(action)) return fail(TOOL, action, 'Unknown action', { kind: 'invalid', message: `Use one of: ${ACTIONS.join(', ')}.` }, context)
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (!id) return fail(TOOL, action, 'Which schedule?', { kind: 'invalid', message: 'Pass id, as list shows it.' }, context)
    // An option-shaped id would leave pause/resume with no trigger, and the CLI would flip the project-wide switch.
    const badId = cliArgProblem('id', id)
    if (badId) return fail(TOOL, action, 'Which schedule?', { kind: 'invalid', message: badId }, context)
    return change(action, id, context)
  },
}
