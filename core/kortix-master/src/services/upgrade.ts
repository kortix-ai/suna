import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { dirname, join } from 'path'
import { getDb, resolveDbPath } from './db'
import { ensureWorkspaceProject } from './project-bootstrap'
import { ensureProjectWorkspace } from './project-access-client'
import { WORKSPACE_ROOT } from './workspace'

const BACKUP_DIR = process.env.KORTIX_DB_BACKUP_DIR || '/workspace/.kortix/backups'
const BACKUP_KEEP = Number(process.env.KORTIX_DB_BACKUP_KEEP || 5)
const REGISTRY_PATH =
  process.env.KORTIX_SERVICE_REGISTRY || '/workspace/.kortix/services/registry.json'
const ISOLATION_ON = process.env.KORTIX_LINUX_ISOLATION === 'on'

interface ProjectRow {
  id: string
  path: string
  kind: 'scoped' | 'workspace'
}

export async function runUpgradeMigrations(): Promise<void> {
  console.log('[upgrade] starting migrations')

  backupKortixDb()

  try {
    await ensureWorkspaceProject()
  } catch (err) {
    console.warn(
      `[upgrade] workspace project ensure failed: ${err instanceof Error ? err.message : err}`,
    )
  }

  await migrateScopedProjects()

  console.log('[upgrade] migrations complete')
}

function backupKortixDb(): void {
  const dbPath = resolveDbPath()
  if (!existsSync(dbPath)) return
  try {
    mkdirSync(BACKUP_DIR, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = join(BACKUP_DIR, `kortix-${ts}.db`)
    copyFileSync(dbPath, dest)
    console.log(`[upgrade] backed up kortix.db -> ${dest}`)
    pruneBackups(BACKUP_DIR, 'kortix-', BACKUP_KEEP)
  } catch (err) {
    console.warn(
      `[upgrade] db backup failed: ${err instanceof Error ? err.message : err}`,
    )
  }
}

function pruneBackups(dir: string, prefix: string, keep: number): void {
  try {
    const entries = readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const entry of entries.slice(keep)) {
      unlinkSync(join(dir, entry.f))
    }
  } catch {}
}

function cleanStaleOpencodeServe(): void {
  if (!ISOLATION_ON) return
  if (!existsSync(REGISTRY_PATH)) return

  try {
    const raw = readFileSync(REGISTRY_PATH, 'utf-8')
    const data = JSON.parse(raw) as unknown
    let changed = false
    let payload: unknown = data

    const removeFromArray = (arr: any[]) => {
      const before = arr.length
      const filtered = arr.filter((s) => s?.id !== 'opencode-serve')
      changed = changed || filtered.length !== before
      return filtered
    }

    if (Array.isArray(data)) {
      payload = removeFromArray(data)
    } else if (data && typeof data === 'object' && Array.isArray((data as any).services)) {
      const services = removeFromArray((data as any).services)
      payload = { ...(data as any), services }
    }

    if (!changed) return

    const tmp = `${REGISTRY_PATH}.tmp-${process.pid}`
    mkdirSync(dirname(REGISTRY_PATH), { recursive: true })
    writeFileSync(tmp, JSON.stringify(payload, null, 2))
    renameSync(tmp, REGISTRY_PATH)
    console.log('[upgrade] removed stale opencode-serve from service registry')
  } catch (err) {
    console.warn(
      `[upgrade] registry cleanup failed: ${err instanceof Error ? err.message : err}`,
    )
  }
}

async function migrateScopedProjects(): Promise<void> {
  const db = getDb()
  const rows = db
    .prepare(`SELECT id, path, kind FROM projects WHERE kind = 'scoped'`)
    .all() as ProjectRow[]

  if (rows.length === 0) {
    console.log('[upgrade] no scoped projects to migrate')
    return
  }

  for (const project of rows) {
    if (!project.path || project.path === WORKSPACE_ROOT) continue
    try {
      const result = await ensureProjectWorkspace({
        projectId: project.id,
        kind: 'scoped',
        members: [],
        migrateFrom: project.path,
      })
      console.log(
        `[upgrade] scoped project ${project.id} ensured at ${result.path} (legacy=${project.path})`,
      )
    } catch (err) {
      console.warn(
        `[upgrade] scoped project ${project.id} ensure failed: ${err instanceof Error ? err.message : err}`,
      )
    }
  }
}
