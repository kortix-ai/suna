/**
 * Report a permission request to apps/api, which sends the session creator a
 * "needs your approval" push (`POST …/turn-permission`).
 *
 * REPORT ONLY. The permission stays open until the user approves or rejects it
 * in the session UI; this relay never replies to it. Best-effort: a failed
 * report is logged and dropped, and apps/api dedupes a repeated request id.
 * `metadata` is not sent: it is tool-specific (an edit carries its full diff)
 * and the push does not use it.
 *
 * Host-layer: both adapters relay through this one function (OpenCode's
 * `permission.asked` event, pi's `PermissionBroker.ask`). It lives in
 * `harness/shared/` because the boundary lint forbids one adapter importing
 * another's module.
 */
import { logger } from '@/lib/log/logger'
import { sandboxRelayContext } from '@/lib/kortix-api/relay-context'

/** The fields of a permission request the push needs; both adapters' request objects carry them. */
export interface RelayedPermissionRequest {
  id: string
  /** The harness session the request belongs to. */
  sessionID: string
  permission: string
  patterns?: string[]
}

export async function relayPermissionToApi(req: RelayedPermissionRequest): Promise<void> {
  const ctx = sandboxRelayContext()
  if (!ctx) return
  const { projectId, sessionId, token, apiRoot } = ctx
  const url = `${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-permission`
  logger.info('[permission-relay] relaying a permission request', {
    requestId: req.id, permission: req.permission,
  })
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        session_id: sessionId,
        request_id: req.id,
        opencode_session_id: req.sessionID,
        permission: req.permission,
        patterns: Array.isArray(req.patterns) ? req.patterns : [],
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) {
      logger.warn('[permission-relay] turn-permission post non-ok (non-fatal)', { status: r.status })
    }
  } catch (err) {
    logger.warn('[permission-relay] turn-permission post failed (non-fatal)', { err: (err as Error).message })
  }
}
