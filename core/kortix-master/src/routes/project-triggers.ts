/**
 * Project-scoped triggers — thin view on top of the global triggers engine.
 *
 * The engine (triggers/src) stays untouched. We add a nullable `project_id`
 * column on `triggers` so one workspace DB serves both workspace-global
 * triggers (project_id NULL) and per-project ones (project_id set). This
 * file mounts HTTP routes under `/kortix/projects/:id/triggers` that filter
 * by project_id on read and stamp it on write. All CRUD delegates to the
 * global `/kortix/triggers` endpoints to keep one write path + one YAML
 * reconciliation path.
 */

import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'fs'
import * as fs from 'node:fs/promises'
import { join } from 'path'
import * as yaml from 'js-yaml'
import { config } from '../config'

function getWorkspaceRoot(): string {
  return process.env.WORKSPACE_DIR || process.env.KORTIX_WORKSPACE || '/workspace'
}

function getDb(): Database {
  const dbPath = join(getWorkspaceRoot(), '.kortix', 'kortix.db')
  if (!existsSync(dbPath)) throw new Error('kortix.db not found')
  const db = new Database(dbPath)
  db.exec('PRAGMA busy_timeout=5000')
  // One-time additive migration — column is nullable, existing rows stay NULL
  // (workspace-global) until explicitly scoped. Engine ignores the column.
  try { db.exec(`ALTER TABLE triggers ADD COLUMN project_id TEXT`) } catch {}
  return db
}

interface ProjectRow { id: string; name: string; path: string }

function resolveProject(db: Database, idOrPath: string): ProjectRow | null {
  return db.prepare('SELECT id,name,path FROM projects WHERE id=$v OR path=$v').get({ $v: idOrPath }) as ProjectRow | null
}

const KORTIX_MASTER_URL = `http://${config.OPENCODE_HOST === '0.0.0.0' ? 'localhost' : config.OPENCODE_HOST}:${config.PORT}`

async function masterFetch(pathAndQuery: string, init?: RequestInit): Promise<Response> {
  return fetch(`${KORTIX_MASTER_URL}${pathAndQuery}`, init)
}

const router = new Hono()

// ── GET /kortix/projects/:id/triggers ─────────────────────────────────────────

router.get('/:id/triggers', (c) => {
  const db = getDb()
  const p = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!p) return c.json({ error: 'Project not found' }, 404)
  const rows = db.prepare(
    `SELECT id,name,description,source_type,source_config,action_type,action_config,
            agent_name,model_id,is_active,last_run_at,next_run_at,event_count,
            created_at,updated_at
       FROM triggers
      WHERE project_id=$pid
      ORDER BY created_at DESC`
  ).all({ $pid: p.id }) as Array<Record<string, unknown>>
  const shaped = rows.map((r) => ({
    ...r,
    source_config: JSON.parse((r.source_config as string) || '{}'),
    action_config: JSON.parse((r.action_config as string) || '{}'),
    is_active: !!r.is_active,
  }))
  return c.json({ project_id: p.id, triggers: shaped })
})

// ── POST /kortix/projects/:id/triggers ────────────────────────────────────────
// Creates a trigger and stamps project_id. Body mirrors the global POST shape.

router.post('/:id/triggers', async (c) => {
  const db = getDb()
  const p = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!p) return c.json({ error: 'Project not found' }, 404)
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return c.json({ error: 'body required' }, 400)

  // Delegate to the global POST /kortix/triggers
  const res = await masterFetch('/kortix/triggers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await res.json().catch(() => ({} as Record<string, unknown>))
  if (!res.ok) return c.json(payload, res.status as any)

  // Stamp project_id on the freshly-created row.
  const created = (payload as any)?.data ?? payload
  const triggerId = (created?.id || created?.triggerId) as string | undefined
  if (triggerId) {
    db.prepare('UPDATE triggers SET project_id=$pid WHERE id=$id').run({ $pid: p.id, $id: triggerId })
    // Write a convenience copy to <project>/.kortix/triggers.yaml so it's
    // discoverable in the project folder. Engine still reads the workspace
    // yaml; this file is a view/mirror.
    await writeProjectYaml(db, p).catch(() => {})
  }
  return c.json({ ...(payload as any), project_id: p.id }, res.status as any)
})

// ── Action endpoints — thin forwarders that verify project ownership ─────────

async function ensureBelongs(db: Database, pid: string, triggerId: string): Promise<boolean> {
  const row = db.prepare('SELECT 1 FROM triggers WHERE id=$tid AND project_id=$pid')
    .get({ $tid: triggerId, $pid: pid })
  return !!row
}

router.post('/:id/triggers/:tid/run', async (c) => {
  const db = getDb()
  const p = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!p) return c.json({ error: 'Project not found' }, 404)
  const tid = c.req.param('tid')
  if (!await ensureBelongs(db, p.id, tid)) return c.json({ error: 'Trigger not found in this project' }, 404)
  const res = await masterFetch(`/kortix/triggers/${tid}/run`, { method: 'POST' })
  return c.json(await res.json().catch(() => ({})), res.status as any)
})

router.post('/:id/triggers/:tid/pause', async (c) => {
  const db = getDb()
  const p = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!p) return c.json({ error: 'Project not found' }, 404)
  const tid = c.req.param('tid')
  if (!await ensureBelongs(db, p.id, tid)) return c.json({ error: 'Trigger not found in this project' }, 404)
  const res = await masterFetch(`/kortix/triggers/${tid}/pause`, { method: 'POST' })
  return c.json(await res.json().catch(() => ({})), res.status as any)
})

router.post('/:id/triggers/:tid/resume', async (c) => {
  const db = getDb()
  const p = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!p) return c.json({ error: 'Project not found' }, 404)
  const tid = c.req.param('tid')
  if (!await ensureBelongs(db, p.id, tid)) return c.json({ error: 'Trigger not found in this project' }, 404)
  const res = await masterFetch(`/kortix/triggers/${tid}/resume`, { method: 'POST' })
  return c.json(await res.json().catch(() => ({})), res.status as any)
})

router.delete('/:id/triggers/:tid', async (c) => {
  const db = getDb()
  const p = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!p) return c.json({ error: 'Project not found' }, 404)
  const tid = c.req.param('tid')
  if (!await ensureBelongs(db, p.id, tid)) return c.json({ error: 'Trigger not found in this project' }, 404)
  const res = await masterFetch(`/kortix/triggers/${tid}`, { method: 'DELETE' })
  await writeProjectYaml(db, p).catch(() => {})
  return c.json(await res.json().catch(() => ({})), res.status as any)
})

router.get('/:id/triggers/:tid/executions', async (c) => {
  const db = getDb()
  const p = resolveProject(db, decodeURIComponent(c.req.param('id')))
  if (!p) return c.json({ error: 'Project not found' }, 404)
  const tid = c.req.param('tid')
  if (!await ensureBelongs(db, p.id, tid)) return c.json({ error: 'Trigger not found in this project' }, 404)
  const limit = Number(c.req.query('limit') ?? 20)
  const rows = db.prepare(
    `SELECT id,status,session_id,http_status,duration_ms,error_message,started_at,completed_at
       FROM trigger_executions
      WHERE trigger_id=$tid
      ORDER BY started_at DESC
      LIMIT $limit`
  ).all({ $tid: tid, $limit: limit }) as any[]
  return c.json({ project_id: p.id, trigger_id: tid, executions: rows })
})

// ── Project-folder yaml mirror ────────────────────────────────────────────────
// Engine reads /workspace/.kortix/triggers.yaml (global). We mirror the
// project's triggers into <project>/.kortix/triggers.yaml for discoverability
// + hand-edit. The mirror is regenerated after every create/delete.

async function writeProjectYaml(db: Database, project: ProjectRow): Promise<void> {
  const rows = db.prepare(
    `SELECT name,description,source_type,source_config,action_type,action_config,
            agent_name,model_id,is_active
       FROM triggers
      WHERE project_id=$pid
      ORDER BY created_at ASC`
  ).all({ $pid: project.id }) as Array<Record<string, unknown>>

  const entries = rows.map((r) => {
    const src = JSON.parse((r.source_config as string) || '{}') as Record<string, unknown>
    const act = JSON.parse((r.action_config as string) || '{}') as Record<string, unknown>
    return {
      name: r.name,
      description: r.description ?? undefined,
      source: { type: r.source_type, ...src },
      action: {
        type: r.action_type,
        agent: r.agent_name ?? undefined,
        model: r.model_id ?? undefined,
        ...act,
      },
    }
  })

  const yamlBody = entries.length
    ? yaml.dump({ triggers: entries })
    : '# No project-scoped triggers yet.\ntriggers: []\n'
  const kortixDir = join(project.path, '.kortix')
  try { mkdirSync(kortixDir, { recursive: true }) } catch {}
  await fs.writeFile(
    join(kortixDir, 'triggers.yaml'),
    `# Triggers scoped to this project. Mirror of the DB rows for hand-edit / VCS.\n# Engine reads /workspace/.kortix/triggers.yaml (workspace view). Edits here\n# are not picked up automatically — use the Triggers tab to manage.\n${yamlBody}`,
    'utf8',
  )
}

export default router
