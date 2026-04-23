import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, statSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'

let handle: Database | null = null

export function resolveDbPath(): string {
  const workspace =
    process.env.KORTIX_WORKSPACE?.trim() ||
    process.env.OPENCODE_CONFIG_DIR?.replace(/\/opencode\/?$/, '') ||
    '/workspace'
  return join(workspace, '.kortix', 'kortix.db')
}

export function getDb(): Database {
  if (handle) return handle

  const dbPath = resolveDbPath()
  const dir = dirname(dbPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  try {
    const exists = existsSync(dbPath)
    const empty = exists && statSync(dbPath).size === 0
    if (!exists || empty) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try { unlinkSync(dbPath + suffix) } catch {}
      }
    }
  } catch {}

  try {
    handle = new Database(dbPath)
  } catch {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { unlinkSync(dbPath + suffix) } catch {}
    }
    handle = new Database(dbPath)
  }

  handle.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000')
  migrate(handle)
  handle.exec('PRAGMA foreign_keys=ON')
  return handle
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      opencode_id TEXT,
      maintainer_session_id TEXT
    );

    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      added_by TEXT,
      added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (project_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

    CREATE TABLE IF NOT EXISTS supabase_uid_map (
      supabase_user_id TEXT PRIMARY KEY,
      linux_uid INTEGER NOT NULL UNIQUE,
      username TEXT NOT NULL UNIQUE,
      primary_gid INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_uid_map_uid ON supabase_uid_map(linux_uid);
  `)
}
