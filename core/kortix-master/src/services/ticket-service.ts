/**
 * Kortix Tickets — v2 project board.
 *
 * Parallel to tasks/task_events (v1). New projects default to structure_version=2
 * and get tickets/columns/fields/templates/agents. v1 projects keep using tasks.
 *
 * Tables:
 *   tickets, ticket_events, ticket_assignees, project_ticket_counter,
 *   project_columns, project_fields, ticket_templates,
 *   project_agents, ticket_agent_sessions
 *
 * Status is a free string matching a project_columns.key — no hardcoded enum.
 * Column auto-assignee rule fires on status change.
 * Permissions are encoded in project_agents.tool_groups_json, not per-action ACL.
 */

import { Database } from 'bun:sqlite'

export type ActorType = 'user' | 'agent' | 'system'
export type AssigneeType = 'user' | 'agent'
export type ExecutionMode = 'per_ticket' | 'per_assignment' | 'persistent'
export type ToolGroup = 'project_action' | 'project_manage'

export interface TicketRow {
  id: string
  project_id: string
  number: number
  title: string
  body_md: string
  status: string
  template_id: string | null
  custom_fields_json: string
  created_by_type: ActorType
  created_by_id: string | null
  created_at: string
  updated_at: string
  /**
   * If non-null, this ticket is a sub-ticket decomposed from the parent
   * (same project). Used by the tool-level permission logic to let
   * contributors create children of tickets they're assigned to, without
   * being able to spawn rogue top-level tickets.
   */
  parent_id: string | null
}

export interface TicketAssigneeRow {
  ticket_id: string
  assignee_type: AssigneeType
  assignee_id: string
  assigned_at: string
  assigned_by_type: ActorType | null
  assigned_by_id: string | null
}

export interface TicketEventRow {
  id: string
  ticket_id: string
  project_id: string
  actor_type: ActorType
  actor_id: string | null
  type: string
  message: string | null
  payload_json: string | null
  created_at: string
}

export interface ProjectColumnRow {
  id: string
  project_id: string
  key: string
  label: string
  order_index: number
  default_assignee_type: AssigneeType | null
  default_assignee_id: string | null
  is_terminal: number
  /**
   * Off-flow columns (e.g. "blocked") are side-channels — a ticket can enter
   * or leave them from any main column, and they don't participate in the
   * linear flow. Skip-column and gate-column guards ignore them.
   */
  is_off_flow: number
  icon: string | null
}

export interface ProjectFieldRow {
  id: string
  project_id: string
  key: string
  label: string
  type: 'text' | 'number' | 'date' | 'select'
  options_json: string | null
  order_index: number
}

export interface TicketTemplateRow {
  id: string
  project_id: string
  name: string
  body_md: string
  created_at: string
}

export interface ProjectAgentRow {
  id: string
  project_id: string
  slug: string
  name: string
  file_path: string
  session_id: string | null
  execution_mode: ExecutionMode
  tool_groups_json: string
  default_assignee_columns_json: string
  default_model: string | null
  color_hue: number | null
  icon: string | null
  created_at: string
  /**
   * Set once opencode's per-directory config cache has been refreshed since
   * this agent's file was written, so dispatches by slug are guaranteed to
   * resolve. Null while the register/dispose cycle is still in flight.
   * Triggers fired for a not-ready agent are queued in pending_agent_triggers
   * and drained when this flips.
   */
  ready_at: string | null
}

export interface PendingAgentTriggerRow {
  id: string
  agent_id: string
  ticket_id: string
  reason: string
  created_at: string
}

export interface TicketAgentSessionRow {
  ticket_id: string
  agent_id: string
  session_id: string
  created_at: string
}

export interface TicketWithRelations extends TicketRow {
  assignees: TicketAssigneeRow[]
  column?: ProjectColumnRow | null
}

// ── ID + time helpers ─────────────────────────────────────────────────────────

export function nowIso(): string { return new Date().toISOString() }

function shortId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
export function genTicketId(): string { return shortId('tk') }
export function genTicketEventId(): string { return shortId('te') }
export function genColumnId(): string { return shortId('col') }
export function genFieldId(): string { return shortId('fld') }
export function genTemplateId(): string { return shortId('tpl') }
export function genAgentId(): string { return shortId('ag') }

// ── Schema ────────────────────────────────────────────────────────────────────

export function ensureTicketTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      body_md TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      template_id TEXT,
      custom_fields_json TEXT NOT NULL DEFAULT '{}',
      created_by_type TEXT NOT NULL DEFAULT 'user',
      created_by_id TEXT,
      parent_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, number)
    );
    CREATE TABLE IF NOT EXISTS project_ticket_counter (
      project_id TEXT PRIMARY KEY,
      next_number INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS ticket_events (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      type TEXT NOT NULL,
      message TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ticket_assignees (
      ticket_id TEXT NOT NULL,
      assignee_type TEXT NOT NULL,
      assignee_id TEXT NOT NULL,
      assigned_at TEXT NOT NULL,
      assigned_by_type TEXT,
      assigned_by_id TEXT,
      PRIMARY KEY (ticket_id, assignee_type, assignee_id)
    );
    CREATE TABLE IF NOT EXISTS project_columns (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      default_assignee_type TEXT,
      default_assignee_id TEXT,
      is_terminal INTEGER NOT NULL DEFAULT 0,
      is_off_flow INTEGER NOT NULL DEFAULT 0,
      icon TEXT,
      UNIQUE(project_id, key)
    );
    CREATE TABLE IF NOT EXISTS project_fields (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      type TEXT NOT NULL,
      options_json TEXT,
      order_index INTEGER NOT NULL,
      UNIQUE(project_id, key)
    );
    CREATE TABLE IF NOT EXISTS ticket_templates (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      body_md TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(project_id, name)
    );
    CREATE TABLE IF NOT EXISTS project_agents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      session_id TEXT,
      execution_mode TEXT NOT NULL DEFAULT 'per_ticket',
      tool_groups_json TEXT NOT NULL DEFAULT '["project_action"]',
      default_assignee_columns_json TEXT NOT NULL DEFAULT '[]',
      default_model TEXT,
      color_hue INTEGER,
      icon TEXT,
      ready_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, slug)
    );
    CREATE TABLE IF NOT EXISTS ticket_agent_sessions (
      ticket_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (ticket_id, agent_id)
    );
    -- Triggers that wanted to fire but the target agent wasn't yet "ready"
    -- (opencode's per-directory config cache hadn't refreshed since the
    -- agent file was written). Drained when the dispose cycle completes
    -- and agents flip to ready.
    CREATE TABLE IF NOT EXISTS pending_agent_triggers (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
  try { db.exec(`ALTER TABLE projects ADD COLUMN structure_version INTEGER NOT NULL DEFAULT 1`) } catch {}
  try { db.exec(`ALTER TABLE project_agents ADD COLUMN default_model TEXT`) } catch {}
  try { db.exec(`ALTER TABLE project_agents ADD COLUMN color_hue INTEGER`) } catch {}
  try { db.exec(`ALTER TABLE project_agents ADD COLUMN icon TEXT`) } catch {}
  try { db.exec(`ALTER TABLE project_columns ADD COLUMN icon TEXT`) } catch {}
  try { db.exec(`ALTER TABLE project_columns ADD COLUMN is_off_flow INTEGER NOT NULL DEFAULT 0`) } catch {}
  try { db.exec(`ALTER TABLE project_agents ADD COLUMN ready_at TEXT`) } catch {}
  try { db.exec(`ALTER TABLE tickets ADD COLUMN parent_id TEXT`) } catch {}
}

// ── Columns ───────────────────────────────────────────────────────────────────

export function listColumns(db: Database, projectId: string): ProjectColumnRow[] {
  return db.prepare('SELECT * FROM project_columns WHERE project_id=$pid ORDER BY order_index ASC').all({ $pid: projectId }) as ProjectColumnRow[]
}

export function getColumnByKey(db: Database, projectId: string, key: string): ProjectColumnRow | null {
  return db.prepare('SELECT * FROM project_columns WHERE project_id=$pid AND key=$k').get({ $pid: projectId, $k: key }) as ProjectColumnRow | null
}

export interface ColumnInput {
  key: string
  label: string
  default_assignee_type?: AssigneeType | null
  default_assignee_id?: string | null
  is_terminal?: boolean
  is_off_flow?: boolean
  icon?: string | null
}

export function replaceColumns(db: Database, projectId: string, columns: ColumnInput[]): ProjectColumnRow[] {
  db.prepare('DELETE FROM project_columns WHERE project_id=$pid').run({ $pid: projectId })
  columns.forEach((c, i) => {
    db.prepare(`INSERT INTO project_columns
      (id, project_id, key, label, order_index, default_assignee_type, default_assignee_id, is_terminal, is_off_flow, icon)
      VALUES ($id, $pid, $k, $l, $o, $dat, $dai, $t, $off, $icon)`).run({
      $id: genColumnId(),
      $pid: projectId,
      $k: c.key,
      $l: c.label,
      $o: i,
      $dat: c.default_assignee_type ?? null,
      $dai: c.default_assignee_id ?? null,
      $t: c.is_terminal ? 1 : 0,
      $off: c.is_off_flow ? 1 : 0,
      $icon: c.icon ?? null,
    })
  })
  return listColumns(db, projectId)
}

export function updateColumn(db: Database, projectId: string, key: string, patch: Partial<ColumnInput>): ProjectColumnRow | null {
  const col = getColumnByKey(db, projectId, key)
  if (!col) return null
  db.prepare(`UPDATE project_columns SET
      label = COALESCE($label, label),
      default_assignee_type = $dat,
      default_assignee_id = $dai,
      is_terminal = COALESCE($t, is_terminal),
      is_off_flow = COALESCE($off, is_off_flow),
      icon = CASE WHEN $iconSet=1 THEN $icon ELSE icon END
    WHERE project_id=$pid AND key=$k`).run({
    $label: patch.label ?? null,
    $dat: patch.default_assignee_type === undefined ? col.default_assignee_type : patch.default_assignee_type,
    $dai: patch.default_assignee_id === undefined ? col.default_assignee_id : patch.default_assignee_id,
    $t: patch.is_terminal === undefined ? null : (patch.is_terminal ? 1 : 0),
    $off: patch.is_off_flow === undefined ? null : (patch.is_off_flow ? 1 : 0),
    $iconSet: patch.icon === undefined ? 0 : 1,
    $icon: patch.icon ?? null,
    $pid: projectId,
    $k: key,
  })
  return getColumnByKey(db, projectId, key)
}

// ── Fields ────────────────────────────────────────────────────────────────────

export function listFields(db: Database, projectId: string): ProjectFieldRow[] {
  return db.prepare('SELECT * FROM project_fields WHERE project_id=$pid ORDER BY order_index ASC').all({ $pid: projectId }) as ProjectFieldRow[]
}

export interface FieldInput {
  key: string
  label: string
  type: 'text' | 'number' | 'date' | 'select'
  options?: string[] | null
}

export function replaceFields(db: Database, projectId: string, fields: FieldInput[]): ProjectFieldRow[] {
  db.prepare('DELETE FROM project_fields WHERE project_id=$pid').run({ $pid: projectId })
  fields.forEach((f, i) => {
    db.prepare(`INSERT INTO project_fields
      (id, project_id, key, label, type, options_json, order_index)
      VALUES ($id, $pid, $k, $l, $t, $o, $i)`).run({
      $id: genFieldId(),
      $pid: projectId,
      $k: f.key,
      $l: f.label,
      $t: f.type,
      $o: f.options ? JSON.stringify(f.options) : null,
      $i: i,
    })
  })
  return listFields(db, projectId)
}

// ── Templates ─────────────────────────────────────────────────────────────────

export function listTemplates(db: Database, projectId: string): TicketTemplateRow[] {
  return db.prepare('SELECT * FROM ticket_templates WHERE project_id=$pid ORDER BY name ASC').all({ $pid: projectId }) as TicketTemplateRow[]
}

export function getTemplate(db: Database, id: string): TicketTemplateRow | null {
  return db.prepare('SELECT * FROM ticket_templates WHERE id=$id').get({ $id: id }) as TicketTemplateRow | null
}

export interface TemplateInput { name: string; body_md: string }

export function replaceTemplates(db: Database, projectId: string, templates: TemplateInput[]): TicketTemplateRow[] {
  db.prepare('DELETE FROM ticket_templates WHERE project_id=$pid').run({ $pid: projectId })
  for (const t of templates) {
    db.prepare(`INSERT INTO ticket_templates (id, project_id, name, body_md, created_at)
      VALUES ($id, $pid, $n, $b, $now)`).run({
      $id: genTemplateId(),
      $pid: projectId,
      $n: t.name,
      $b: t.body_md,
      $now: nowIso(),
    })
  }
  return listTemplates(db, projectId)
}

// ── Agents ────────────────────────────────────────────────────────────────────

export function listAgents(db: Database, projectId: string): ProjectAgentRow[] {
  return db.prepare('SELECT * FROM project_agents WHERE project_id=$pid ORDER BY created_at ASC').all({ $pid: projectId }) as ProjectAgentRow[]
}

export function getAgentBySlug(db: Database, projectId: string, slug: string): ProjectAgentRow | null {
  return db.prepare('SELECT * FROM project_agents WHERE project_id=$pid AND slug=$s').get({ $pid: projectId, $s: slug }) as ProjectAgentRow | null
}

export function getAgentById(db: Database, id: string): ProjectAgentRow | null {
  return db.prepare('SELECT * FROM project_agents WHERE id=$id').get({ $id: id }) as ProjectAgentRow | null
}

export interface AgentInput {
  slug: string
  name: string
  file_path: string
  execution_mode?: ExecutionMode
  tool_groups?: ToolGroup[]
  default_assignee_columns?: string[]
  default_model?: string | null
  color_hue?: number | null
  icon?: string | null
}

/** Derive a deterministic hue from a slug so PM/engineer/etc. stay consistent
 *  even if nobody picked a color at creation time. */
function hashHue(slug: string): number {
  let h = 0
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}

export function insertAgent(db: Database, projectId: string, input: AgentInput): ProjectAgentRow {
  const id = genAgentId()
  const hue = input.color_hue ?? hashHue(input.slug)
  db.prepare(`INSERT INTO project_agents
      (id, project_id, slug, name, file_path, session_id, execution_mode, tool_groups_json, default_assignee_columns_json, default_model, color_hue, icon, created_at)
    VALUES ($id, $pid, $s, $n, $f, NULL, $m, $tg, $dc, $dm, $hue, $icon, $now)`).run({
    $id: id,
    $pid: projectId,
    $s: input.slug,
    $n: input.name,
    $f: input.file_path,
    $m: input.execution_mode || 'per_ticket',
    $tg: JSON.stringify(input.tool_groups || ['project_action']),
    $dc: JSON.stringify(input.default_assignee_columns || []),
    $dm: input.default_model ?? null,
    $hue: hue,
    $icon: input.icon ?? null,
    $now: nowIso(),
  })
  return getAgentById(db, id)!
}

export function updateAgent(db: Database, id: string, patch: Partial<AgentInput>): ProjectAgentRow | null {
  const current = getAgentById(db, id)
  if (!current) return null
  db.prepare(`UPDATE project_agents SET
      slug = COALESCE($slug, slug),
      name = COALESCE($name, name),
      file_path = COALESCE($file, file_path),
      execution_mode = COALESCE($mode, execution_mode),
      tool_groups_json = COALESCE($tg, tool_groups_json),
      default_assignee_columns_json = COALESCE($dc, default_assignee_columns_json),
      default_model = CASE WHEN $dmSet=1 THEN $dm ELSE default_model END,
      color_hue = CASE WHEN $hueSet=1 THEN $hue ELSE color_hue END,
      icon = CASE WHEN $iconSet=1 THEN $icon ELSE icon END
    WHERE id=$id`).run({
    $slug: patch.slug ?? null,
    $name: patch.name ?? null,
    $file: patch.file_path ?? null,
    $mode: patch.execution_mode ?? null,
    $tg: patch.tool_groups ? JSON.stringify(patch.tool_groups) : null,
    $dc: patch.default_assignee_columns ? JSON.stringify(patch.default_assignee_columns) : null,
    $dmSet: patch.default_model === undefined ? 0 : 1,
    $dm: patch.default_model ?? null,
    $hueSet: patch.color_hue === undefined ? 0 : 1,
    $hue: patch.color_hue ?? null,
    $iconSet: patch.icon === undefined ? 0 : 1,
    $icon: patch.icon ?? null,
    $id: id,
  })
  return getAgentById(db, id)
}

export function deleteAgent(db: Database, id: string): void {
  db.prepare('DELETE FROM project_agents WHERE id=$id').run({ $id: id })
  db.prepare('DELETE FROM ticket_agent_sessions WHERE agent_id=$id').run({ $id: id })
}

export function setAgentSession(db: Database, agentId: string, sessionId: string | null): void {
  db.prepare('UPDATE project_agents SET session_id=$sid WHERE id=$id').run({ $sid: sessionId, $id: agentId })
}

// ── Agent readiness (directory-cache sync) ───────────────────────────────────

/**
 * Mark every not-ready agent in a project as ready and return the rows that
 * just flipped. Callers typically run this right after opencode's
 * /instance/dispose call resolves: at that point opencode has refreshed its
 * per-directory agent cache and any pending agent-file writes are live.
 */
export function markAgentsReadyForProject(db: Database, projectId: string): ProjectAgentRow[] {
  const flipped = db.prepare(
    'SELECT * FROM project_agents WHERE project_id=$pid AND ready_at IS NULL'
  ).all({ $pid: projectId }) as ProjectAgentRow[]
  if (!flipped.length) return []
  db.prepare('UPDATE project_agents SET ready_at=$now WHERE project_id=$pid AND ready_at IS NULL')
    .run({ $now: nowIso(), $pid: projectId })
  return flipped.map((a) => ({ ...a, ready_at: nowIso() }))
}

/** Force a specific agent's ready_at. Used by seedV2Project for the PM
 * on the first project-create path, when no sessions exist in the dir yet. */
export function markAgentReady(db: Database, agentId: string): void {
  db.prepare('UPDATE project_agents SET ready_at=$now WHERE id=$id').run({ $now: nowIso(), $id: agentId })
}

// ── Pending agent triggers ───────────────────────────────────────────────────

export function enqueuePendingTrigger(db: Database, input: {
  agent_id: string; ticket_id: string; reason: string
}): PendingAgentTriggerRow {
  const id = 'pt-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const now = nowIso()
  db.prepare(
    `INSERT INTO pending_agent_triggers (id, agent_id, ticket_id, reason, created_at)
     VALUES ($id, $aid, $tid, $r, $now)`
  ).run({ $id: id, $aid: input.agent_id, $tid: input.ticket_id, $r: input.reason, $now: now })
  return { id, agent_id: input.agent_id, ticket_id: input.ticket_id, reason: input.reason, created_at: now }
}

/** Drain (read + delete) pending triggers for the given agent ids. */
export function drainPendingTriggersForAgents(
  db: Database, agentIds: string[],
): PendingAgentTriggerRow[] {
  if (!agentIds.length) return []
  const placeholders = agentIds.map((_, i) => `$a${i}`).join(',')
  const params: Record<string, string> = {}
  agentIds.forEach((id, i) => { params[`$a${i}`] = id })
  const rows = db.prepare(
    `SELECT * FROM pending_agent_triggers WHERE agent_id IN (${placeholders}) ORDER BY created_at ASC`
  ).all(params) as PendingAgentTriggerRow[]
  if (!rows.length) return []
  db.prepare(`DELETE FROM pending_agent_triggers WHERE agent_id IN (${placeholders})`).run(params)
  return rows
}

// ── Tickets ───────────────────────────────────────────────────────────────────

function nextTicketNumber(db: Database, projectId: string): number {
  const row = db.prepare('SELECT next_number FROM project_ticket_counter WHERE project_id=$pid').get({ $pid: projectId }) as { next_number: number } | null
  const next = row?.next_number ?? 1
  db.prepare(`INSERT INTO project_ticket_counter (project_id, next_number) VALUES ($pid, $n)
    ON CONFLICT(project_id) DO UPDATE SET next_number=$n`).run({ $pid: projectId, $n: next + 1 })
  return next
}

export interface CreateTicketInput {
  project_id: string
  title: string
  body_md?: string
  status?: string
  template_id?: string | null
  custom_fields?: Record<string, unknown>
  created_by_type?: ActorType
  created_by_id?: string | null
  /** Skip the column's default-assignee rule (keep true by default). */
  auto_assign?: boolean
  /**
   * Explicit assignees to attach on create. When non-empty the column's
   * default-assignee rule is SKIPPED — the creator has made the call, so
   * we don't also tag the default (typically the creator themselves).
   * Creator agent is never added to its own assign_to list (self-assign
   * is pointless).
   */
  assign_to?: Array<{ type: AssigneeType; id: string }>
  /**
   * Parent ticket id. When set, this ticket is a sub-ticket of the parent.
   * Parent must exist and belong to the same project.
   */
  parent_id?: string | null
}

export function listTickets(db: Database, filters: { projectId?: string; status?: string } = {}): TicketWithRelations[] {
  let q = 'SELECT * FROM tickets WHERE 1=1'
  const params: Record<string, string> = {}
  if (filters.projectId) { q += ' AND project_id=$pid'; params.$pid = filters.projectId }
  if (filters.status) { q += ' AND status=$s'; params.$s = filters.status }
  q += ' ORDER BY created_at DESC LIMIT 500'
  const rows = db.prepare(q).all(params) as TicketRow[]
  return rows.map((r) => enrichTicket(db, r))
}

export function getTicket(db: Database, id: string): TicketWithRelations | null {
  const row = db.prepare('SELECT * FROM tickets WHERE id=$id').get({ $id: id }) as TicketRow | null
  if (!row) return null
  return enrichTicket(db, row)
}

/** Sub-tickets of a parent, ordered by number. */
export function listSubTickets(db: Database, parentId: string): TicketWithRelations[] {
  const rows = db.prepare('SELECT * FROM tickets WHERE parent_id=$pid ORDER BY number ASC').all({ $pid: parentId }) as TicketRow[]
  return rows.map((r) => enrichTicket(db, r))
}

/** Is the given agent currently assigned to this ticket? */
export function isAgentAssignedTo(db: Database, ticketId: string, agentId: string): boolean {
  const row = db.prepare(
    `SELECT 1 FROM ticket_assignees
     WHERE ticket_id=$tid AND assignee_type='agent' AND assignee_id=$aid`
  ).get({ $tid: ticketId, $aid: agentId })
  return !!row
}

export function getTicketByNumber(db: Database, projectId: string, number: number): TicketWithRelations | null {
  const row = db.prepare('SELECT * FROM tickets WHERE project_id=$pid AND number=$n').get({ $pid: projectId, $n: number }) as TicketRow | null
  if (!row) return null
  return enrichTicket(db, row)
}

function enrichTicket(db: Database, row: TicketRow): TicketWithRelations {
  const assignees = db.prepare('SELECT * FROM ticket_assignees WHERE ticket_id=$id').all({ $id: row.id }) as TicketAssigneeRow[]
  const column = getColumnByKey(db, row.project_id, row.status)
  return { ...row, assignees, column }
}

export function listTicketEvents(db: Database, ticketId: string): TicketEventRow[] {
  return db.prepare('SELECT * FROM ticket_events WHERE ticket_id=$id ORDER BY created_at ASC LIMIT 500').all({ $id: ticketId }) as TicketEventRow[]
}

// ── Event recording ───────────────────────────────────────────────────────────

export function recordTicketEvent(db: Database, input: {
  ticketId: string
  actor_type: ActorType
  actor_id?: string | null
  type: string
  message?: string | null
  payload?: unknown
}): TicketEventRow {
  const t = db.prepare('SELECT project_id FROM tickets WHERE id=$id').get({ $id: input.ticketId }) as { project_id: string } | null
  if (!t) throw new Error('Ticket not found')
  const row: TicketEventRow = {
    id: genTicketEventId(),
    ticket_id: input.ticketId,
    project_id: t.project_id,
    actor_type: input.actor_type,
    actor_id: input.actor_id ?? null,
    type: input.type,
    message: input.message ?? null,
    payload_json: input.payload === undefined ? null : JSON.stringify(input.payload),
    created_at: nowIso(),
  }
  db.prepare(`INSERT INTO ticket_events
      (id, ticket_id, project_id, actor_type, actor_id, type, message, payload_json, created_at)
    VALUES ($id, $tid, $pid, $at, $aid, $type, $msg, $payload, $now)`).run({
    $id: row.id,
    $tid: row.ticket_id,
    $pid: row.project_id,
    $at: row.actor_type,
    $aid: row.actor_id,
    $type: row.type,
    $msg: row.message,
    $payload: row.payload_json,
    $now: row.created_at,
  })
  return row
}

// ── Assignees ─────────────────────────────────────────────────────────────────

export function addAssignee(db: Database, input: {
  ticketId: string
  assignee_type: AssigneeType
  assignee_id: string
  actor_type?: ActorType
  actor_id?: string | null
}): { added: boolean } {
  const existing = db.prepare(`SELECT 1 FROM ticket_assignees
    WHERE ticket_id=$tid AND assignee_type=$at AND assignee_id=$aid`).get({
    $tid: input.ticketId, $at: input.assignee_type, $aid: input.assignee_id,
  })
  if (existing) return { added: false }
  db.prepare(`INSERT INTO ticket_assignees
      (ticket_id, assignee_type, assignee_id, assigned_at, assigned_by_type, assigned_by_id)
    VALUES ($tid, $at, $aid, $now, $bt, $bid)`).run({
    $tid: input.ticketId,
    $at: input.assignee_type,
    $aid: input.assignee_id,
    $now: nowIso(),
    $bt: input.actor_type ?? null,
    $bid: input.actor_id ?? null,
  })
  recordTicketEvent(db, {
    ticketId: input.ticketId,
    actor_type: input.actor_type ?? 'system',
    actor_id: input.actor_id,
    type: 'assigned',
    payload: { assignee_type: input.assignee_type, assignee_id: input.assignee_id },
  })
  touchTicket(db, input.ticketId)
  return { added: true }
}

export function removeAssignee(db: Database, input: {
  ticketId: string
  assignee_type: AssigneeType
  assignee_id: string
  actor_type?: ActorType
  actor_id?: string | null
}): { removed: boolean } {
  const res = db.prepare(`DELETE FROM ticket_assignees
    WHERE ticket_id=$tid AND assignee_type=$at AND assignee_id=$aid`).run({
    $tid: input.ticketId, $at: input.assignee_type, $aid: input.assignee_id,
  })
  if (res.changes === 0) return { removed: false }
  recordTicketEvent(db, {
    ticketId: input.ticketId,
    actor_type: input.actor_type ?? 'system',
    actor_id: input.actor_id,
    type: 'unassigned',
    payload: { assignee_type: input.assignee_type, assignee_id: input.assignee_id },
  })
  touchTicket(db, input.ticketId)
  return { removed: true }
}

function touchTicket(db: Database, ticketId: string): void {
  db.prepare('UPDATE tickets SET updated_at=$now WHERE id=$id').run({ $now: nowIso(), $id: ticketId })
}

// ── Create / Update ───────────────────────────────────────────────────────────

export interface CreateTicketResult {
  ticket: TicketWithRelations
  triggered: Array<{ agent_id: string; agent_slug: string; reason: 'column_default' }>
}

export function createTicket(db: Database, input: CreateTicketInput): CreateTicketResult {
  const columns = listColumns(db, input.project_id)
  if (columns.length === 0) throw new Error('Project has no columns; seed it first')

  const status = input.status && columns.some((c) => c.key === input.status) ? input.status : columns[0].key
  const number = nextTicketNumber(db, input.project_id)
  const id = genTicketId()
  const now = nowIso()

  // Validate parent_id if provided — must exist, same project.
  let parentId: string | null = null
  if (input.parent_id) {
    const parent = db.prepare('SELECT id, project_id FROM tickets WHERE id=$id').get({ $id: input.parent_id }) as { id: string; project_id: string } | null
    if (!parent) throw new Error(`Parent ticket not found: ${input.parent_id}`)
    if (parent.project_id !== input.project_id) throw new Error(`Parent ticket belongs to a different project: ${input.parent_id}`)
    parentId = parent.id
  }

  db.prepare(`INSERT INTO tickets
      (id, project_id, number, title, body_md, status, template_id,
       custom_fields_json, created_by_type, created_by_id, parent_id, created_at, updated_at)
    VALUES ($id, $pid, $num, $title, $body, $status, $tpl,
       $fields, $cbt, $cbi, $parent, $now, $now)`).run({
    $id: id,
    $pid: input.project_id,
    $num: number,
    $title: input.title,
    $body: input.body_md ?? '',
    $status: status,
    $tpl: input.template_id ?? null,
    $fields: JSON.stringify(input.custom_fields ?? {}),
    $cbt: input.created_by_type ?? 'user',
    $cbi: input.created_by_id ?? null,
    $parent: parentId,
    $now: now,
  })
  recordTicketEvent(db, {
    ticketId: id,
    actor_type: input.created_by_type ?? 'user',
    actor_id: input.created_by_id ?? null,
    type: 'created',
    message: input.title,
    payload: { status, ...(parentId ? { parent_id: parentId } : {}) },
  })

  const triggered: CreateTicketResult['triggered'] = []
  const creatorAgentId = input.created_by_type === 'agent' ? input.created_by_id : null

  if (input.assign_to && input.assign_to.length > 0) {
    // Explicit routing — the creator made the call. Skip the column default.
    for (const a of input.assign_to) {
      // Never self-attach: if the creator is an agent asking to assign
      // themselves, just ignore — creating a ticket for yourself to do is
      // the same as creating it and starting work.
      if (creatorAgentId && a.type === 'agent' && a.id === creatorAgentId) continue
      const r = addAssignee(db, {
        ticketId: id,
        assignee_type: a.type,
        assignee_id: a.id,
        actor_type: input.created_by_type ?? 'system',
        actor_id: input.created_by_id ?? null,
      })
      if (r.added && a.type === 'agent') {
        const ag = getAgentById(db, a.id)
        if (ag) triggered.push({ agent_id: ag.id, agent_slug: ag.slug, reason: 'column_default' })
      }
    }
  } else if (input.auto_assign !== false) {
    const col = getColumnByKey(db, input.project_id, status)
    if (col?.default_assignee_type && col.default_assignee_id) {
      const r = addAssignee(db, {
        ticketId: id,
        assignee_type: col.default_assignee_type,
        assignee_id: col.default_assignee_id,
        actor_type: 'system',
      })
      if (r.added && col.default_assignee_type === 'agent') {
        const ag = getAgentById(db, col.default_assignee_id)
        if (ag) triggered.push({ agent_id: ag.id, agent_slug: ag.slug, reason: 'column_default' })
      }
    }
  }

  return { ticket: getTicket(db, id)!, triggered }
}

export interface UpdateTicketInput {
  title?: string
  body_md?: string
  template_id?: string | null
  custom_fields?: Record<string, unknown>
}

export function updateTicket(db: Database, id: string, patch: UpdateTicketInput, actor: { type: ActorType; id?: string | null }): TicketWithRelations | null {
  const t = getTicket(db, id)
  if (!t) return null
  const now = nowIso()
  const fieldsChanged: Record<string, { from: unknown; to: unknown }> = {}

  if (patch.title !== undefined && patch.title !== t.title) {
    fieldsChanged.title = { from: t.title, to: patch.title }
    db.prepare('UPDATE tickets SET title=$v, updated_at=$now WHERE id=$id').run({ $v: patch.title, $now: now, $id: id })
  }
  if (patch.body_md !== undefined && patch.body_md !== t.body_md) {
    fieldsChanged.body_md = { from: '(previous)', to: '(updated)' }
    db.prepare('UPDATE tickets SET body_md=$v, updated_at=$now WHERE id=$id').run({ $v: patch.body_md, $now: now, $id: id })
  }
  if (patch.template_id !== undefined && patch.template_id !== t.template_id) {
    fieldsChanged.template_id = { from: t.template_id, to: patch.template_id }
    db.prepare('UPDATE tickets SET template_id=$v, updated_at=$now WHERE id=$id').run({ $v: patch.template_id, $now: now, $id: id })
  }
  if (patch.custom_fields !== undefined) {
    const prev = JSON.parse(t.custom_fields_json || '{}')
    const next = { ...prev, ...patch.custom_fields }
    fieldsChanged.custom_fields = { from: prev, to: next }
    db.prepare('UPDATE tickets SET custom_fields_json=$v, updated_at=$now WHERE id=$id').run({ $v: JSON.stringify(next), $now: now, $id: id })
  }

  if (Object.keys(fieldsChanged).length > 0) {
    recordTicketEvent(db, {
      ticketId: id,
      actor_type: actor.type,
      actor_id: actor.id,
      type: 'field_changed',
      payload: fieldsChanged,
    })
  }
  return getTicket(db, id)
}

export interface UpdateStatusResult {
  ticket: TicketWithRelations
  triggered: Array<{ agent_id: string; agent_slug: string; reason: 'column_default' }>
}

/**
 * Status change rules:
 *
 * - Validates destination is a real column key for this project.
 * - Emits a `status_changed` event into the activity log.
 * - If destination column has a default assignee, we ADD it (no-op if already
 *   assigned). Whoever was on the ticket BEFORE the move stays on — nobody
 *   gets silently unassigned just because they moved the ticket forward.
 *   Earlier behaviour auto-cleared the mover; that caused "engineer did the
 *   work, then disappeared" once QA got added. Responsibility isn't passed
 *   by moving; it's passed by explicit unassignment or reassignment.
 */
export function updateTicketStatus(db: Database, input: {
  ticketId: string
  toStatus: string
  actor_type: ActorType
  actor_id?: string | null
}): UpdateStatusResult | null {
  const t = getTicket(db, input.ticketId)
  if (!t) return null
  const col = getColumnByKey(db, t.project_id, input.toStatus)
  if (!col) throw new Error(`Unknown status '${input.toStatus}' for project ${t.project_id}`)
  if (t.status === input.toStatus) return { ticket: t, triggered: [] }

  const fromStatus = t.status
  const now = nowIso()
  db.prepare('UPDATE tickets SET status=$s, updated_at=$now WHERE id=$id').run({
    $s: input.toStatus, $now: now, $id: input.ticketId,
  })
  recordTicketEvent(db, {
    ticketId: input.ticketId,
    actor_type: input.actor_type,
    actor_id: input.actor_id,
    type: 'status_changed',
    payload: { from: fromStatus, to: input.toStatus },
  })

  const triggered: UpdateStatusResult['triggered'] = []
  if (col.default_assignee_type && col.default_assignee_id) {
    // Defensive slug→id resolution: a column stored "qa" as default_assignee_id
    // because PM called project_columns_update before QA existed means
    // subsequent updates can't find the agent. Fall back to slug lookup here.
    let resolvedId = col.default_assignee_id
    if (col.default_assignee_type === 'agent' && !resolvedId.startsWith('ag-')) {
      const ag = getAgentBySlug(db, t.project_id, resolvedId)
      if (ag) {
        resolvedId = ag.id
        // Heal the column row so future lookups are fast + self-consistent.
        try {
          db.prepare('UPDATE project_columns SET default_assignee_id=$id WHERE id=$cid')
            .run({ $id: ag.id, $cid: col.id })
        } catch {}
      }
    }
    const r = addAssignee(db, {
      ticketId: input.ticketId,
      assignee_type: col.default_assignee_type,
      assignee_id: resolvedId,
      actor_type: 'system',
    })
    if (r.added && col.default_assignee_type === 'agent') {
      const ag = getAgentById(db, resolvedId)
      if (ag) triggered.push({ agent_id: ag.id, agent_slug: ag.slug, reason: 'column_default' })
    }
  }

  return { ticket: getTicket(db, input.ticketId)!, triggered }
}

// ── Comments + @-mentions ─────────────────────────────────────────────────────

const MENTION_RE = /@([a-z0-9][a-z0-9_-]{0,63})/gi

export function extractMentions(body: string, availableSlugs: string[]): string[] {
  const slugSet = new Set(availableSlugs.map((s) => s.toLowerCase()))
  const hits = new Set<string>()
  for (const m of body.matchAll(MENTION_RE)) {
    const slug = m[1].toLowerCase()
    if (slugSet.has(slug)) hits.add(slug)
  }
  return Array.from(hits)
}

export interface CommentResult {
  event: TicketEventRow
  mentions: string[]
  triggered: Array<{ agent_id: string; agent_slug: string; reason: 'mention' }>
}

export function addComment(db: Database, input: {
  ticketId: string
  body: string
  actor_type: ActorType
  actor_id?: string | null
}): CommentResult {
  const t = getTicket(db, input.ticketId)
  if (!t) throw new Error('Ticket not found')
  const agents = listAgents(db, t.project_id)
  const slugs = agents.map((a) => a.slug)
  const mentions = extractMentions(input.body, slugs)
  const event = recordTicketEvent(db, {
    ticketId: input.ticketId,
    actor_type: input.actor_type,
    actor_id: input.actor_id,
    type: 'comment',
    message: input.body,
    payload: { mentions },
  })
  const triggered: CommentResult['triggered'] = []
  for (const slug of mentions) {
    const ag = agents.find((a) => a.slug === slug)
    if (!ag) continue
    if (input.actor_type === 'agent' && input.actor_id === ag.id) continue // don't notify self
    recordTicketEvent(db, {
      ticketId: input.ticketId,
      actor_type: 'system',
      type: 'mention',
      payload: { mentioned_agent_id: ag.id, mentioned_agent_slug: ag.slug, comment_event_id: event.id },
    })
    triggered.push({ agent_id: ag.id, agent_slug: ag.slug, reason: 'mention' })
  }
  touchTicket(db, input.ticketId)
  return { event, mentions, triggered }
}

// ── Delete ────────────────────────────────────────────────────────────────────

export function deleteTicket(db: Database, id: string): void {
  db.prepare('DELETE FROM ticket_events WHERE ticket_id=$id').run({ $id: id })
  db.prepare('DELETE FROM ticket_assignees WHERE ticket_id=$id').run({ $id: id })
  db.prepare('DELETE FROM ticket_agent_sessions WHERE ticket_id=$id').run({ $id: id })
  db.prepare('DELETE FROM tickets WHERE id=$id').run({ $id: id })
}

// ── Ticket↔Agent sessions (execution bindings) ────────────────────────────────

export function getTicketAgentSession(db: Database, ticketId: string, agentId: string): TicketAgentSessionRow | null {
  return db.prepare('SELECT * FROM ticket_agent_sessions WHERE ticket_id=$t AND agent_id=$a').get({ $t: ticketId, $a: agentId }) as TicketAgentSessionRow | null
}

export function setTicketAgentSession(db: Database, ticketId: string, agentId: string, sessionId: string): void {
  db.prepare(`INSERT INTO ticket_agent_sessions (ticket_id, agent_id, session_id, created_at)
    VALUES ($t, $a, $s, $now)
    ON CONFLICT(ticket_id, agent_id) DO UPDATE SET session_id=$s`).run({
    $t: ticketId, $a: agentId, $s: sessionId, $now: nowIso(),
  })
}

export function deleteTicketAgentSession(db: Database, ticketId: string, agentId: string): void {
  db.prepare('DELETE FROM ticket_agent_sessions WHERE ticket_id=$t AND agent_id=$a').run({ $t: ticketId, $a: agentId })
}

// ── Project structure version ─────────────────────────────────────────────────

export function getProjectStructureVersion(db: Database, projectId: string): number {
  try {
    const row = db.prepare('SELECT structure_version FROM projects WHERE id=$id').get({ $id: projectId }) as { structure_version: number } | null
    return row?.structure_version ?? 1
  } catch {
    return 1
  }
}

export function setProjectStructureVersion(db: Database, projectId: string, version: number): void {
  db.prepare('UPDATE projects SET structure_version=$v WHERE id=$id').run({ $v: version, $id: projectId })
}
