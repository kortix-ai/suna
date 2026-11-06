/**
 * Two resolvers, one id in, the workspace's keys out (design.md §3.2 C2, C5).
 *
 * `resolveWorkspace(idOrLegacyAccountId)` is for the LEGACY routes
 * (`/v1/accounts/:accountId`, `/v1/projects/:projectId`, credentials that carry
 * an account key). It accepts a workspace id or a legacy account key and
 * keeps the old answer exactly: it resolves only a workspace whose project row
 * is active (the old `kortix.workspaces` view). An archived project, an
 * unknown id and an account with no active project resolve to `null`. The
 * account key of a legacy multi-project account (`split_pending`) names
 * several workspaces and throws `WorkspaceAmbiguousError`
 * (`workspace_ambiguous`); its project ids still resolve.
 *
 * `resolveCanonicalWorkspace(workspaceId)` is for `/v1/workspaces/**`. It
 * accepts a workspace id only and resolves every live workspace: `active`,
 * `dormant` (project-less, `workspace_id = account_id`) and `closing`. A
 * legacy account key that is not its workspace's id, a tombstone and an
 * unknown id are `null`. Whether a live workspace is served is the caller's
 * call (`workspaceState`, C1).
 *
 * Both read `kortix.workspaces_expected` (primary) and compare the table
 * (shadow), through the store.
 */
import { sql } from 'drizzle-orm';

import {
  asWorkspaceAccountKey,
  asWorkspaceId,
  isUuid,
  type WorkspaceAccountKey,
  type WorkspaceId,
} from './ids';
import { getWorkspace, liveRecordsOf, type WorkspaceLifecycle, type WorkspaceRecord } from './store';

export interface ResolvedWorkspace {
  /** The public id. */
  workspaceId: WorkspaceId;
  /** The internal billing and directory key (`legacy_account_id`). */
  accountId: WorkspaceAccountKey;
  /** True for a project of a legacy multi-project account that is not split yet. */
  splitPending: boolean;
  /** The live row's lifecycle. Optional so existing literals and test doubles still type-check. */
  lifecycle?: Exclude<WorkspaceLifecycle, 'tombstone'>;
  /** = workspaceId when the workspace has its project row, null before Set up. Optional, as `lifecycle`. */
  projectId?: WorkspaceId | null;
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

/** One candidate row of `pickWorkspace`: a live workspace whose id OR account key matched. */
export interface WorkspaceResolveCandidate {
  workspaceId: string;
  accountId: string;
  splitPending: boolean;
  lifecycle?: Exclude<WorkspaceLifecycle, 'tombstone'>;
  projectId?: string | null;
}

/**
 * The pure decision behind `resolveWorkspace`, given every active project whose
 * `project_id` or `account_id` equals `id`. A project-id match wins: a
 * workspace id is never also read as an account key.
 */
export function pickWorkspace(id: string, candidates: readonly WorkspaceResolveCandidate[]): ResolvedWorkspace | null {
  const key = id.toLowerCase();
  const toResolved = (row: WorkspaceResolveCandidate): ResolvedWorkspace => ({
    workspaceId: asWorkspaceId(row.workspaceId),
    accountId: asWorkspaceAccountKey(row.accountId),
    splitPending: row.splitPending,
    ...(row.lifecycle ? { lifecycle: row.lifecycle } : {}),
    ...(row.projectId !== undefined ? { projectId: row.projectId ? asWorkspaceId(row.projectId) : null } : {}),
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

const candidateOf = (record: WorkspaceRecord): WorkspaceResolveCandidate => ({
  workspaceId: record.workspaceId,
  accountId: record.accountId,
  splitPending: record.splitPending,
  lifecycle: record.lifecycle,
  projectId: record.projectId,
});

/** The accounts an id can name: the account of a project row with that id, or the account with that id. */
const accountsNamedBy = (id: string) => sql`
  SELECT p.account_id AS id FROM kortix.projects p WHERE p.project_id = ${id}::uuid
  UNION
  SELECT a.account_id FROM kortix.accounts a WHERE a.account_id = ${id}::uuid`;

/**
 * Legacy routes: resolve a workspace id or a legacy account key to a
 * workspace whose project row is active. `null` when nothing matches or the id
 * is not a uuid (no query runs). Throws `WorkspaceAmbiguousError` for the
 * account key of a `split_pending` account.
 */
export async function resolveWorkspace(idOrLegacyAccountId: string): Promise<ResolvedWorkspace | null> {
  if (!isUuid(idOrLegacyAccountId)) return null;
  const id = idOrLegacyAccountId.toLowerCase();
  const records = await liveRecordsOf(accountsNamedBy(id));
  return pickWorkspace(
    id,
    records.filter((record) => record.projectStatus === 'active').map(candidateOf),
  );
}

/**
 * Canonical routes: resolve a workspace id (never a legacy account key that
 * is not the workspace's own id) to its live row: active, dormant or closing.
 * `null` for an account key of a workspace that has a project row, a
 * tombstone, an unknown id and a non-uuid.
 */
export async function resolveCanonicalWorkspace(workspaceId: string): Promise<ResolvedWorkspace | null> {
  if (!isUuid(workspaceId)) return null;
  const record = await getWorkspace(workspaceId);
  if (!record) return null;
  return pickWorkspace(record.workspaceId, [candidateOf(record)]);
}
