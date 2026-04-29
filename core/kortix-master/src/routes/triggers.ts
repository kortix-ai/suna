/**
 * Unified Triggers Router — Full CRUD for all trigger types.
 * Replaces both the old /kortix/triggers (read-only list) and /kortix/cron/* routes.
 *
 * Writes go through TriggerManager which handles YAML + DB write-through.
 */
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import { join } from 'path'
import { z } from 'zod'
import { TriggerStore, TriggerYaml, isValidCronExpression, describeCron, getNextRun } from '../../triggers/src/index'
import type { TriggerRecord, TriggerResponse, ExecutionResponse } from '../../triggers/src/types'

// ─── Singleton store + yaml sync ────────────────────────────────────────────
// These are initialized once and shared across all requests.
// The TriggerManager in the plugin handles the lifecycle; these are the
// direct DB/YAML accessors for the HTTP API layer.

let store: TriggerStore | null = null
let yamlSync: TriggerYaml | null = null

function getWorkspaceRoot(): string {
  return process.env.WORKSPACE_DIR || process.env.KORTIX_WORKSPACE || '/workspace'
}

function getStore(): TriggerStore {
  if (!store) {
    store = new TriggerStore(join(getWorkspaceRoot(), '.kortix', 'kortix.db'))
    // Additive columns the engine ignores but the UI + dispatch read:
    //   project_id — scope a trigger to a project's Triggers tab
    //   ticket_id  — bind a trigger to a ticket (persistent per-ticket session)
    try { (store as any).db?.exec?.(`ALTER TABLE triggers ADD COLUMN project_id TEXT`) } catch {}
    try { (store as any).db?.exec?.(`ALTER TABLE triggers ADD COLUMN ticket_id TEXT`) } catch {}
  }
  return store
}

function getYamlSync(): TriggerYaml {
  if (!yamlSync) {
    yamlSync = new TriggerYaml(getStore(), getWorkspaceRoot())
  }
  return yamlSync
}

/**
 * Tell the in-plugin trigger manager to re-read the DB and re-register
 * runtime (cron jobs + webhook routes). kortix-master's HTTP CRUD path
 * bypasses manager.createTrigger (we hit the store directly so the
 * transaction stays in-process), so without this ping the new cron
 * schedule + webhook route never register until an opencode restart.
 */
async function pokeTriggerManagerReload(): Promise<void> {
  const port = process.env.KORTIX_TRIGGER_WEBHOOK_PORT || '8099'
  try {
    await fetch(`http://localhost:${port}/internal/reload`, {
      method: 'POST',
      signal: AbortSignal.timeout(2_000),
    })
  } catch {
    // Best-effort — if the plugin is down, triggers will pick up on next
    // opencode boot via its own sync loop.
  }
}

/**
 * Forward a manual fire to the in-plugin trigger manager. Hits
 * POST /internal/run/:id on the trigger webhook server, which routes
 * to manager.runTrigger(id) → ActionDispatcher.dispatch → real session
 * creation. Without this the /run endpoint only logs an execution row.
 */
async function pokeTriggerManagerRun(triggerId: string): Promise<{ ok: boolean; executionId?: string; error?: string }> {
  const port = process.env.KORTIX_TRIGGER_WEBHOOK_PORT || '8099'
  try {
    const res = await fetch(`http://localhost:${port}/internal/run/${encodeURIComponent(triggerId)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; executionId?: string; error?: string }
    return { ok: !!body.ok, executionId: body.executionId, error: body.error }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ─── Response mappers ───────────────────────────────────────────────────────

function mapTriggerToResponse(t: TriggerRecord): TriggerResponse {
  const sourceConfig = JSON.parse(t.source_config) as Record<string, unknown>
  const actionConfig = JSON.parse(t.action_config) as Record<string, unknown>
  const contextConfig = JSON.parse(t.context_config || '{}') as Record<string, unknown>
  const pipedreamProps = JSON.parse(t.pipedream_props || '{}') as Record<string, unknown>
  const metadata = JSON.parse(t.metadata || '{}') as Record<string, unknown>

  const isCron = t.source_type === 'cron'
  const isWebhook = t.source_type === 'webhook'

  return {
    id: t.id,
    name: t.name,
    description: t.description,
    source_type: t.source_type as any,
    source_config: sourceConfig,
    action_type: t.action_type as any,
    action_config: actionConfig,
    context_config: contextConfig,
    agent_name: t.agent_name,
    model_id: t.model_id,
    session_mode: t.session_mode,
    session_id: t.session_id,
    pipedream: t.pipedream_app ? {
      app: t.pipedream_app,
      component: t.pipedream_component,
      deployed_id: t.pipedream_deployed_id,
      webhook_url: t.pipedream_webhook_url,
      props: pipedreamProps,
    } : null,
    is_active: !!t.is_active,
    last_run_at: t.last_run_at,
    next_run_at: t.next_run_at,
    last_event_at: t.last_event_at,
    event_count: t.event_count,
    metadata,
    created_at: t.created_at,
    updated_at: t.updated_at,
    // Frontend compat fields
    triggerId: t.id,
    type: t.source_type,
    sourceType: 'manual', // all triggers are now "manual" (user-created)
    prompt: (actionConfig.prompt as string) ?? '',
    enabled: !!t.is_active,
    isActive: !!t.is_active,
    editable: true,
    cronExpr: isCron ? (sourceConfig.cron_expr as string) ?? null : null,
    timezone: isCron ? (sourceConfig.timezone as string) ?? 'UTC' : null,
    nextRunAt: t.next_run_at,
    lastRunAt: t.last_run_at,
    sessionMode: t.session_mode ?? 'new',
    agentName: t.agent_name,
    modelId: t.model_id,
    modelProviderId: t.model_id?.includes('/') ? t.model_id.split('/')[0] : null,
    webhook: isWebhook ? {
      path: (sourceConfig.path as string) ?? '',
      method: (sourceConfig.method as string) ?? 'POST',
      secretProtected: !!(sourceConfig.secret),
    } : null,
    agentFilePath: null,
    maxRetries: 0,
    timeoutMs: (actionConfig.timeout_ms as number) ?? 300000,
    project_id: (t as any).project_id ?? null,
    ticket_id: (t as any).ticket_id ?? null,
  }
}

function mapExecution(e: any): ExecutionResponse {
  return {
    executionId: e.id,
    triggerId: e.trigger_id,
    status: e.status,
    sessionId: e.session_id ?? null,
    errorMessage: e.error_message ?? null,
    stdout: e.stdout ?? null,
    stderr: e.stderr ?? null,
    exitCode: e.exit_code ?? null,
    httpStatus: e.http_status ?? null,
    retryCount: e.retry_count ?? 0,
    metadata: e.metadata ? (typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata) : {},
    result_text: e.result_text ?? null,
    startedAt: e.started_at,
    completedAt: e.completed_at ?? null,
    durationMs: e.duration_ms ?? null,
    createdAt: e.created_at,
  }
}

// ─── Validation schemas ─────────────────────────────────────────────────────

const createSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  source: z.object({
    type: z.enum(['cron', 'webhook']),
    cron_expr: z.string().optional(),
    timezone: z.string().optional(),
    path: z.string().optional(),
    method: z.string().optional(),
    secret: z.string().optional(),
  }),
  action: z.object({
    type: z.enum(['prompt', 'command', 'http', 'ticket_create']).optional().default('prompt'),
    prompt: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    session_mode: z.enum(['new', 'reuse']).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    workdir: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeout_ms: z.number().optional(),
    url: z.string().optional(),
    method: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body_template: z.string().optional(),
    // ticket_create action
    title: z.string().optional(),
    body_md: z.string().optional(),
    template_id: z.string().optional(),
    column: z.string().optional(),
    assignee_slugs: z.array(z.string()).optional(),
  }).optional().default({ type: 'prompt' }),
  context: z.object({
    extract: z.record(z.string(), z.string()).optional(),
    include_raw: z.boolean().optional(),
  }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Legacy compat: accept flat fields from old cron API
  cron_expr: z.string().optional(),
  timezone: z.string().optional(),
  prompt: z.string().optional(),
  agent_name: z.string().optional(),
  model_provider_id: z.string().optional(),
  model_id: z.string().optional(),
  session_mode: z.enum(['new', 'reuse']).optional(),
  carry_state: z.boolean().optional(),
}).passthrough()

function notFound(c: any, resource: string) {
  return c.json({ error: `${resource} not found` }, 404)
}

// ─── Router ─────────────────────────────────────────────────────────────────

const triggersRouter = new Hono()

// GET /triggers — List all triggers
triggersRouter.get('/',
  describeRoute({ tags: ['Triggers'], summary: 'List all triggers', responses: { 200: { description: 'Trigger list' } } }),
  (c) => {
    const db = getStore()
    const sourceType = c.req.query('source_type')
    const isActiveParam = c.req.query('is_active')
    const projectId = c.req.query('project_id')
    const ticketId = c.req.query('ticket_id')
    const filter: { source_type?: string; is_active?: boolean } = {}
    if (sourceType) filter.source_type = sourceType
    if (isActiveParam === 'true') filter.is_active = true
    if (isActiveParam === 'false') filter.is_active = false

    let triggers = db.list(filter)
    // Honor project_id / ticket_id query filters. The underlying store's
    // `filter` doesn't know about these columns so we filter in-memory —
    // callers (sidebar, project pages) were previously forced to pull all
    // triggers and filter client-side, which leaked other projects'
    // triggers to the wire.
    if (projectId) triggers = triggers.filter((t: any) => t.project_id === projectId)
    if (ticketId) triggers = triggers.filter((t: any) => t.ticket_id === ticketId)

    const data = triggers.map(mapTriggerToResponse)
    return c.json({ success: true, data, total: data.length })
  },
)

// POST /triggers — Create trigger
triggersRouter.post('/',
  describeRoute({ tags: ['Triggers'], summary: 'Create trigger', responses: { 201: { description: 'Created' }, 400: { description: 'Invalid' } } }),
  async (c) => {
    const body = await c.req.json()
    const db = getStore()
    const ys = getYamlSync()

    // Handle legacy flat format (from old /kortix/cron API)
    if (body.cron_expr && !body.source) {
      body.source = { type: 'cron', cron_expr: body.cron_expr, timezone: body.timezone ?? 'UTC' }
      body.action = { type: 'prompt', prompt: body.prompt }
      if (body.agent_name) body.action.agent = body.agent_name
      if (body.model_id) body.action.model = body.model_id
      if (body.session_mode) body.action.session_mode = body.session_mode
    }

    const parsed = createSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(', ') }, 400)
    }
    const data = parsed.data

    // Validate source
    if (data.source.type === 'cron') {
      const expr = data.source.cron_expr
      if (!expr) return c.json({ error: 'cron_expr is required for cron triggers' }, 400)
      if (!isValidCronExpression(expr)) return c.json({ error: 'Invalid cron expression. Use 6-field format: second minute hour day month weekday' }, 400)
    } else if (data.source.type === 'webhook') {
      if (!data.source.path) return c.json({ error: 'path is required for webhook triggers' }, 400)
    }

    // Validate action
    const actionType = data.action.type ?? 'prompt'
    if (actionType === 'prompt' && !data.action.prompt) {
      return c.json({ error: 'prompt is required for prompt actions' }, 400)
    }
    if (actionType === 'command' && !data.action.command) {
      return c.json({ error: 'command is required for command actions' }, 400)
    }
    if (actionType === 'http' && !data.action.url) {
      return c.json({ error: 'url is required for http actions' }, 400)
    }
    if (actionType === 'ticket_create') {
      if (!data.action.title) return c.json({ error: 'title is required for ticket_create actions' }, 400)
      if (!(body as any).project_id) return c.json({ error: 'project_id is required for ticket_create (the ticket\'s target project)' }, 400)
    }

    // Build source config
    const sourceConfig: Record<string, unknown> = data.source.type === 'cron'
      ? { cron_expr: data.source.cron_expr, timezone: data.source.timezone ?? 'UTC' }
      : { path: data.source.path, method: data.source.method ?? 'POST', secret: data.source.secret }

    // Build action config
    const actionConfig: Record<string, unknown> = {}
    if (actionType === 'prompt') {
      actionConfig.prompt = data.action.prompt
    } else if (actionType === 'command') {
      actionConfig.command = data.action.command
      if (data.action.args) actionConfig.args = data.action.args
      if (data.action.workdir) actionConfig.workdir = data.action.workdir
      if (data.action.env) actionConfig.env = data.action.env
      if (data.action.timeout_ms) actionConfig.timeout_ms = data.action.timeout_ms
    } else if (actionType === 'http') {
      actionConfig.url = data.action.url
      if (data.action.method) actionConfig.method = data.action.method
      if (data.action.headers) actionConfig.headers = data.action.headers
      if (data.action.body_template) actionConfig.body_template = data.action.body_template
      if (data.action.timeout_ms) actionConfig.timeout_ms = data.action.timeout_ms
    } else if (actionType === 'ticket_create') {
      actionConfig.title = data.action.title
      if (data.action.body_md) actionConfig.body_md = data.action.body_md
      if (data.action.template_id) actionConfig.template_id = data.action.template_id
      if (data.action.column) actionConfig.column = data.action.column
      if (data.action.assignee_slugs && data.action.assignee_slugs.length) {
        actionConfig.assignee_slugs = data.action.assignee_slugs
      }
    }

    const trigger = db.create({
      name: data.name,
      description: data.description,
      source_type: data.source.type,
      source_config: sourceConfig,
      action_type: actionType,
      action_config: actionConfig,
      context_config: data.context,
      agent_name: data.action.agent ?? data.agent_name ?? null,
      model_id: data.action.model ?? data.model_id ?? null,
      session_mode: data.action.session_mode ?? data.session_mode ?? 'new',
      metadata: data.metadata,
    })

    // carry_state: stamp on the DB row
    if (data.carry_state) {
      try {
        ;(db as any).db?.query?.('UPDATE triggers SET carry_state = 1 WHERE id = ?').run(trigger.id)
        ;(trigger as any).carry_state = 1
      } catch {}
    }

    // Stamp additive scoping columns the engine doesn't know about.
    const projectId = (body as any).project_id as string | undefined
    const ticketId = (body as any).ticket_id as string | undefined
    if (projectId) {
      try {
        ;(db as any).db?.query?.('UPDATE triggers SET project_id = ? WHERE id = ?').run(projectId, trigger.id)
        ;(trigger as any).project_id = projectId
      } catch {}
    }
    if (ticketId) {
      try {
        ;(db as any).db?.query?.('UPDATE triggers SET ticket_id = ? WHERE id = ?').run(ticketId, trigger.id)
        ;(trigger as any).ticket_id = ticketId
      } catch {}
    }

    // Write through to YAML + poke the plugin to re-register runtime
    ys.writeThrough()
    await pokeTriggerManagerReload()

    return c.json({ success: true, data: mapTriggerToResponse(trigger) }, 201)
  },
)

// GET /triggers/:id
triggersRouter.get('/:id',
  describeRoute({ tags: ['Triggers'], summary: 'Get trigger', responses: { 200: { description: 'Trigger detail' }, 404: { description: 'Not found' } } }),
  (c) => {
    const db = getStore()
    const trigger = db.get(c.req.param('id')) ?? db.getByName(c.req.param('id'))
    if (!trigger) return notFound(c, 'Trigger')
    return c.json({ success: true, data: mapTriggerToResponse(trigger) })
  },
)

// PATCH /triggers/:id
triggersRouter.patch('/:id',
  describeRoute({ tags: ['Triggers'], summary: 'Update trigger', responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } } }),
  async (c) => {
    const db = getStore()
    const ys = getYamlSync()
    const id = c.req.param('id')
    const body = await c.req.json()
    const current = db.get(id)
    if (!current) return notFound(c, 'Trigger')

    const patch: any = {}

    // Handle structured source/action updates
    if (body.source) {
      const currentSc = JSON.parse(current.source_config)
      patch.source_config = { ...currentSc, ...body.source }
    }
    if (body.action) {
      const currentAc = JSON.parse(current.action_config)
      patch.action_config = { ...currentAc, ...body.action }
      if (body.action.agent !== undefined) patch.agent_name = body.action.agent
      if (body.action.model !== undefined) patch.model_id = body.action.model
      if (body.action.session_mode !== undefined) patch.session_mode = body.action.session_mode
      if (body.action.type !== undefined) patch.action_type = body.action.type
    }
    if (body.context) patch.context_config = body.context

    // Handle flat field updates (legacy compat)
    if (body.name) patch.name = body.name
    if (body.description !== undefined) patch.description = body.description
    if (body.cron_expr) {
      const currentSc = JSON.parse(current.source_config)
      patch.source_config = { ...currentSc, cron_expr: body.cron_expr, ...(body.timezone ? { timezone: body.timezone } : {}) }
    }
    if (body.timezone && !body.cron_expr) {
      const currentSc = JSON.parse(current.source_config)
      patch.source_config = { ...currentSc, timezone: body.timezone }
    }
    if (body.prompt) {
      const currentAc = JSON.parse(current.action_config)
      patch.action_config = { ...currentAc, prompt: body.prompt }
    }
    if (body.agent_name !== undefined) patch.agent_name = body.agent_name
    if (body.model_id !== undefined) patch.model_id = body.model_id
    if (body.session_mode) patch.session_mode = body.session_mode
    if (body.is_active !== undefined) patch.is_active = body.is_active
    if (body.metadata) patch.metadata = body.metadata

    const trigger = db.update(id, patch)
    if (!trigger) return notFound(c, 'Trigger')

    // Write through to YAML (skip for runtime-only changes like is_active)
    const hasConfigChange = body.source || body.action || body.name || body.description !== undefined || body.cron_expr || body.prompt || body.context
    if (hasConfigChange) ys.writeThrough()
    await pokeTriggerManagerReload()

    return c.json({ success: true, data: mapTriggerToResponse(trigger) })
  },
)

// DELETE /triggers/:id
triggersRouter.delete('/:id',
  describeRoute({ tags: ['Triggers'], summary: 'Delete trigger', responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' } } }),
  async (c) => {
    const db = getStore()
    const ys = getYamlSync()
    const deleted = db.delete(c.req.param('id'))
    if (!deleted) return notFound(c, 'Trigger')
    ys.writeThrough()
    await pokeTriggerManagerReload()
    return c.json({ success: true, message: 'Trigger deleted' })
  },
)

// POST /triggers/:id/pause
triggersRouter.post('/:id/pause',
  describeRoute({ tags: ['Triggers'], summary: 'Pause trigger', responses: { 200: { description: 'Paused' }, 404: { description: 'Not found' } } }),
  async (c) => {
    const db = getStore()
    const trigger = db.update(c.req.param('id'), { is_active: false })
    if (!trigger) return notFound(c, 'Trigger')
    await pokeTriggerManagerReload()
    return c.json({ success: true, data: mapTriggerToResponse(trigger) })
  },
)

// POST /triggers/:id/resume
triggersRouter.post('/:id/resume',
  describeRoute({ tags: ['Triggers'], summary: 'Resume trigger', responses: { 200: { description: 'Resumed' }, 404: { description: 'Not found' } } }),
  async (c) => {
    const db = getStore()
    const trigger = db.update(c.req.param('id'), { is_active: true })
    if (!trigger) return notFound(c, 'Trigger')
    await pokeTriggerManagerReload()
    return c.json({ success: true, data: mapTriggerToResponse(trigger) })
  },
)

// POST /triggers/:id/run
triggersRouter.post('/:id/run',
  describeRoute({ tags: ['Triggers'], summary: 'Fire trigger manually', responses: { 200: { description: 'Fired' }, 404: { description: 'Not found' } } }),
  async (c) => {
    const db = getStore()
    const trigger = db.get(c.req.param('id'))
    if (!trigger) return notFound(c, 'Trigger')

    // Forward to the in-plugin manager so the action dispatcher actually
    // runs (creates a session via prompt/ticket_create action). The manager
    // owns execution-row creation, status transitions, and session linkage.
    const result = await pokeTriggerManagerRun(trigger.id)
    if (!result.ok) {
      return c.json({ success: false, error: result.error ?? 'dispatch_failed' }, 502)
    }

    return c.json({
      success: true,
      data: {
        execution_id: result.executionId,
        status: 'running',
        message: 'Trigger execution started',
      },
    })
  },
)

// GET /triggers/:id/executions
triggersRouter.get('/:id/executions',
  describeRoute({ tags: ['Triggers'], summary: 'Get trigger execution history', responses: { 200: { description: 'Executions' }, 404: { description: 'Not found' } } }),
  (c) => {
    const db = getStore()
    const trigger = db.get(c.req.param('id')) ?? db.getByName(c.req.param('id'))
    if (!trigger) return notFound(c, 'Trigger')
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200)
    const offset = parseInt(c.req.query('offset') || '0', 10)
    const result = db.listExecutions({ triggerId: trigger.id, limit, offset })
    return c.json({
      success: true,
      data: result.data.map(mapExecution),
      total: result.total,
      limit,
      offset,
    })
  },
)

// GET /triggers/executions — all executions
triggersRouter.get('/executions',
  describeRoute({ tags: ['Triggers'], summary: 'List all executions', responses: { 200: { description: 'All executions' } } }),
  (c) => {
    const db = getStore()
    const triggerId = c.req.query('trigger_id')
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200)
    const offset = parseInt(c.req.query('offset') || '0', 10)
    const result = db.listExecutions({ triggerId: triggerId ?? undefined, limit, offset })
    return c.json({ success: true, data: result.data.map(mapExecution), total: result.total, limit, offset })
  },
)

// POST /triggers/sync — Force re-read YAML
triggersRouter.post('/sync',
  describeRoute({ tags: ['Triggers'], summary: 'Force sync triggers.yaml to DB', responses: { 200: { description: 'Sync result' } } }),
  (c) => {
    const ys = getYamlSync()
    const result = ys.syncFromYaml()
    return c.json({ success: true, ...result })
  },
)

// ─── Legacy compat: /executions/by-trigger/:triggerId ───────────────────────
// The frontend currently calls this endpoint
triggersRouter.get('/executions/by-trigger/:triggerId',
  (c) => {
    const db = getStore()
    const trigger = db.get(c.req.param('triggerId')) ?? db.getByName(c.req.param('triggerId'))
    if (!trigger) return notFound(c, 'Trigger')
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200)
    const offset = parseInt(c.req.query('offset') || '0', 10)
    const result = db.listExecutions({ triggerId: trigger.id, limit, offset })
    return c.json({ success: true, data: result.data.map(mapExecution), total: result.total, limit, offset })
  },
)

export default triggersRouter
