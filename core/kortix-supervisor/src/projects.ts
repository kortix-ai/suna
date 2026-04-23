import { existsSync, mkdirSync, chmodSync, statSync } from 'fs'
import { execFileSync, execSync } from 'child_process'
import { sysbin } from './sysbin'
import type {
  ProjectDeleteSpec,
  ProjectEnsureSpec,
  ProjectGrantSpec,
  ProjectOpResponse,
  ProjectRevokeSpec,
} from './schema'

const PROJECT_ROOT = process.env.KORTIX_PROJECT_ROOT || '/srv/kortix/projects'
const ARCHIVE_ROOT =
  process.env.KORTIX_PROJECT_ARCHIVE_ROOT || '/srv/kortix/projects.archive'
const WORKSPACE_ROOT = process.env.KORTIX_WORKSPACE || '/workspace'
const PROJECT_MODE = 0o2770
const PROJECT_OWNER = process.env.KORTIX_PROJECT_OWNER || 'root'

export function projectGroupName(projectId: string): string {
  return `proj_${projectId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

export function projectWorkspacePath(projectId: string, kind: 'scoped' | 'workspace' = 'scoped'): string {
  if (kind === 'workspace') return WORKSPACE_ROOT
  return `${PROJECT_ROOT}/${projectId}`
}

export interface ProjectOps {
  respawnDaemon?: (username: string, supabaseUserId?: string) => Promise<void>
}

export class ProjectLifecycle {
  constructor(private ops: ProjectOps = {}) {}

  async ensure(spec: ProjectEnsureSpec): Promise<ProjectOpResponse> {
    const kind = spec.kind ?? 'scoped'
    const dir = projectWorkspacePath(spec.project_id, kind)
    const group = projectGroupName(spec.project_id)

    ensureGroup(group)
    ensureUserInGroup(PROJECT_OWNER, group)
    const gid = getGroupGid(group)

    if (kind === 'scoped') {
      ensureDir(PROJECT_ROOT, 0o755)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      if (spec.migrate_from && spec.migrate_from !== dir) {
        this.migrateContents(spec.migrate_from, dir)
      }
      chownRecursive(dir, PROJECT_OWNER, gid)
      chmodSync(dir, PROJECT_MODE)
      setgidRecursive(dir)
    } else {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      this.applyWorkspaceGroup(dir, gid)
    }

    for (const m of spec.members) {
      ensureUserInGroup(m.username, group)
    }

    return { path: dir, group }
  }

  async grant(spec: ProjectGrantSpec): Promise<ProjectOpResponse> {
    const group = projectGroupName(spec.project_id)
    ensureGroup(group)
    ensureUserInGroup(PROJECT_OWNER, group)
    ensureUserInGroup(spec.username, group)
    await this.ops.respawnDaemon?.(spec.username)
    return { path: projectWorkspacePath(spec.project_id), group }
  }

  async revoke(spec: ProjectRevokeSpec): Promise<ProjectOpResponse> {
    const group = projectGroupName(spec.project_id)
    if (groupExists(group)) {
      removeUserFromGroup(spec.username, group)
    }
    await this.ops.respawnDaemon?.(spec.username, spec.supabase_user_id)
    return { path: projectWorkspacePath(spec.project_id), group }
  }

  async delete(spec: ProjectDeleteSpec): Promise<ProjectOpResponse> {
    const group = projectGroupName(spec.project_id)
    const dir = projectWorkspacePath(spec.project_id)

    if (dir !== WORKSPACE_ROOT && existsSync(dir)) {
      const archiveDir = spec.archive_to || `${ARCHIVE_ROOT}/${spec.project_id}-${Date.now()}`
      ensureDir(ARCHIVE_ROOT, 0o700)
      try {
        execFileSync(sysbin('mv'), [dir, archiveDir], { stdio: 'ignore' })
      } catch (err) {
        throw new Error(
          `archive failed for ${dir} -> ${archiveDir}: ${err instanceof Error ? err.message : err}`,
        )
      }
    }

    if (groupExists(group)) {
      try {
        execFileSync(sysbin('groupdel'), [group], { stdio: 'ignore' })
      } catch (err) {
        console.warn(
          `[supervisor] groupdel ${group} failed: ${err instanceof Error ? err.message : err}`,
        )
      }
    }

    return { path: dir, group }
  }

  private applyWorkspaceGroup(dir: string, gid: number): void {
    try {
      execFileSync(sysbin('chgrp'), [String(gid), dir], { stdio: 'ignore' })
      execFileSync(sysbin('find'), [
        dir,
        '-mindepth', '1',
        '-not', '-path', `${dir}/.persistent-system*`,
        '-not', '-path', `${dir}/.secrets*`,
        '-exec', sysbin('chgrp'), String(gid), '{}', '+',
      ], { stdio: 'ignore' })
      chmodSync(dir, PROJECT_MODE)
      execFileSync(sysbin('find'), [
        dir,
        '-type', 'd',
        '-not', '-path', `${dir}/.persistent-system*`,
        '-not', '-path', `${dir}/.secrets*`,
        '-exec', sysbin('chmod'), 'g+s', '{}', '+',
      ], { stdio: 'ignore' })
    } catch (err) {
      console.warn(
        `[supervisor] workspace group apply failed: ${err instanceof Error ? err.message : err}`,
      )
    }
  }

  private migrateContents(from: string, to: string): void {
    if (!existsSync(from)) return
    if (!statSync(from).isDirectory()) return
    const dbPath = `${to}/.migrated-from`
    if (existsSync(dbPath)) return
    console.log(`[supervisor] project migrate ${from} -> ${to}`)
    try {
      execSync(`cp -a "${from}"/. "${to}"/`, { stdio: 'inherit' })
      execFileSync('sh', ['-c', `echo "${from}" > "${dbPath}"`], { stdio: 'ignore' })
    } catch (err) {
      throw new Error(
        `project migrate failed ${from} -> ${to}: ${err instanceof Error ? err.message : err}`,
      )
    }
  }
}

function ensureDir(dir: string, mode: number): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  try {
    chmodSync(dir, mode)
  } catch {}
}

function ensureGroup(name: string): void {
  if (groupExists(name)) return
  try {
    execFileSync(sysbin('groupadd'), [name], { stdio: 'ignore' })
  } catch (err) {
    if (!groupExists(name)) {
      throw new Error(
        `groupadd ${name} failed: ${err instanceof Error ? err.message : err}`,
      )
    }
  }
}

function groupExists(name: string): boolean {
  try {
    execFileSync(sysbin('getent'), ['group', name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function getGroupGid(name: string): number {
  const out = execFileSync(sysbin('getent'), ['group', name], { encoding: 'utf8' }).trim()
  const parts = out.split(':')
  const gid = Number(parts[2])
  if (!Number.isFinite(gid)) throw new Error(`invalid gid for group ${name}`)
  return gid
}

function ensureUserInGroup(username: string, group: string): void {
  if (userInGroup(username, group)) return
  try {
    execFileSync(sysbin('gpasswd'), ['-a', username, group], { stdio: 'ignore' })
  } catch (err) {
    console.warn(
      `[supervisor] gpasswd -a ${username} ${group} failed: ${err instanceof Error ? err.message : err}`,
    )
  }
}

function removeUserFromGroup(username: string, group: string): void {
  try {
    execFileSync(sysbin('gpasswd'), ['-d', username, group], { stdio: 'ignore' })
  } catch (err) {
    console.warn(
      `[supervisor] gpasswd -d ${username} ${group} failed: ${err instanceof Error ? err.message : err}`,
    )
  }
}

function userInGroup(username: string, group: string): boolean {
  try {
    const out = execFileSync(sysbin('id'), ['-Gn', username], { encoding: 'utf8' })
    return out.split(/\s+/).includes(group)
  } catch {
    return false
  }
}

function chownGroupRecursive(dir: string, gid: number): void {
  try {
    execFileSync(sysbin('chgrp'), ['-R', String(gid), dir], { stdio: 'ignore' })
  } catch (err) {
    console.warn(
      `[supervisor] chgrp -R ${gid} ${dir} failed: ${err instanceof Error ? err.message : err}`,
    )
  }
}

function chownRecursive(dir: string, user: string, gid: number): void {
  try {
    execFileSync(sysbin('chown'), ['-R', `${user}:${gid}`, dir], { stdio: 'ignore' })
  } catch (err) {
    console.warn(
      `[supervisor] chown -R ${user}:${gid} ${dir} failed: ${err instanceof Error ? err.message : err}`,
    )
  }
}

function setgidRecursive(dir: string): void {
  try {
    execFileSync(sysbin('find'), [dir, '-type', 'd', '-exec', sysbin('chmod'), 'g+s', '{}', '+'], {
      stdio: 'ignore',
    })
  } catch (err) {
    console.warn(
      `[supervisor] setgid on ${dir} failed: ${err instanceof Error ? err.message : err}`,
    )
  }
}
