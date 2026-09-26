import { logger } from '../../logger'
import { sandboxRelayContext } from '../../relay-context'
import type { PermissionRequest } from './events'

/**
 * Report an OpenCode `permission.asked` event to apps/api, which sends the
 * session creator a "needs your approval" push (`POST …/turn-permission`).
 *
 * REPORT ONLY. The permission stays open until the user approves or rejects it
 * in the session UI over OpenCode's own API; this relay never replies to it.
 * Best-effort: a failed report is logged and dropped, and apps/api dedupes a
 * repeated request id. `metadata` is not sent: it is tool-specific (an edit
 * carries its full diff) and the push does not use it.
 */
export async function relayPermissionToApi(req: PermissionRequest): Promise<void> {
  const ctx = sandboxRelayContext()
  if (!ctx) return
  const { projectId, sessionId, token, apiRoot } = ctx
  const url = `${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-permission`
  logger.info('[opencode-events] relaying permission.asked', {
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
      logger.warn('[opencode-events] turn-permission post non-ok (non-fatal)', { status: r.status })
    }
  } catch (err) {
    logger.warn('[opencode-events] turn-permission post failed (non-fatal)', { err: (err as Error).message })
  }
}
