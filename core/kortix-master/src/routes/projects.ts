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
import { seedV2Project, syncTeamSection, DEFAULT_PM_SLUG, resolveDefaultModel } from '../services/project-v2-seed'
import { wakeAgentForProject, type OpenCodeClientLike } from '../services/ticket-triggers'
import { createOpencodeClient } from '@opencode-ai/sdk/client'
import { config } from '../config'
import { getMember } from '../services/member-context'
import { ensureMemberDaemon, listMemberDaemons } from '../services/supervisor-client'


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

  return _db
}

// ── Router ───────────────────────────────────────────────────────────────────

const projectsRouter = new Hono()

// POST / — create or ensure a project exists
projectsRouter.post('/', async (c) => {
  try {
    const db = getDb()
    const body = await c.req.json<{ id?: string; name?: string; path?: string; description?: string; structure_version?: number; user_handle?: string }>().catch(() => ({} as { id?: string; name?: string; path?: string; description?: string; structure_version?: number; user_handle?: string }))
    const rawPath = body.path?.trim() || ''
    // Refuse workspace-root paths. v2 seed writes PM agent files under
    // <path>/.opencode/agent/ — if path is the workspace root, those files
    // pollute the global agent picker (every session in /workspace tree
    // would discover the PM as a global agent). Past incidents created a
    // rogue /workspace/.opencode/agent/project-manager.md exactly this way.
    if (!rawPath || rawPath === '/workspace' || rawPath === '/workspace/') {
      return c.json({
        error: `path is required and must be a subdirectory of /workspace, e.g. /workspace/${(body.name?.trim() || 'my-project').replace(/[^\w-]/g, '-').toLowerCase()}. Refusing to create a project at the workspace root.`,
      }, 400)
    }
    const projectPath = rawPath
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
            // PM was just seeded with a model — pass the SAME id into the
            // onboarding prompt so PM tells team_create_agent calls to use
            // it, instead of re-running resolveDefaultModel() (which can
            // diverge from the seed if env changed between calls and
            // makes PM seed the team on a different model than itself).
            const seededModel = (pm.default_model && pm.default_model.trim()) || resolveDefaultModel()
            wakeAgentForProject({
              db,
              client: getOpenCodeClient(),
              projectId: created.id,
              agent: pm,
              sessionTitle: `Onboarding · ${created.name}`,
              prompt: buildOnboardingPrompt(created.name, userHandle, created.description, seededModel),
            }).then((sid) => console.log('[projects] PM onboarding session:', sid))
              .catch((err) => console.warn('[projects] PM onboarding failed:', err))
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
  if (!pm) return c.json({ error: 'PM agent not found for this project' }, 404)

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
  if (!pm) return c.json({ error: 'Project Manager agent not found — run v2 seed first' }, 404)

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

// Small/cheap tiers struggle on real engineering tickets (patchy diff edits,
// dropped tool calls, weak QA evidence). PM should flag this in onboarding
// so the human can opt up before the team is created.
const SMALL_MODELS = new Set<string>(['kortix-yolo/think', 'kortix-yolo/code'])

function buildOnboardingPrompt(name: string, handle: string, description: string, seededModel: string): string {
  // No `/autowork` wrapper — onboarding is a real back-and-forth, not a task
  // loop. One turn, then wait for the human's reply.
  const isSmallSeed = SMALL_MODELS.has(seededModel)
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
    `Pass \`default_model: "${seededModel}"\` on every \`team_create_agent\``,
    'call. This is the model the human selected for this project (their',
    'current chat model, an explicit project_create override, or the',
    "sandbox default in that order). Do NOT substitute another model unless",
    'the human explicitly asks during onboarding — in which case use their',
    'pick verbatim.',
    isSmallSeed
      ? `\n**MODEL ADVISORY** — the seeded model \`${seededModel}\` is a small/cheap tier and tends to misfire on real engineering work (dropped tool calls, patchy diff edits, weak QA evidence). Inside Q2 (stack), include ONE short sentence flagging this and offer a larger option (e.g. \`kortix/minimax-m27\`, \`anthropic/claude-sonnet-4-6\` if the human's API key is loaded). If they confirm the small model anyway, ship it — don't keep asking.`
      : null,
    '',
    'Copy the Communication discipline block from your persona into each',
    'agent body_md verbatim — non-negotiable.',
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

  // Fan out across every opencode daemon: the legacy shared one (port 4096)
  // PLUS every per-user daemon the supervisor has running. Sessions linked
  // to the project are scattered — each project member's sessions live in
  // their OWN opencode, so a single-port query (the previous bug) returned
  // only the requester's slice. Project view needs the union, otherwise
  // the dashboard's sessions tab looks empty even when teammates have
  // active work threads on the project.
  try {
    const ports = new Set<number>()
    ports.add(config.OPENCODE_PORT)
    const member = getMember(c as any)
    if (member) {
      try { ports.add(await ensureMemberDaemon(member)) } catch {}
    }
    const daemons = await listMemberDaemons()
    for (const d of daemons) ports.add(d.port)

    const allSessions: any[] = []
    const seen = new Set<string>()
    await Promise.all(
      Array.from(ports).map(async (port) => {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/session`, {
            signal: AbortSignal.timeout(3000),
          })
          if (!res.ok) return
          const body = await res.json() as any
          const list = Array.isArray(body) ? body : (body?.data ?? [])
          for (const s of list) {
            if (s?.id && !seen.has(s.id)) {
              seen.add(s.id)
              allSessions.push(s)
            }
          }
        } catch { /* skip dead daemons */ }
      }),
    )

    if (allSessions.length > 0) {
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

  // Clean up all related records — cascade through every v2 table that
  // holds a project_id FK. Previously only session_projects was nuked,
  // which left orphans in triggers / tickets / milestones / agents /
  // columns / credentials. The next project created under the same name
  // then silently collided with those orphans (most visibly: the
  // board-sweep trigger seed's idempotency check matched a dead row and
  // skipped creation). Each DELETE is guarded because not every table
  // exists on v1-only installs.
  const v2Tables = [
    'session_projects',
    'project_credential_events',
    'project_credentials',
    'project_milestone_counter',
    'milestone_events',
    'milestones',
    'project_ticket_counter',
    'ticket_agent_sessions',
    'ticket_assignees',
    'ticket_events',
    'tickets',
    'ticket_templates',
    'project_fields',
    'project_columns',
    'project_agents',
    'project_members',
    'pending_agent_triggers',
    'triggers',
  ] as const
  for (const t of v2Tables) {
    try { db.prepare(`DELETE FROM ${t} WHERE project_id=$pid`).run({ $pid: p.id }) } catch {}
  }
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
