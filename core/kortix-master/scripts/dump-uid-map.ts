import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'

const workspace =
  process.env.KORTIX_WORKSPACE?.trim() ||
  process.env.OPENCODE_CONFIG_DIR?.replace(/\/opencode\/?$/, '') ||
  '/workspace'
const dbPath = process.env.KORTIX_DB_PATH || join(workspace, '.kortix', 'kortix.db')

if (!existsSync(dbPath)) process.exit(0)

const db = new Database(dbPath, { readonly: true })
try {
  const row = db
    .query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='supabase_uid_map'`,
    )
    .get() as { name?: string } | null
  if (!row?.name) process.exit(0)

  const rows = db
    .query(
      `SELECT supabase_user_id, linux_uid, username, primary_gid
       FROM supabase_uid_map ORDER BY linux_uid ASC`,
    )
    .all() as Array<{
      supabase_user_id: string
      linux_uid: number
      username: string
      primary_gid: number
    }>
  for (const r of rows) {
    process.stdout.write(`${r.supabase_user_id}\t${r.linux_uid}\t${r.username}\t${r.primary_gid}\n`)
  }
} finally {
  db.close()
}
