import type { Context } from 'hono'
import type { KortixUserContext } from './kortix-user-context'
import { ensureUidFor, type UidRow } from './uid-map'

export interface MemberContext {
  supabaseUserId: string
  sandboxId: string
  role: 'owner' | 'admin' | 'member' | 'platform_admin'
  scopes: ReadonlySet<string>
  linuxUid: number
  username: string
  primaryGid: number
  homeDir: string
}

export const MEMBER_HOME_ROOT = '/srv/kortix/home'

export function homeDirFor(username: string): string {
  return `${MEMBER_HOME_ROOT}/${username}`
}

export function buildMemberContext(user: KortixUserContext): MemberContext {
  const row: UidRow = ensureUidFor(user.userId)
  return {
    supabaseUserId: user.userId,
    sandboxId: user.sandboxId,
    role: user.sandboxRole,
    scopes: new Set(user.scopes ?? []),
    linuxUid: row.linuxUid,
    username: row.username,
    primaryGid: row.primaryGid,
    homeDir: homeDirFor(row.username),
  }
}

export function getMember(c: Context): MemberContext | undefined {
  return c.get('kortixMember')
}
