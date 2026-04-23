import { createHash } from 'crypto'
import { getDb } from './db'

export interface UidRow {
  supabaseUserId: string
  linuxUid: number
  username: string
  primaryGid: number
  createdAt: number
}

export const UID_MIN = 10_000
export const UID_MAX = 19_999

const TTL_MS = 60_000
const cache = new Map<string, { row: UidRow; expiresAt: number }>()

export function usernameFor(supabaseUserId: string): string {
  const hash = createHash('sha256').update(supabaseUserId).digest('hex')
  return `k_${hash.slice(0, 10)}`
}

export function getUidFor(supabaseUserId: string): UidRow | null {
  if (!supabaseUserId) return null
  const hit = cache.get(supabaseUserId)
  if (hit && hit.expiresAt > Date.now()) return hit.row
  if (hit) cache.delete(supabaseUserId)

  const db = getDb()
  const raw = db
    .prepare(
      `SELECT supabase_user_id, linux_uid, username, primary_gid, created_at
       FROM supabase_uid_map WHERE supabase_user_id=?`,
    )
    .get(supabaseUserId) as
    | { supabase_user_id: string; linux_uid: number; username: string; primary_gid: number; created_at: number }
    | null
  if (!raw) return null

  const row: UidRow = {
    supabaseUserId: raw.supabase_user_id,
    linuxUid: raw.linux_uid,
    username: raw.username,
    primaryGid: raw.primary_gid,
    createdAt: raw.created_at,
  }
  cache.set(supabaseUserId, { row, expiresAt: Date.now() + TTL_MS })
  return row
}

export function ensureUidFor(supabaseUserId: string): UidRow {
  const existing = getUidFor(supabaseUserId)
  if (existing) return existing

  const db = getDb()
  const tx = db.transaction((userId: string): UidRow => {
    const again = db
      .prepare(
        `SELECT supabase_user_id, linux_uid, username, primary_gid, created_at
         FROM supabase_uid_map WHERE supabase_user_id=?`,
      )
      .get(userId) as
      | { supabase_user_id: string; linux_uid: number; username: string; primary_gid: number; created_at: number }
      | null
    if (again) {
      return {
        supabaseUserId: again.supabase_user_id,
        linuxUid: again.linux_uid,
        username: again.username,
        primaryGid: again.primary_gid,
        createdAt: again.created_at,
      }
    }

    const next = db
      .prepare(
        `SELECT COALESCE(MAX(linux_uid) + 1, ?) AS next_uid
         FROM supabase_uid_map`,
      )
      .get(UID_MIN) as { next_uid: number }
    const linuxUid = next.next_uid
    if (linuxUid > UID_MAX) {
      throw new Error(`[uid-map] uid pool exhausted (max=${UID_MAX})`)
    }

    const row: UidRow = {
      supabaseUserId: userId,
      linuxUid,
      username: usernameFor(userId),
      primaryGid: linuxUid,
      createdAt: Math.floor(Date.now() / 1000),
    }
    db.prepare(
      `INSERT INTO supabase_uid_map
       (supabase_user_id, linux_uid, username, primary_gid, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(row.supabaseUserId, row.linuxUid, row.username, row.primaryGid, row.createdAt)
    return row
  })

  const row = tx(supabaseUserId)
  cache.set(supabaseUserId, { row, expiresAt: Date.now() + TTL_MS })
  return row
}

export function listUidRows(): UidRow[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT supabase_user_id, linux_uid, username, primary_gid, created_at
       FROM supabase_uid_map ORDER BY linux_uid ASC`,
    )
    .all() as Array<{
      supabase_user_id: string
      linux_uid: number
      username: string
      primary_gid: number
      created_at: number
    }>
  return rows.map((r) => ({
    supabaseUserId: r.supabase_user_id,
    linuxUid: r.linux_uid,
    username: r.username,
    primaryGid: r.primary_gid,
    createdAt: r.created_at,
  }))
}

export function clearUidMapCache(): void {
  cache.clear()
}
