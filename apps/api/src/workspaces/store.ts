/**
 * The workspace store: the ONE repository that writes a workspace.
 *
 * A workspace has two base rows, `kortix.projects` (the public id, the name,
 * the repository) and `kortix.accounts` (the settings: MFA, session and PAT
 * policy, branding, automations). `kortix.workspaces` is a read-only view over
 * both. `updateWorkspace` splits one patch across the two rows in ONE
 * transaction, so a reader never sees half a change.
 *
 * Name: `projects.name` is the workspace name. A 1:1 workspace also writes
 * `accounts.name` (the `projects_name_sync` trigger would mirror it too; the
 * explicit write keeps the store correct without the trigger). A
 * `split_pending` workspace shares its account with other projects, so its
 * rename leaves `accounts.name` alone. The name also lives in `kortix.yaml`:
 * a rename from a user request commits the manifest first
 * (`commitProjectName`, `projects/lib/workspace-name.ts`) and then calls this.
 *
 * Account settings of a `split_pending` workspace are its legacy account's
 * settings and apply to every project of that account, as they did before.
 */
import { accounts, projects, workspaces, type AccountBrandingRecord } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { db } from '../shared/db';
import { asWorkspaceId, isUuid, type WorkspaceId } from './ids';

/** One row of `kortix.workspaces`. */
export type WorkspaceRecord = typeof workspaces.$inferSelect;

type ProjectSecretStrategy = (typeof projects.$inferInsert)['secretDefaultStrategy'];

/** The fields `updateWorkspace` writes. Omitted = unchanged; `null` clears a nullable setting. */
export interface WorkspacePatch {
  // projects
  name?: string;
  secretDefaultStrategy?: NonNullable<ProjectSecretStrategy>;
  // accounts
  mfaRequired?: boolean;
  sessionMaxLifetimeMinutes?: number | null;
  sessionIdleTimeoutMinutes?: number | null;
  patMaxLifetimeDays?: number | null;
  patRequireExpiry?: boolean;
  patIdleRevokeDays?: number | null;
  adminsSeeAllSessions?: boolean;
  branding?: AccountBrandingRecord;
}

const ACCOUNT_FIELDS = [
  'mfaRequired',
  'sessionMaxLifetimeMinutes',
  'sessionIdleTimeoutMinutes',
  'patMaxLifetimeDays',
  'patRequireExpiry',
  'patIdleRevokeDays',
  'adminsSeeAllSessions',
  'branding',
] as const satisfies readonly (keyof WorkspacePatch)[];

/** The two row patches one `WorkspacePatch` becomes. Pure: exported for tests. */
export function splitWorkspacePatch(
  patch: WorkspacePatch,
  splitPending: boolean,
): { project: Partial<typeof projects.$inferInsert>; account: Partial<typeof accounts.$inferInsert> } {
  const project: Partial<typeof projects.$inferInsert> = {};
  const account: Partial<typeof accounts.$inferInsert> = {};
  if (patch.name !== undefined) {
    project.name = patch.name;
    if (!splitPending) account.name = patch.name;
  }
  if (patch.secretDefaultStrategy !== undefined) project.secretDefaultStrategy = patch.secretDefaultStrategy;
  for (const field of ACCOUNT_FIELDS) {
    if (patch[field] !== undefined) (account as Record<string, unknown>)[field] = patch[field];
  }
  return { project, account };
}

/** The workspace, or `null` when `workspaceId` is not an active project. */
export async function getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null> {
  if (!isUuid(workspaceId)) return null;
  const [row] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.workspaceId, workspaceId.toLowerCase()))
    .limit(1);
  return row ?? null;
}

/**
 * Apply `patch` to both base rows in one transaction and return the new view
 * row. `null` when the workspace does not exist (or is archived). The project
 * row is locked first, then the account row: the same order as every other
 * writer of both (`projects/lib/workspace-name.ts`), so two writers never
 * deadlock.
 */
export async function updateWorkspace(workspaceId: WorkspaceId, patch: WorkspacePatch): Promise<WorkspaceRecord | null> {
  const id = asWorkspaceId(workspaceId);
  const updated = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ accountId: projects.accountId, status: projects.status, splitPending: projects.splitPending })
      .from(projects)
      .where(eq(projects.projectId, id))
      .for('update')
      .limit(1);
    if (!current || current.status !== 'active') return false;

    const { project, account } = splitWorkspacePatch(patch, current.splitPending);
    const now = new Date();
    if (Object.keys(project).length > 0) {
      await tx.update(projects).set({ ...project, updatedAt: now }).where(eq(projects.projectId, id));
    }
    if (Object.keys(account).length > 0) {
      await tx.update(accounts).set({ ...account, updatedAt: now }).where(eq(accounts.accountId, current.accountId));
    }
    return true;
  });
  return updated ? getWorkspace(id) : null;
}
