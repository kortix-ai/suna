/**
 * GET /kortix/logs — the daemon's own log and OpenCode's, from the box.
 *
 * `?source=daemon` (default) tails the daemon log file (see logger.ts),
 * `?source=opencode` tails OpenCode's `~/.local/share/opencode/log/opencode.log`,
 * `?source=all` returns both, each under a `==> <path> <==` header.
 * `?tail=N` (default 500, max 5000) is the number of lines from the end.
 *
 * Plain text, so `curl … | grep` works. Reachable through the API's sandbox
 * proxy (`/v1/p/<external_id>/8000/kortix/logs`) — the proxy authenticates
 * with the sandbox service key and stamps the user context, exactly like
 * `/kortix/refresh`, so the gate is the same one: the service bearer, or a
 * verified user context for a principal who can see this session.
 */
import { Hono } from 'hono'
import type { Config } from '../config'
import type { HarnessDiagnosticsService } from '../harness/diagnostics'
import { KORTIX_USER_CONTEXT_HEADER, verifyKortixUserContext } from '../kortix-user-context'
import { logger } from '../logger'

export const DEFAULT_TAIL_LINES = 500
export const MAX_TAIL_LINES = 5_000
function parseTail(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TAIL_LINES
  return Math.min(Math.floor(n), MAX_TAIL_LINES)
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim() || null
}

export function createLogsRouter(cfg: Config, diagnostics: HarnessDiagnosticsService): Hono {
  const router = new Hono()

  router.get('/', (c) => {
    if (!cfg.sandboxToken) {
      return c.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, 503)
    }
    const serviceAuthenticated = bearerToken(c.req.header('Authorization')) === cfg.sandboxToken
    if (!serviceAuthenticated) {
      const auth = verifyKortixUserContext(c.req.header(KORTIX_USER_CONTEXT_HEADER), cfg.sandboxToken)
      if (!auth.ok) {
        logger.warn('[logs] reject', { reason: auth.reason })
        return c.json({ error: 'unauthorized', reason: auth.reason }, 401)
      }
    }

    const requested = (c.req.query('source') ?? 'daemon').trim().toLowerCase()
    const available = diagnostics.logSources()
    if (requested !== 'all' && !available.includes(requested)) {
      return c.json({ error: 'unknown source', detail: `source must be ${available.join(', ')}, or all` }, 400)
    }
    const lines = parseTail(c.req.query('tail'))
    const sources = requested === 'all' ? available : [requested]

    const chunks: string[] = []
    let found = 0
    for (const source of sources) {
      const { label, text: body } = diagnostics.readLog(source, lines)
      if (body !== null) found++
      if (sources.length > 1) chunks.push(`==> ${label} <==\n`)
      chunks.push(body ?? `(no log file at ${label})\n`)
    }
    const status = found === 0 ? 404 : 200
    return c.text(chunks.join(''), status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-kortix-log-tail': String(lines),
    })
  })

  return router
}
