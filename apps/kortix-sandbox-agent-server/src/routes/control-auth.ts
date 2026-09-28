import type { Context } from 'hono'
import type { Config } from '../config'
import { KORTIX_USER_CONTEXT_HEADER, verifyKortixUserContext } from '../kortix-user-context'
import { logger } from '../logger'

export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim() || null
}

/**
 * Authenticate a daemon control request: the sandbox bearer, or a user context
 * signed with the sandbox token. Returns the error response, or null and
 * whether the bearer matched.
 */
export function authorizeControl(
  c: Context,
  cfg: Config,
  label: string,
): { response: Response; serviceAuthenticated: false } | { response: null; serviceAuthenticated: boolean } {
  if (!cfg.sandboxToken) {
    return {
      response: c.json({ error: 'daemon not configured', detail: 'KORTIX_TOKEN unset' }, 503),
      serviceAuthenticated: false,
    }
  }
  if (bearerToken(c.req.header('Authorization')) === cfg.sandboxToken) {
    return { response: null, serviceAuthenticated: true }
  }
  const auth = verifyKortixUserContext(c.req.header(KORTIX_USER_CONTEXT_HEADER), cfg.sandboxToken)
  if (!auth.ok) {
    logger.warn(`[${label}] reject`, { reason: auth.reason })
    return { response: c.json({ error: 'unauthorized', reason: auth.reason }, 401), serviceAuthenticated: false }
  }
  return { response: null, serviceAuthenticated: false }
}
