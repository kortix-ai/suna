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
 * A missing dependency does not stop OpenCode; it drops a tool. Condition 3
 * catches that. The check polls until the verify deadline, because OpenCode
 * loads tools after its session API answers.
 */

export interface ProvenCheckInput {
  /** The directory OpenCode instances are scoped to (`cfg.projectTarget`). */
  directory: string
  /** Tool names that must be registered. */
  toolNames: readonly string[]
  fetchImpl?: typeof fetch
  pollMs?: number
}

export type ProvenCheckResult = { ok: true } | { ok: false; reason: string }

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

async function readJson(
  fetchImpl: typeof fetch,
  url: string,
  deadline: number,
): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(Math.max(250, Math.min(5_000, deadline - Date.now()))),
  })
  const text = await res.text()
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  return { status: res.status, body }
}

async function checkOnce(baseUrl: string, input: ProvenCheckInput, deadline: number): Promise<ProvenCheckResult> {
  const fetchImpl = input.fetchImpl ?? fetch
  const scope = `directory=${encodeURIComponent(input.directory)}`

  const config = await readJson(fetchImpl, `${baseUrl}/config?${scope}`, deadline)
  if (config.status !== 200 || !config.body || typeof config.body !== 'object') {
    return { ok: false, reason: `GET /config answered ${config.status}` }
  }
  const configured = (config.body as Record<string, unknown>).default_agent
  const defaultAgent = typeof configured === 'string' && configured.trim() ? configured.trim() : null

  const agents = await readJson(fetchImpl, `${baseUrl}/agent?${scope}`, deadline)
  if (agents.status !== 200 || !Array.isArray(agents.body)) {
    return { ok: false, reason: `GET /agent answered ${agents.status}` }
  }
  const listed = agents.body.filter(
    (agent): agent is { name: string; mode?: unknown } =>
      !!agent && typeof agent === 'object' && typeof (agent as { name?: unknown }).name === 'string',
  )
  if (defaultAgent) {
    if (!listed.some((agent) => agent.name === defaultAgent)) {
      return { ok: false, reason: `the default agent "${defaultAgent}" is not loaded` }
    }
  } else if (!listed.some((agent) => agent.mode !== 'subagent')) {
    // No `default_agent` in the config: OpenCode picks the first primary agent.
    return { ok: false, reason: 'no primary agent is loaded' }
  }

  if (input.toolNames.length > 0) {
    const tools = await readJson(fetchImpl, `${baseUrl}/experimental/tool/ids?${scope}`, deadline)
    if (tools.status === 404) return { ok: true }
    if (tools.status !== 200 || !Array.isArray(tools.body)) {
      return { ok: false, reason: `GET /experimental/tool/ids answered ${tools.status}` }
    }
    const ids = new Set(tools.body.filter((id): id is string => typeof id === 'string'))
    // A file with a default export registers `<name>`; each named export
    // registers `<name>_<export>`.
    const missing = input.toolNames.filter(
      (name) => !ids.has(name) && ![...ids].some((id) => id.startsWith(`${name}_`)),
    )
    if (missing.length > 0) return { ok: false, reason: `tools not loaded: ${missing.join(', ')}` }
  }
  return { ok: true }
}

/** Poll `checkOnce` until it passes or `deadline` (epoch ms) passes. */
export async function provenCheck(
  baseUrl: string,
  deadline: number,
  input: ProvenCheckInput,
): Promise<ProvenCheckResult> {
  let last: ProvenCheckResult = { ok: false, reason: 'the proven check did not run' }
  do {
    try {
      last = await checkOnce(baseUrl, input, deadline)
    } catch (err) {
      last = { ok: false, reason: `proven check request failed: ${(err as Error).message}` }
    }
    if (last.ok) return last
    if (Date.now() + (input.pollMs ?? 500) >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, input.pollMs ?? 500))
  } while (Date.now() < deadline)
  return last
}
