import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'

const legacyMigrateRouter = new Hono()

const OPENCODE_DB_PATH = process.env.OPENCODE_DB_PATH
  || `${process.env.OPENCODE_STORAGE_BASE || `${process.env.KORTIX_PERSISTENT_ROOT || '/persistent'}/opencode`}/opencode.db`

legacyMigrateRouter.post('/migrate', async (c) => {
  const body = await c.req.json<{ sql: string; sessionId?: string }>()
  if (!body.sql) {
    return c.json({ error: 'Missing sql in request body' }, 400)
  }

  if (!existsSync(OPENCODE_DB_PATH)) {
    return c.json({ error: 'OpenCode database not found', dbPath: OPENCODE_DB_PATH }, 503)
  }

  let db: Database | null = null
  try {
    db = new Database(OPENCODE_DB_PATH)
    db.exec('PRAGMA busy_timeout=5000')
    db.exec(body.sql)

    let verification = null
    if (body.sessionId) {
      const row = db.query('SELECT id, title FROM session WHERE id = ?').get(body.sessionId) as any
      const msgCount = db.query('SELECT COUNT(*) as count FROM message WHERE session_id = ?').get(body.sessionId) as any
      const partCount = db.query('SELECT COUNT(*) as count FROM part WHERE session_id = ?').get(body.sessionId) as any
      verification = {
        sessionFound: !!row,
        messageCount: msgCount?.count ?? 0,
        partCount: partCount?.count ?? 0,
      }
    }

    db.close()
    db = null
    return c.json({ success: true, verification })
  } catch (err: any) {
    if (db) db.close()
    console.error('[legacy-migrate] SQL execution error:', err)
    return c.json({ error: err.message || 'SQL execution failed' }, 500)
  }
})

legacyMigrateRouter.get('/schema', async (c) => {
  if (!existsSync(OPENCODE_DB_PATH)) {
    return c.json({ error: 'OpenCode database not found' }, 503)
  }
  let db: Database | null = null
  try {
    db = new Database(OPENCODE_DB_PATH, { readonly: true })
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    const schema: Record<string, any> = {}
    for (const t of tables as any[]) {
      schema[t.name] = db.query(`PRAGMA table_info('${t.name}')`).all()
    }
    db.close()
    return c.json(schema)
  } catch (err: any) {
    if (db) db.close()
    return c.json({ error: err.message }, 500)
  }
})

export default legacyMigrateRouter
