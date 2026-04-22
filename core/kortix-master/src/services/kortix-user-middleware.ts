/**
 * Hono middleware that verifies the signed `X-Kortix-User-Context` header
 * on incoming requests and attaches the parsed context to the Hono context
 * under the `kortixUser` key. Downstream handlers read it to make per-user
 * authorization decisions (project ACL, session scoping).
 *
 * No header → `kortixUser` is absent (legacy / anonymous path). Any existing
 * route stays functional — user-aware logic layers on top without breaking
 * service-to-service traffic or pre-phase-1 clients.
 *
 * Invalid header → we log and treat as absent rather than 401, so the
 * authenticated `Authorization: Bearer <serviceKey>` layer (the existing
 * gate) still owns the hard access decision. The context header is purely
 * additive identity information.
 */

import type { Context, Next } from 'hono'
import {
  KORTIX_USER_CONTEXT_HEADER,
  verifyKortixUserContext,
  type KortixUserContext,
} from './kortix-user-context'

declare module 'hono' {
  interface ContextVariableMap {
    kortixUser?: KortixUserContext
  }
}

export function kortixUserContextMiddleware() {
  return async (c: Context, next: Next) => {
    const raw = c.req.header(KORTIX_USER_CONTEXT_HEADER)
    console.log(
      `[kortix-user] ${c.req.method} ${c.req.path} header=${raw ? `present(${raw.slice(0, 16)}…)` : 'absent'}`,
    )
    if (!raw) {
      await next()
      return
    }

    const secret = process.env.KORTIX_TOKEN
    if (!secret) {
      console.warn('[kortix-user] KORTIX_TOKEN unset; skipping verification')
      await next()
      return
    }

    const result = verifyKortixUserContext(raw, secret)
    if (!result.ok) {
      console.warn(
        `[kortix-user] Ignoring bad ${KORTIX_USER_CONTEXT_HEADER} (${result.reason}); continuing without user context`,
      )
      await next()
      return
    }

    console.log(
      `[kortix-user] verified user=${result.context.userId} sandbox=${result.context.sandboxId} role=${result.context.sandboxRole}`,
    )
    c.set('kortixUser', result.context)
    await next()
  }
}
