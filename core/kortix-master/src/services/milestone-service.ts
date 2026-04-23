/**
 * Milestone service — outcome-level grouping for v2 projects.
 *
 * A milestone answers "what does 'shipped' mean end-to-end?" and aggregates
 * the tickets that serve that outcome. Mirrors GitHub Milestones / Linear
 * Projects / Jira Epics in shape; stays column-orthogonal (milestone lives
 * on the ticket as a nullable foreign key).
 *
 * Tables (created by ensureTicketTables):
 *   milestones, milestone_events, project_milestone_counter
 *
 * Callers should resolve milestones by `{project_id, number}` (stable, human)
 * when they have a URL or reference to follow, and by `id` when they've just
 * created one. Per-project `number` mirrors tickets.number.
 */

import { Database } from 'bun:sqlite'
import type { ActorType, TicketRow } from './ticket-service'

export type MilestoneStatus = 'open' | 'closed' | 'cancelled'

export interface MilestoneRow {
  id: string
  project_id: string
  number: number
  title: string
  description_md: string
  acceptance_md: string
  status: MilestoneStatus
  due_at: string | null
  completed_at: string | null
  closed_by_type: ActorType | null
  closed_by_id: string | null
  created_by_type: ActorType
  created_by_id: string | null
  color_hue: number | null
  icon: string | null
  created_at: string
  updated_at: string
}

export interface MilestoneEventRow {
  id: string
  milestone_id: string
  project_id: string
  actor_type: ActorType
  actor_id: string | null
  type: string
  message: string | null
  payload_json: string | null
  created_at: string
}

/** Aggregate ticket-status breakdown for a milestone. */
export interface MilestoneProgress {
  total: number
  done: number
  in_progress: number
  blocked: number
  review: number
  /** other/unknown statuses rolled into a single count */
  other: number
}

export interface MilestoneWithProgress extends MilestoneRow {
  progress: MilestoneProgress
}

function genMilestoneId(): string {
  return 'ms-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function nowIso(): string {
  return new Date().toISOString()
}

// ── Counter ──────────────────────────────────────────────────────────────────

function nextMilestoneNumber(db: Database, projectId: string): number {
  const row = db.prepare(
    'SELECT next_number FROM project_milestone_counter WHERE project_id=$pid',
  ).get({ $pid: projectId }) as { next_number: number } | null
  const next = row?.next_number ?? 1
  db.prepare(`
    INSERT INTO project_milestone_counter (project_id, next_number)
    VALUES ($pid, $n)
    ON CONFLICT(project_id) DO UPDATE SET next_number=$n
  `).run({ $pid: projectId, $n: next + 1 })
  return next
}

// ── Event log ────────────────────────────────────────────────────────────────

export function recordMilestoneEvent(db: Database, input: {
  milestoneId: string
  projectId: string
  actor_type: ActorType
  actor_id: string | null
  type: string
  message?: string | null
  payload?: Record<string, unknown>
}): MilestoneEventRow {
  const id = 'mse-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const now = nowIso()
  db.prepare(`
    INSERT INTO milestone_events
      (id, milestone_id, project_id, actor_type, actor_id, type, message, payload_json, created_at)
    VALUES ($id, $mid, $pid, $at, $ai, $t, $m, $p, $now)
  `).run({
    $id: id,
    $mid: input.milestoneId,
    $pid: input.projectId,
    $at: input.actor_type,
    $ai: input.actor_id ?? null,
    $t: input.type,
    $m: input.message ?? null,
    $p: input.payload ? JSON.stringify(input.payload) : null,
    $now: now,
  })
  // Touch milestone.updated_at so UIs re-render on new activity.
  db.prepare('UPDATE milestones SET updated_at=$now WHERE id=$id')
    .run({ $now: now, $id: input.milestoneId })
  return {
    id, milestone_id: input.milestoneId, project_id: input.projectId,
    actor_type: input.actor_type, actor_id: input.actor_id ?? null,
    type: input.type, message: input.message ?? null,
    payload_json: input.payload ? JSON.stringify(input.payload) : null,
    created_at: now,
  }
}

export function listMilestoneEvents(db: Database, milestoneId: string, limit = 200): MilestoneEventRow[] {
  return db.prepare(
    'SELECT * FROM milestone_events WHERE milestone_id=$id ORDER BY created_at ASC LIMIT $limit'
  ).all({ $id: milestoneId, $limit: limit }) as MilestoneEventRow[]
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export interface CreateMilestoneInput {
  project_id: string
  title: string
  description_md?: string
  acceptance_md?: string
  due_at?: string | null
  color_hue?: number | null
  icon?: string | null
  created_by_type?: ActorType
  created_by_id?: string | null
}

export function createMilestone(db: Database, input: CreateMilestoneInput): MilestoneRow {
  const title = input.title.trim()
  if (!title) throw new Error('Milestone title is required')
  // Reject duplicate title per project — matches UNIQUE constraint, gives
  // a human-readable error before sqlite fires the constraint violation.
  const existing = db.prepare(
    'SELECT id FROM milestones WHERE project_id=$pid AND title=$t'
  ).get({ $pid: input.project_id, $t: title }) as { id: string } | null
  if (existing) throw new Error(`Milestone with title "${title}" already exists in this project`)

  const id = genMilestoneId()
  const number = nextMilestoneNumber(db, input.project_id)
  const now = nowIso()
  const actorType: ActorType = input.created_by_type ?? 'user'

  db.prepare(`
    INSERT INTO milestones
      (id, project_id, number, title, description_md, acceptance_md, status,
       due_at, completed_at, closed_by_type, closed_by_id,
       created_by_type, created_by_id, color_hue, icon, created_at, updated_at)
    VALUES
      ($id, $pid, $n, $title, $desc, $acc, 'open',
       $due, NULL, NULL, NULL,
       $cbt, $cbi, $hue, $icon, $now, $now)
  `).run({
    $id: id,
    $pid: input.project_id,
    $n: number,
    $title: title,
    $desc: input.description_md ?? '',
    $acc: input.acceptance_md ?? '',
    $due: input.due_at ?? null,
    $cbt: actorType,
    $cbi: input.created_by_id ?? null,
    $hue: input.color_hue ?? null,
    $icon: input.icon ?? null,
    $now: now,
  })

  recordMilestoneEvent(db, {
    milestoneId: id,
    projectId: input.project_id,
    actor_type: actorType,
    actor_id: input.created_by_id ?? null,
    type: 'created',
    message: title,
    payload: { number, acceptance_md: input.acceptance_md ?? '' },
  })

  return getMilestoneById(db, id)!
}

export interface UpdateMilestoneInput {
  title?: string
  description_md?: string
  acceptance_md?: string
  due_at?: string | null
  color_hue?: number | null
  icon?: string | null
}

export function updateMilestone(
  db: Database,
  id: string,
  patch: UpdateMilestoneInput,
  actor: { type: ActorType; id?: string | null },
): MilestoneRow | null {
  const m = getMilestoneById(db, id)
  if (!m) return null
  const now = nowIso()
  const changed: Record<string, { from: unknown; to: unknown }> = {}

  if (patch.title !== undefined && patch.title.trim() !== m.title) {
    const newTitle = patch.title.trim()
    if (!newTitle) throw new Error('Milestone title cannot be empty')
    const dup = db.prepare(
      'SELECT id FROM milestones WHERE project_id=$pid AND title=$t AND id<>$id'
    ).get({ $pid: m.project_id, $t: newTitle, $id: id }) as { id: string } | null
    if (dup) throw new Error(`Another milestone already uses the title "${newTitle}"`)
    changed.title = { from: m.title, to: newTitle }
    db.prepare('UPDATE milestones SET title=$v, updated_at=$now WHERE id=$id')
      .run({ $v: newTitle, $now: now, $id: id })
  }
  if (patch.description_md !== undefined && patch.description_md !== m.description_md) {
    changed.description_md = { from: '(previous)', to: '(updated)' }
    db.prepare('UPDATE milestones SET description_md=$v, updated_at=$now WHERE id=$id')
      .run({ $v: patch.description_md, $now: now, $id: id })
  }
  if (patch.acceptance_md !== undefined && patch.acceptance_md !== m.acceptance_md) {
    changed.acceptance_md = { from: '(previous)', to: '(updated)' }
    db.prepare('UPDATE milestones SET acceptance_md=$v, updated_at=$now WHERE id=$id')
      .run({ $v: patch.acceptance_md, $now: now, $id: id })
  }
  if (patch.due_at !== undefined && patch.due_at !== m.due_at) {
    changed.due_at = { from: m.due_at, to: patch.due_at }
    db.prepare('UPDATE milestones SET due_at=$v, updated_at=$now WHERE id=$id')
      .run({ $v: patch.due_at, $now: now, $id: id })
  }
  if (patch.color_hue !== undefined && patch.color_hue !== m.color_hue) {
    changed.color_hue = { from: m.color_hue, to: patch.color_hue }
    db.prepare('UPDATE milestones SET color_hue=$v, updated_at=$now WHERE id=$id')
      .run({ $v: patch.color_hue, $now: now, $id: id })
  }
  if (patch.icon !== undefined && patch.icon !== m.icon) {
    changed.icon = { from: m.icon, to: patch.icon }
    db.prepare('UPDATE milestones SET icon=$v, updated_at=$now WHERE id=$id')
      .run({ $v: patch.icon, $now: now, $id: id })
  }

  if (Object.keys(changed).length > 0) {
    recordMilestoneEvent(db, {
      milestoneId: id,
      projectId: m.project_id,
      actor_type: actor.type,
      actor_id: actor.id ?? null,
      type: 'updated',
      payload: changed,
    })
  }
  return getMilestoneById(db, id)
}

export function closeMilestone(
  db: Database,
  id: string,
  opts: {
    actor_type: ActorType
    actor_id?: string | null
    summary_md?: string
    cancelled?: boolean
  },
): MilestoneRow | null {
  const m = getMilestoneById(db, id)
  if (!m) return null
  if (m.status !== 'open') return m
  const now = nowIso()
  const targetStatus: MilestoneStatus = opts.cancelled ? 'cancelled' : 'closed'
  db.prepare(`
    UPDATE milestones
       SET status=$s, completed_at=$now, updated_at=$now,
           closed_by_type=$at, closed_by_id=$ai
     WHERE id=$id
  `).run({
    $s: targetStatus, $now: now, $at: opts.actor_type, $ai: opts.actor_id ?? null, $id: id,
  })
  recordMilestoneEvent(db, {
    milestoneId: id,
    projectId: m.project_id,
    actor_type: opts.actor_type,
    actor_id: opts.actor_id ?? null,
    type: opts.cancelled ? 'cancelled' : 'closed',
    message: opts.summary_md ?? null,
  })
  return getMilestoneById(db, id)
}

export function reopenMilestone(
  db: Database,
  id: string,
  actor: { type: ActorType; id?: string | null },
): MilestoneRow | null {
  const m = getMilestoneById(db, id)
  if (!m) return null
  if (m.status === 'open') return m
  const now = nowIso()
  db.prepare(`
    UPDATE milestones
       SET status='open', completed_at=NULL, closed_by_type=NULL, closed_by_id=NULL, updated_at=$now
     WHERE id=$id
  `).run({ $now: now, $id: id })
  recordMilestoneEvent(db, {
    milestoneId: id,
    projectId: m.project_id,
    actor_type: actor.type,
    actor_id: actor.id ?? null,
    type: 'reopened',
  })
  return getMilestoneById(db, id)
}

export function deleteMilestone(
  db: Database,
  id: string,
  actor: { type: ActorType; id?: string | null },
): { deleted: boolean; reason?: string } {
  const m = getMilestoneById(db, id)
  if (!m) return { deleted: false, reason: 'not_found' }
  const linked = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE milestone_id=$id')
    .get({ $id: id }) as { n: number }
  if (linked.n > 0) {
    return { deleted: false, reason: `milestone has ${linked.n} linked ticket(s); unlink them first` }
  }
  db.prepare('DELETE FROM milestone_events WHERE milestone_id=$id').run({ $id: id })
  db.prepare('DELETE FROM milestones WHERE id=$id').run({ $id: id })
  // No event recorded on the milestone itself (it's gone). Callers can log on
  // the project if they want.
  void actor
  return { deleted: true }
}

// ── Read ─────────────────────────────────────────────────────────────────────

export function getMilestoneById(db: Database, id: string): MilestoneRow | null {
  return db.prepare('SELECT * FROM milestones WHERE id=$id').get({ $id: id }) as MilestoneRow | null
}

export function getMilestoneByNumber(db: Database, projectId: string, number: number): MilestoneRow | null {
  return db.prepare('SELECT * FROM milestones WHERE project_id=$pid AND number=$n')
    .get({ $pid: projectId, $n: number }) as MilestoneRow | null
}

export function getMilestoneByTitle(db: Database, projectId: string, title: string): MilestoneRow | null {
  return db.prepare('SELECT * FROM milestones WHERE project_id=$pid AND title=$t')
    .get({ $pid: projectId, $t: title }) as MilestoneRow | null
}

/**
 * List milestones for a project with progress aggregation.
 *
 * `status_filter`:
 *   - 'open'   → only open milestones (default)
 *   - 'closed' → closed + cancelled
 *   - 'all'    → every milestone
 */
export function listMilestones(
  db: Database,
  projectId: string,
  status_filter: 'open' | 'closed' | 'all' = 'all',
): MilestoneWithProgress[] {
  let sql = 'SELECT * FROM milestones WHERE project_id=$pid'
  if (status_filter === 'open') sql += " AND status='open'"
  else if (status_filter === 'closed') sql += " AND status IN ('closed','cancelled')"
  sql += ' ORDER BY status ASC, number ASC'  // open first, then closed by number asc
  const rows = db.prepare(sql).all({ $pid: projectId }) as MilestoneRow[]

  // One aggregated query for ticket breakdown across all milestones in this
  // project — avoids N+1.
  const statuses = db.prepare(`
    SELECT milestone_id, status, COUNT(*) AS n
      FROM tickets
     WHERE project_id=$pid AND milestone_id IS NOT NULL
     GROUP BY milestone_id, status
  `).all({ $pid: projectId }) as Array<{ milestone_id: string; status: string; n: number }>

  const byMilestone = new Map<string, MilestoneProgress>()
  for (const r of statuses) {
    const p = byMilestone.get(r.milestone_id) ?? emptyProgress()
    p.total += r.n
    if (r.status === 'done') p.done += r.n
    else if (r.status === 'in_progress') p.in_progress += r.n
    else if (r.status === 'blocked') p.blocked += r.n
    else if (r.status === 'review') p.review += r.n
    else p.other += r.n
    byMilestone.set(r.milestone_id, p)
  }

  return rows.map((m) => ({
    ...m,
    progress: byMilestone.get(m.id) ?? emptyProgress(),
  }))
}

function emptyProgress(): MilestoneProgress {
  return { total: 0, done: 0, in_progress: 0, blocked: 0, review: 0, other: 0 }
}

/** Progress for a single milestone (cheaper than listMilestones if you only
 *  need one). */
export function computeMilestoneProgress(db: Database, milestoneId: string): MilestoneProgress {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS n FROM tickets WHERE milestone_id=$id GROUP BY status
  `).all({ $id: milestoneId }) as Array<{ status: string; n: number }>
  const p = emptyProgress()
  for (const r of rows) {
    p.total += r.n
    if (r.status === 'done') p.done += r.n
    else if (r.status === 'in_progress') p.in_progress += r.n
    else if (r.status === 'blocked') p.blocked += r.n
    else if (r.status === 'review') p.review += r.n
    else p.other += r.n
  }
  return p
}

export function listTicketsForMilestone(db: Database, milestoneId: string): TicketRow[] {
  return db.prepare(
    'SELECT * FROM tickets WHERE milestone_id=$id ORDER BY number ASC'
  ).all({ $id: milestoneId }) as TicketRow[]
}
