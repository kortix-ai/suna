/**
 * Kortix Projects API
 *
 * Reads/writes from the shared .kortix/kortix.db (same DB the orchestrator plugin uses).
 * This is the frontend's source of truth for project data — NOT the OpenCode SDK.
 *
 * Mounted at /kortix/projects in kortix-master.
 */

import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, unlinkSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'

// ── Types ────────────────────────────────────────────────────────────────────

interface ProjectRow {
  id: string; name: string; path: string; description: string
  created_at: string; opencode_id: string | null
}

// ── DB singleton ─────────────────────────────────────────────────────────────

let _db: Database | null = null

function getDb(): Database {
  if (_db) return _db

  const workspace = process.env.KORTIX_WORKSPACE?.trim()
    || process.env.OPENCODE_CONFIG_DIR?.replace(/\/opencode\/?$/, '')
    || '/workspace'
  const dbPath = join(workspace, '.kortix', 'kortix.db')

  if (!existsSync(dirname(dbPath))) {
    mkdirSync(dirname(dbPath), { recursive: true })
  }

  try {
    const dbExists = existsSync(dbPath)
    const dbEmpty = dbExists && statSync(dbPath).size === 0
    if (!dbExists || dbEmpty) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try { unlinkSync(dbPath + suffix) } catch {}
      }
    }
  } catch {}

  try {
    _db = new Database(dbPath)
  } catch {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { unlinkSync(dbPath + suffix) } catch {}
    }
    _db = new Database(dbPath)
  }

  _db.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000')

  _db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      opencode_id TEXT, maintainer_session_id TEXT
    );
  `)

  return _db
}

// ── Router ───────────────────────────────────────────────────────────────────

const projectsRouter = new Hono()

// POST / — create or ensure a project exists
projectsRouter.post('/', async (c) => {
  try {
    const db = getDb()
    const body = await c.req.json<{ id?: string; name?: string; path?: string; description?: string }>().catch(() => ({}))
    const projectPath = body.path?.trim() || '/workspace'
    const existing = db.prepare('SELECT * FROM projects WHERE path=$path').get({ $path: projectPath }) as ProjectRow | null
    if (existing) return c.json(existing)

    const fallbackName = projectPath === '/workspace' ? 'Workspace' : basename(projectPath) || 'Project'
    const name = body.name?.trim() || fallbackName
    const id = body.id?.trim() || `project_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const description = body.description ?? ''
    const createdAt = new Date().toISOString()

    db.prepare(`INSERT INTO projects (id, name, path, description, created_at, opencode_id, maintainer_session_id)
      VALUES ($id, $name, $path, $description, $createdAt, NULL, NULL)`)
      .run({
        $id: id,
        $name: name,
        $path: projectPath,
        $description: description,
        $createdAt: createdAt,
      })

    return c.json(db.prepare('SELECT * FROM projects WHERE id=$id').get({ $id: id }))
  } catch (e) {
    return c.json({ error: String(e) }, 400)
  }
})

// GET / — list all projects with stats
projectsRouter.get('/', async (c) => {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[]
  const enriched = rows.map((p) => {
    const sessionCount = (db.prepare(
      'SELECT COUNT(*) as c FROM session_projects WHERE project_id=$pid'
    ).get({ $pid: p.id }) as { c: number })?.c || 0
    return {
      ...p,
      sessionCount,
    }
  })
  return c.json(enriched)
})

// GET /:id — single project
projectsRouter.get('/:id', async (c) => {
  const db = getDb()
  const id = decodeURIComponent(c.req.param('id'))
  const p = (
    db.prepare('SELECT * FROM projects WHERE id=$v').get({ $v: id })
    || db.prepare('SELECT * FROM projects WHERE opencode_id=$v').get({ $v: id })
    || db.prepare('SELECT * FROM projects WHERE LOWER(name)=LOWER($v)').get({ $v: id })
  ) as ProjectRow | null
  if (!p) return c.json({ error: 'Project not found' }, 404)

  return c.json(p)
})

// GET /:id/sessions — sessions linked to this project via session_projects table
// Enriches with OpenCode session data (title, time, etc.) from the OC API
projectsRouter.get('/:id/sessions', async (c) => {
  const db = getDb()
  const id = decodeURIComponent(c.req.param('id'))
  const p = (
    db.prepare('SELECT * FROM projects WHERE id=$v').get({ $v: id })
    || db.prepare('SELECT * FROM projects WHERE opencode_id=$v').get({ $v: id })
    || db.prepare('SELECT * FROM projects WHERE LOWER(name)=LOWER($v)').get({ $v: id })
  ) as ProjectRow | null
  if (!p) return c.json({ error: 'Project not found' }, 404)

  // Get session IDs linked to this project
  const links = db.prepare(
    'SELECT session_id FROM session_projects WHERE project_id=$pid ORDER BY set_at DESC'
  ).all({ $pid: p.id }) as Array<{ session_id: string }>

  const sessionIds = new Set(links.map(l => l.session_id))

  // Fetch all sessions from OpenCode and filter to our linked set
  try {
    const ocPort = process.env.OPENCODE_PORT || '4096'
    const ocRes = await fetch(`http://127.0.0.1:${ocPort}/session`, { signal: AbortSignal.timeout(5000) })
    if (ocRes.ok) {
      const ocData = await ocRes.json() as any
      const allSessions = Array.isArray(ocData) ? ocData : (ocData.data ?? [])
      // Include all project sessions (parents + children)
      const matched = allSessions
        .filter((s: any) => sessionIds.has(s.id))
        .sort((a: any, b: any) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))

      // Enrich with task info — which task owns which session
      const tasksBySession = new Map<string, { id: string; title: string; status: string }>()
      try {
        const tasks = db.prepare(
          'SELECT id, title, status, owner_session_id FROM tasks WHERE project_id=$pid AND owner_session_id IS NOT NULL'
        ).all({ $pid: p.id }) as Array<{ id: string; title: string; status: string; owner_session_id: string }>
        for (const t of tasks) tasksBySession.set(t.owner_session_id, { id: t.id, title: t.title, status: t.status })
      } catch {}

      const enriched = matched.map((s: any) => ({
        ...s,
        task: tasksBySession.get(s.id) || null,
      }))
      return c.json(enriched)
    }
  } catch {}

  // Fallback: return just the IDs without enrichment
  return c.json(links.map(l => ({ id: l.session_id })))
})

// GET /by-session/:sessionId — resolve the project linked to a session
projectsRouter.get('/by-session/:sessionId', async (c) => {
  const db = getDb()
  const sessionId = decodeURIComponent(c.req.param('sessionId'))
  const p = db.prepare(
    'SELECT p.* FROM session_projects sp JOIN projects p ON sp.project_id = p.id WHERE sp.session_id=$sid LIMIT 1'
  ).get({ $sid: sessionId }) as ProjectRow | null
  if (!p) return c.json({ error: 'No project linked' }, 404)
  return c.json(p)
})

// DELETE /by-session/:sessionId — unlink a session from any project
projectsRouter.delete('/by-session/:sessionId', async (c) => {
  try {
    const db = getDb()
    const sessionId = decodeURIComponent(c.req.param('sessionId'))
    db.exec(`CREATE TABLE IF NOT EXISTS session_projects (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      set_at TEXT NOT NULL
    )`)
    db.prepare('DELETE FROM session_projects WHERE session_id=$sid').run({ $sid: sessionId })
    return c.json({ ok: true, session_id: sessionId })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

// DELETE /:id — remove project from registry (does NOT delete files on disk)
projectsRouter.delete('/:id', async (c) => {
  const db = getDb()
  const id = decodeURIComponent(c.req.param('id'))
  const p = (
    db.prepare('SELECT * FROM projects WHERE id=$v').get({ $v: id })
    || db.prepare('SELECT * FROM projects WHERE opencode_id=$v').get({ $v: id })
    || db.prepare('SELECT * FROM projects WHERE LOWER(name)=LOWER($v)').get({ $v: id })
  ) as ProjectRow | null
  if (!p) return c.json({ error: 'Project not found' }, 404)

  // Clean up all related records
  try { db.prepare('DELETE FROM session_projects WHERE project_id=$pid').run({ $pid: p.id }) } catch {}
  db.prepare('DELETE FROM projects WHERE id=$id').run({ $id: p.id })

  return c.json({ deleted: true, name: p.name, path: p.path })
})

// PATCH /:id — update project
projectsRouter.patch('/:id', async (c) => {
  const db = getDb()
  const id = decodeURIComponent(c.req.param('id'))
  const body = await c.req.json<{ name?: string; description?: string }>()
  const p = db.prepare('SELECT * FROM projects WHERE id=$id').get({ $id: id }) as ProjectRow | null
  if (!p) return c.json({ error: 'Project not found' }, 404)

  if (body.name !== undefined) {
    db.prepare('UPDATE projects SET name=$n WHERE id=$id').run({ $n: body.name, $id: id })
  }
  if (body.description !== undefined) {
    db.prepare('UPDATE projects SET description=$d WHERE id=$id').run({ $d: body.description, $id: id })
  }
  return c.json(db.prepare('SELECT * FROM projects WHERE id=$id').get({ $id: id }))
})

// POST /:id/link-session — bind any existing session to this project
projectsRouter.post('/:id/link-session', async (c) => {
  try {
    const db = getDb()
    const id = decodeURIComponent(c.req.param('id'))
    const p = (
      db.prepare('SELECT * FROM projects WHERE id=$v').get({ $v: id })
      || db.prepare('SELECT * FROM projects WHERE opencode_id=$v').get({ $v: id })
      || db.prepare('SELECT * FROM projects WHERE LOWER(name)=LOWER($v)').get({ $v: id })
    ) as ProjectRow | null
    if (!p) return c.json({ error: 'Project not found' }, 404)

    const body = await c.req.json<{ session_id?: string }>()
    const sessionId = body.session_id?.trim()
    if (!sessionId) return c.json({ error: 'session_id required' }, 400)

    db.exec(`CREATE TABLE IF NOT EXISTS session_projects (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      set_at TEXT NOT NULL
    )`)
    db.prepare('INSERT OR REPLACE INTO session_projects (session_id, project_id, set_at) VALUES ($sid, $pid, $now)').run({
      $sid: sessionId,
      $pid: p.id,
      $now: new Date().toISOString(),
    })

    return c.json({ ok: true, project_id: p.id, session_id: sessionId })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

export default projectsRouter
