/**
 * Session-ownership tracking. Rows in `.kortix/kortix.db` mapping each
 * opencode session id to the user who created it. Kortix-master uses
 * this to:
 *   - Stamp ownership on session creation (POST /session).
 *   - Filter session lists (GET /session) to the caller's own sessions.
 *
 * Stamped sessions are strictly per-user — even the sandbox owner can't
 * see a member's session. Unstamped legacy rows (sessions that existed
 * before this layer was deployed) are visible to managers only, so the
 * owner keeps pre-existing work while plain members never see traces of
 * sessions they never created.
 */

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

let _db: Database | null = null

function getDb(): Database {
  if (_db) return _db

  const workspace =
    process.env.KORTIX_WORKSPACE?.trim() ||
    process.env.OPENCODE_CONFIG_DIR?.replace(/\/opencode\/?$/, '') ||
    '/workspace'
  const dbPath = join(workspace, '.kortix', 'kortix.db')
  if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true })

  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_owners (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      stamped_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_session_owners_user ON session_owners(user_id);
  `)
  _db = db
  return db
}

export function stampSessionOwner(sessionId: string, userId: string): void {
  if (!sessionId || !userId) return
  try {
    getDb()
      .prepare(
        'INSERT OR IGNORE INTO session_owners (session_id, user_id) VALUES ($sid, $uid)',
      )
      .run({ $sid: sessionId, $uid: userId })
  } catch (err) {
    console.warn('[session-ownership] Failed to stamp session owner:', err)
  }
}

/**
 * Pure predicate — is this session visible to `userId`? Stamped rows match
 * the stored owner exactly. Unstamped rows fall through to `canSeeLegacy`
 * (true for managers, false for plain members).
 */
export function isSessionVisibleToUser(
  sessionId: string,
  userId: string,
  canSeeLegacy: boolean,
): boolean {
  try {
    const row = getDb()
      .prepare('SELECT user_id FROM session_owners WHERE session_id=$sid')
      .get({ $sid: sessionId }) as { user_id: string } | null
    if (!row) return canSeeLegacy
    return row.user_id === userId
  } catch (err) {
    console.warn('[session-ownership] Lookup failed, denying:', err)
    return false
  }
}

/**
 * Bulk-filter an opencode session array. Returns the subset the caller can see.
 * Loaded once per request: O(sessions) sqlite lookups against a PRIMARY KEY,
 * which is well under a millisecond for the volume we expect (tens of rows).
 */
export function filterVisibleSessions<T extends { id: string }>(
  sessions: T[],
  userId: string,
  canSeeLegacy: boolean,
): T[] {
  if (sessions.length === 0) return sessions
  try {
    const ids = sessions.map((s) => s.id)
    const placeholders = ids.map(() => '?').join(',')
    const rows = getDb()
      .prepare(`SELECT session_id, user_id FROM session_owners WHERE session_id IN (${placeholders})`)
      .all(...ids) as Array<{ session_id: string; user_id: string }>
    const ownerBySession = new Map(rows.map((r) => [r.session_id, r.user_id]))
    return sessions.filter((s) => {
      const owner = ownerBySession.get(s.id)
      if (!owner) return canSeeLegacy
      return owner === userId
    })
  } catch (err) {
    console.warn('[session-ownership] Bulk filter failed, denying:', err)
    return []
  }
}

export function deleteSessionOwner(sessionId: string): void {
  try {
    getDb().prepare('DELETE FROM session_owners WHERE session_id=$sid').run({ $sid: sessionId })
  } catch (err) {
    console.warn('[session-ownership] Failed to delete session owner:', err)
  }
}
