import { createHash, timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import type { Config } from '@/lib/config/config'
import { KORTIX_USER_CONTEXT_HEADER, verifyKortixUserContext } from '@/lib/kortix-api/kortix-user-context'
import { logger } from '@/lib/log/logger'

export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length).trim() || null
}

/**
 * Does the request's bearer equal `secret`? Constant time: both sides are
 * hashed first, so neither the compare nor the length leaks. The sandbox token
 * is also the HMAC key of the user context, so a timing oracle on it is worth
 * more than the check looks.
 */
export function bearerMatches(header: string | undefined, secret: string): boolean {
  const presented = bearerToken(header)
  if (presented === null) return false
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(presented), digest(secret))
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
  if (bearerMatches(c.req.header('Authorization'), cfg.sandboxToken)) {
    return { response: null, serviceAuthenticated: true }
  }
  const auth = verifyKortixUserContext(c.req.header(KORTIX_USER_CONTEXT_HEADER), cfg.sandboxToken)
  if (!auth.ok) {
    logger.warn(`[${label}] reject`, { reason: auth.reason })
    return { response: c.json({ error: 'unauthorized', reason: auth.reason }, 401), serviceAuthenticated: false }
  }
  return { response: null, serviceAuthenticated: false }
}
