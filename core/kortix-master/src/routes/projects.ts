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
import type { KortixUserContext } from '../services/kortix-user-context'
import { hasScope } from '../services/permissions'

// Project ACL rule:
//   - managers (owner / admin / platform_admin) see every project
//   - plain members see only projects they have an explicit grant for
//
// No header at all = service-key / internal caller → bypass. Returns true
// when the caller may see the project; callers render the deny response.
function enforceProjectAccess(c: any, projectId: string): boolean {
  const user = c.get('kortixUser') as KortixUserContext | undefined
  if (!user) return true // service-key traffic
  if (
    user.sandboxRole === 'platform_admin' ||
    user.sandboxRole === 'owner' ||
    user.sandboxRole === 'admin'
  ) {
    return true
  }
  return userHasProjectGrant(projectId, user.userId)
}

function isProjectManager(c: any): boolean {
  const user = c.get('kortixUser') as KortixUserContext | undefined
  if (!user) return true // service-key path bypasses
  return (
    user.sandboxRole === 'platform_admin' ||
    user.sandboxRole === 'owner' ||
    user.sandboxRole === 'admin'
  )
}

function userCan(c: any, scope: string): boolean {
  const user = c.get('kortixUser') as KortixUserContext | undefined
  return hasScope(user, scope)
}

/**
 * Return the subset of `projectIds` visible to a non-manager user. Only
 * projects with an explicit grant for this user pass through. Single
 * indexed query.
 */
function filterVisibleProjectIdsForUser(projectIds: string[], user: KortixUserContext): string[] {
  if (projectIds.length === 0) return projectIds
  const db = getDb()
  const placeholders = projectIds.map(() => '?').join(',')
  const grantRows = db
    .prepare(
      `SELECT project_id FROM project_members WHERE user_id=? AND project_id IN (${placeholders})`,
    )
    .all(user.userId, ...projectIds) as Array<{ project_id: string }>
  const allowedSet = new Set(grantRows.map((r) => r.project_id))
  return projectIds.filter((pid) => allowedSet.has(pid))
}

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

    -- Per-project ACL. Lives here (not in central Postgres) so the source
    -- of truth for projects and their access policy is one database with
    -- real referential integrity. A project with zero rows here is "open"
    -- (every sandbox member sees it, matches pre-ACL behavior); any row
    -- flips it to strict mode.
    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      added_by TEXT,
      added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (project_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
  `)
  _db.exec('PRAGMA foreign_keys=ON')

  return _db
}

// ── ACL helpers (used by the enforcement guard below) ──────────────────────

/**
 * Does this user have an explicit grant on this project?
 *
 * Rule: managers (owner / admin / platform_admin) see everything unconditionally.
 * Plain members only see a project when they are explicitly listed in
 * project_members. No "open mode" fallback — if you want someone to see a
 * project, add them.
 */
export function userHasProjectGrant(projectId: string, userId: string): boolean {
  const db = getDb()
  const row = db
    .prepare('SELECT 1 as x FROM project_members WHERE project_id=$pid AND user_id=$uid')
    .get({ $pid: projectId, $uid: userId }) as { x: number } | null
  return !!row
}

// ── Router ───────────────────────────────────────────────────────────────────

const projectsRouter = new Hono()

// POST / — create or ensure a project exists
projectsRouter.post('/', async (c) => {
  if (!userCan(c, 'projects:create')) {
    return c.json({ error: 'Missing permission: projects:create' }, 403)
  }
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
  // Filter out projects the caller can't see. Invisible to them by design —
  // not 404, not 403. Managers and unauthenticated service traffic see everything.
  const user = c.get('kortixUser') as KortixUserContext | undefined
  let visible = rows
  if (user && !isProjectManager(c)) {
    const visibleIds = new Set(filterVisibleProjectIdsForUser(rows.map((r) => r.id), user))
    visible = rows.filter((p) => visibleIds.has(p.id))
  }
  const enriched = visible.map((p) => {
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
  if (!enforceProjectAccess(c, p.id)) {
    // 404 instead of 403 so we don't confirm the project's existence to
    // someone who shouldn't know it's there.
    return c.json({ error: 'Project not found' }, 404)
  }

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
  if (!enforceProjectAccess(c, p.id)) {
    return c.json({ error: 'Project not found' }, 404)
  }

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
  if (!enforceProjectAccess(c, p.id)) {
    return c.json({ error: 'Project not found' }, 404)
  }
  if (!userCan(c, 'projects:delete')) {
    return c.json({ error: 'Missing permission: projects:delete' }, 403)
  }

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
  if (!enforceProjectAccess(c, p.id)) {
    return c.json({ error: 'Project not found' }, 404)
  }
  if (!userCan(c, 'projects:rename')) {
    return c.json({ error: 'Missing permission: projects:rename' }, 403)
  }

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

// ─── Project members (local ACL) ─────────────────────────────────────────────
// GET/POST/DELETE /:id/members. Manager-gated: owner / admin / platform_admin.
// Target user ids are supabase auth user ids — we don't validate existence,
// we just store the grant. Email hydration happens client-side by joining
// against the already-fetched sandbox member list.

function resolveProject(id: string): ProjectRow | null {
  const db = getDb()
  return (
    db.prepare('SELECT * FROM projects WHERE id=$v').get({ $v: id })
    || db.prepare('SELECT * FROM projects WHERE opencode_id=$v').get({ $v: id })
    || db.prepare('SELECT * FROM projects WHERE LOWER(name)=LOWER($v)').get({ $v: id })
  ) as ProjectRow | null
}

projectsRouter.get('/:id/members', async (c) => {
  if (!userCan(c, 'projects:access.manage')) {
    return c.json({ error: 'Missing permission: projects:access.manage' }, 403)
  }
  const p = resolveProject(decodeURIComponent(c.req.param('id')))
  if (!p) return c.json({ error: 'Project not found' }, 404)
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM project_members WHERE project_id=$pid ORDER BY added_at ASC')
    .all({ $pid: p.id }) as Array<{
      project_id: string
      user_id: string
      role: string
      added_by: string | null
      added_at: string
    }>
  return c.json({
    project_id: p.id,
    members: rows.map((r) => ({
      user_id: r.user_id,
      role: r.role,
      added_by: r.added_by,
      added_at: r.added_at,
    })),
  })
})

projectsRouter.post('/:id/members', async (c) => {
  if (!userCan(c, 'projects:access.manage')) {
    return c.json({ error: 'Missing permission: projects:access.manage' }, 403)
  }
  const p = resolveProject(decodeURIComponent(c.req.param('id')))
  if (!p) return c.json({ error: 'Project not found' }, 404)
  const body = await c.req.json<{ user_id?: string; role?: string }>().catch(() => ({}))
  const targetUserId = typeof body.user_id === 'string' ? body.user_id.trim() : ''
  if (!targetUserId) return c.json({ error: 'user_id is required' }, 400)
  const role = body.role === 'admin' ? 'admin' : 'member'
  const addedBy = (c.get('kortixUser') as KortixUserContext | undefined)?.userId ?? null

  const db = getDb()
  db.prepare(
    `INSERT INTO project_members (project_id, user_id, role, added_by)
     VALUES ($pid, $uid, $role, $by)
     ON CONFLICT(project_id, user_id) DO UPDATE SET role=$role`,
  ).run({ $pid: p.id, $uid: targetUserId, $role: role, $by: addedBy })

  return c.json({ ok: true, project_id: p.id, user_id: targetUserId, role })
})

projectsRouter.delete('/:id/members/:userId', async (c) => {
  if (!userCan(c, 'projects:access.manage')) {
    return c.json({ error: 'Missing permission: projects:access.manage' }, 403)
  }
  const p = resolveProject(decodeURIComponent(c.req.param('id')))
  if (!p) return c.json({ error: 'Project not found' }, 404)
  const userId = c.req.param('userId')
  const db = getDb()
  db.prepare('DELETE FROM project_members WHERE project_id=$pid AND user_id=$uid').run({
    $pid: p.id,
    $uid: userId,
  })
  return c.json({ ok: true })
})

export default projectsRouter
