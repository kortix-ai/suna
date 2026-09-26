/**
 * GET /kortix/diag — one call, the whole error report.
 *
 * Everything an incident needs from a box, in one JSON document:
 *   - the daemon's view of OpenCode (state, pid, port, boot phase, timeline)
 *   - a fresh resource snapshot (memory, cgroup, load, disk, RSS, duplicate
 *     opencode processes) plus the last periodic one
 *   - the runtime-assets convergence report (which build of what is live)
 *   - the tail of the daemon log and of OpenCode's log (`?tail=N`, default
 *     200, max 2000 — the plain-text `/kortix/logs` route serves more)
 *   - process/runtime identity: daemon pid, Bun version, uptime, workspace
 *
 * Nothing secret: no env dump, no tokens. Same auth as `/kortix/logs`.
 */
import { Hono } from 'hono'
import type { HarnessDiagnosticsContext, HarnessDiagnosticsService } from '../harness/diagnostics'
import { KORTIX_USER_CONTEXT_HEADER, verifyKortixUserContext } from '../kortix-user-context'
import { logger } from '../logger'

const DEFAULT_DIAG_TAIL = 200
const MAX_DIAG_TAIL = 2_000

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim() || null
}

export function createDiagRouter(
  context: HarnessDiagnosticsContext,
  diagnostics: HarnessDiagnosticsService,
): Hono {
  const router = new Hono()
  const { cfg } = context

  router.get('/', async (c) => {
    if (!cfg.sandboxToken) {
      return c.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, 503)
    }
    const serviceAuthenticated = bearerToken(c.req.header('Authorization')) === cfg.sandboxToken
    if (!serviceAuthenticated) {
      const auth = verifyKortixUserContext(c.req.header(KORTIX_USER_CONTEXT_HEADER), cfg.sandboxToken)
      if (!auth.ok) {
        logger.warn('[diag] reject', { reason: auth.reason })
        return c.json({ error: 'unauthorized', reason: auth.reason }, 401)
      }
    }
    const n = Number(c.req.query('tail'))
    const tail = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_DIAG_TAIL) : DEFAULT_DIAG_TAIL
    return c.json(await diagnostics.report(context, tail))
  })

  return router
}
