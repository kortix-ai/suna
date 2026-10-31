/**
 * kortix_schedules: work that starts by itself, and the follow-through that
 * keeps a long task alive.
 *
 * - `follow_up`: a loop that brings THIS session back on a schedule
 *   (`kortix loop "<text>" --in|--at|--every|--cron`).
 * - `wake_on`: a trigger that wakes THIS session when something happens: a
 *   change request merges, a webhook is called, a connector event, an App
 *   event (`kortix triggers add "<text>" --on …`).
 * - `events`: the event types a connector can wake a session with.
 * - `create` with `agent`: a schedule that starts a new session of an agent.
 * - `list`, `pause`, `resume`, `run_now`, `remove` (alias `delete`).
 *
 * Everything is a runtime row in the database: it applies at once, with no
 * change to the project files. A My Kortix platform tool (`platform.ts`): every
 * action is one or two `kortix` commands. Every model-chosen value goes through
 * `cliArgProblem` (CWE-88); flag values go as `--flag=value`, which the CLI
 * never reads as an option.
 */
import type { KortixCardRow, KortixToolError } from '@kortix/api-contract/kortix-tool-card'
import { adminHref, capRows, cliArgProblem, cliError, cliJson, cliRun, fail, ok, parseJson, runKortix, type PlatformToolContext } from './platform'

const TOOL = 'kortix_schedules' as const
/**
 * The ids the API issues for runtime rows: `reminder.<12 hex>` (a loop of a
 * session, `session-reminders.ts`), `trigger.<12 hex>` (`runtime-triggers.ts`),
 * `automation.<12 hex>` (a runtime trigger from before the rename). The same
 * shape as the CLI's `RUNTIME_ID`.
 */
const RUNTIME_ID = /^(?:reminder|trigger|automation)\.[0-9a-f]{12}$/
/** A kortix.yaml trigger's slug, the manifest grammar (`@kortix/manifest-schema` `SLUG_RE`). */
const TRIGGER_SLUG = /^[a-z0-9][a-z0-9_-]{0,127}$/
const ACTIONS = ['follow_up', 'wake_on', 'events', 'list', 'create', 'pause', 'resume', 'remove', 'delete', 'run_now'] as const
const WAKE_ON = ['cr_merged', 'webhook', 'connector_event', 'app_event'] as const

/** A trigger's source, as `GET /triggers/all` and `POST /triggers/runtime` return it. */
interface TriggerSource {
  type?: string
  cron?: string | null
  every?: string | null
  at?: string | null
  timezone?: string
  secret_env?: string | null
  webhook_url?: string
  connector?: string | null
  event?: string | null
  app?: string | null
  cr_id?: string | null
  base?: string | null
}

/** A kortix.yaml trigger (`GET /triggers`) or a runtime trigger (`GET /triggers/all`), loosely. */
interface TriggerRow {
  slug?: string
  id?: string
  name?: string | null
  prompt?: string | null
  prompt_template?: string | null
  enabled?: boolean
  paused?: boolean
  state?: string
  schedule?: string | null
  cron?: string | null
  every?: string | null
  agent?: string | null
  on?: unknown
  run?: unknown
  source?: TriggerSource
  target?: { kind?: string; session_id?: string }
  next_fire_at?: string | null
}

/** One row of `kortix loops ls --json`: a loop, or a trigger that wakes this session. */
interface LoopRow {
  id: string
  source_type?: string
  name?: string | null
  prompt: string
  every?: string | null
  cron?: string | null
  timezone?: string
  at?: string | null
  state?: string
  next_fire_at?: string | null
  last_error?: string | null
}

/** An ISO instant as "2026-10-31 14:00 UTC". */
function instant(iso: string | null | undefined): string | null {
  if (!iso) return null
  const time = new Date(iso)
  return Number.isNaN(time.getTime()) ? iso : `${time.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

const short = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** What brings a trigger back, in plain words: "every 3h", "change request 42 merges". */
function condition(source: TriggerSource | undefined): string {
  switch (source?.type) {
    case 'change_request':
      return source.cr_id ? `change request ${source.cr_id} merges` : source.base ? `a change request merges into ${source.base}` : 'any change request merges'
    case 'webhook':
      return 'the webhook is called'
    case 'event':
      return `${source.connector ?? 'a connector'} sends ${source.event ?? 'an event'}`
    case 'app':
      return source.app ? `App ${source.app} sends an event` : 'an App sends an event'
    default:
      return schedule(source ?? {})
  }
}

/** A schedule in plain words. */
function schedule(row: { cron?: string | null; every?: string | null; at?: string | null; timezone?: string }): string {
  if (row.cron) return `cron ${row.cron}${row.timezone && row.timezone !== 'UTC' ? ` (${row.timezone})` : ''}`
  if (row.every) return `every ${row.every}`
  if (row.at) return `once at ${instant(row.at)}`
  return 'once'
}

const badge = (state: string | undefined, paused?: boolean) => (paused || state === 'paused' ? 'paused' : state === 'done' ? 'done' : 'on')

/**
 * Run one command and parse its JSON. A project feature flag that is off (403
 * `feature_disabled`) prints the server's sentence on stderr, with no machine
 * line: it becomes one plain instruction for the person.
 */
async function runJson<T>(args: string[], context: PlatformToolContext): Promise<{ value: T } | { error: KortixToolError }> {
  const run = await runKortix(args, context)
  if (run.code !== 0) {
    const off = run.stderr.split('\n').find((line) => /is not enabled for this project/.test(line))
    if (off) {
      const sentence = off.replace(/^\W+/, '').trim()
      return { error: { kind: 'failed', message: `${sentence} Ask the person or a project admin to turn it on.` } }
    }
    return { error: cliError(run) }
  }
  const value = parseJson<T>(run.stdout)
  return value === null ? { error: { kind: 'failed', message: 'The command answered with no JSON.' } } : { value }
}

/** Keys a model sends for `text`, in the order one is taken. */
const TEXT_KEYS = ['text', 'prompt', 'message', 'note'] as const

/** A one-line call that works, per action: what a refusal for a missing `text` shows. */
const TEXT_EXAMPLE: Record<'follow_up' | 'wake_on', string> = {
  follow_up: '{"action":"follow_up","in":"4d","text":"Check replies to the sticker quotes sent 2026-10-31. Chase non-responders once; remove this on 2026-11-14."}',
  wake_on: '{"action":"wake_on","on":"cr_merged","cr":"42","text":"Change request 42 merged: verify the deploy and tell the person."}',
}

/**
 * The required `text`: what the woken turn reads. `prompt`, `message` and
 * `note` count as `text` (a model that guesses the name still sets its
 * follow-up); every other key the call does not use is ignored.
 */
function wakeText(args: Record<string, any>, action: 'follow_up' | 'wake_on'): string | { error: string } {
  const key = TEXT_KEYS.find((k) => typeof args[k] === 'string' && args[k].trim())
  const text = key ? String(args[key]).trim() : ''
  if (!text) {
    return { error: `Missing \`text\`: what the woken turn reads (what was done, what to check, what to do on each outcome, an end date). Call again with it, e.g. ${TEXT_EXAMPLE[action]}` }
  }
  const problem = cliArgProblem('text', text, 'text')
  return problem ? { error: problem } : text
}

/** The schedule keys of a follow-up, in the order one is used when a call passes several. */
const SCHEDULE_KEYS = ['at', 'in', 'cron', 'every'] as const

/** A named word parameter, checked, or the reason it cannot go to the CLI. */
function word(args: Record<string, any>, field: string, hint: string): string | { error: string } {
  const raw = args[field]
  const value = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
  if (!value) return { error: `Missing \`${field}\`: ${hint}.` }
  const problem = cliArgProblem(field, value)
  return problem ? { error: problem } : value
}

const isError = (value: unknown): value is { error: string } => typeof value === 'object' && value !== null && 'error' in value

/**
 * A follow-up call without `text` is refused once. A model that repeats the
 * call without it (DeepSeek Flash did 3 times in a row on dev) gets the
 * follow-up with this generic text instead: the woken turn runs in this same
 * session, so it still has the conversation. One box serves one session, so
 * the flag is that session's.
 */
let refusedMissingText = false

/** The generic text of a follow-up whose call twice had no `text`, named by the label the call gave. */
function fallbackText(args: Record<string, any>): string {
  const label = ['id', 'name', 'title'].map((k) => (typeof args[k] === 'string' ? args[k].trim() : '')).find((v) => v && v.length <= 80 && !RUNTIME_ID.test(v) && !cliArgProblem('label', v))
  const today = new Date()
  const stop = new Date(today.getTime() + 14 * 86_400_000).toISOString().slice(0, 10)
  return `Follow-up${label ? ` "${label}"` : ''} set ${today.toISOString().slice(0, 10)}: check what this conversation is waiting on, tell the person what came in and what is still missing, and remove this follow-up once nothing is pending (on ${stop} at the latest).`
}

async function followUp(args: Record<string, any>, context: PlatformToolContext) {
  let text = wakeText(args, 'follow_up')
  let fallback = false
  if (isError(text) && text.error.startsWith('Missing `text`') && refusedMissingText) {
    text = fallbackText(args)
    fallback = true
  }
  refusedMissingText = isError(text) && text.error.startsWith('Missing `text`')
  if (isError(text)) return fail(TOOL, 'follow_up', 'What should the follow-up check?', { kind: 'invalid', message: text.error }, context)
  const given = SCHEDULE_KEYS.filter((key) => typeof args[key] === 'string' && args[key].trim())
  if (given.length === 0) {
    return fail(TOOL, 'follow_up', 'When should it check?', { kind: 'invalid', message: 'Pass one of: in ("3h", once), at (an ISO time, once), every ("4h", repeats; at least 5m), cron ("0 9 * * 1-5", repeats, plus timezone). Got none.' }, context)
  }
  // Several schedule fields: the first by precedence wins, and the result says which.
  const key = given[0]!
  const ignored = given.slice(1)
  const value = String(args[key]).trim()
  const flags = [`--${key}=${value}`]
  const timezone = typeof args.timezone === 'string' ? args.timezone.trim() : ''
  if (key === 'cron' && timezone) {
    const bad = cliArgProblem('timezone', timezone)
    if (bad) return fail(TOOL, 'follow_up', 'Which time zone?', { kind: 'invalid', message: bad }, context)
    flags.push(`--timezone=${timezone}`)
  }
  const made = await runJson<LoopRow>(['loop', text, ...flags, '--json'], context)
  if ('error' in made) return fail(TOOL, 'follow_up', 'Could not set the follow-up', made.error, context)
  const loop = made.value
  const when = key === 'in' ? `in ${value}` : key === 'at' ? `at ${instant(value)}` : key === 'every' ? `every ${value}` : `cron ${value}${timezone ? ` (${timezone})` : ''}`
  const next = instant(loop.next_fire_at)
  return ok(
    TOOL,
    'follow_up',
    {
      title: `Follow-up set: ${when}`,
      subtitle: short(text, 140),
      ...(next ? { rows: [{ title: 'Next check', detail: next }] } : {}),
      links: [{ label: 'Triggers', href: adminHref(context.env, 'triggers') }],
    },
    {
      id: loop.id,
      schedule: when,
      next_fire: loop.next_fire_at ?? null,
      text,
      ...(ignored.length > 0
        ? { used: key, ignored, note: `Set with \`${key}\` (${when}); ignored ${ignored.map((k) => `\`${k}\``).join(', ')}. One schedule field per follow-up; set another follow-up for a second check.` }
        : {}),
      ...(fallback ? { fallback_text: true, text_note: 'Done: the follow-up is set and works. The woken turn reads this conversation, so this text is enough. Keep it: do not remove it, replace it or set it again.' } : {}),
    },
  )
}

/** The `--on …` flags of a wake-on, with the plain condition, or why there are none. */
function wakeFlags(args: Record<string, any>): { flags: string[]; condition: string; extra?: string } | { error: string } {
  const on = String(args.on ?? '')
  if (on === 'cr_merged') {
    const cr = word(args, 'cr', 'the change request id or number, as kortix_change_requests shows it')
    if (isError(cr)) return cr
    return { flags: ['--on=cr-merged', `--cr=${cr}`], condition: `change request ${cr} merges` }
  }
  if (on === 'webhook') {
    const secret = word(args, 'secret_env', 'the name of a project secret that signs the calls, e.g. ORDERS_WEBHOOK_SECRET')
    if (isError(secret)) return secret
    return { flags: ['--on=webhook', `--secret-env=${secret}`], condition: 'the webhook is called' }
  }
  if (on === 'connector_event') {
    const connector = word(args, 'connector', 'the connector slug, as kortix_connectors lists it')
    if (isError(connector)) return connector
    const event = word(args, 'event', 'an event type, as `events` lists it for this connector')
    if (isError(event)) return event
    const flags = ['--on=event', `--connector=${connector}`, `--event=${event}`]
    if (args.config !== undefined) {
      if (!args.config || typeof args.config !== 'object' || Array.isArray(args.config)) return { error: '`config` must be an object of the event\'s config fields, as `events` lists them.' }
      flags.push(`--config=${JSON.stringify(args.config)}`)
    }
    return { flags, condition: `${connector} sends ${event}` }
  }
  if (on === 'app_event') {
    const app = word(args, 'app', 'the App slug')
    if (isError(app)) return app
    // The CLI wakes on every event the App emits (`--on app` has no event filter): the text names the one that matters.
    const event = args.event === undefined || args.event === '' ? null : word(args, 'event', 'the App event name')
    if (isError(event)) return event
    return event
      ? { flags: ['--on=app', `--app=${app}`], condition: `App ${app} sends ${event}`, extra: ` (This wakes on every event from App ${app}; act only on "${event}" and end the turn on any other.)` }
      : { flags: ['--on=app', `--app=${app}`], condition: `App ${app} sends an event` }
  }
  return { error: `\`on\` must be one of: ${WAKE_ON.join(', ')}.` }
}

async function wakeOn(args: Record<string, any>, context: PlatformToolContext) {
  const text = wakeText(args, 'wake_on')
  if (isError(text)) return fail(TOOL, 'wake_on', 'What should the woken turn do?', { kind: 'invalid', message: text.error }, context)
  const spec = wakeFlags(args)
  if (isError(spec)) return fail(TOOL, 'wake_on', 'Wake on what?', { kind: 'invalid', message: spec.error }, context)
  const prompt = spec.extra ? `${text}${spec.extra}` : text
  const made = await runJson<TriggerRow>(['triggers', 'add', prompt, ...spec.flags, '--json'], context)
  if ('error' in made) return fail(TOOL, 'wake_on', 'Could not set the wake-up', made.error, context)
  const trigger = made.value
  const url = trigger.source?.webhook_url
  const rows: KortixCardRow[] = url ? [{ title: 'Webhook URL', detail: url }] : []
  return ok(
    TOOL,
    'wake_on',
    {
      title: `Will wake when ${spec.condition}`,
      subtitle: url ? `The outside system POSTs to this URL, signed with the secret ${args.secret_env}.` : short(text, 140),
      ...(rows.length ? { rows } : {}),
      links: [{ label: 'Triggers', href: adminHref(context.env, 'triggers') }],
    },
    { id: trigger.id ?? trigger.slug ?? '', on: args.on, condition: spec.condition, next_fire: trigger.next_fire_at ?? null, ...(url ? { webhook_url: url } : {}), text: prompt },
  )
}

interface EventType {
  type: string
  name?: string
  description?: string
  config_schema?: { properties?: Record<string, { type?: unknown; description?: unknown }>; required?: unknown }
}

async function events(args: Record<string, any>, context: PlatformToolContext) {
  const connector = word(args, 'connector', 'the connector slug, as kortix_connectors lists it')
  if (isError(connector)) return fail(TOOL, 'events', 'Which connector?', { kind: 'invalid', message: connector.error }, context)
  const read = await runJson<{ app?: string; event_types?: EventType[] }>(['triggers', 'events', `--connector=${connector}`, '--json'], context)
  if ('error' in read) return fail(TOOL, 'events', `Could not list the events of ${connector}`, read.error, context)
  const types = Array.isArray(read.value.event_types) ? read.value.event_types : []
  // The model passes required config fields to wake_on as `config`.
  const listed = types.map((e) => {
    const required = Array.isArray(e.config_schema?.required) ? (e.config_schema.required as string[]) : []
    const config = Object.entries(e.config_schema?.properties ?? {}).map(([name, p]) => ({
      name,
      required: required.includes(name),
      ...(typeof p?.description === 'string' ? { description: p.description } : {}),
    }))
    return { type: e.type, name: e.name ?? e.type, description: e.description ?? '', config }
  })
  return ok(
    TOOL,
    'events',
    {
      title: listed.length === 1 ? `1 event on ${connector}` : `${listed.length} events on ${connector}`,
      ...(listed.length === 0 ? { subtitle: `${connector} cannot wake a session. Use a follow-up instead.` } : {}),
      rows: capRows(listed.map((e) => ({ title: e.type, detail: short(e.description || e.name, 100) }))),
    },
    { connector, events: listed },
  )
}

function rowsOf(value: unknown): TriggerRow[] {
  if (Array.isArray(value)) return value as TriggerRow[]
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  return [...(Array.isArray(record.triggers) ? record.triggers : []), ...(Array.isArray(record.runtime) ? record.runtime : [])] as TriggerRow[]
}

/** The schedule of a kortix.yaml or runtime agent trigger, when it names one. */
function when(row: TriggerRow): string | undefined {
  if (row.source?.type && row.source.type !== 'schedule') return condition(row.source)
  const on = (row.on ?? row.source ?? {}) as Record<string, unknown>
  const value = row.schedule ?? row.cron ?? row.every ?? on.cron ?? on.every ?? on.at ?? on.schedule
  return typeof value === 'string' && value ? value : undefined
}

async function list(context: PlatformToolContext) {
  const [triggers, loops] = await Promise.all([cliJson(['triggers', 'ls', '--json'], context), runJson<{ reminders?: LoopRow[] }>(['loops', 'ls', '--json'], context)])
  if ('error' in triggers && 'error' in loops) return fail(TOOL, 'list', 'Could not list the schedules', triggers.error, context)
  const all = 'error' in triggers ? [] : rowsOf(triggers.value)
  // Runtime rows that wake a session are loops and wake-ons: this session's come from `loops ls`, with the full source from here.
  const sources = new Map(all.filter((row) => row.id && row.source).map((row) => [row.id!, row.source!]))
  const agentRows = all.filter((row) => row.target?.kind !== 'session')
  const mine = 'error' in loops ? [] : Array.isArray(loops.value.reminders) ? loops.value.reminders : []
  const isLoop = (row: LoopRow) => !row.source_type || row.source_type === 'schedule'

  const followUps = mine.filter(isLoop).map((row) => ({ id: row.id, text: row.prompt, schedule: schedule(row), next_fire: row.next_fire_at ?? null, state: row.state ?? 'active' }))
  const wakeOns = mine.filter((row) => !isLoop(row)).map((row) => ({
    id: row.id,
    text: row.prompt,
    condition: condition(sources.get(row.id) ?? { type: row.source_type }),
    next_fire: row.next_fire_at ?? null,
    state: row.state ?? 'active',
  }))
  const schedules = agentRows.map((row) => ({
    id: row.slug ?? row.id ?? '',
    text: row.name || row.prompt || row.prompt_template || row.slug || row.id || '',
    schedule: when(row) ?? null,
    agent: row.agent ?? null,
    next_fire: row.next_fire_at ?? null,
    state: row.enabled === false || row.paused || row.state === 'paused' ? 'paused' : (row.state ?? 'active'),
  }))

  const rows: KortixCardRow[] = [
    ...followUps.map((r) => ({ title: short(r.text, 80), detail: `Follow-up · ${r.schedule}${r.next_fire ? ` · next ${instant(r.next_fire)}` : ''}`, badge: badge(r.state) })),
    ...wakeOns.map((r) => ({ title: short(r.text, 80), detail: `Wakes when ${r.condition}`, badge: badge(r.state) })),
    ...schedules.map((r) => ({
      title: short(r.text, 80),
      ...(r.schedule || r.next_fire ? { detail: [r.schedule, r.next_fire ? `next ${instant(r.next_fire)}` : null].filter(Boolean).join(' · ') } : {}),
      badge: badge(r.state),
    })),
  ]
  const count = (n: number, one: string, many: string) => (n === 0 ? null : `${n} ${n === 1 ? one : many}`)
  const title = [count(followUps.length, 'follow-up', 'follow-ups'), count(wakeOns.length, 'wake-on', 'wake-ons'), count(schedules.length, 'schedule', 'schedules')].filter(Boolean).join(', ') || 'Nothing scheduled'
  const missing = 'error' in loops ? `This session's follow-ups could not be read: ${loops.error.message}` : 'error' in triggers ? `The project schedules could not be read: ${triggers.error.message}` : null
  return ok(
    TOOL,
    'list',
    { title, ...(missing ? { subtitle: missing } : {}), rows: capRows(rows), links: [{ label: 'Triggers', href: adminHref(context.env, 'triggers') }] },
    { follow_ups: followUps, wake_ons: wakeOns, schedules },
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
  // A schedule into this session is a loop (`reminder.<hex>`); one that starts an agent is `trigger.<hex>`.
  const id = made.text.match(/(?:trigger|reminder)\.[0-9a-f]+/)?.[0] ?? made.text.split('\n').pop() ?? ''
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

const VERB: Record<string, { loops: string; triggers: string; title: string }> = {
  pause: { loops: 'pause', triggers: 'pause', title: 'Paused' },
  resume: { loops: 'resume', triggers: 'resume', title: 'Running again' },
  remove: { loops: 'rm', triggers: 'rm', title: 'Removed' },
  run_now: { loops: 'run', triggers: 'run', title: 'Ran it now' },
}

/** `action` is what the caller asked (`delete` stays `delete` in the result); `verb` routes it. */
async function change(action: string, verb: keyof typeof VERB, id: string, context: PlatformToolContext) {
  const cli = VERB[verb]!
  // A loop of this session (`reminder.<hex>`) changes through `kortix loops`; a runtime trigger
  // (`trigger.<hex>`) as it is; a kortix.yaml trigger needs `--apply` to change the live project.
  const argv = id.startsWith('reminder.')
    ? ['loops', cli.loops, id]
    : ['triggers', cli.triggers, id, ...(verb === 'remove' && !RUNTIME_ID.test(id) ? ['--apply'] : [])]
  const done = await cliRun(argv, context)
  if ('error' in done) return fail(TOOL, action, `Could not ${action.replace('_', ' ')} it`, done.error, context)
  return ok(TOOL, action, { title: cli.title, subtitle: id, links: [{ label: 'Triggers', href: adminHref(context.env, 'triggers') }] }, { id })
}

export default {
  description:
    'Follow-through and work that starts by itself. ' +
    'FOLLOW-THROUGH RULE: after any action whose result arrives later (an email or message sent and a reply expected, an order or form submitted, a change request opened, a deploy started, a question asked of a person, a page or vendor to watch), set your own wake-up BEFORE you end the turn, without being asked. ' +
    '1) Prefer an event: `wake_on` with on=cr_merged (cr), connector_event (connector + event; run `events` first to pick a real event type), webhook (secret_env; give the outside system the returned URL) or app_event (app). ' +
    '2) Add a fallback `follow_up` when the event might never come: replies first in 2-4h during the recipient\'s working hours, then 2-4 times a day; deploys/CI every 10-30m; slow vendors daily. ' +
    '3) Write `text` for the woken turn: what was sent, to whom, what to check, what to do on each outcome, and when to stop, with an end date (default 14 days). ' +
    '4) Tell the person in one line, e.g. "I\'ll check for replies every 3 hours until 14 Nov." ' +
    '5) On each fire: check, act, report what changed; widen the cadence after repeated empty checks (remove, then a slower follow_up); `remove` every follow-up and wake-on the moment the work is done or the end date passes. ' +
    'No follow-up for work that finishes this turn, for background hand-offs, teammates and workflows (they report back by themselves), or when the person said not to track it. ' +
    'If it answers that Loops are not enabled, tell the person and ask them or a project admin to turn Loops on in Settings → Feature flags. ' +
    'Actions: `follow_up` (text + ONE of in "3h", at ISO time, every "4h" (min 5m), cron "0 9 * * 1-5" + timezone; with several, the first of at, in, cron, every is used); ' +
    '`wake_on` (text + on); `events` (connector); `list` (this session\'s follow-ups and wake-ons, and the project schedules, with ids); ' +
    '`create` (prompt + agent + one schedule: each run starts a new session of that agent); `pause`, `resume`, `run_now`, `remove` (each needs `id` as list shows it; `delete` = remove).',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: 'What to do.' },
      text: { type: 'string', description: 'For follow_up and wake_on: what the woken turn reads. What was done, what to check, what to do on each outcome, when to stop (an end date). `prompt`, `message` or `note` also work.' },
      on: { type: 'string', enum: [...WAKE_ON], description: 'For wake_on: what wakes this session.' },
      cr: { type: 'string', description: 'For wake_on cr_merged: the change request id or number.' },
      secret_env: { type: 'string', description: 'For wake_on webhook: the name of the project secret that signs the calls.' },
      connector: { type: 'string', description: 'For wake_on connector_event and events: the connector slug.' },
      event: { type: 'string', description: 'For wake_on connector_event: the event type, as `events` lists it. For app_event: the App event that matters (optional).' },
      config: { type: 'object', description: 'For wake_on connector_event: the event\'s config fields, as `events` lists them (only when it has required ones).' },
      app: { type: 'string', description: 'For wake_on app_event: the App slug.' },
      prompt: { type: 'string', description: 'For create: the message each run starts with.' },
      agent: { type: 'string', description: 'For create: the agent each run starts a session of. Without it, create is a reminder to this session (prefer follow_up).' },
      every: { type: 'string', description: 'For follow_up and create: repeat interval, e.g. "4h", "1d".' },
      cron: { type: 'string', description: 'For follow_up and create: a cron expression, e.g. "0 9 * * 1-5".' },
      timezone: { type: 'string', description: 'With cron: an IANA time zone, e.g. "Europe/Berlin".' },
      at: { type: 'string', description: 'For follow_up and create: one time, ISO 8601.' },
      in: { type: 'string', description: 'For follow_up and create: once, after this long, e.g. "3h".' },
      id: { type: 'string', description: 'For pause, resume, run_now, remove: the id, as list shows it (reminder.<hex>, trigger.<hex> or a schedule slug).' },
    },
    required: ['action'],
  },
  async execute(args: Record<string, any>, context: PlatformToolContext) {
    const action = String(args.action ?? '')
    if (action === 'follow_up') return followUp(args, context)
    if (action === 'wake_on') return wakeOn(args, context)
    if (action === 'events') return events(args, context)
    if (action === 'list') return list(context)
    if (action === 'create') return create(args, context)
    if (!(ACTIONS as readonly string[]).includes(action)) return fail(TOOL, action, 'Unknown action', { kind: 'invalid', message: `Use one of: ${ACTIONS.join(', ')}.` }, context)
    const verb = (action === 'delete' ? 'remove' : action) as keyof typeof VERB
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (!id) return fail(TOOL, action, 'Which one?', { kind: 'invalid', message: 'Pass id, as list shows it.' }, context)
    // Exactly the shapes `list` prints. The id goes into the CLI's request path, where `/` or `..` would address
    // another endpoint (CWE-22), and an option-shaped one would leave pause/resume with no trigger, so the CLI
    // would flip the project-wide switch (CWE-88). Neither shape can be either.
    if (!RUNTIME_ID.test(id) && !TRIGGER_SLUG.test(id)) {
      return fail(
        TOOL,
        action,
        'Which one?',
        { kind: 'invalid', message: '`id` must be an id exactly as list shows it: reminder.<12 hex>, trigger.<12 hex>, or a schedule slug (lower-case letters, digits, "-" and "_").' },
        context,
      )
    }
    return change(action, verb, id, context)
  },
}
