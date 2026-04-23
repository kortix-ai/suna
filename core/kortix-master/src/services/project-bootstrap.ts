import { getDb } from './db'
import { WORKSPACE_ROOT, workspaceScopedProject } from './workspace'
import { ensureProjectWorkspace } from './project-access-client'

const DEFAULT_WORKSPACE_PROJECT_ID = 'proj-workspace'
const DEFAULT_WORKSPACE_PROJECT_NAME = 'Workspace'
const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000]

export async function ensureWorkspaceProject(): Promise<void> {
  const db = getDb()
  const existing = workspaceScopedProject()
  let projectId: string
  if (!existing) {
    projectId = DEFAULT_WORKSPACE_PROJECT_ID
    db.prepare(
      `INSERT OR IGNORE INTO projects
       (id, name, path, kind, description, created_at, opencode_id, maintainer_session_id)
       VALUES (?, ?, ?, 'workspace', '', ?, NULL, NULL)`,
    ).run(projectId, DEFAULT_WORKSPACE_PROJECT_NAME, WORKSPACE_ROOT, new Date().toISOString())
    console.log(`[project-bootstrap] created workspace project ${projectId}`)
  } else {
    projectId = existing.id
  }

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const result = await ensureProjectWorkspace({ projectId, kind: 'workspace', members: [] })
      console.log(
        `[project-bootstrap] workspace ready path=${result.path} group=${result.group}`,
      )
      return
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (attempt === RETRY_DELAYS_MS.length) {
        console.warn(`[project-bootstrap] giving up after ${attempt + 1} attempts: ${message}`)
        return
      }
      console.warn(
        `[project-bootstrap] supervisor unreachable (attempt ${attempt + 1}): ${message}; retrying`,
      )
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]))
    }
  }
}
