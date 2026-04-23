const KORTIX_MASTER_URL = `http://127.0.0.1:${process.env.KORTIX_MASTER_PORT || '8000'}`
const TTL_MS = 30_000

interface CacheEntry {
  scopes: Set<string> | null
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

export async function canForSession(sessionId: string | undefined, scope: string): Promise<boolean> {
  if (!sessionId) return true
  const scopes = await getScopesForSession(sessionId)
  if (scopes === null) return true
  return scopes.has(scope)
}

async function getScopesForSession(sessionId: string): Promise<Set<string> | null> {
  const cached = cache.get(sessionId)
  if (cached && cached.expiresAt > Date.now()) return cached.scopes

  let scopes: Set<string> | null = null
  try {
    const res = await fetch(
      `${KORTIX_MASTER_URL}/kortix/internal/session-scopes/${encodeURIComponent(sessionId)}`,
      { signal: AbortSignal.timeout(1500) },
    )
    if (res.ok) {
      const body = (await res.json()) as {
        success?: boolean
        data?: { scopes?: string[] | null }
      }
      if (body?.data?.scopes) {
        scopes = new Set(body.data.scopes)
      }
    }
  } catch (err) {
    console.warn(`[scope-check] lookup failed for ${sessionId}:`, err)
  }

  cache.set(sessionId, { scopes, expiresAt: Date.now() + TTL_MS })
  return scopes
}

export function denyMessage(scope: string): string {
  return `You don't have permission to do this in the current instance (missing \`${scope}\`). Ask the instance owner to grant it.`
}
