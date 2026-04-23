const TTL_MS = 60_000

interface Entry {
  scopes: Set<string>
  expiresAt: number
}

const cache = new Map<string, Entry>()

export function rememberUserScopes(userId: string, scopes: string[]): void {
  if (!userId) return
  cache.set(userId, { scopes: new Set(scopes), expiresAt: Date.now() + TTL_MS })
}

export function getUserScopes(userId: string): ReadonlySet<string> | null {
  const entry = cache.get(userId)
  if (!entry) return null
  if (entry.expiresAt < Date.now()) {
    cache.delete(userId)
    return null
  }
  return entry.scopes
}

export function clearUserScopeCache(): void {
  cache.clear()
}
