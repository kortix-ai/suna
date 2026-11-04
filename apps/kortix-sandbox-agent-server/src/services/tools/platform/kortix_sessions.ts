/**
 * kortix_sessions: the project's sessions — what is running, what one said
 * last, a follow-up message to one, and stopping one. Starting work is the
 * `agent` tool (each hand-off is its own session), not this tool. A My Kortix
 * platform tool (`platform.ts`): every action is one `kortix sessions …` command.
 */
import { capRows, cliJson, cliRun, fail, ok, projectHref, sessionHref, cliArgProblem, type PlatformToolContext } from './platform'

const TOOL = 'kortix_sessions' as const
const ACTIONS = ['list', 'read', 'message', 'stop'] as const

interface SessionRow {
  session_id?: string
  id?: string
  title?: string | null
  name?: string | null
  agent_name?: string | null
  status?: string | null
  runtime_status?: string | null
  metadata?: Record<string, unknown> | null
}

function sessionId(row: SessionRow): string {
  return row.session_id ?? row.id ?? ''
}

function sessionTitle(row: SessionRow): string {
  const meta = row.metadata ?? {}
  const named = row.title || row.name || (typeof meta.title === 'string' ? meta.title : '') || (typeof meta.name === 'string' ? meta.name : '')
  return named || `Session ${sessionId(row).slice(0, 8)}`
}

/** A plain word for a session's state. */
function stateWord(row: SessionRow): string | undefined {
  const runtime = row.runtime_status ?? ''
  if (runtime === 'busy' || runtime === 'running' || runtime === 'retry') return 'working'
  if (row.status === 'stopped' || row.status === 'archived') return 'stopped'
  if (row.status === 'failed' || row.status === 'error') return 'failed'
  return row.status ?? undefined
}

async function list(args: Record<string, any>, context: PlatformToolContext) {
  const flags: string[] = []
  if (typeof args.children_of === 'string' && args.children_of) flags.push(`--children=${args.children_of}`)
  else if (args.filter === 'mine') flags.push('--mine')
  else if (args.filter === 'automated') flags.push('--automated')
  if (typeof args.search === 'string' && args.search.trim()) flags.push(`--search=${args.search.trim()}`)
  const read = await cliJson<SessionRow[]>(['sessions', 'ls', ...flags, '--json'], context)
  if ('error' in read) return fail(TOOL, 'list', 'Could not list the sessions', read.error, context)
  const rows = Array.isArray(read.value) ? read.value : []
  const working = rows.filter((row) => stateWord(row) === 'working').length
  return ok(
    TOOL,
    'list',
    {
      title: rows.length === 1 ? '1 session' : `${rows.length} sessions`,
      ...(working > 0 ? { subtitle: `${working} working right now` } : {}),
      rows: capRows(
        rows.map((row) => {
          const state = stateWord(row)
          return {
            title: sessionTitle(row),
            ...(row.agent_name ? { detail: row.agent_name } : {}),
            ...(state ? { badge: state } : {}),
            href: sessionHref(context.env, sessionId(row)),
          }
        }),
      ),
    },
    rows.map((row) => ({ session_id: sessionId(row), title: sessionTitle(row), agent: row.agent_name ?? null, state: stateWord(row) ?? null })),
  )
}

/** The newest assistant text anywhere in a `sessions log --json` answer. */
function lastAnswer(log: unknown): string {
  let found = ''
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    const role = record.role ?? (record.info as Record<string, unknown> | undefined)?.role
    if (role === 'assistant' && typeof record.text === 'string' && record.text.trim()) found = record.text.trim()
    for (const value of Object.values(record)) if (value && typeof value === 'object') visit(value)
  }
  visit(log)
  return found
}

async function read(id: string, context: PlatformToolContext) {
  const log = await cliJson(['sessions', 'log', id, '--limit', '6', '--json'], context)
  if ('error' in log) return fail(TOOL, 'read', 'Could not read the session', log.error, context)
  const answer = lastAnswer(log.value)
  return ok(
    TOOL,
    'read',
    {
      title: answer ? 'Latest answer' : 'No answer yet',
      ...(answer ? { subtitle: answer.length > 280 ? `${answer.slice(0, 277)}…` : answer } : {}),
      links: [{ label: 'Open session', href: sessionHref(context.env, id) }],
    },
    { session_id: id, answer: answer.slice(0, 8000) },
  )
}

async function message(id: string, text: string, context: PlatformToolContext) {
  // `--queue`: the prompt lands in the session's durable inbox, and a stopped session wakes for it.
  const sent = await cliRun(['sessions', 'chat', id, `--prompt=${text}`, '--queue'], context)
  if ('error' in sent) return fail(TOOL, 'message', 'Could not send the message', sent.error, context)
  return ok(TOOL, 'message', {
    title: 'Message sent',
    subtitle: text.length > 140 ? `${text.slice(0, 137)}…` : text,
    status: 'running',
    links: [{ label: 'Open session', href: sessionHref(context.env, id) }],
  })
}

async function stop(id: string, context: PlatformToolContext) {
  const stopped = await cliRun(['sessions', 'stop', id], context)
  if ('error' in stopped) return fail(TOOL, 'stop', 'Could not stop the session', stopped.error, context)
  return ok(TOOL, 'stop', {
    title: 'Session stopped',
    subtitle: 'Its work is saved. A new message wakes it up again.',
    links: [{ label: 'Open session', href: sessionHref(context.env, id) }, { label: 'All sessions', href: projectHref(context.env, '/sessions') }],
  })
}

export default {
  description:
    "The project's sessions: each is one piece of work by one agent on its own computer. " +
    'Actions: `list` (optional filter "mine" | "automated", search, or children_of a session id); `read` (session_id: its latest answer); ' +
    '`message` (session_id, text: a follow-up the session works on next; a stopped session wakes up); `stop` (session_id). ' +
    'To start new work, hand it off with the `agent` tool instead.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: 'What to do.' },
      session_id: { type: 'string', description: 'The session, for read, message and stop.' },
      text: { type: 'string', description: 'The message, for message.' },
      filter: { type: 'string', enum: ['all', 'mine', 'automated'], description: 'For list: whose sessions. Default all.' },
      search: { type: 'string', description: 'For list: words to match.' },
      children_of: { type: 'string', description: 'For list: only the sessions this session started.' },
    },
    required: ['action'],
  },
  async execute(args: Record<string, any>, context: PlatformToolContext) {
    const action = String(args.action ?? '')
    const id = typeof args.session_id === 'string' ? args.session_id.trim() : ''
    if (action === 'list') return list(args, context)
    if (!(ACTIONS as readonly string[]).includes(action)) return fail(TOOL, action, 'Unknown action', { kind: 'invalid', message: `Use one of: ${ACTIONS.join(', ')}.` }, context)
    if (!id) return fail(TOOL, action, 'Which session?', { kind: 'invalid', message: 'Pass session_id.' }, context)
    const badId = cliArgProblem('session_id', id)
    if (badId) return fail(TOOL, action, 'Which session?', { kind: 'invalid', message: badId }, context)
    if (action === 'read') return read(id, context)
    if (action === 'stop') return stop(id, context)
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (!text) return fail(TOOL, action, 'What should I send?', { kind: 'invalid', message: 'Pass text.' }, context)
    return message(id, text, context)
  },
}
