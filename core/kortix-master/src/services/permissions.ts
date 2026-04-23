import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'

import type { KortixUserContext } from './kortix-user-context'

export type KortixScope = string

const WILDCARD: KortixScope = '*'
const MANAGER_ROLES = new Set(['owner', 'platform_admin'])

function getUser(c: Context): KortixUserContext | undefined {
  return c.get('kortixUser') as KortixUserContext | undefined
}

export function hasScope(
  user: KortixUserContext | undefined,
  scope: KortixScope,
): boolean {
  if (!user) return true
  if (MANAGER_ROLES.has(user.sandboxRole)) return true
  if (user.scopes?.includes(WILDCARD)) return true
  return user.scopes?.includes(scope) ?? false
}

export function hasScopeIn(
  user: KortixUserContext | undefined,
  ...scopes: KortixScope[]
): boolean {
  return scopes.some((s) => hasScope(user, s))
}

export function requireScope(scope: KortixScope) {
  return async (c: Context, next: () => Promise<void>) => {
    const user = getUser(c)
    if (!hasScope(user, scope)) {
      throw new HTTPException(403, { message: `Missing permission: ${scope}` })
    }
    await next()
  }
}

export function assertScope(c: Context, scope: KortixScope): void {
  const user = getUser(c)
  if (!hasScope(user, scope)) {
    throw new HTTPException(403, { message: `Missing permission: ${scope}` })
  }
}

export function isManager(user: KortixUserContext | undefined): boolean {
  if (!user) return true
  return MANAGER_ROLES.has(user.sandboxRole)
}
