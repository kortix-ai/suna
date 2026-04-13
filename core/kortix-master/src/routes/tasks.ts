/**
 * Kortix Tasks API — task-centric project execution.
 *
 * Statuses: todo, in_progress, input_needed, awaiting_review, completed, cancelled
 *
 * State machine:
 *   todo → [POST /start] → in_progress → input_needed/awaiting_review
 *   awaiting_review → [POST /approve, human review only] → completed
 *   cancelled is always reachable; can reopen to todo
 *
 * POST /:id/start creates a real worker session via OpenCode and binds it to the task.
 * POST /:id/approve moves awaiting_review → completed (human decision only).
 */

import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { config } from '../config'
import { createOpencodeClient } from '@opencode-ai/sdk/client'
import {
  approveTask,
  createTask,
  deleteTask,
  ensureTasksTable,
  getTaskById,
  getTaskResolved,
  getTaskLiveStatus,
  listTasksResolved,
  listTaskEvents,
  patchTask,
  startTask,
  type OpenCodeClientLike,
  type TaskRow,
} from '../services/task-service'

const tasksRouter = new Hono()

// ---------------------------------------------------------------------------
// DB + types
// ---------------------------------------------------------------------------

function getDb(): Database {
  const workspace = process.env.WORKSPACE_DIR || process.env.KORTIX_WORKSPACE || '/workspace'
  const dbPath = join(workspace, '.kortix', 'kortix.db')
  if (!existsSync(dbPath)) throw new Error('kortix.db not found')
  const db = new Database(dbPath)
  db.exec('PRAGMA busy_timeout=5000')
  return db
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _ocClient: ReturnType<typeof createOpencodeClient> | null = null
function getOpenCodeClient() {
  if (!_ocClient) {
    _ocClient = createOpencodeClient({
      baseUrl: `http://${config.OPENCODE_HOST}:${config.OPENCODE_PORT}`,
    })
  }
  return _ocClient
}

// ---------------------------------------------------------------------------
// GET /kortix/tasks?project_id=xxx&status=yyy
// ---------------------------------------------------------------------------
tasksRouter.get('/', async (c) => {
  try {
    const db = getDb()
    ensureTasksTable(db)
    const tasks = await listTasksResolved(db, getOpenCodeClient() as OpenCodeClientLike, {
      projectId: c.req.query('project_id') || undefined,
      status: c.req.query('status') || undefined,
    })
    return c.json(tasks)
  } catch {
    return c.json([])
  }
})

// ---------------------------------------------------------------------------
// GET /kortix/tasks/:id
// ---------------------------------------------------------------------------
tasksRouter.get('/:id', async (c) => {
  try {
    const db = getDb()
    ensureTasksTable(db)
    const task = await getTaskResolved(db, getOpenCodeClient() as OpenCodeClientLike, c.req.param('id'))
    if (!task) return c.json({ error: 'Not found' }, 404)
    return c.json(task)
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

// ---------------------------------------------------------------------------
// GET /kortix/tasks/:id/status
// ---------------------------------------------------------------------------
tasksRouter.get('/:id/status', async (c) => {
  try {
    const db = getDb()
    ensureTasksTable(db)
    const task = getTaskById(db, c.req.param('id'))
    if (!task) return c.json({ error: 'Not found' }, 404)
    return c.json(await getTaskLiveStatus(db, getOpenCodeClient() as OpenCodeClientLike, task.id))
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

// ---------------------------------------------------------------------------
// GET /kortix/tasks/:id/events
// ---------------------------------------------------------------------------
tasksRouter.get('/:id/events', async (c) => {
  try {
    const db = getDb()
    ensureTasksTable(db)
    const task = getTaskById(db, c.req.param('id'))
    if (!task) return c.json({ error: 'Not found' }, 404)
    return c.json(listTaskEvents(db, task.id))
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /kortix/tasks  — create a new task
// ---------------------------------------------------------------------------
tasksRouter.post('/', async (c) => {
  try {
    const db = getDb()
    const body = await c.req.json<Partial<TaskRow>>()
    if (!body.project_id || !body.title) {
      return c.json({ error: 'project_id and title required' }, 400)
    }
    return c.json(createTask(db, {
      project_id: body.project_id,
      title: body.title,
      description: body.description,
      verification_condition: body.verification_condition,
      status: body.status,
    }))
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /kortix/tasks/:id/start — start execution (creates worker session)
// ---------------------------------------------------------------------------
tasksRouter.post('/:id/start', async (c) => {
  try {
    const db = getDb()
    const body = await c.req.json<{ session_id?: string }>().catch(() => ({} as { session_id?: string }))
    const existing = getTaskById(db, c.req.param('id'))
    if (!existing) return c.json({ error: 'Not found' }, 404)
    return c.json(await startTask({
      db,
      client: getOpenCodeClient() as OpenCodeClientLike,
      taskId: c.req.param('id'),
      parentSessionId: body.session_id || null,
      workerAgent: 'worker',
    }))
  } catch (e) {
    return c.json({ error: String(e) }, 400)
  }
})

// ---------------------------------------------------------------------------
// POST /kortix/tasks/:id/approve  — HUMAN review approval → completed
// ---------------------------------------------------------------------------
tasksRouter.post('/:id/approve', async (c) => {
  try {
    return c.json(approveTask(getDb(), c.req.param('id')))
  } catch (e) {
    return c.json({ error: String(e) }, 400)
  }
})

// ---------------------------------------------------------------------------
// PATCH /kortix/tasks/:id
// ---------------------------------------------------------------------------
tasksRouter.patch('/:id', async (c) => {
  try {
    const db = getDb()
    const body = await c.req.json<Partial<TaskRow>>()
    return c.json(patchTask(db, c.req.param('id'), body))
  } catch (e) {
    return c.json({ error: String(e) }, 400)
  }
})

// ---------------------------------------------------------------------------
// DELETE /kortix/tasks/:id
// ---------------------------------------------------------------------------
tasksRouter.delete('/:id', (c) => {
  try {
    const db = getDb()
    const id = c.req.param('id')
    const task = getTaskById(db, id)
    if (!task) return c.json({ error: 'Not found' }, 404)
    deleteTask(db, id)
    return c.json({ deleted: true })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

export { tasksRouter }
