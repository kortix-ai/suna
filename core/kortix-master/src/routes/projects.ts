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
import { dirname, join } from 'path'
import { ensureTicketTables, getAgentBySlug, listColumns, replaceColumns } from '../services/ticket-service'
import { DEFAULT_PM_SLUG } from '../services/project-v2-seed'
import { wakeAgentForProject, type OpenCodeClientLike } from '../services/ticket-triggers'
import { createOpencodeClient } from '@opencode-ai/sdk/client'
import { config } from '../config'


// ── Types ────────────────────────────────────────────────────────────────────

interface ProjectRow {
  id: string; name: string; path: string; description: string
  created_at: string; opencode_id: string | null
  structure_version: number
}

const GLOBAL_PROJECT_ID = 'proj-global'
const GLOBAL_PROJECT_NAME = 'Kortix'
const GLOBAL_PROJECT_DESCRIPTION = 'Global Kortix workspace. All tasks, tickets, credentials, agents, and durable context live here.'

function workspaceRoot(): string {
  return process.env.KORTIX_WORKSPACE?.trim()
    || process.env.OPENCODE_CONFIG_DIR?.replace(/\/opencode\/?$/, '')
    || '/workspace'
}

function ensureGlobalProject(db: Database): ProjectRow {
  const workspace = workspaceRoot()
  const now = new Date().toISOString()
  const ctxDir = join(workspace, '.kortix')
  mkdirSync(ctxDir, { recursive: true })

  let row = db.prepare('SELECT * FROM projects WHERE path=$path').get({ $path: workspace }) as ProjectRow | null
  if (row) {
    db.prepare("UPDATE projects SET description=COALESCE(NULLIF(description,''), $description), structure_version=1 WHERE id=$id")
      .run({ $description: GLOBAL_PROJECT_DESCRIPTION, $id: row.id })
    row = db.prepare('SELECT * FROM projects WHERE id=$id').get({ $id: row.id }) as ProjectRow
  } else {
    row = db.prepare('SELECT * FROM projects WHERE id=$id').get({ $id: GLOBAL_PROJECT_ID }) as ProjectRow | null
    if (row) {
      db.prepare("UPDATE projects SET path=$path, description=COALESCE(NULLIF(description,''), $description), structure_version=1 WHERE id=$id")
        .run({ $path: workspace, $description: GLOBAL_PROJECT_DESCRIPTION, $id: row.id })
      row = db.prepare('SELECT * FROM projects WHERE id=$id').get({ $id: row.id }) as ProjectRow
    } else {
      db.prepare(`INSERT INTO projects (id, name, path, description, created_at, opencode_id, maintainer_session_id, structure_version, user_handle)
        VALUES ($id, $name, $path, $description, $createdAt, NULL, NULL, 1, NULL)`)
        .run({ $id: GLOBAL_PROJECT_ID, $name: GLOBAL_PROJECT_NAME, $path: workspace, $description: GLOBAL_PROJECT_DESCRIPTION, $createdAt: now })
      row = db.prepare('SELECT * FROM projects WHERE id=$id').get({ $id: GLOBAL_PROJECT_ID }) as ProjectRow
    }
  }

  try {
    if (listColumns(db, row.id).length === 0) {
      replaceColumns(db, row.id, [
        { key: 'backlog', label: 'Backlog' },
        { key: 'in_progress', label: 'In Progress' },
        { key: 'review', label: 'Review' },
        { key: 'done', label: 'Done', is_terminal: true },
      ])
    }
  } catch {}

  return row
}

// ── DB singleton ─────────────────────────────────────────────────────────────

let _db: Database | null = null

function getDb(): Database {
  if (_db) return _db

  const workspace = workspaceRoot()
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
      structure_version INTEGER NOT NULL DEFAULT 2,
      user_handle TEXT
    );
  `)
  // v2 is the new default — any legacy row that was inserted with the old
  // default=1 gets upgraded automatically on the next boot. (The only
  // project that SHOULD stay v1 is the virtual `proj-workspace` catch-all,
  // which represents /workspace itself and has no PM/board/tickets.)
  try { _db.exec(`ALTER TABLE projects ADD COLUMN structure_version INTEGER NOT NULL DEFAULT 2`) } catch {}
  try { _db.exec(`ALTER TABLE projects ADD COLUMN user_handle TEXT`) } catch {}
  // One-shot migration: upgrade every non-workspace v1 row to v2. Any
  // project the user spawned against older plugin/route code that defaulted
  // to 1 gets corrected on the next boot without manual intervention.
  try {
    const up = _db.prepare(`UPDATE projects SET structure_version=2 WHERE structure_version<2 AND id<>'proj-workspace'`).run()
    if (up.changes > 0) console.log(`[projects] migrated ${up.changes} legacy project(s) from v1 → v2`)
  } catch {}
  ensureTicketTables(_db)
  ensureGlobalProject(_db)

  return _db
}

// ── Router ───────────────────────────────────────────────────────────────────

const projectsRouter = new Hono()

// POST / — compatibility endpoint; Kortix now has one implicit global workspace.
projectsRouter.post('/', async (c) => {
  try {
    const db = getDb()
    const body = await c.req.json<{ name?: string; description?: string; user_handle?: string }>().catch(() => ({}))
    let global = ensureGlobalProject(db)
    if (body.description !== undefined && body.description.trim()) {
      db.prepare('UPDATE projects SET description=$d WHERE id=$id').run({ $d: body.description.trim(), $id: global.id })
    }
    if (body.name !== undefined && body.name.trim()) {
      db.prepare('UPDATE projects SET name=$n WHERE id=$id').run({ $n: body.name.trim(), $id: global.id })
    }
    if (body.user_handle !== undefined && body.user_handle.trim()) {
      db.prepare('UPDATE projects SET user_handle=$h WHERE id=$id').run({ $h: body.user_handle.trim(), $id: global.id })
    }
    global = ensureGlobalProject(db)
    return c.json({ ...global, global: true })
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

// POST /:id/pm-review — periodic board check-in, typically wired to a cron
// trigger. The trigger (action=http) hits this endpoint, we spawn a fresh PM
// session scoped to the project's directory and fire a board-review prompt.
// Kept here (not in triggers) so the engine stays untouched: the trigger
// doesn't need to know about project directories — it just POSTs.
projectsRouter.post('/:id/pm-review', async (c) => {
  const db = getDb()
  const pid = decodeURIComponent(c.req.param('id'))
  const project = db.prepare('SELECT * FROM projects WHERE id=$id OR path=$id').get({ $id: pid }) as ProjectRow | null
  if (!project) return c.json({ error: 'Project not found' }, 404)
  if ((project as any).structure_version !== 2) {
    return c.json({ error: 'pm-review is v2-only' }, 400)
  }
  const pm = getAgentBySlug(db, project.id, DEFAULT_PM_SLUG)
  if (!pm) return c.json({ error: 'Global workspace has no separate Project Manager agent.' }, 404)

  const prompt = [
    `Scheduled board check-in for "${project.name}".`,
    '',
    'Open `project_context_read` to load CONTEXT.md.',
    'List tickets with `ticket_list` filtered by each status key.',
    '',
    'For every ticket in `in_progress` or `review`:',
    '1. Call `ticket_events` to see last activity timestamp + assignee history.',
    '2. If last activity is >1h old: post a tight comment on that ticket',
    '   flagging the stall — name the assignee, note what was last done,',
    '   suggest a next step or reassignment.',
    '3. If the review-column ticket has no QA activity but QA is assigned,',
    '   nudge: "@qa reminder on #N".',
    '',
    'After scanning everything, post ONE summary comment on the project\'s',
    'most recent goal ticket (parent_id IS NULL, newest created_at) —',
    'shape: "Board check · <timestamp>: N in-progress, M in review, K stalled."',
    'No tables, no emoji verdicts, no re-listing everything. One line per',
    'signal. Then stop.',
    '',
    'This is an automated cron check. Do NOT tag the human unless a',
    'ticket is genuinely blocked and needs their input per CONTEXT.md.',
  ].join('\n')

  // Force a fresh session for each review — we don't want consecutive cron
  // fires to stack up context in the same thread. Clearing pm.session_id
  // makes wakeAgentForProject create+bind a new one.
  try { db.prepare('UPDATE project_agents SET session_id=NULL WHERE id=$id').run({ $id: pm.id }) } catch {}
  const freshPm = getAgentBySlug(db, project.id, DEFAULT_PM_SLUG)!
  try {
    const sid = await wakeAgentForProject({
      db,
      client: getOpenCodeClient(),
      projectId: project.id,
      agent: freshPm,
      sessionTitle: `PM review · ${project.name} · ${new Date().toISOString().slice(0, 16)}`,
      prompt,
    })
    if (!sid) return c.json({ error: 'Failed to spawn PM review session' }, 500)
    return c.json({ session_id: sid })
  } catch (err) {
    return c.json({ error: String(err) }, 500)
  }
})

// POST /:id/pm-session — create a fresh chat session bound to the project's
// PM. Each click = new session, no kickoff, no fake user-message. The user
// types the first message themselves. The plugin's system-prompt transform
// injects PM's persona as real system prompt so the LLM is PM without any
// visible pollution in the chat.
projectsRouter.post('/:id/pm-session', async (c) => {
  const db = getDb()
  const pid = decodeURIComponent(c.req.param('id'))
  const project = db.prepare('SELECT * FROM projects WHERE id=$id OR path=$id').get({ $id: pid }) as ProjectRow | null
  if (!project) return c.json({ error: 'Project not found' }, 404)
  if ((project as any).structure_version !== 2) {
    return c.json({ error: 'PM chat is only available on v2 projects' }, 400)
  }
  const pm = getAgentBySlug(db, project.id, DEFAULT_PM_SLUG)
  if (!pm) return c.json({ error: 'Global workspace has no separate Project Manager agent.' }, 404)

  try {
    const client = getOpenCodeClient()
    const res = await client.session.create({
      body: { title: `PM · ${project.name}` },
      // Scope to the project directory. OpenCode will then discover the
      // project's real agents from `<project.path>/.opencode/agent/*.md`.
      query: { directory: project.path },
    } as any)
    const sessionId = (res as any)?.data?.id as string | undefined
    if (!sessionId) return c.json({ error: 'Failed to create session' }, 500)
    try {
      db.prepare('INSERT OR REPLACE INTO session_projects (session_id, project_id, set_at) VALUES ($sid, $pid, $now)')
        .run({ $sid: sessionId, $pid: project.id, $now: new Date().toISOString() })
    } catch {}
    // Bind session ↔ PM in the kortix DB so ticketToolGateHook resolves
    // which tool_group applies when this session runs PM-dispatched tools.
    try {
      db.prepare('UPDATE project_agents SET session_id=$sid WHERE id=$id').run({ $sid: sessionId, $id: pm.id })
    } catch {}
    return c.json({ session_id: sessionId })
  } catch (err) {
    return c.json({ error: String(err) }, 500)
  }
})

// GET / — list all projects with stats
projectsRouter.get('/', async (c) => {
  const db = getDb()
  const p = ensureGlobalProject(db)
  const sessionCount = (db.prepare(
    'SELECT COUNT(*) as c FROM session_projects WHERE project_id=$pid'
  ).get({ $pid: p.id }) as { c: number })?.c || 0
  return c.json([{ ...p, sessionCount, global: true }])
})

// GET /:id — single project
projectsRouter.get('/:id', async (c) => {
  const db = getDb()
  return c.json({ ...ensureGlobalProject(db), global: true })
})

// GET /:id/sessions — sessions linked to this project via session_projects table
// Enriches with OpenCode session data (title, time, etc.) from the OC API
projectsRouter.get('/:id/sessions', async (c) => {
  const db = getDb()
  const p = ensureGlobalProject(db)

  // Get session IDs linked to this project
  const links = db.prepare(
    'SELECT session_id FROM session_projects WHERE project_id=$pid ORDER BY set_at DESC'
  ).all({ $pid: p.id }) as Array<{ session_id: string }>

  const sessionIds = new Set(links.map(l => l.session_id))

  // Fetch session details from OpenCode in one batch
  try {
    const res = await fetch(`http://${config.OPENCODE_HOST}:${config.OPENCODE_PORT}/session`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const body = await res.json() as any
      const allSessions = Array.isArray(body) ? body : (body?.data ?? [])

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
  const p = ensureGlobalProject(db)
  db.prepare('INSERT OR REPLACE INTO session_projects (session_id, project_id, set_at) VALUES ($sid, $pid, $now)')
    .run({ $sid: sessionId, $pid: p.id, $now: new Date().toISOString() })
  return c.json({ ...p, global: true })
})

// DELETE /by-session/:sessionId — unlink a session from any project
projectsRouter.delete('/by-session/:sessionId', async (c) => {
  try {
    const db = getDb()
    const sessionId = decodeURIComponent(c.req.param('sessionId'))
    const p = ensureGlobalProject(db)
    db.prepare('INSERT OR REPLACE INTO session_projects (session_id, project_id, set_at) VALUES ($sid, $pid, $now)')
      .run({ $sid: sessionId, $pid: p.id, $now: new Date().toISOString() })
    return c.json({ ok: true, session_id: sessionId, project_id: p.id, global: true })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

// DELETE /:id — remove project from registry (does NOT delete files on disk)
projectsRouter.delete('/:id', async (c) => {
  const db = getDb()
  const p = ensureGlobalProject(db)
  return c.json({ deleted: false, global: true, name: p.name, path: p.path, message: 'The global Kortix workspace cannot be deleted.' })
})

// PATCH /:id — update project
projectsRouter.patch('/:id', async (c) => {
  const db = getDb()
  const body = await c.req.json<{ name?: string; description?: string; user_handle?: string | null }>()
  const p = ensureGlobalProject(db)

  if (body.name !== undefined) {
    db.prepare('UPDATE projects SET name=$n WHERE id=$id').run({ $n: body.name, $id: p.id })
  }
  if (body.description !== undefined) {
    db.prepare('UPDATE projects SET description=$d WHERE id=$id').run({ $d: body.description, $id: p.id })
  }
  if (body.user_handle !== undefined) {
    const handle = (typeof body.user_handle === 'string' && body.user_handle.trim()) || null
    db.prepare('UPDATE projects SET user_handle=$h WHERE id=$id').run({ $h: handle, $id: p.id })
  }
  return c.json({ ...ensureGlobalProject(db), global: true })
})

// POST /:id/link-session — bind any existing session to this project
projectsRouter.post('/:id/link-session', async (c) => {
  try {
    const db = getDb()
    const p = ensureGlobalProject(db)

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

    return c.json({ ok: true, project_id: p.id, session_id: sessionId, global: true })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

export default projectsRouter
