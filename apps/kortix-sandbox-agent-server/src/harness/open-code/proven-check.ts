import type { ConfigReleaseFile } from '../../config-release/descriptor'

/**
 * The proven check. Spec: docs/specs/config-releases.md, "Proven check".
 *
 * A replacement OpenCode is proven when all hold:
 *   1. It serves the session API. `reloadVerified` proves this before the
 *      check runs.
 *   2. `GET /agent` includes the default agent.
 *   3. `GET /experimental/tool/ids` includes the base name of every
 *      `tools/*.ts` in the release. A `404` skips this condition.
 *
 * A failure names its CAUSE and ends early when the cause cannot go away.
 * Measured against real OpenCode 1.18.31 (2026-09-22):
 *   - a syntax error in opencode.jsonc: every directory route answers 400
 *     `ConfigJsonError` with the error positions. Fatal at once.
 *   - a plugin that throws at import: `GET /session` answers, while `/config`,
 *     `/agent` and the tool list never answer. Fatal after `hangLimit`
 *     unanswered requests.
 *   - a tool that throws at import: `/experimental/tool/ids` answers 500
 *     `UnknownError`. Fatal when the same 5xx answer repeats.
 * A missing dependency does not stop OpenCode; it drops a tool, which
 * condition 3 catches.
 */

export interface ProvenCheckInput {
  /** The directory OpenCode instances are scoped to (`cfg.projectTarget`). */
  directory: string
  /** Tool names that must be registered. */
  toolNames: readonly string[]
  /** `plugins/*` files of the config, named when the config load hangs. */
  pluginFiles?: readonly string[]
  /** The config dir, so an error names a file relative to it. */
  configDir?: string
  fetchImpl?: typeof fetch
  pollMs?: number
  /** Per-request budget. */
  requestTimeoutMs?: number
  /** Unanswered requests in a row that end the check. */
  hangLimit?: number
}

export type ProvenCheckResult = { ok: true } | { ok: false; reason: string; fatal?: boolean }

const MAX_REASON = 300

function bounded(text: string): string {
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text
}

/** Base names of `tools/<name>.ts` files at the top of the tools directory. */
export function toolNamesFromFiles(files: readonly ConfigReleaseFile[] | readonly string[]): string[] {
  const names = new Set<string>()
  for (const entry of files) {
    const path = typeof entry === 'string' ? entry : entry[0]
    const match = /^tools\/([^/]+)\.ts$/.exec(path)
    if (match?.[1]) names.add(match[1])
  }
  return [...names].sort()
}

/** `plugins/*.{ts,js}` files of a config. */
export function pluginFilesFrom(files: readonly ConfigReleaseFile[] | readonly string[]): string[] {
  return files
    .map((entry) => (typeof entry === 'string' ? entry : entry[0]))
    .filter((path) => /^plugins\/[^/]+\.(?:[cm]?[jt]s)$/.test(path))
    .sort()
}

/** OpenCode names every config load failure `Config…` (ConfigJsonError, ConfigInvalidError, …). */
export function isConfigErrorName(name: unknown): name is string {
  return typeof name === 'string' && name.startsWith('Config')
}

/**
 * One line that names the cause of an OpenCode error answer. Never includes
 * file content: a ConfigJsonError message quotes the whole file, so only its
 * `<Kind> at line N, column M` lines are kept. Bounded to 300 characters.
 */
export function describeOpencodeError(status: number, bodyText: string, configDir?: string): string {
  let body: { name?: unknown; data?: { path?: unknown; message?: unknown; ref?: unknown } } | null = null
  try {
    body = JSON.parse(bodyText)
  } catch {
    body = null
  }
  const name = typeof body?.name === 'string' ? body.name : null
  if (!name) return `HTTP ${status}`
  const data = body?.data ?? {}
  const message = typeof data.message === 'string' ? data.message : ''
  if (isConfigErrorName(name)) {
    let file = typeof data.path === 'string' ? data.path : ''
    if (configDir && file.startsWith(`${configDir.replace(/\/+$/, '')}/`)) {
      file = file.slice(configDir.replace(/\/+$/, '').length + 1)
    } else if (file) {
      file = file.split('/').slice(-2).join('/')
    }
    const positions = message
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\w+ at line \d+, column \d+$/.test(line))
    const where = file ? ` in ${file}` : ''
    if (positions.length > 0) {
      const shown = positions.slice(0, 3).join('; ')
      const more = positions.length > 3 ? ` (+${positions.length - 3} more)` : ''
      return bounded(`${name}${where}: ${shown}${more}`)
    }
    // No positions (a schema error, for example): its first message line.
    const first = message.split('\n').map((line) => line.trim()).find(Boolean)
    return bounded(`${name}${where}${first ? `: ${first.slice(0, 200)}` : ''}`)
  }
  const first = message.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  const ref = typeof data.ref === 'string' ? ` (ref ${data.ref})` : ''
  const room = MAX_REASON - `HTTP ${status} ${name}: `.length - ref.length
  return bounded(`HTTP ${status} ${name}${first ? `: ${first.slice(0, Math.max(0, room))}` : ''}${ref}`)
}

class RequestHang extends Error {}

async function readJson(
  fetchImpl: typeof fetch,
  url: string,
  deadline: number,
  timeoutMs: number,
): Promise<{ status: number; body: unknown; text: string }> {
  let res: Response
  try {
    res = await fetchImpl(url, {
      signal: AbortSignal.timeout(Math.max(250, Math.min(timeoutMs, deadline - Date.now()))),
    })
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new RequestHang(url)
    throw err
  }
  const text = await res.text()
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  return { status: res.status, body, text }
}

interface Attempt {
  result: ProvenCheckResult
  /** Which request did not answer, when one hung. */
  hung?: string
  /** A 5xx answer to compare with the next attempt. */
  serverError?: string
}

async function checkOnce(baseUrl: string, input: ProvenCheckInput, deadline: number): Promise<Attempt> {
  const fetchImpl = input.fetchImpl ?? fetch
  const scope = `directory=${encodeURIComponent(input.directory)}`
  const timeoutMs = input.requestTimeoutMs ?? 5_000
  const get = async (path: string) => {
    try {
      return await readJson(fetchImpl, `${baseUrl}${path}?${scope}`, deadline, timeoutMs)
    } catch (err) {
      if (err instanceof RequestHang) return { hung: `GET ${path}` } as const
      throw err
    }
  }
  const configError = (answer: { status: number; body: unknown; text: string }): Attempt | null =>
    answer.status >= 400 && isConfigErrorName((answer.body as { name?: unknown } | null)?.name)
      ? { result: { ok: false, fatal: true, reason: describeOpencodeError(answer.status, answer.text, input.configDir) } }
      : null

  const config = await get('/config')
  if ('hung' in config) return { result: { ok: false, reason: `${config.hung} did not answer` }, hung: config.hung }
  const configFailure = configError(config)
  if (configFailure) return configFailure
  if (config.status !== 200 || !config.body || typeof config.body !== 'object') {
    const reason = `GET /config: ${describeOpencodeError(config.status, config.text, input.configDir)}`
    return { result: { ok: false, reason }, serverError: config.status >= 500 ? reason : undefined }
  }
  const configured = (config.body as Record<string, unknown>).default_agent
  const defaultAgent = typeof configured === 'string' && configured.trim() ? configured.trim() : null

  const agents = await get('/agent')
  if ('hung' in agents) return { result: { ok: false, reason: `${agents.hung} did not answer` }, hung: agents.hung }
  const agentsFailure = configError(agents)
  if (agentsFailure) return agentsFailure
  if (agents.status !== 200 || !Array.isArray(agents.body)) {
    const reason = `GET /agent: ${describeOpencodeError(agents.status, agents.text, input.configDir)}`
    return { result: { ok: false, reason }, serverError: agents.status >= 500 ? reason : undefined }
  }
  const listed = agents.body.filter(
    (agent): agent is { name: string; mode?: unknown } =>
      !!agent && typeof agent === 'object' && typeof (agent as { name?: unknown }).name === 'string',
  )
  if (defaultAgent) {
    if (!listed.some((agent) => agent.name === defaultAgent)) {
      return { result: { ok: false, reason: `the default agent "${defaultAgent}" is not loaded` } }
    }
  } else if (!listed.some((agent) => agent.mode !== 'subagent')) {
    // No `default_agent` in the config: OpenCode picks the first primary agent.
    return { result: { ok: false, reason: 'no primary agent is loaded' } }
  }

  if (input.toolNames.length > 0) {
    const tools = await get('/experimental/tool/ids')
    if ('hung' in tools) return { result: { ok: false, reason: `${tools.hung} did not answer` }, hung: tools.hung }
    if (tools.status === 404) return { result: { ok: true } }
    const toolsFailure = configError(tools)
    if (toolsFailure) return toolsFailure
    if (tools.status !== 200 || !Array.isArray(tools.body)) {
      const files = input.toolNames.map((name) => `tools/${name}.ts`).join(', ')
      const reason = bounded(
        `tools failed to load: ${describeOpencodeError(tools.status, tools.text, input.configDir)} (tool files: ${files})`,
      )
      return { result: { ok: false, reason }, serverError: tools.status >= 500 ? reason : undefined }
    }
    const ids = new Set(tools.body.filter((id): id is string => typeof id === 'string'))
    // A file with a default export registers `<name>`; each named export
    // registers `<name>_<export>`.
    const missing = input.toolNames.filter(
      (name) => !ids.has(name) && ![...ids].some((id) => id.startsWith(`${name}_`)),
    )
    if (missing.length > 0) return { result: { ok: false, reason: `tools not loaded: ${missing.join(', ')}` } }
  }
  return { result: { ok: true } }
}

/** Poll `checkOnce` until it passes, a cause is final, or `deadline` (epoch ms) passes. */
export async function provenCheck(
  baseUrl: string,
  deadline: number,
  input: ProvenCheckInput,
): Promise<ProvenCheckResult> {
  const hangLimit = input.hangLimit ?? 3
  let last: ProvenCheckResult = { ok: false, reason: 'the proven check did not run' }
  let hangs = 0
  let lastServerError: string | null = null
  do {
    let attempt: Attempt
    try {
      attempt = await checkOnce(baseUrl, input, deadline)
    } catch (err) {
      attempt = { result: { ok: false, reason: `proven check request failed: ${(err as Error).message}` } }
    }
    last = attempt.result
    if (last.ok || last.fatal) return last
    if (attempt.hung) {
      hangs += 1
      if (hangs >= hangLimit) {
        const plugins = input.pluginFiles?.length ? ` (plugins: ${input.pluginFiles.join(', ')})` : ''
        return {
          ok: false,
          fatal: true,
          reason: bounded(
            `${attempt.hung} did not answer in ${hangs} attempts; a plugin that fails at import stops the config load${plugins}`,
          ),
        }
      }
    } else {
      hangs = 0
    }
    // The same 5xx twice in a row is the config, not a start-up race.
    if (attempt.serverError && attempt.serverError === lastServerError) {
      return { ok: false, fatal: true, reason: attempt.serverError }
    }
    lastServerError = attempt.serverError ?? null
    if (Date.now() + (input.pollMs ?? 500) >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, input.pollMs ?? 500))
  } while (Date.now() < deadline)
  return last
}
