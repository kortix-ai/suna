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
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../config'
import { KORTIX_USER_CONTEXT_HEADER, verifyKortixUserContext } from '../kortix-user-context'
import { daemonLogFilePath, logger } from '../logger'

export const DEFAULT_TAIL_LINES = 500
export const MAX_TAIL_LINES = 5_000
/** Read at most this many bytes from the end of a file for one tail. */
const TAIL_READ_CAP = 4 * 1024 * 1024

export type LogSource = 'daemon' | 'opencode'

export function opencodeLogFilePath(home: string): string {
  return join(home, '.local', 'share', 'opencode', 'log', 'opencode.log')
}

/** The last `lines` lines of a file, reading only its tail. Null when absent. */
export function tailFile(path: string, lines: number): string | null {
  if (!existsSync(path)) return null
  const size = statSync(path).size
  const span = Math.min(size, TAIL_READ_CAP)
  if (span === 0) return ''
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(span)
    readSync(fd, buf, 0, span, size - span)
    let text = buf.toString('utf8')
    if (span < size) {
      // Started mid-line: drop the partial first line.
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
    const parts = text.split('\n')
    if (parts[parts.length - 1] === '') parts.pop()
    return parts.slice(-lines).join('\n') + (parts.length ? '\n' : '')
  } finally {
    closeSync(fd)
  }
}

function parseTail(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TAIL_LINES
  return Math.min(Math.floor(n), MAX_TAIL_LINES)
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim() || null
}

export function createLogsRouter(cfg: Config, opts: { opencodeHome: string }): Hono {
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
    if (requested !== 'daemon' && requested !== 'opencode' && requested !== 'all') {
      return c.json({ error: 'unknown source', detail: 'source must be daemon, opencode, or all' }, 400)
    }
    const lines = parseTail(c.req.query('tail'))
    const sources: LogSource[] = requested === 'all' ? ['daemon', 'opencode'] : [requested]

    const chunks: string[] = []
    let found = 0
    for (const source of sources) {
      const path = source === 'daemon' ? daemonLogFilePath() : opencodeLogFilePath(opts.opencodeHome)
      const label = path ?? '(daemon file sink disabled: KORTIX_DAEMON_LOG_FILE=off)'
      const body = path ? tailFile(path, lines) : null
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
