/**
 * Kortix Tickets API — v2 project boards.
 *
 * Status is a free string keyed off project_columns. Assignees are polymorphic
 * (user|agent). Column rules auto-assign on status change and produce a
 * `triggered` array in the response so callers can spawn agent sessions.
 */

import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import * as fs from 'node:fs/promises'
import { join } from 'path'
import {
  addAssignee,
  addComment,
  createTicket,
  deleteTicket,
  ensureTicketTables,
  getTicket,
  listTicketEvents,
  listTickets,
  removeAssignee,
  updateTicket,
  updateTicketStatus,
  listColumns,
  replaceColumns,
  updateColumn,
  listFields,
  replaceFields,
  listTemplates,
  replaceTemplates,
  listAgents,
  getAgentBySlug,
  insertAgent,
  updateAgent,
  deleteAgent,
  type ActorType,
  type AssigneeType,
  type ExecutionMode,
  type ToolGroup,
} from '../services/ticket-service'
import {
  seedV2Project,
  syncTeamSection,
  tryReadContext,
  writeContextPreservingTeam,
} from '../services/project-v2-seed'
import { fireAgentTrigger, fireAgentTriggers, type OpenCodeClientLike } from '../services/ticket-triggers'
import { createOpencodeClient } from '@opencode-ai/sdk/client'
import { config } from '../config'

function getDb(): Database {
  const workspace = process.env.WORKSPACE_DIR || process.env.KORTIX_WORKSPACE || '/workspace'
  const dbPath = join(workspace, '.kortix', 'kortix.db')
  if (!existsSync(dbPath)) throw new Error('kortix.db not found')
  const db = new Database(dbPath)
  db.exec('PRAGMA busy_timeout=5000')
  ensureTicketTables(db)
  return db
}

let _ocClient: ReturnType<typeof createOpencodeClient> | null = null
function getOpenCodeClient(): OpenCodeClientLike {
  if (!_ocClient) {
    _ocClient = createOpencodeClient({
      baseUrl: `http://${config.OPENCODE_HOST}:${config.OPENCODE_PORT}`,
    })
  }
  return _ocClient as unknown as OpenCodeClientLike
}

interface ProjectRow { id: string; name: string; path: string; description: string; user_handle?: string | null }

function resolveProject(db: Database, id: string): ProjectRow | null {
  return (
    db.prepare('SELECT id,name,path,description,user_handle FROM projects WHERE id=$v').get({ $v: id })
    || db.prepare('SELECT id,name,path,description,user_handle FROM projects WHERE opencode_id=$v').get({ $v: id })
    || db.prepare('SELECT id,name,path,description,user_handle FROM projects WHERE LOWER(name)=LOWER($v)').get({ $v: id })
  ) as ProjectRow | null
}

const ticketsRouter = new Hono()

// ── Tickets CRUD ──────────────────────────────────────────────────────────────

ticketsRouter.get('/', (c) => {
  try {
    const db = getDb()
    return c.json(listTickets(db, {
      projectId: c.req.query('project_id') || undefined,
      status: c.req.query('status') || undefined,
    }))
  } catch {
    return c.json([])
  }
})

ticketsRouter.get('/:id', (c) => {
  try {
    const db = getDb()
    const t = getTicket(db, c.req.param('id'))
    if (!t) return c.json({ error: 'Not found' }, 404)
    return c.json(t)
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

ticketsRouter.get('/:id/events', (c) => {
  try {
    const db = getDb()
    return c.json(listTicketEvents(db, c.req.param('id')))
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

ticketsRouter.post('/', async (c) => {
  try {
    const db = getDb()
    const body = await c.req.json<{
      project_id?: string
      title?: string
      body_md?: string
      status?: string
      template_id?: string | null
      custom_fields?: Record<string, unknown>
      created_by_type?: ActorType
      created_by_id?: string | null
    }>()
    if (!body.project_id || !body.title) {
      return c.json({ error: 'project_id and title required' }, 400)
    }
    const result = createTicket(db, {
      project_id: body.project_id,
      title: body.title,
      body_md: body.body_md,
      status: body.status,
      template_id: body.template_id,
      custom_fields: body.custom_fields,
      created_by_type: body.created_by_type,
      created_by_id: body.created_by_id,
    })
    if (result.triggered.length) {
      fireAgentTriggers({
        db,
        client: getOpenCodeClient(),
        projectId: body.project_id,
        ticketId: result.ticket.id,
        triggered: result.triggered.map((t) => ({ ...t, reason: 'You are the default assignee for this column.' })),
        actor: { type: body.created_by_type ?? 'user', id: body.created_by_id ?? null },
      }).catch(() => {})
    }
    return c.json(result)
  } catch (e) {
    return c.json({ error: String(e) }, 400)
  }
})

ticketsRouter.patch('/:id', async (c) => {
  try {
    const db = getDb()
    const id = c.req.param('id')
    const body = await c.req.json<{
      title?: string
      body_md?: string
      template_id?: string | null
      custom_fields?: Record<string, unknown>
      actor_type?: ActorType
      actor_id?: string | null
    }>()
    const updated = updateTicket(db, id, {
      title: body.title,
      body_md: body.body_md,
      template_id: body.template_id,
      custom_fields: body.custom_fields,
    }, { type: body.actor_type ?? 'user', id: body.actor_id ?? null })
    if (!updated) return c.json({ error: 'Not found' }, 404)
    return c.json(updated)
  } catch (e) {
    return c.json({ error: String(e) }, 400)
  }
})

ticketsRouter.post('/:id/status', async (c) => {
  try {
    const db = getDb()
    const body = await c.req.json<{ status: string; actor_type?: ActorType; actor_id?: string | null }>()
    if (!body.status) return c.json({ error: 'status required' }, 400)
    const r = updateTicketStatus(db, {
      ticketId: c.req.param('id'),
      toStatus: body.status,
      actor_type: body.actor_type ?? 'user',
      actor_id: body.actor_id ?? null,
    })
    if (!r) return c.json({ error: 'Not found' }, 404)
    if (r.triggered.length) {
      fireAgentTriggers({
        db,
        client: getOpenCodeClient(),
        projectId: r.ticket.project_id,
        ticketId: r.ticket.id,
        triggered: r.triggered.map((t) => ({ ...t, reason: `Ticket moved to "${body.status}" — you are the default assignee.` })),
        actor: { type: body.actor_type ?? 'user', id: body.actor_id ?? null },
      }).catch(() => {})
    }
    return c.json(r)
  } catch (e) {
    return c.json({ error: String(e) }, 400)
  }
})

ticketsRouter.post('/:id/assign', async (c) => {
  try {
    const db = getDb()
    const body = await c.req.json<{ assignee_type: AssigneeType; assignee_id: string; actor_type?: ActorType; actor_id?: string | null }>()
    if (!body.assignee_type || !body.assignee_id) return c.json({ error: 'assignee_type and assignee_id required' }, 400)
    const ticket = getTicket(db, c.req.param('id'))
    if (!ticket) return c.json({ error: 'Not found' }, 404)
    const r = addAssignee(db, {
      ticketId: ticket.id,
      assignee_type: body.assignee_type,
      assignee_id: body.assignee_id,
      actor_type: body.actor_type,
      actor_id: body.actor_id,
    })
    if (r.added && body.assignee_type === 'agent') {
      const agent = db.prepare('SELECT * FROM project_agents WHERE id=$id').get({ $id: body.assignee_id }) as any
      if (agent && (body.actor_type !== 'agent' || body.actor_id !== agent.id)) {
        fireAgentTrigger({
          db,
          client: getOpenCodeClient(),
          projectId: ticket.project_id,
          ticketId: ticket.id,
          agent,
          reason: 'You were assigned to this ticket.',
        }).catch(() => {})
      }
    }
    return c.json({ ...r, ticket: getTicket(db, ticket.id) })
  } catch (e) {
    return c.json({ error: String(e) }, 400)
  }
})

ticketsRouter.post('/:id/unassign', async (c) => {
  try {
    const db = getDb()
    const body = await c.req.json<{ assignee_type: AssigneeType; assignee_id: string; actor_type?: ActorType; actor_id?: string | null }>()
    if (!body.assignee_type || !body.assignee_id) return c.json({ error: 'assignee_type and assignee_id required' }, 400)
    const r = removeAssignee(db, {
      ticketId: c.req.param('id'),
      assignee_type: body.assignee_type,
      assignee_id: body.assignee_id,
      actor_type: body.actor_type,
      actor_id: body.actor_id,
    })
    return c.json({ ...r, ticket: getTicket(db, c.req.param('id')) })
  } catch (e) {
    return c.json({ error: String(e) }, 400)
  }
})

ticketsRouter.post('/:id/comments', async (c) => {
  try {
    const db = getDb()
    const body = await c.req.json<{ body?: string; actor_type?: ActorType; actor_id?: string | null }>()
    if (!body.body) return c.json({ error: 'body required' }, 400)
    const ticket = getTicket(db, c.req.param('id'))
    if (!ticket) return c.json({ error: 'Not found' }, 404)
    const r = addComment(db, {
      ticketId: ticket.id,
      body: body.body,
      actor_type: body.actor_type ?? 'user',
      actor_id: body.actor_id ?? null,
    })
    if (r.triggered.length) {
      fireAgentTriggers({
        db,
        client: getOpenCodeClient(),
        projectId: ticket.project_id,
        ticketId: ticket.id,
        triggered: r.triggered.map((t) => ({ ...t, reason: 'You were @-mentioned in a comment.' })),
        actor: { type: body.actor_type ?? 'user', id: body.actor_id ?? null },
      }).catch(() => {})
    }
    return c.json(r)
  } catch (e) {
    return c.json({ error: String(e) }, 400)
  }
})

ticketsRouter.delete('/:id', (c) => {
  try {
    const db = getDb()
    deleteTicket(db, c.req.param('id'))
    return c.json({ deleted: true })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

export { ticketsRouter }

// ═════════════════════════════════════════════════════════════════════════════
// Project-scoped ticket configuration: /kortix/projects/:id/{columns,fields,templates,agents,context,seed}
// ═════════════════════════════════════════════════════════════════════════════

const ticketProjectsRouter = new Hono()

// ── Columns ────────────────────────────────────────────────────────────────

ticketProjectsRouter.get('/:id/columns', (c) => {
  const db = getDb()
  const project = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!project) return c.json({ error: 'Project not found' }, 404)
  return c.json(listColumns(db, project.id))
})

ticketProjectsRouter.put('/:id/columns', async (c) => {
  const db = getDb()
  const project = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!project) return c.json({ error: 'Project not found' }, 404)
  const body = await c.req.json<{ columns: Array<{ key: string; label: string; default_assignee_type?: AssigneeType | null; default_assignee_id?: string | null; is_terminal?: boolean }> }>()
  if (!Array.isArray(body.columns)) return c.json({ error: 'columns[] required' }, 400)
  const replaced = replaceColumns(db, project.id, body.columns)
  return c.json(replaced)
})

ticketProjectsRouter.patch('/:id/columns/:key', async (c) => {
  const db = getDb()
  const project = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!project) return c.json({ error: 'Project not found' }, 404)
  const patch = await c.req.json<{ label?: string; default_assignee_type?: AssigneeType | null; default_assignee_id?: string | null; is_terminal?: boolean }>()
  const updated = updateColumn(db, project.id, c.req.param('key'), patch)
  if (!updated) return c.json({ error: 'Column not found' }, 404)
  return c.json(updated)
})

// ── Fields ────────────────────────────────────────────────────────────────

ticketProjectsRouter.get('/:id/fields', (c) => {
  const db = getDb()
  const project = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!project) return c.json({ error: 'Project not found' }, 404)
  return c.json(listFields(db, project.id))
})

ticketProjectsRouter.put('/:id/fields', async (c) => {
  const db = getDb()
  const project = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!project) return c.json({ error: 'Project not found' }, 404)
  const body = await c.req.json<{ fields: Array<{ key: string; label: string; type: 'text' | 'number' | 'date' | 'select'; options?: string[] | null }> }>()
  if (!Array.isArray(body.fields)) return c.json({ error: 'fields[] required' }, 400)
  return c.json(replaceFields(db, project.id, body.fields))
})

// ── Templates ─────────────────────────────────────────────────────────────

ticketProjectsRouter.get('/:id/templates', (c) => {
  const db = getDb()
  const project = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!project) return c.json({ error: 'Project not found' }, 404)
  return c.json(listTemplates(db, project.id))
})

ticketProjectsRouter.put('/:id/templates', async (c) => {
  const db = getDb()
  const project = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!project) return c.json({ error: 'Project not found' }, 404)
  const body = await c.req.json<{ templates: Array<{ name: string; body_md: string }> }>()
  if (!Array.isArray(body.templates)) return c.json({ error: 'templates[] required' }, 400)
  return c.json(replaceTemplates(db, project.id, body.templates))
})

// ── Agents (team) ─────────────────────────────────────────────────────────

ticketProjectsRouter.get('/:id/agents', (c) => {
  const db = getDb()
  const project = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!project) return c.json({ error: 'Project not found' }, 404)
  return c.json(listAgents(db, project.id))
})

ticketProjectsRouter.post('/:id/agents', async (c) => {
  const db = getDb()
  const project = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!project) return c.json({ error: 'Project not found' }, 404)
  const body = await c.req.json<{
    slug: string
    name: string
    body_md: string
    execution_mode?: ExecutionMode
    tool_groups?: ToolGroup[]
    default_assignee_columns?: string[]
  }>()
  if (!body.slug || !body.name || !body.body_md) {
    return c.json({ error: 'slug, name, body_md required' }, 400)
  }
  if (getAgentBySlug(db, project.id, body.slug)) {
    return c.json({ error: 'Agent with this slug already exists' }, 409)
  }
  const filePath = join(project.path, '.kortix', 'agents', `${body.slug}.md`)
  await fs.mkdir(join(project.path, '.kortix', 'agents'), { recursive: true })
  await fs.writeFile(filePath, body.body_md, 'utf8')
  const agent = insertAgent(db, project.id, {
    slug: body.slug,
    name: body.name,
    file_path: filePath,
    execution_mode: body.execution_mode,
    tool_groups: body.tool_groups,
    default_assignee_columns: body.default_assignee_columns,
  })
  await syncTeamSection(db, project)
  return c.json(agent)
})

ticketProjectsRouter.patch('/:id/agents/:slug', async (c) => {
  const db = getDb()
  const project = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!project) return c.json({ error: 'Project not found' }, 404)
  const agent = getAgentBySlug(db, project.id, c.req.param('slug'))
  if (!agent) return c.json({ error: 'Agent not found' }, 404)
  const body = await c.req.json<{
    name?: string
    body_md?: string
    execution_mode?: ExecutionMode
    tool_groups?: ToolGroup[]
    default_assignee_columns?: string[]
  }>()
  if (body.body_md !== undefined) {
    try { await fs.writeFile(agent.file_path, body.body_md, 'utf8') } catch {}
  }
  const updated = updateAgent(db, agent.id, {
    name: body.name,
    execution_mode: body.execution_mode,
    tool_groups: body.tool_groups,
    default_assignee_columns: body.default_assignee_columns,
  })
  await syncTeamSection(db, project)
  return c.json(updated)
})

ticketProjectsRouter.delete('/:id/agents/:slug', async (c) => {
  const db = getDb()
  const project = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!project) return c.json({ error: 'Project not found' }, 404)
  const agent = getAgentBySlug(db, project.id, c.req.param('slug'))
  if (!agent) return c.json({ error: 'Agent not found' }, 404)
  try { await fs.unlink(agent.file_path) } catch {}
  deleteAgent(db, agent.id)
  await syncTeamSection(db, project)
  return c.json({ deleted: true })
})

ticketProjectsRouter.get('/:id/agents/:slug/persona', async (c) => {
  const db = getDb()
  const project = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!project) return c.json({ error: 'Project not found' }, 404)
  const agent = getAgentBySlug(db, project.id, c.req.param('slug'))
  if (!agent) return c.json({ error: 'Agent not found' }, 404)
  let body_md = ''
  try { body_md = await fs.readFile(agent.file_path, 'utf8') } catch {}
  return c.json({ agent, body_md })
})

// ── Context ─────────────────────────────────────────────────────────────────

ticketProjectsRouter.get('/:id/context', async (c) => {
  const db = getDb()
  const project = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!project) return c.json({ error: 'Project not found' }, 404)
  const body = await tryReadContext(project.path)
  return c.json({ body })
})

ticketProjectsRouter.put('/:id/context', async (c) => {
  const db = getDb()
  const project = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!project) return c.json({ error: 'Project not found' }, 404)
  const { body } = await c.req.json<{ body: string }>()
  if (typeof body !== 'string') return c.json({ error: 'body required' }, 400)
  await writeContextPreservingTeam(project.path, body)
  await syncTeamSection(db, project)
  return c.json({ ok: true })
})

// ── Seed (upgrade existing project → v2) ────────────────────────────────────

ticketProjectsRouter.post('/:id/seed-v2', async (c) => {
  const db = getDb()
  const project = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!project) return c.json({ error: 'Project not found' }, 404)
  const body = await c.req.json<{ user_handle?: string }>().catch(() => ({} as { user_handle?: string }))
  const userHandle = body.user_handle?.trim() || null
  if (userHandle) {
    db.prepare('UPDATE projects SET user_handle=$h WHERE id=$id').run({ $h: userHandle, $id: project.id })
  }
  const { pmAgent } = await seedV2Project(db, { ...project, user_handle: userHandle })
  return c.json({ ok: true, pm_agent_id: pmAgent.id })
})

export { ticketProjectsRouter }
