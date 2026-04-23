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

  ensureColumn(db, 'projects', 'kind', `TEXT NOT NULL DEFAULT 'scoped'`, () => {
    db.exec(`UPDATE projects SET kind='workspace' WHERE path='/workspace'`)
  })

  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_workspace_kind
     ON projects(kind) WHERE kind='workspace'`,
  )
}

function ensureColumn(
  db: Database,
  table: string,
  column: string,
  definition: string,
  backfill?: () => void,
): void {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>
  if (cols.some((c) => c.name === column)) return

  const MAX_ATTEMPTS = 5
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      backfill?.()
      return
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(
          `migration failed: could not add ${table}.${column} after ${attempt} attempts: ${message}`,
        )
      }
      console.warn(
        `[db] ALTER TABLE ${table} ADD ${column} attempt ${attempt} failed (${message}); retrying`,
      )
      const deadline = Date.now() + 500 * attempt
      while (Date.now() < deadline) {}
    }
  }
}
