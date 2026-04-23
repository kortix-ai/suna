/**
 * Milestones API — outcome-level grouping inside a project.
 *
 * Routes are mounted TWICE in index.ts:
 *   - as a project-scoped router under /kortix/projects/:projectId/milestones
 *   - re-used by agent tools that go through the same HTTP surface
 *
 * Auth/actor:
 *   - Headers X-Kortix-Actor-Type + X-Kortix-Actor-Id stamp the actor_type/id on
 *     every write. Falls back to 'user'/null. Mirrors the ticket-events pattern.
 */

import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import {
  ensureTicketTables,
  type ActorType,
} from '../services/ticket-service'
import {
  closeMilestone,
  createMilestone,
  deleteMilestone,
  getMilestoneById,
  getMilestoneByNumber,
  listMilestoneEvents,
  listMilestones,
  listTicketsForMilestone,
  reopenMilestone,
  updateMilestone,
  type MilestoneWithProgress,
} from '../services/milestone-service'
import { syncMilestonesSection } from '../services/project-v2-seed'

// Fire-and-forget: writing CONTEXT.md shouldn't block the HTTP response. Any
// filesystem error gets swallowed and logged — the DB write already succeeded.
function scheduleContextSync(db: Database, project: ProjectRow) {
  syncMilestonesSection(db, { ...project, description: project.description ?? '' }).catch((err) => {
    console.warn('[milestones] CONTEXT.md sync failed:', err instanceof Error ? err.message : err)
  })
}

function getDb(): Database {
  const workspace = process.env.WORKSPACE_DIR || process.env.KORTIX_WORKSPACE || '/workspace'
  const dbPath = join(workspace, '.kortix', 'kortix.db')
  if (!existsSync(dbPath)) throw new Error('kortix.db not found')
  const db = new Database(dbPath)
  db.exec('PRAGMA busy_timeout=5000')
  ensureTicketTables(db)
  return db
}

interface ProjectRow { id: string; name: string; path: string; description: string }
function resolveProject(db: Database, id: string): ProjectRow | null {
  return (
    db.prepare('SELECT id,name,path,description FROM projects WHERE id=$v').get({ $v: id })
    || db.prepare('SELECT id,name,path,description FROM projects WHERE LOWER(name)=LOWER($v)').get({ $v: id })
  ) as ProjectRow | null
}

function actorFromHeaders(c: { req: { header: (k: string) => string | undefined } }): { type: ActorType; id: string | null } {
  const rawType = c.req.header('x-kortix-actor-type') ?? c.req.header('X-Kortix-Actor-Type')
  const rawId = c.req.header('x-kortix-actor-id') ?? c.req.header('X-Kortix-Actor-Id')
  const type: ActorType = rawType === 'agent' || rawType === 'system' ? rawType : 'user'
  return { type, id: rawId ? String(rawId) : null }
}

function resolveMilestone(db: Database, projectId: string, ref: string) {
  // `ref` can be either the milestone id (ms-…) or its per-project number.
  const n = Number(ref)
  if (Number.isInteger(n) && n > 0 && /^\d+$/.test(ref)) {
    return getMilestoneByNumber(db, projectId, n)
  }
  const m = getMilestoneById(db, ref)
  if (m && m.project_id === projectId) return m
  return null
}

function serialize(m: MilestoneWithProgress): Record<string, unknown> {
  return {
    ...m,
    /** precomputed % for the UI progress bar (done / total, integer 0–100). */
    percent_complete: m.progress.total === 0 ? 0 : Math.round((m.progress.done / m.progress.total) * 100),
  }
}

const milestonesRouter = new Hono()

// GET /kortix/projects/:projectId/milestones
milestonesRouter.get('/:projectId/milestones', (c) => {
  try {
    const db = getDb()
    const project = resolveProject(db, c.req.param('projectId'))
    if (!project) return c.json({ error: 'Project not found' }, 404)
    const statusFilter = (c.req.query('status') ?? 'all') as 'open' | 'closed' | 'all'
    const list = listMilestones(db, project.id, statusFilter)
    return c.json(list.map(serialize))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// POST /kortix/projects/:projectId/milestones
milestonesRouter.post('/:projectId/milestones', async (c) => {
  try {
    const db = getDb()
    const project = resolveProject(db, c.req.param('projectId'))
    if (!project) return c.json({ error: 'Project not found' }, 404)
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
    const actor = actorFromHeaders(c)

    const title = String(body.title ?? '').trim()
    if (!title) return c.json({ error: 'title is required' }, 400)

    const m = createMilestone(db, {
      project_id: project.id,
      title,
      description_md: typeof body.description_md === 'string' ? body.description_md : undefined,
      acceptance_md: typeof body.acceptance_md === 'string' ? body.acceptance_md : undefined,
      due_at: typeof body.due_at === 'string' ? body.due_at : null,
      color_hue: typeof body.color_hue === 'number' ? body.color_hue : null,
      icon: typeof body.icon === 'string' ? body.icon : null,
      created_by_type: actor.type,
      created_by_id: actor.id,
    })
    const [withProgress] = listMilestones(db, project.id, 'all').filter((x) => x.id === m.id)
    scheduleContextSync(db, project)
    return c.json(serialize(withProgress), 201)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

// GET /kortix/projects/:projectId/milestones/:ref (id or number)
milestonesRouter.get('/:projectId/milestones/:ref', (c) => {
  try {
    const db = getDb()
    const project = resolveProject(db, c.req.param('projectId'))
    if (!project) return c.json({ error: 'Project not found' }, 404)
    const m = resolveMilestone(db, project.id, c.req.param('ref'))
    if (!m) return c.json({ error: 'Milestone not found' }, 404)
    const [withProgress] = listMilestones(db, project.id, 'all').filter((x) => x.id === m.id)
    const tickets = listTicketsForMilestone(db, m.id)
    return c.json({ ...serialize(withProgress), tickets })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// PATCH /kortix/projects/:projectId/milestones/:ref
milestonesRouter.patch('/:projectId/milestones/:ref', async (c) => {
  try {
    const db = getDb()
    const project = resolveProject(db, c.req.param('projectId'))
    if (!project) return c.json({ error: 'Project not found' }, 404)
    const m = resolveMilestone(db, project.id, c.req.param('ref'))
    if (!m) return c.json({ error: 'Milestone not found' }, 404)
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
    const actor = actorFromHeaders(c)
    const updated = updateMilestone(db, m.id, {
      title: typeof body.title === 'string' ? body.title : undefined,
      description_md: typeof body.description_md === 'string' ? body.description_md : undefined,
      acceptance_md: typeof body.acceptance_md === 'string' ? body.acceptance_md : undefined,
      due_at: body.due_at === null ? null : (typeof body.due_at === 'string' ? body.due_at : undefined),
      color_hue: body.color_hue === null ? null : (typeof body.color_hue === 'number' ? body.color_hue : undefined),
      icon: body.icon === null ? null : (typeof body.icon === 'string' ? body.icon : undefined),
    }, actor)
    if (!updated) return c.json({ error: 'Milestone not found' }, 404)
    const [withProgress] = listMilestones(db, project.id, 'all').filter((x) => x.id === updated.id)
    scheduleContextSync(db, project)
    return c.json(serialize(withProgress))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

// POST /kortix/projects/:projectId/milestones/:ref/close
milestonesRouter.post('/:projectId/milestones/:ref/close', async (c) => {
  try {
    const db = getDb()
    const project = resolveProject(db, c.req.param('projectId'))
    if (!project) return c.json({ error: 'Project not found' }, 404)
    const m = resolveMilestone(db, project.id, c.req.param('ref'))
    if (!m) return c.json({ error: 'Milestone not found' }, 404)
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
    const actor = actorFromHeaders(c)
    const closed = closeMilestone(db, m.id, {
      actor_type: actor.type,
      actor_id: actor.id,
      summary_md: typeof body.summary_md === 'string' ? body.summary_md : undefined,
      cancelled: body.cancelled === true,
    })
    if (!closed) return c.json({ error: 'Milestone not found' }, 404)
    const [withProgress] = listMilestones(db, project.id, 'all').filter((x) => x.id === closed.id)
    scheduleContextSync(db, project)
    return c.json(serialize(withProgress))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

// POST /kortix/projects/:projectId/milestones/:ref/reopen
milestonesRouter.post('/:projectId/milestones/:ref/reopen', (c) => {
  try {
    const db = getDb()
    const project = resolveProject(db, c.req.param('projectId'))
    if (!project) return c.json({ error: 'Project not found' }, 404)
    const m = resolveMilestone(db, project.id, c.req.param('ref'))
    if (!m) return c.json({ error: 'Milestone not found' }, 404)
    const actor = actorFromHeaders(c)
    const reopened = reopenMilestone(db, m.id, actor)
    if (!reopened) return c.json({ error: 'Milestone not found' }, 404)
    const [withProgress] = listMilestones(db, project.id, 'all').filter((x) => x.id === reopened.id)
    scheduleContextSync(db, project)
    return c.json(serialize(withProgress))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

// DELETE /kortix/projects/:projectId/milestones/:ref
milestonesRouter.delete('/:projectId/milestones/:ref', (c) => {
  try {
    const db = getDb()
    const project = resolveProject(db, c.req.param('projectId'))
    if (!project) return c.json({ error: 'Project not found' }, 404)
    const m = resolveMilestone(db, project.id, c.req.param('ref'))
    if (!m) return c.json({ error: 'Milestone not found' }, 404)
    const actor = actorFromHeaders(c)
    const r = deleteMilestone(db, m.id, actor)
    if (!r.deleted) return c.json({ error: r.reason ?? 'delete_failed' }, 400)
    scheduleContextSync(db, project)
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

// GET /kortix/projects/:projectId/milestones/:ref/events
milestonesRouter.get('/:projectId/milestones/:ref/events', (c) => {
  try {
    const db = getDb()
    const project = resolveProject(db, c.req.param('projectId'))
    if (!project) return c.json({ error: 'Project not found' }, 404)
    const m = resolveMilestone(db, project.id, c.req.param('ref'))
    if (!m) return c.json({ error: 'Milestone not found' }, 404)
    return c.json(listMilestoneEvents(db, m.id))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

export default milestonesRouter
