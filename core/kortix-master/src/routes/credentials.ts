/**
 * Project-scoped credentials API.
 *
 * Routes are mounted under /kortix/projects/:projectId/credentials. List
 * returns names + metadata only (no values). Reveal is its own endpoint so
 * a curious page-load doesn't spray plaintext across every card render.
 *
 * Actor attribution comes from X-Kortix-Actor-Type + X-Kortix-Actor-Id
 * headers — same pattern as milestones + tickets routes.
 */

import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { ensureTicketTables, type ActorType } from '../services/ticket-service'
import {
  deleteCredential,
  getCredentialRow,
  listCredentials,
  listCredentialEvents,
  readCredential,
  upsertCredential,
} from '../services/credential-service'

function getDb(): Database {
  const workspace = process.env.WORKSPACE_DIR || process.env.KORTIX_WORKSPACE || '/workspace'
  const dbPath = join(workspace, '.kortix', 'kortix.db')
  if (!existsSync(dbPath)) throw new Error('kortix.db not found')
  const db = new Database(dbPath)
  db.exec('PRAGMA busy_timeout=5000')
  ensureTicketTables(db)
  return db
}

interface ProjectRow { id: string; name: string; path: string }
function resolveProject(db: Database, id: string): ProjectRow | null {
  return (
    db.prepare('SELECT id,name,path FROM projects WHERE id=$v').get({ $v: id })
    || db.prepare('SELECT id,name,path FROM projects WHERE LOWER(name)=LOWER($v)').get({ $v: id })
  ) as ProjectRow | null
}

function actorFromHeaders(c: { req: { header: (k: string) => string | undefined } }): { type: ActorType; id: string | null } {
  const rawType = c.req.header('x-kortix-actor-type') ?? c.req.header('X-Kortix-Actor-Type')
  const rawId = c.req.header('x-kortix-actor-id') ?? c.req.header('X-Kortix-Actor-Id')
  const type: ActorType = rawType === 'agent' || rawType === 'system' ? rawType : 'user'
  return { type, id: rawId ? String(rawId) : null }
}

const router = new Hono()

// GET /kortix/projects/:projectId/credentials — list (no values)
router.get('/:projectId/credentials', (c) => {
  try {
    const db = getDb()
    const project = resolveProject(db, c.req.param('projectId'))
    if (!project) return c.json({ error: 'Project not found' }, 404)
    return c.json(listCredentials(db, project.id))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// POST /kortix/projects/:projectId/credentials — upsert {name, value, description?}
router.post('/:projectId/credentials', async (c) => {
  try {
    const db = getDb()
    const project = resolveProject(db, c.req.param('projectId'))
    if (!project) return c.json({ error: 'Project not found' }, 404)
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
    const actor = actorFromHeaders(c)

    const name = typeof body.name === 'string' ? body.name : ''
    const value = typeof body.value === 'string' ? body.value : ''
    if (!name.trim()) return c.json({ error: 'name is required' }, 400)
    if (!value) return c.json({ error: 'value is required' }, 400)

    const { row, created } = await upsertCredential(db, {
      project_id: project.id,
      name,
      value,
      description: typeof body.description === 'string' ? body.description : null,
      actor_type: actor.type,
      actor_id: actor.id,
    })
    const safe = {
      id: row.id,
      name: row.name,
      description: row.description,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_read_at: row.last_read_at,
    }
    return c.json(safe, created ? 201 : 200)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
})

// GET /kortix/projects/:projectId/credentials/:name — reveal decrypted value
router.get('/:projectId/credentials/:name', async (c) => {
  try {
    const db = getDb()
    const project = resolveProject(db, c.req.param('projectId'))
    if (!project) return c.json({ error: 'Project not found' }, 404)
    const name = c.req.param('name')
    const actor = actorFromHeaders(c)
    const result = await readCredential(db, {
      project_id: project.id,
      name,
      actor_type: actor.type,
      actor_id: actor.id,
    })
    if (!result) return c.json({ error: 'Credential not found' }, 404)
    return c.json({
      id: result.row.id,
      name: result.row.name,
      value: result.value,
      description: result.row.description,
      created_at: result.row.created_at,
      updated_at: result.row.updated_at,
      last_read_at: result.row.last_read_at,
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// DELETE /kortix/projects/:projectId/credentials/:name
router.delete('/:projectId/credentials/:name', (c) => {
  try {
    const db = getDb()
    const project = resolveProject(db, c.req.param('projectId'))
    if (!project) return c.json({ error: 'Project not found' }, 404)
    const name = c.req.param('name')
    const actor = actorFromHeaders(c)
    const deleted = deleteCredential(db, {
      project_id: project.id,
      name,
      actor_type: actor.type,
      actor_id: actor.id,
    })
    if (!deleted) return c.json({ error: 'Credential not found' }, 404)
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// GET /kortix/projects/:projectId/credentials/:name/events — per-credential audit
router.get('/:projectId/credentials/:name/events', (c) => {
  try {
    const db = getDb()
    const project = resolveProject(db, c.req.param('projectId'))
    if (!project) return c.json({ error: 'Project not found' }, 404)
    const name = c.req.param('name')
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100), 1), 500)
    return c.json(listCredentialEvents(db, project.id, { name, limit }))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// HEAD /kortix/projects/:projectId/credentials/:name — existence check without reveal
router.get('/:projectId/credentials/:name/exists', (c) => {
  try {
    const db = getDb()
    const project = resolveProject(db, c.req.param('projectId'))
    if (!project) return c.json({ error: 'Project not found' }, 404)
    const row = getCredentialRow(db, project.id, c.req.param('name'))
    return c.json({ exists: !!row })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

export default router
