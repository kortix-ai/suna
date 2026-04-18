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
import { ensureTicketTables, getAgentBySlug } from '../services/ticket-service'
import { seedV2Project, syncTeamSection, DEFAULT_PM_SLUG } from '../services/project-v2-seed'
import { wakeAgentForProject, type OpenCodeClientLike } from '../services/ticket-triggers'
import { createOpencodeClient } from '@opencode-ai/sdk/client'
import { config } from '../config'

// ── Types ────────────────────────────────────────────────────────────────────

interface ProjectRow {
  id: string; name: string; path: string; description: string
  created_at: string; opencode_id: string | null
  structure_version?: number
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
      opencode_id TEXT, maintainer_session_id TEXT,
      structure_version INTEGER NOT NULL DEFAULT 1,
      user_handle TEXT
    );
  `)
  try { _db.exec(`ALTER TABLE projects ADD COLUMN structure_version INTEGER NOT NULL DEFAULT 1`) } catch {}
  try { _db.exec(`ALTER TABLE projects ADD COLUMN user_handle TEXT`) } catch {}
  ensureTicketTables(_db)

  return _db
}

// ── Router ───────────────────────────────────────────────────────────────────

const projectsRouter = new Hono()

// POST / — create or ensure a project exists
projectsRouter.post('/', async (c) => {
  try {
    const db = getDb()
    const body = await c.req.json<{ id?: string; name?: string; path?: string; description?: string; structure_version?: number; user_handle?: string }>().catch(() => ({} as { id?: string; name?: string; path?: string; description?: string; structure_version?: number; user_handle?: string }))
    const projectPath = body.path?.trim() || '/workspace'
    const existing = db.prepare('SELECT * FROM projects WHERE path=$path').get({ $path: projectPath }) as ProjectRow | null
    if (existing) {
      if (body.user_handle && body.user_handle.trim() && !(existing as any).user_handle) {
        db.prepare('UPDATE projects SET user_handle=$h WHERE id=$id').run({ $h: body.user_handle.trim(), $id: existing.id })
        return c.json(db.prepare('SELECT * FROM projects WHERE id=$id').get({ $id: existing.id }))
      }
      return c.json(existing)
    }

    const fallbackName = projectPath === '/workspace' ? 'Workspace' : basename(projectPath) || 'Project'
    const name = body.name?.trim() || fallbackName
    const id = body.id?.trim() || `project_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const description = body.description ?? ''
    const userHandle = body.user_handle?.trim() || null
    const createdAt = new Date().toISOString()
    // New projects default to v2. Pass structure_version=1 explicitly to opt
    // into the legacy tasks-only layout.
    const structureVersion = body.structure_version === 1 ? 1 : 2

    db.prepare(`INSERT INTO projects (id, name, path, description, created_at, opencode_id, maintainer_session_id, structure_version, user_handle)
      VALUES ($id, $name, $path, $description, $createdAt, NULL, NULL, $sv, $uh)`)
      .run({
        $id: id,
        $name: name,
        $path: projectPath,
        $description: description,
        $createdAt: createdAt,
        $sv: structureVersion,
        $uh: userHandle,
      })

    const created = db.prepare('SELECT * FROM projects WHERE id=$id').get({ $id: id }) as ProjectRow
    if (structureVersion === 2) {
      try {
        await seedV2Project(db, {
          id: created.id,
          name: created.name,
          path: created.path,
          description: created.description,
          user_handle: userHandle,
        })
        // Kick off PM onboarding in a project-level session so the human can
        // chat with the PM right away from the Sessions tab. Fire-and-forget
        // — the create HTTP response should not wait on LLM turns.
        if (userHandle) {
          const pm = getAgentBySlug(db, created.id, DEFAULT_PM_SLUG)
          if (pm) {
            wakeAgentForProject({
              db,
              client: getOpenCodeClient(),
              projectId: created.id,
              agent: pm,
              sessionTitle: `Onboarding · ${created.name}`,
              prompt: buildOnboardingPrompt(created.name, userHandle, created.description),
            }).catch((err) => console.warn('[projects] PM onboarding failed:', err))
          }
        }
      } catch (err) {
        console.warn('[projects] v2 seed failed:', err)
      }
    }
    return c.json(db.prepare('SELECT * FROM projects WHERE id=$id').get({ $id: id }))
  } catch (e) {
    return c.json({ error: String(e) }, 400)
  }
})

let _ocClient: ReturnType<typeof createOpencodeClient> | null = null
function getOpenCodeClient(): OpenCodeClientLike {
  if (!_ocClient) {
    _ocClient = createOpencodeClient({
      baseUrl: `http://${config.OPENCODE_HOST}:${config.OPENCODE_PORT}`,
    })
  }
  return _ocClient as unknown as OpenCodeClientLike
}

// POST /:id/pm-session — create a fresh chat session with the project's PM.
// Each click = new session. The session is bound to the project and to the
// PM agent (via project_agents.session_id) so findAgentForSession resolves
// the right persona + tool groups. A short kickoff prompt is fired so PM
// greets the user in-persona; subsequent turns continue with full context.
projectsRouter.post('/:id/pm-session', async (c) => {
  const db = getDb()
  const pid = decodeURIComponent(c.req.param('id'))
  const project = db.prepare('SELECT * FROM projects WHERE id=$id OR path=$id').get({ $id: pid }) as ProjectRow | null
  if (!project) return c.json({ error: 'Project not found' }, 404)
  if ((project as any).structure_version !== 2) {
    return c.json({ error: 'PM chat is only available on v2 projects' }, 400)
  }
  const pm = getAgentBySlug(db, project.id, DEFAULT_PM_SLUG)
  if (!pm) return c.json({ error: 'Project Manager agent not found — run v2 seed first' }, 404)

  // Clear PM's session pointer so wakeAgentForProject creates a fresh one.
  // Latest "Ask PM" click becomes the canonical PM session; older sessions
  // remain readable but are no longer bound (actions there attribute as user).
  try { db.prepare('UPDATE project_agents SET session_id=NULL WHERE id=$id').run({ $id: pm.id }) } catch {}
  const freshPm = getAgentBySlug(db, project.id, DEFAULT_PM_SLUG)!

  const userHandle = (project as any).user_handle || 'there'
  const kickoff = [
    `Human @${userHandle} just opened a direct chat with you from the project page.`,
    'No task attached. Greet them briefly in your PM voice, then ask what they need.',
    'One short paragraph. No bullet lists, no table. Stop after.',
  ].join('\n')
  try {
    const sessionId = await wakeAgentForProject({
      db,
      client: getOpenCodeClient(),
      projectId: project.id,
      agent: freshPm,
      sessionTitle: `PM · ${project.name}`,
      prompt: kickoff,
    })
    if (!sessionId) return c.json({ error: 'Failed to create PM session' }, 500)
    return c.json({ session_id: sessionId })
  } catch (err) {
    return c.json({ error: String(err) }, 500)
  }
})

function buildOnboardingPrompt(name: string, handle: string, description: string): string {
  // No `/autowork` wrapper — onboarding is a real back-and-forth, not a task
  // loop. One turn, then wait for the human's reply.
  return [
    `Fresh project "${name}". Human: @${handle}.`,
    description ? `User's description: ${description}` : null,
    '',
    'Run the onboarding interview from your persona. ONE short question at a',
    'time — no batching, no answering for the user. STOP after each turn and',
    'wait for their reply.',
    '',
    'Cover (in order): project · stack · role + reach-back · autonomy ·',
    'starting team · columns/templates. Apply each piece only after approval,',
    'using your `project_manage` tools. Keep CONTEXT.md tight.',
    '',
    'Pass `default_model: "anthropic/claude-sonnet-4-6"` on every agent. Copy',
    'the Communication discipline block from your persona into each agent',
    'body_md verbatim — non-negotiable.',
    '',
    'Your messages follow the same rules as the team: short, decisive, no',
    'tables, no verdict banners.',
    '',
    `First message: brief intro + question #1, addressed to @${handle}. Then STOP.`,
  ].filter(Boolean).join('\n')
}

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
  const body = await c.req.json<{ name?: string; description?: string; user_handle?: string | null }>()
  const p = db.prepare('SELECT * FROM projects WHERE id=$id').get({ $id: id }) as ProjectRow | null
  if (!p) return c.json({ error: 'Project not found' }, 404)

  if (body.name !== undefined) {
    db.prepare('UPDATE projects SET name=$n WHERE id=$id').run({ $n: body.name, $id: id })
  }
  if (body.description !== undefined) {
    db.prepare('UPDATE projects SET description=$d WHERE id=$id').run({ $d: body.description, $id: id })
  }
  if (body.user_handle !== undefined) {
    const handle = (typeof body.user_handle === 'string' && body.user_handle.trim()) || null
    db.prepare('UPDATE projects SET user_handle=$h WHERE id=$id').run({ $h: handle, $id: id })
    const refreshed = db.prepare('SELECT * FROM projects WHERE id=$id').get({ $id: id }) as ProjectRow
    if ((refreshed as any).structure_version === 2) {
      try {
        await syncTeamSection(db, {
          id: refreshed.id,
          name: refreshed.name,
          path: refreshed.path,
          description: refreshed.description,
          user_handle: handle,
        })
      } catch (err) {
        console.warn('[projects] team-section sync failed:', err)
      }
    }
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
