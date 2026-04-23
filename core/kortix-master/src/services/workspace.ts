import type { MemberContext } from './member-context'
import { getDb } from './db'

export const PROJECT_ROOT = '/srv/kortix/projects'
export const MEMBER_HOME_ROOT = '/srv/kortix/home'
export const WORKSPACE_ROOT = process.env.KORTIX_WORKSPACE || '/workspace'

export type ProjectKind = 'scoped' | 'workspace'

export interface ProjectRow {
  id: string
  name: string
  path: string
  kind: ProjectKind
}

export function projectWorkspacePath(project: ProjectRow): string {
  if (project.kind === 'workspace') return WORKSPACE_ROOT
  return `${PROJECT_ROOT}/${project.id}`
}

export function personalWorkspacePath(member: MemberContext): string {
  return `${member.homeDir}/workspace`
}

export function projectGroupName(projectId: string): string {
  return `proj_${projectId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

function listProjectRows(): ProjectRow[] {
  const db = getDb()
  return db
    .prepare('SELECT id, name, path, kind FROM projects')
    .all() as ProjectRow[]
}

function listGrantedProjectRows(userId: string): ProjectRow[] {
  const db = getDb()
  return db
    .prepare(
      `SELECT p.id, p.name, p.path, p.kind
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       WHERE pm.user_id = ?`,
    )
    .all(userId) as ProjectRow[]
}

export function isManager(member: MemberContext): boolean {
  return (
    member.role === 'owner' ||
    member.role === 'admin' ||
    member.role === 'platform_admin'
  )
}

export function grantedProjectsFor(member: MemberContext): ProjectRow[] {
  return isManager(member)
    ? listProjectRows()
    : listGrantedProjectRows(member.supabaseUserId)
}

export function workspaceFor(
  member: MemberContext,
  sessionProjectId: string | null,
): string {
  if (sessionProjectId) {
    const db = getDb()
    const row = db
      .prepare('SELECT id, name, path, kind FROM projects WHERE id = ?')
      .get(sessionProjectId) as ProjectRow | null
    if (row) return projectWorkspacePath(row)
  }
  return personalWorkspacePath(member)
}

export function allowedWorkspacesFor(member: MemberContext): string[] {
  const projects = grantedProjectsFor(member)
  return dedupe([
    personalWorkspacePath(member),
    ...projects.map((p) => projectWorkspacePath(p)),
  ])
}

function dedupe(paths: string[]): string[] {
  return Array.from(new Set(paths.filter((p) => typeof p === 'string' && p.length > 0)))
}

export type WorkspaceKind = 'personal' | 'project' | 'legacy'

export interface WorkspaceEntry {
  id: string
  kind: WorkspaceKind
  label: string
  path: string
  project_id?: string
}

export function workspaceListFor(member: MemberContext): WorkspaceEntry[] {
  const entries: WorkspaceEntry[] = [
    {
      id: 'personal',
      kind: 'personal',
      label: 'My Workspace',
      path: personalWorkspacePath(member),
    },
  ]
  for (const p of grantedProjectsFor(member)) {
    entries.push({
      id: `project:${p.id}`,
      kind: 'project',
      label: p.name,
      path: projectWorkspacePath(p),
      project_id: p.id,
    })
  }
  return entries
}

export function workspaceScopedProject(): ProjectRow | null {
  const db = getDb()
  return (
    db
      .prepare(`SELECT id, name, path, kind FROM projects WHERE kind='workspace' LIMIT 1`)
      .get() as ProjectRow | null
  )
}
