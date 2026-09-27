/**
 * Report a memory-guard abort to apps/api as the turn's end, in the shape
 * the turn-stream already accepts (`kind: 'end'`, `status: 'error'`), so the
 * ledger records `failed` with a reason that names memory and the UI shows
 * it. apps/api closes a turn only when the frame names it (`turn_message_id`);
 * an unnamed frame settles as `identity_mismatch` and the reason is lost.
 *
 * Host-layer, not harness-layer: every harness's background monitor relays
 * through this one function (see `resources.ts` `MemoryGuardOptions.onGuard`).
 * It lives in `services/harness/shared/`, so `open-code/` and `pi/` share it
 * without importing each other — the boundary lint (eslint.config.mjs) forbids
 * a concrete adapter from importing another adapter's module.
 */
import { sandboxRelayContext } from '../../../lib/kortix-api/relay-context'
import { logger } from '../../../lib/log/logger'

export async function relayMemoryGuardTurnEnd(input: {
  reason: string
  aborted: boolean
  opencodeRssMb: number | null
  opencodeSessionId: string | null
  /** The turn that was running when the guard fired, read before the abort. */
  turnMessageId: string | null
}): Promise<boolean> {
  const ctx = sandboxRelayContext()
  if (!ctx) return false
  const { projectId, sessionId, token, apiRoot } = ctx
  // Name the turn only when the abort landed: a named end closes the turn,
  // and a failed abort leaves it running.
  const turnMessageId = input.aborted ? input.turnMessageId : null
  try {
    const res = await fetch(`${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        session_id: sessionId,
        kind: 'end',
        status: 'error',
        opencode_session_id: input.opencodeSessionId ?? undefined,
        turn_message_id: turnMessageId ?? undefined,
        error_name: 'SandboxMemoryGuard',
        error_message: input.reason,
        // An aborted turn is over. apps/api reads `true` as "a retry, still
        // running" and drops the frame as `non_terminal`; that is only the
        // truth when the abort did not land.
        error_retryable: !input.aborted,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    logger.warn('[resources] memory guard relayed to the control plane', {
      status: res.status,
      turnMessageId,
      aborted: input.aborted,
      opencodeRssMb: input.opencodeRssMb,
    })
    return res.ok
  } catch (err) {
    logger.warn('[resources] memory guard relay failed', { err: (err as Error).message })
    return false
  }
}
