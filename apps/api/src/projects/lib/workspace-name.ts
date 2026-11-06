/**
 * Workspace name = account name = project name (Workspaces, ux.md "Model the
 * UI shows"). A workspace is one account and its one active project, so a
 * rename of either row writes the other. An account with 0 or 2+ active
 * projects is not one workspace (legacy multi-project accounts are
 * grandfathered, D4): its names stay independent.
 */
import { and, eq } from 'drizzle-orm';

import { db } from '../../shared/db';
import { commitProjectName, MANIFEST_PROJECT_NAME_KEY } from './manifest-project-name';
import { accountsView, metadataMerge, projectsView, updateAccountRows, updateProjectRowsReturning } from '../../workspaces/rows';

type ProjectRow = typeof projectsView.$inferSelect;

/** The account's active projects, at most 2: enough to tell "exactly one". */
async function activeProjectsOf(accountId: string): Promise<ProjectRow[]> {
  return db
    .select()
    .from(projectsView)
    .where(and(eq(projectsView.accountId, accountId), eq(projectsView.status, 'active')))
    .limit(2);
}

/** The account's one active project, or null when it has 0 or 2+. */
export async function soleActiveProjectOf(accountId: string): Promise<ProjectRow | null> {
  const rows = await activeProjectsOf(accountId);
  return rows.length === 1 ? rows[0]! : null;
}

/**
 * After a project rename: rename its account too when the project is the
 * account's only active project. Idempotent, a no-op when the names match.
 */
export async function renameAccountOfSoleProject(project: Pick<ProjectRow, 'projectId' | 'accountId'>, name: string): Promise<void> {
  const sole = await soleActiveProjectOf(project.accountId);
  if (!sole || sole.projectId !== project.projectId) return;
  await updateAccountRows(eq(accountsView.accountId, project.accountId), { name, updatedAt: new Date() });
}

export type SoleProjectRenameResult =
  | { ok: true; project: ProjectRow | null }
  | { ok: false; error: string; code: string; status: 400 | 409 };

/**
 * Before an account rename: rename the account's only active project. The
 * project name lives in kortix.yaml (`commitProjectName`), so the commit runs
 * first; a refused commit refuses the whole rename, and the two names never
 * drift apart. `project: null` when the account is not one workspace.
 */
export async function renameSoleProjectOfAccount(accountId: string, name: string): Promise<SoleProjectRenameResult> {
  const sole = await soleActiveProjectOf(accountId);
  if (!sole) return { ok: true, project: null };
  if (sole.name === name) return { ok: true, project: sole };
  const declared = await commitProjectName(sole, name);
  if (!declared.ok) {
    return {
      ok: false,
      error: declared.error,
      code: declared.code ?? 'manifest_write_failed',
      status: declared.status === 400 ? 400 : 409,
    };
  }
  const [row] = await updateProjectRowsReturning(eq(projectsView.projectId, sole.projectId), { name, metadata: metadataMerge({ [MANIFEST_PROJECT_NAME_KEY]: name }), updatedAt: new Date() });
  return { ok: true, project: row ?? null };
}
