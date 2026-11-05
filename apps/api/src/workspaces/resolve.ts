/**
 * `resolveWorkspace(idOrAccountId)`: one id in, the workspace's two keys out.
 *
 * Callers hold either key: a `/v1/projects/:projectId` route the public
 * workspace id, a `/v1/accounts/:accountId` route or a credential the account
 * key. Both keys are unique uuids, so either one names at most one workspace,
 * with one exception: a legacy account with 2+ active projects that the split
 * has not reached yet (`split_pending`). Its account key names several
 * projects, so resolving it throws `WorkspaceAmbiguousError`
 * (`workspace_ambiguous`). Its project ids still resolve.
 *
 * Reads `kortix.workspaces` (the view: active projects joined to their
 * accounts). An archived project, an unknown id and an account with 0 active
 * projects (a dormant account) all resolve to `null`.
 */
import { workspaces } from '@kortix/db';
import { eq, or } from 'drizzle-orm';

import { db } from '../shared/db';
import {
  asWorkspaceAccountKey,
  asWorkspaceId,
  isUuid,
  type WorkspaceAccountKey,
  type WorkspaceId,
} from './ids';

export interface ResolvedWorkspace {
  /** The public id (`project_id`). */
  workspaceId: WorkspaceId;
  /** The internal billing and directory key (`account_id`). */
  accountId: WorkspaceAccountKey;
  /** True for a project of a legacy multi-project account that is not split yet. */
  splitPending: boolean;
}

export const WORKSPACE_AMBIGUOUS_CODE = 'workspace_ambiguous';

/** An account key that names 2+ active projects (a `split_pending` legacy account). */
export class WorkspaceAmbiguousError extends Error {
  readonly code = WORKSPACE_AMBIGUOUS_CODE;
  constructor(
    readonly accountId: WorkspaceAccountKey,
    readonly workspaceIds: readonly WorkspaceId[],
  ) {
    super(
      `Account ${accountId} holds ${workspaceIds.length} active projects and is not one workspace yet. Name the workspace by its project id.`,
    );
    this.name = 'WorkspaceAmbiguousError';
  }
}

/** One candidate row: an active project whose project id OR account id matched. */
export interface WorkspaceCandidate {
  workspaceId: string;
  accountId: string;
  splitPending: boolean;
}

/**
 * The pure decision behind `resolveWorkspace`, given every active project whose
 * `project_id` or `account_id` equals `id`. A project-id match wins: a
 * workspace id is never also read as an account key.
 */
export function pickWorkspace(id: string, candidates: readonly WorkspaceCandidate[]): ResolvedWorkspace | null {
  const key = id.toLowerCase();
  const toResolved = (row: WorkspaceCandidate): ResolvedWorkspace => ({
    workspaceId: asWorkspaceId(row.workspaceId),
    accountId: asWorkspaceAccountKey(row.accountId),
    splitPending: row.splitPending,
  });

  const byProject = candidates.find((row) => row.workspaceId.toLowerCase() === key);
  if (byProject) return toResolved(byProject);

  const byAccount = candidates.filter((row) => row.accountId.toLowerCase() === key);
  if (byAccount.length === 0) return null;
  if (byAccount.length === 1) return toResolved(byAccount[0]!);
  throw new WorkspaceAmbiguousError(
    asWorkspaceAccountKey(key),
    byAccount.map((row) => asWorkspaceId(row.workspaceId)),
  );
}

/**
 * Resolve a workspace id (`project_id`) or a workspace account key
 * (`account_id`). `null` when nothing active matches or `idOrAccountId` is not a
 * uuid (no query runs). Throws `WorkspaceAmbiguousError` for the account key of
 * a legacy multi-project account.
 */
export async function resolveWorkspace(idOrAccountId: string): Promise<ResolvedWorkspace | null> {
  if (!isUuid(idOrAccountId)) return null;
  const id = idOrAccountId.toLowerCase();
  const rows = await db
    .select({
      workspaceId: workspaces.workspaceId,
      accountId: workspaces.accountId,
      splitPending: workspaces.splitPending,
    })
    .from(workspaces)
    .where(or(eq(workspaces.workspaceId, id), eq(workspaces.accountId, id)))
    // A legacy account holds at most a few dozen projects (prod max 23); the
    // bound keeps a pathological account from loading every row.
    .limit(100);
  return pickWorkspace(id, rows);
}
