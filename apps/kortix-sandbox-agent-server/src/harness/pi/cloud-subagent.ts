/**
 * Cloud subagent spawn: the `agent` tool as a REAL Kortix child session.
 *
 * RFC `.agents/skills/learnings/work/claude-code-harness-parity/README.md`,
 * Pillar 1 (the keystone). Behind `KORTIX_PI_CLOUD_SUBAGENTS` (default OFF),
 * `runtime.kortixHost()` routes `spawnSession` here instead of the in-process
 * `PiRuntime.spawnSession`. A spawn becomes one `POST /v1/projects/:id/sessions`
 * from this box, which provisions the child its own sandbox + pi and runs the
 * prompt. The child auto-links to this session as its parent, because the box's
 * `KORTIX_TOKEN` is session-bound and the API reads the caller session from it
 * (`middleware/caller-session.ts` → `session-create.ts` `parentSessionId`).
 *
 * The return shape is `SpawnSessionResult`, identical to the in-process path,
 * so `extensions/subagents.ts` is unchanged: the tool part still carries the
 * child id in `metadata.sessionId` and the output still starts `task_id: <id>`.
 * The id now names a real session, so the web client renders the child as a
 * normal session (its own event stream), not a part of this box's wire.
 *
 * FIRST CUT — pieces that are stubbed, each listed in the PR/report:
 *  1. Reading the child's final report back (the `<task_result>` body) is a
 *     STUB: it needs a cross-session transcript read from this box, which is
 *     unverified here (no real sandbox). `readFinalText` returns a pointer to
 *     the child session instead. The child's full transcript is visible in the
 *     UI via `metadata.sessionId` regardless.
 *  2. Inline ephemeral agents (`agent` spec: systemPrompt/tools overrides) do
 *     not map to a cloud agent (no yaml). The child runs the project default
 *     agent; the overrides are dropped.
 *  3. `task_id` resume is not supported in cloud mode (a resume = a new prompt
 *     to the existing child session, a follow-up). It throws a clear error.
 *  4. Guardrails from the RFC (per-parent concurrency cap, idle-reap, nesting
 *     gate, billing roll-up) are NOT added here — the in-process path's gates
 *     still apply; the cloud cap is a follow-up.
 */
import { logger } from '@/lib/log/logger'
import type { SpawnSessionInput, SpawnSessionResult } from './extensions/subagents'

/** The API callback target, from the box env (`cfg.apiUrl` / `projectId` / `sandboxToken`, `KORTIX_SESSION_ID`). */
export interface CloudSubagentApi {
  /** `KORTIX_API_URL`, with or without the `/v1` suffix. */
  apiUrl: string
  projectId: string
  /** The session's sandbox token (`KORTIX_TOKEN`); its bearer identifies this session as the parent. */
  token: string
  fetchImpl?: typeof fetch
}

/** Resolve the callback target, or null when the box has no control plane (a local/offline box). */
export function cloudSubagentApiFrom(input: {
  apiUrl?: string
  projectId?: string
  sandboxToken?: string
}): CloudSubagentApi | null {
  const apiUrl = input.apiUrl?.trim()
  const projectId = input.projectId?.trim()
  const token = input.sandboxToken?.trim()
  if (!apiUrl || !projectId || !token) return null
  return { apiUrl, projectId, token }
}

/** `https://api.example.com/v1` → `https://api.example.com`. `/v1` is part of every path below. */
function apiOrigin(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -'/v1'.length) : trimmed
}

/** `provider/model` → the two fields `onSession`/the result report. Best-effort; informational only. */
function splitModel(ref: string | undefined): { providerID: string; modelID: string } {
  if (!ref) return { providerID: 'kortix', modelID: 'default' }
  const slash = ref.indexOf('/')
  return slash < 0 ? { providerID: 'kortix', modelID: ref } : { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }
}

/** Built-in subagent names and the inline label: none is a real project agent, so the child runs the default. */
const CLOUD_UNMAPPABLE_AGENTS = new Set(['general', 'explore', 'inline'])

/** Poll the child session until it goes idle, at most this long. */
// ponytail: fixed 30 min ceiling + 2 s poll; make it env-tunable if a real subagent run needs longer.
const WAIT_CEILING_MS = 30 * 60_000
const POLL_INTERVAL_MS = 2_000

export interface CloudSubagentOptions {
  waitCeilingMs?: number
  pollIntervalMs?: number
  now?: () => number
}

/**
 * Spawn one real cloud child session for an `agent`-tool call and wait for its
 * first turn to settle. Returns the same shape as the in-process spawn.
 */
export async function cloudSpawnSession(
  api: CloudSubagentApi,
  input: SpawnSessionInput,
  opts: CloudSubagentOptions = {},
): Promise<SpawnSessionResult> {
  const model = splitModel(input.model)
  if (input.sessionId) {
    // STUB (3): resume is a new prompt to the existing child. Not in the first cut.
    throw new Error('cloud subagents do not support task_id resume yet; start a new task')
  }
  const fetchImpl = api.fetchImpl ?? fetch
  const origin = apiOrigin(api.apiUrl)
  const headers = { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' }

  // The named project agent, when the call names one; built-ins and inline run the project default.
  const agentName = input.agent && !CLOUD_UNMAPPABLE_AGENTS.has(input.agent) ? input.agent : undefined

  const createBody: Record<string, unknown> = {
    initial_prompt: input.prompt,
    name: input.title,
    ...(agentName ? { agent_name: agentName } : {}),
    ...(input.model ? { model: input.model } : {}),
  }

  let created: Response
  try {
    created = await fetchImpl(`${origin}/v1/projects/${encodeURIComponent(api.projectId)}/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(createBody),
    })
  } catch (err) {
    return { sessionId: '', status: 'error', text: '', error: `child session create failed: ${err instanceof Error ? err.message : String(err)}`, model }
  }
  if (created.status !== 201 && created.status !== 202) {
    const body = (await created.text().catch(() => '')).slice(0, 500)
    return { sessionId: '', status: 'error', text: '', error: `child session create answered ${created.status}: ${body}`, model }
  }
  const createdJson = (await created.json().catch(() => null)) as { session_id?: string; sessionId?: string } | null
  const childId = createdJson?.session_id ?? createdJson?.sessionId ?? ''
  if (!childId) {
    return { sessionId: '', status: 'error', text: '', error: 'child session create returned no session_id', model }
  }
  // Publish the child id to the tool part NOW, so the UI links the real child while it works.
  input.onSession?.({ sessionId: childId, model })

  const settled = await waitForIdle(fetchImpl, origin, headers, api.projectId, childId, input.signal, opts)
  if (settled.status === 'aborted') return { sessionId: childId, status: 'aborted', text: '', model }
  if (settled.status === 'error') return { sessionId: childId, status: 'error', text: '', error: settled.error, model }

  const text = readFinalText(childId)
  return { sessionId: childId, status: 'completed', text, model }
}

type Settled = { status: 'completed' | 'error' | 'aborted'; error?: string }

/**
 * Poll `GET /v1/projects/:projectId/sessions/:childId` until the child's
 * `working.state` is `idle` (after it has begun) or its lifecycle `status` is
 * terminal. A session-bound parent token may read its own child (the same
 * visibility the factory workers rely on). LIVE-VERIFY: the exact field
 * timing and the parent→child read authorization need a real sandbox.
 */
async function waitForIdle(
  fetchImpl: typeof fetch,
  origin: string,
  headers: Record<string, string>,
  projectId: string,
  childId: string,
  signal: AbortSignal | undefined,
  opts: CloudSubagentOptions,
): Promise<Settled> {
  const now = opts.now ?? (() => Date.now())
  const ceiling = opts.waitCeilingMs ?? WAIT_CEILING_MS
  const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS
  const deadline = now() + ceiling
  let everWorked = false
  for (;;) {
    if (signal?.aborted) return { status: 'aborted' }
    if (now() > deadline) return { status: 'error', error: `child session did not settle within ${Math.round(ceiling / 60_000)} min` }
    let res: Response
    try {
      res = await fetchImpl(`${origin}/v1/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(childId)}`, { headers })
    } catch (err) {
      logger.warn('[pi] cloud subagent poll failed, retrying', { childId, err: err instanceof Error ? err.message : String(err) })
      await delay(interval, signal)
      continue
    }
    if (res.status === 200) {
      const row = (await res.json().catch(() => null)) as
        | { status?: string; working?: { state?: string; pending_delivery?: boolean } }
        | null
      if (row) {
        if (row.status === 'failed') return { status: 'error', error: 'child session failed' }
        if (row.status === 'stopped') return { status: 'aborted' }
        const working = row.working
        if (working?.state === 'working' || working?.pending_delivery) everWorked = true
        // Settled: it worked and is now idle, or the lifecycle already marked it completed.
        if ((everWorked && working?.state === 'idle' && !working.pending_delivery) || row.status === 'completed') {
          return { status: 'completed' }
        }
      }
    } else if (res.status === 404) {
      return { status: 'error', error: 'child session disappeared' }
    }
    await delay(interval, signal)
  }
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

/**
 * STUB (1): the child's final assistant report, read back cross-session.
 *
 * Reading it means proxying to the child's own box
 * (`GET /v1/p/<child_sandbox_id>/8000/session/<runtime_session_id>/message?limit=1`)
 * with this box's token, which is unverified without a real sandbox. Until the
 * live-verify pass confirms that read + its authorization, return a pointer to
 * the child session. The model still gets `task_id: <childId>` from the tool
 * wrapper, and the human sees the full child transcript in the UI.
 */
function readFinalText(childId: string): string {
  return `The subagent ran as the real Kortix child session ${childId}. Its full transcript is that session; reading its final report back into this task is not wired yet (cloud-subagent.ts readFinalText stub).`
}
