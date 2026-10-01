import { relayTurnAccepted } from '../shared/turn-relay'
import { logger } from '@/lib/log/logger'
import { hasKortixLlmGateway, type Opencode } from './lifecycle'
import { sandboxRelayContext } from '@/lib/kortix-api/relay-context'
import type { InitialTurnClaim } from '@/types/control-plane'
import { getClaimedInitialTurn, setClaimedInitialTurn } from './initial-turn-claim'
import { observeOpencodeDelivery } from './opencode-turn-state'

const LEGACY_OPENCODE_ZEN_FREE_MODELS = new Set([
  'deepseek-v4-flash-free',
  'mimo-v2.5-free',
  'nemotron-3-ultra-free',
  'north-mini-code-free',
])

export async function createInitialOpenCodeSession(
  opencode: Opencode,
  workspace: string,
): Promise<{ id: string }> {
  const response = await waitForInitialSessionCreate(opencode.getInternalUrl(), workspace)
  const session = (await response.json()) as { id?: string }
  if (!session.id) throw new Error('opencode session create returned no id')
  return { id: session.id }
}

export async function deliverInitialOpenCodePrompt(
  opencode: Opencode,
  sessionId: string,
  workspace: string,
  prompt: ReturnType<typeof buildInitialPromptBody>,
): Promise<void> {
  const response = await fetch(
    `${opencode.getInternalUrl()}/session/${sessionId}/prompt_async?directory=${encodeURIComponent(workspace)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prompt),
      signal: AbortSignal.timeout(15_000),
    },
  )
  if (!response.ok) {
    throw new Error(`opencode prompt failed: ${response.status} ${await response.text()}`)
  }
}

/**
 * Promote only the initial-turn authority that apps/api created before the
 * sandbox existed. The daemon cannot mint a token, create a lifecycle record,
 * or revive a record removed by terminal evidence.
 */
export async function relayInitialTurnAcceptedToApi(
  opencodeSessionId: string,
  messageId: string,
  turnToken: string,
): Promise<boolean> {
  return relayTurnAccepted(opencodeSessionId, messageId, turnToken)
}

/** Claim the pending first turn through the session-bound Kortix credential. */
export async function claimInitialTurnFromApi(): Promise<InitialTurnClaim | null> {
  if (getClaimedInitialTurn()) return getClaimedInitialTurn()
  const ctx = sandboxRelayContext()
  if (!ctx) return null
  const { projectId, sessionId, token, apiRoot } = ctx
  let response: Response | null = null
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(`${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session_id: sessionId, kind: 'initial_turn_claim' }),
        signal: AbortSignal.timeout(15_000),
      })
      if (response.ok || response.status < 500) break
      lastError = new Error(`initial turn claim returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    if (attempt < 2) await Bun.sleep(250 * 2 ** attempt)
  }
  if (!response) {
    throw new Error(`initial turn claim failed after 3 attempts: ${String(lastError)}`)
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`initial turn claim rejected: ${response.status} ${body.slice(0, 200)}`)
  }
  const body = (await response.json()) as {
    initial_turn?: { prompt?: unknown; turn_token?: unknown; message_id?: unknown } | null
  }
  const turn = body.initial_turn
  if (
    !turn ||
    typeof turn.prompt !== 'string' ||
    typeof turn.turn_token !== 'string' ||
    typeof turn.message_id !== 'string'
  ) return null
  setClaimedInitialTurn({
    prompt: turn.prompt,
    turnToken: turn.turn_token,
    messageId: turn.message_id,
  })
  return getClaimedInitialTurn()
}

/** Remove only a pre-created initial-turn record that OpenCode never accepted. */
export async function relayInitialTurnAbandonedToApi(turnToken: string): Promise<boolean> {
  const ctx = sandboxRelayContext()
  if (!ctx) throw new Error('initial turn abandonment relay context is unavailable')
  const { projectId, sessionId, token: sandboxToken, apiRoot } = ctx
  const response = await fetch(`${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sandboxToken}`,
    },
    body: JSON.stringify({
      session_id: sessionId,
      kind: 'turn_abandoned',
      turn_token: turnToken,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`initial turn abandonment rejected: ${response.status} ${body.slice(0, 200)}`)
  }
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean }
  return body.ok === true
}

export type InitialTurnAcceptanceReconciliation = 'accepted' | 'inactive' | 'unknown'

/**
 * How long a first prompt THIS boot delivered may stay absent or unanswered
 * before boot calls it abandoned. Matches the control plane's delivery grace
 * (`KORTIX_SANDBOX_TURN_DELIVERY_GRACE_MINUTES`, 15 min): the `delivering`
 * record expires on that grace anyway, so a longer wait buys nothing.
 */
export const INITIAL_TURN_PICKUP_GRACE_MS = 15 * 60_000

/**
 * Promote daemon-delivered authority only after OpenCode exposes the exact
 * client-minted user message as queued or running.
 *
 * A restart can reuse a root that already contains an older prompt. Root-level
 * `hasMessages` evidence is therefore insufficient: it would promote a new
 * token for work that the daemon deliberately did not rerun.
 */
export async function reconcileInitialTurnAcceptanceToApi(
  opencodeBaseUrl: string,
  workspace: string,
  opencodeSessionId: string,
  messageId: string,
  turnToken: string,
  options: { awaitingPickup?: boolean } = {},
): Promise<InitialTurnAcceptanceReconciliation> {
  const observation = await observeOpencodeDelivery(
    opencodeBaseUrl,
    workspace,
    opencodeSessionId,
    messageId,
  )
  if (observation.inFlight === null) return 'unknown'
  if (observation.inFlight) {
    await relayInitialTurnAcceptedToApi(opencodeSessionId, messageId, turnToken)
    return 'accepted'
  }
  // THIS boot just delivered the prompt, and OpenCode has not picked it up
  // yet. `prompt_async` answers 204 before OpenCode writes the user message
  // (absent at +11 ms on 1.18.23) and before its loop marks the root busy
  // (busy at +308 ms). Boot reconciles right after delivery, so both shapes
  // are the normal start of a first turn, not proof it was dropped. Reading
  // them as abandoned stripped the turn authority from ~99% of session-
  // creating first turns on prod from 2026-08-19: the ledger said `abandoned`
  // ~12 s in, `turn_begin` could not re-adopt a known message, and the stale-
  // turn sweeps saw a running first turn as idle. Retry on the reconcile tick
  // until the pickup grace ends. A prompt an EARLIER boot delivered keeps the
  // immediate verdict: on a reused root, absence is proof.
  if (
    options.awaitingPickup &&
    (observation.end === 'abandoned' || observation.orphanedPrompt === true)
  ) {
    return 'unknown'
  }
  await relayInitialTurnAbandonedToApi(turnToken)
  return 'inactive'
}

/**
 * Create the session's root opencode conversation, retrying while opencode is
 * still coming up.
 *
 * The per-attempt budget is deliberately MUCH larger than the call's normal cost.
 * Measured 2026-07-25 against the real binary, `POST /session` is ~370ms once
 * opencode is warm — but Platinum guests run ~3x slower than Daytona on
 * CPU-bound work (`static-web` 5→19ms, `git-identity` 13→44ms at an identical
 * 2-vCPU spec), which puts a genuine Platinum session-create right at ~1.1s: over
 * the 1s budget this used to impose. Aborting there was actively harmful in two
 * ways:
 *
 *  1. It threw away a call that was about to succeed and paid the whole cost
 *     again (~1.05s per wasted round), on the critical path that
 *     `opencode-session-created` measures.
 *  2. A client-side abort does NOT cancel opencode's server-side work. The
 *     resend could therefore run session-create CONCURRENTLY with the one still
 *     in flight, and only whichever returned first got pinned — leaving an
 *     orphaned duplicate root nobody cleans up, in a codebase that goes to
 *     lengths elsewhere (resolveExistingRoot, the seed-root rotation) precisely
 *     to guarantee one root per session.
 *
 * So: give each attempt room to actually finish, and only retry when the request
 * failed at the connection level (opencode not listening yet) rather than on our
 * own impatience. The 20s outer deadline is unchanged and still bounds the whole
 * loop.
 */
const SESSION_CREATE_ATTEMPT_TIMEOUT_MS = 10_000

export async function waitForInitialSessionCreate(baseUrl: string, workspace: string): Promise<Response> {
  const url = `${baseUrl}/session?directory=${encodeURIComponent(workspace)}`
  const deadline = Date.now() + 20_000
  let lastError = 'opencode session create timed out'
  while (Date.now() < deadline) {
    // Never let one attempt outlive the outer deadline.
    const attemptMs = Math.max(500, Math.min(SESSION_CREATE_ATTEMPT_TIMEOUT_MS, deadline - Date.now()))
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(attemptMs),
      })
      if (res.ok) return res
      const body = await res.text().catch(() => '')
      lastError = `opencode session create failed: ${res.status} ${body}`
      if (res.status >= 400 && res.status < 500 && res.status !== 404) break
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      // A timeout means opencode ACCEPTED the request and is still working on it.
      // Resending would duplicate the root (see the doc comment), so stop and let
      // the caller surface it rather than racing ourselves.
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      if (timedOut) break
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(lastError)
}



export function resolveOpencodeModel(): { providerID: string; modelID: string } | undefined {
  const raw = (process.env.KORTIX_OPENCODE_MODEL ?? '').trim()
  if (!raw) return undefined
  if (hasKortixLlmGateway(process.env)) {
    const modelID = raw.startsWith('kortix/') ? raw.slice('kortix/'.length) : raw
    return modelID ? { providerID: 'kortix', modelID } : undefined
  }
  if (LEGACY_OPENCODE_ZEN_FREE_MODELS.has(raw)) return { providerID: 'opencode', modelID: raw }
  // A pin stored while the gateway was ON can survive a live toggle to native
  // mode. `kortix/<provider>/<model>` (a nested BYOK/codex wire ref) strips to
  // the native ref it wraps; a bare `kortix/<managed-id>` has no native
  // provider to map onto, so it is dropped and OpenCode's default applies —
  // never a prompt against the nonexistent `kortix` provider.
  const ref = raw.startsWith('kortix/') ? raw.slice('kortix/'.length) : raw
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash === ref.length - 1) return undefined
  const providerID = ref.slice(0, slash)
  const modelID = ref.slice(slash + 1)
  return { providerID, modelID }
}

/** Build the first-turn request from the session-bound runtime environment. */
export function buildInitialPromptBody(prompt: string, claimedMessageId?: string): {
  messageID?: string
  parts: Array<{ type: 'text'; text: string }>
  model?: { providerID: string; modelID: string }
  agent?: string
} {
  const model = resolveOpencodeModel()
  const agentName = (process.env.KORTIX_AGENT_NAME ?? '').trim()
  const agent = agentName && agentName !== 'default' ? agentName : undefined
  const messageID = claimedMessageId
  return {
    ...(messageID ? { messageID } : {}),
    parts: [{ type: 'text', text: prompt }],
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
  }
}

/** Claim warm-seed boot before the host considers monitor or session mode. */
