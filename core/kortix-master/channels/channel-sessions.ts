import { getDb } from './channel-db'

function ensureSessionTable(): void {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_sessions (
      session_key TEXT PRIMARY KEY,
      current_session_id TEXT NOT NULL,
      history TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
  `)
}

try { ensureSessionTable() } catch {}

export function getSessionState(sessionKey: string): { currentId: string | null; history: string[] } {
  try {
    ensureSessionTable()
    const db = getDb()
    const row = db.prepare('SELECT current_session_id, history FROM channel_sessions WHERE session_key = ?').get(sessionKey) as { current_session_id: string; history: string } | null
    if (!row) return { currentId: null, history: [] }
    return { currentId: row.current_session_id, history: JSON.parse(row.history || '[]') }
  } catch {
    return { currentId: null, history: [] }
  }
}

export function rememberSession(sessionKey: string, sessionId: string): void {
  try {
    ensureSessionTable()
    const db = getDb()
    const existing = getSessionState(sessionKey)
    const history = [sessionId, ...existing.history.filter(id => id !== sessionId)].slice(0, 10)
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO channel_sessions (session_key, current_session_id, history, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET current_session_id = excluded.current_session_id, history = excluded.history, updated_at = excluded.updated_at
    `).run(sessionKey, sessionId, JSON.stringify(history), now)
  } catch {}
}

export function clearSession(sessionKey: string): void {
  try {
    ensureSessionTable()
    const db = getDb()
    db.prepare('UPDATE channel_sessions SET current_session_id = \'\', updated_at = ? WHERE session_key = ?')
      .run(new Date().toISOString(), sessionKey)
  } catch {}
}

export function clearChannelSessions(platform: 'telegram' | 'slack', channelId: string): number {
  try {
    ensureSessionTable()
    const db = getDb()
    const result = db.prepare('DELETE FROM channel_sessions WHERE session_key LIKE ?').run(`${platform}:${channelId}:%`)
    return result.changes
  } catch {
    return 0
  }
}
