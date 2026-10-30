/**
 * The shared half of the My Kortix platform tools (`kortix_*.ts` beside this
 * file). Each tool is a typed front for the `kortix` CLI in the sandbox, which
 * is the `@kortix/sdk` host there: it holds the session token, the project
 * link and the request logic. A tool runs one or two CLI commands with
 * `--json`, and turns their output into the one result shape the web client
 * renders as a card (`@kortix/api-contract/kortix-tool-card`).
 *
 * The CLI runs with `KORTIX_ERROR_FORMAT=json`: a refusal or a failure is one
 * `{"kortix_error":{…}}` line on stderr (`apps/cli/src/token-denial.ts`), so a
 * tool never parses colored human text.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  KortixCardChange,
  KortixCardRow,
  KortixGrantor,
  KortixPlatformToolName,
  KortixToolCard,
  KortixToolError,
  KortixToolResult,
} from '@kortix/api-contract/kortix-tool-card'

/** What a platform tool receives (the project tool contract). */
export interface PlatformToolContext {
  env: Record<string, string | undefined>
  signal?: AbortSignal
}

export interface CliRun {
  code: number
  stdout: string
  stderr: string
}

/** One CLI command's wall-clock limit. A connector sign-in link or a list answers in seconds. */
const CLI_TIMEOUT_MS = 90_000

/** Run `kortix <args>` with the session env. Never throws: a spawn failure is exit 127. */
export function runKortix(args: string[], context: PlatformToolContext, stdin?: string): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn('kortix', args, {
      env: { ...context.env, KORTIX_ERROR_FORMAT: 'json', NO_COLOR: '1', KORTIX_NO_UPDATE_CHECK: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: context.signal,
      timeout: CLI_TIMEOUT_MS,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: `${stderr}${err.message}` }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.stdin.end(stdin ?? '')
  })
}

/** The command's JSON output, or null when stdout is not JSON. */
export function parseJson<T = unknown>(stdout: string): T | null {
  const text = stdout.trim()
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

interface MachineError {
  kind?: string
  message?: string
  status?: number
  code?: string
  action?: string
}

/** The last `{"kortix_error":…}` line of a run's stderr. */
function machineError(stderr: string): MachineError | null {
  const lines = stderr.trim().split('\n').reverse()
  let found: MachineError | null = null
  for (const line of lines) {
    if (!line.startsWith('{"kortix_error"')) continue
    try {
      const value = (JSON.parse(line) as { kortix_error: MachineError }).kortix_error
      // A refusal line names the action; keep it over the generic failure line after it.
      if (value.kind === 'denied') return { ...found, ...value }
      found ??= value
    } catch {
      // not ours
    }
  }
  return found
}

/** The last human line of stderr, for a failure that carried no machine line. */
function lastHumanLine(stderr: string): string {
  return stderr.trim().split('\n').filter((line) => line.trim() && !line.startsWith('{"kortix_error"')).pop()?.trim() ?? ''
}

/** A failed run as the tool error the model and the card read. */
export function cliError(run: CliRun): KortixToolError {
  const parsed = machineError(run.stderr)
  const status = parsed?.status
  const message = parsed?.message || lastHumanLine(run.stderr) || `The command exited ${run.code}.`
  if (parsed?.kind === 'denied' || status === 401 || status === 403) {
    const action = parsed?.action ? ` (${parsed.action})` : ''
    return { kind: 'denied', message: `Kortix refused this: it needs a permission the person does not have${action}.` }
  }
  if (status === 404) return { kind: 'not_found', message }
  if (status === 400 || status === 409 || status === 422) return { kind: 'invalid', message }
  if (run.code === 2) return { kind: 'invalid', message }
  return { kind: 'failed', message }
}

/** The project the session belongs to. */
export function projectId(env: PlatformToolContext['env']): string {
  return env.KORTIX_PROJECT_ID?.trim() ?? ''
}

/** In-app path under the session's project. */
export function projectHref(env: PlatformToolContext['env'], path = ''): string {
  return `/projects/${projectId(env)}${path}`
}

export function sessionHref(env: PlatformToolContext['env'], sessionId: string): string {
  return projectHref(env, `/sessions/${encodeURIComponent(sessionId)}`)
}

export function agentHref(env: PlatformToolContext['env'], agent: string): string {
  return projectHref(env, `/customize/agents/${encodeURIComponent(agent)}`)
}

export function adminHref(env: PlatformToolContext['env'], section: string): string {
  return projectHref(env, `/admin/${section}`)
}

export function ok(tool: KortixPlatformToolName, action: string, card: Omit<KortixToolCard, 'status'> & { status?: KortixToolCard['status'] }, data?: unknown): KortixToolResult {
  return { ok: true, tool, action, card: { status: 'done', ...card }, ...(data === undefined ? {} : { data }) }
}

/**
 * A refused or failed action. A refusal carries the people who can grant it,
 * read from the project's members (a member list the person may not read
 * leaves the list out; the refusal itself still stands).
 */
export async function fail(
  tool: KortixPlatformToolName,
  action: string,
  title: string,
  error: KortixToolError,
  context: PlatformToolContext,
): Promise<KortixToolResult> {
  const grantors = error.kind === 'denied' ? await projectManagers(context) : []
  const withGrantors: KortixToolError = grantors.length > 0 ? { ...error, grantors } : error
  const status: KortixToolCard['status'] = error.kind === 'denied' ? 'denied' : 'error'
  const subtitle =
    error.kind === 'denied'
      ? grantors.length > 0
        ? `${grantors.map((g) => g.name).join(', ')} can grant it.`
        : 'A project manager can grant it.'
      : error.message
  return {
    ok: false,
    tool,
    action,
    card: { title, subtitle, status, ...(error.kind === 'denied' ? { links: [{ label: 'Members', href: projectHref(context.env, '/members') }] } : {}) },
    error: withGrantors,
  }
}

/** An id, name, slug or email: a word that can never read as a CLI option. */
const CLI_WORD = /^[A-Za-z0-9][A-Za-z0-9._:@+\/-]{0,199}$/

/**
 * Why a model-chosen value cannot go to the CLI, or null when it can (CWE-88).
 * A `word` (an id, name, slug or email) must look like one. `text` that the CLI
 * reads as a positional argument must not start with "-": the parser would
 * take it for an option. Text passed as a flag value uses `--flag=value`
 * instead, which the CLI never reads as an option.
 */
export function cliArgProblem(field: string, value: string, kind: 'word' | 'text' = 'word'): string | null {
  if (kind === 'text') return value.startsWith('-') ? `\`${field}\` cannot start with "-". Rephrase it so it starts with a word.` : null
  return CLI_WORD.test(value) ? null : `\`${field}\` must be a plain id or name (letters, digits and . _ : @ + / -), as list shows it.`
}

/** Run one command and parse its JSON, or the error to report. */
export async function cliJson<T = unknown>(args: string[], context: PlatformToolContext, stdin?: string): Promise<{ value: T } | { error: KortixToolError }> {
  const run = await runKortix(args, context, stdin)
  if (run.code !== 0) return { error: cliError(run) }
  const value = parseJson<T>(run.stdout)
  if (value === null) return { error: { kind: 'failed', message: 'The command answered with no JSON.' } }
  return { value }
}

/** Run one command for its effect; its plain output is returned as text. */
export async function cliRun(args: string[], context: PlatformToolContext, stdin?: string): Promise<{ text: string } | { error: KortixToolError }> {
  const run = await runKortix(args, context, stdin)
  if (run.code !== 0) return { error: cliError(run) }
  return { text: run.stdout.trim() }
}

/** Run `fn` with `value` written as JSON to a private temp file, removed afterwards. */
export async function withJsonFile<T>(value: unknown, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-tool-'))
  const file = join(dir, 'input.json')
  try {
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
    return await fn(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

interface RosterMember {
  user_id?: string
  email?: string | null
  name?: string | null
  display_name?: string | null
  full_name?: string | null
  account_role?: string | null
  effective_project_role?: string | null
}

export function memberName(member: RosterMember): string {
  return member.display_name || member.full_name || member.name || member.email || member.user_id || 'someone'
}

/** The project's members (`kortix access ls --json`), or null when the person may not read them. */
export async function projectRoster(context: PlatformToolContext): Promise<RosterMember[] | null> {
  const read = await cliJson<{ members?: RosterMember[] }>(['access', 'ls', '--json'], context)
  if ('error' in read) return null
  return Array.isArray(read.value.members) ? read.value.members : []
}

/** Who can grant a project permission: its managers (account owners and admins included). */
export async function projectManagers(context: PlatformToolContext): Promise<KortixGrantor[]> {
  const roster = await projectRoster(context)
  if (!roster) return []
  return roster
    .filter((m) => m.effective_project_role === 'manager' || m.account_role === 'owner' || m.account_role === 'admin')
    .slice(0, 6)
    .map((m) => ({ name: memberName(m), role: m.account_role === 'owner' || m.account_role === 'admin' ? m.account_role : 'project manager' }))
}

/** A string list argument as the CLI's `a,b` form; `all` and `none` pass through. */
export function listArg(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    return items.length > 0 ? items.join(',') : 'none'
  }
  return null
}

/** A setting's value as a short, readable string for a before → after row. */
export function show(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 77)}…` : value
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.map((item) => show(item)).join(', ')
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 80)
  return String(value)
}

/** The changed fields between two flat records. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>, fields: string[]): KortixCardChange[] {
  return fields.flatMap((field) => {
    const a = show(before[field])
    const b = show(after[field])
    return a === b ? [] : [{ field, before: a, after: b }]
  })
}

/** At most `max` rows, with a last row that says how many more there are. */
export function capRows(rows: KortixCardRow[], max = 12): KortixCardRow[] {
  if (rows.length <= max) return rows
  return [...rows.slice(0, max), { title: `${rows.length - max} more`, detail: 'Ask for the full list.' }]
}

/** The JSON Schema of a required action enum. */
export function actionSchema(actions: readonly string[], description: string) {
  return { type: 'string', enum: [...actions], description }
}
