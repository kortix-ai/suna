import type { MemberContext } from './member-context'
import { grantedProjectsFor } from './workspace'

const SOCKET_PATH =
  process.env.KORTIX_SUPERVISOR_SOCKET || '/run/kortix/supervisor.sock'
const CACHE_TTL_MS = 30_000
const ENSURE_TIMEOUT_MS = 60_000
const LEGACY_OWNER_STORAGE_BASE = '/persistent/opencode'

interface CachedPort {
  port: number
  expiresAt: number
}

const portCache = new Map<string, CachedPort>()

export function isIsolationEnabled(): boolean {
  return process.env.KORTIX_LINUX_ISOLATION === 'on'
}

export function storageBaseFor(member: MemberContext): string {
  return `${member.homeDir}/opencode`
}

export function migrateFromFor(member: MemberContext): string | undefined {
  if (member.role === 'owner' || member.role === 'platform_admin') {
    return LEGACY_OWNER_STORAGE_BASE
  }
  return undefined
}

export function invalidateSupervisorCache(supabaseUserId: string): void {
  portCache.delete(supabaseUserId)
}

export async function ensureMemberDaemon(member: MemberContext): Promise<number> {
  const cached = portCache.get(member.supabaseUserId)
  if (cached && cached.expiresAt > Date.now()) return cached.port

  const projectIds = grantedProjectsFor(member).map((p) => p.id)
  const body = JSON.stringify({
    supabase_user_id: member.supabaseUserId,
    username: member.username,
    linux_uid: member.linuxUid,
    storage_base: storageBaseFor(member),
    migrate_from: migrateFromFor(member),
    role: member.role,
    project_ids: projectIds,
  })

  const res = await fetch('http://supervisor/daemon/ensure', {
    // @ts-ignore Bun supports unix option
    unix: SOCKET_PATH,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(ENSURE_TIMEOUT_MS),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`supervisor ensure failed: ${res.status} ${text}`)
  }

  const payload = (await res.json()) as { port?: number }
  if (typeof payload.port !== 'number') {
    throw new Error(`supervisor ensure returned no port: ${JSON.stringify(payload)}`)
  }

  portCache.set(member.supabaseUserId, {
    port: payload.port,
    expiresAt: Date.now() + CACHE_TTL_MS,
  })
  return payload.port
}

export async function stopMemberDaemon(supabaseUserId: string): Promise<void> {
  portCache.delete(supabaseUserId)
  try {
    await fetch('http://supervisor/daemon/stop', {
      // @ts-ignore
      unix: SOCKET_PATH,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ supabase_user_id: supabaseUserId }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch (err) {
    console.warn(
      `[supervisor-client] stop failed for ${supabaseUserId}: ${err instanceof Error ? err.message : err}`,
    )
  }
}
