/**
 * The workspace lifecycle (design.md §3.1 K2, §3.2 C1, C2, C5): the workspace
 * lifecycle IS the account lifecycle.
 *
 *   closeWorkspace    DELETE /v1/workspaces/:id (and DELETE /v1/projects/:id).
 *                     ONE transaction: an account_deletion_requests row with
 *                     the 14-day grace, the project row archived, every
 *                     credential of the account revoked, automations paused.
 *                     After commit: channels and app-event subscriptions
 *                     released, the subscription set to cancel at period
 *                     end, the IAM cache busted. The workspace is `closing`:
 *                     members lose it at once, owners see it as `deleting`
 *                     and can restore it. The account-deletion sweep erases it
 *                     at `deletion_scheduled_for` (repo, connectors,
 *                     sandboxes, Stripe, wallet, rows). A `split_pending`
 *                     workspace keeps the old behavior: its project row is
 *                     archived and nothing else changes.
 *   restoreWorkspace  POST /v1/workspaces/:id/restore, owners, during the
 *                     grace: the project row un-archived, the request
 *                     cancelled, automations resumed when the close paused
 *                     them, the subscription reactivated when the close
 *                     cancelled it. Revoked credentials stay revoked.
 *   prepareWorkspaceSetup  POST /v1/workspaces/:id/setup: a project-less
 *                     workspace that pays (`setup_required`) gets its project
 *                     row with project_id = workspace_id.
 *
 * Row order in every transaction: the project row first, then the account
 * (the deletion request's reconcile locks the account row). The deletion
 * request is opened BEFORE the archive and cancelled AFTER the un-archive, so
 * the workspace keeps its id through the whole close and restore (the live-row
 * rule, C1); its expand rows are never re-stamped.
 */
import { accountDeletionRequests, accountTokens, accounts, projects } from '@kortix/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { logger } from '../lib/logger';
import { db, withDbTransaction } from '../shared/db';
import { isUniqueViolation } from '../shared/postgres-errors';
import { cancelDeletionRequest } from '../billing/repositories/account-deletion';
import { asWorkspaceId, type WorkspaceAccountKey, type WorkspaceId } from './ids';
import { accountIsPaying, getWorkspace, type WorkspaceRecord } from './store';

/** Days a closed workspace can be restored (the account-deletion grace, D6b). */
export const WORKSPACE_DELETION_GRACE_DAYS = 14;

/** `account_deletion_requests.reason` of a close; the second marks a subscription the close set to cancel. */
export const WORKSPACE_CLOSE_REASON = 'workspace_deleted';
export const WORKSPACE_CLOSE_REASON_SUBSCRIPTION = 'workspace_deleted:subscription_cancelled';

export type WorkspaceLifecycleErrorCode =
  | 'workspace_not_found'
  | 'workspace_not_deleting'
  | 'workspace_deletion_in_progress'
  | 'workspace_setup_not_required'
  | 'workspace_has_project';

/** A lifecycle refusal. Routes answer `status` with `{ error, code, workspace_id }`. */
export class WorkspaceLifecycleError extends Error {
  constructor(
    readonly code: WorkspaceLifecycleErrorCode,
    readonly status: 404 | 409,
    message: string,
    readonly workspaceId: string,
  ) {
    super(message);
    this.name = 'WorkspaceLifecycleError';
  }
}

const notFound = (id: string) =>
  new WorkspaceLifecycleError('workspace_not_found', 404, 'Workspace not found', id);

export type CloseWorkspaceResult = { mode: 'closed'; deletionScheduledFor: Date } | { mode: 'archived_project' };

async function openDeletionRequest(accountId: string) {
  const [row] = await db
    .select()
    .from(accountDeletionRequests)
    .where(
      and(
        eq(accountDeletionRequests.accountId, accountId),
        inArray(accountDeletionRequests.status, ['pending', 'processing']),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Lock the project row first: every writer locks a project row before its account row. */
async function lockProjectRow(projectId: string): Promise<void> {
  await db.execute(sql`SELECT 1 FROM kortix.projects WHERE project_id = ${projectId}::uuid FOR UPDATE`);
}

/** The steps after the close transaction committed. Each failure is logged; none undoes the close. */
async function afterClose(record: WorkspaceRecord, requestId: string): Promise<void> {
  const projectId = record.projectId;
  if (projectId) {
    try {
      // The channels would keep delivering to a closed workspace; the app-event
      // provider instances would keep firing.
      const { releaseProjectChannels } = await import('../channels/install-store');
      await releaseProjectChannels(projectId);
      const { releaseProjectEventSubscriptions } = await import('../projects/surface');
      await releaseProjectEventSubscriptions(projectId);
    } catch (error) {
      logger.error('[workspaces] close: release of channels or event subscriptions failed', {
        workspace_id: record.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  try {
    const { getCreditAccount } = await import('../billing/repositories/credit-accounts');
    const credit = await getCreditAccount(record.accountId);
    const status = (credit as { paymentStatus?: string | null } | null)?.paymentStatus ?? null;
    if (credit?.stripeSubscriptionId && !['cancelling', 'canceled', 'deleted'].includes(status ?? '')) {
      const { cancelSubscription } = await import('../billing/services/subscriptions');
      await cancelSubscription(record.accountId, WORKSPACE_CLOSE_REASON);
      await db
        .update(accountDeletionRequests)
        .set({ reason: WORKSPACE_CLOSE_REASON_SUBSCRIPTION })
        .where(eq(accountDeletionRequests.id, requestId));
    }
  } catch (error) {
    // The sweep cancels the subscription outright at the end of the grace.
    logger.error('[workspaces] close: cancel at period end failed', {
      workspace_id: record.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await bustIamCache(record.accountId);
}

async function bustIamCache(accountId: string): Promise<void> {
  try {
    const { invalidateIamCacheForAccount } = await import('../iam/cache-invalidation');
    const { invalidateWorkspaceFactsForAccount } = await import('../iam/workspace-facts');
    invalidateWorkspaceFactsForAccount(accountId);
    await invalidateIamCacheForAccount(accountId);
  } catch (error) {
    logger.warn('[workspaces] IAM cache bust failed', {
      account_id: accountId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * K2: delete a workspace. Idempotent: a workspace that is already closing
 * answers its scheduled date again. Authorization is the caller's.
 */
export async function closeWorkspace(input: { workspaceId: WorkspaceId; actorUserId: string }): Promise<CloseWorkspaceResult> {
  const record = await getWorkspace(input.workspaceId);
  if (!record) throw notFound(input.workspaceId);
  if (record.lifecycle === 'closing' && record.deletionScheduledFor) {
    return { mode: 'closed', deletionScheduledFor: record.deletionScheduledFor };
  }

  if (record.splitPending) {
    // A legacy account that still holds other workspaces: archive this
    // project row only (the behavior before K2). The split_pending trigger
    // clears the flag when one active project row remains.
    if (record.projectId) await archiveProjectRow(record.projectId, record.accountId);
    // The account may now be one workspace: give its expand rows the id.
    await db.execute(sql`SELECT kortix.workspace_fill_account(${record.accountId}::uuid)`);
    return { mode: 'archived_project' };
  }

  const now = new Date();
  const scheduledFor = new Date(now.getTime() + WORKSPACE_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
  let requestId: string;
  try {
    requestId = await withDbTransaction(async () => {
      if (record.projectId) await lockProjectRow(record.projectId);
      const [request] = await db
        .insert(accountDeletionRequests)
        .values({
          accountId: record.accountId,
          userId: input.actorUserId,
          scheduledFor: scheduledFor.toISOString(),
          requestedAt: now.toISOString(),
          reason: WORKSPACE_CLOSE_REASON,
          status: 'pending',
        })
        .returning({ id: accountDeletionRequests.id });
      if (record.projectId) await archiveProjectRow(record.projectId, record.accountId);
      const { revokeAccountCredentials } = await import('../billing/services/account-deletion');
      // Workspace credentials only: a personal key and an unbound OAuth grant
      // act as their person in every other workspace (revokeAccountCredentials).
      await revokeAccountCredentials(record.accountId, input.actorUserId, 'workspace');
      // Stop automations. `automations_paused_at` = the request's
      // `requested_at` marks a pause the close made, so restore resumes only that.
      await db
        .update(accounts)
        .set({ automationsPausedAt: now, automationsPausedBy: input.actorUserId })
        .where(and(eq(accounts.accountId, record.accountId), isNull(accounts.automationsPausedAt)));
      return request!.id;
    });
  } catch (error) {
    // A concurrent close opened the pending request first: answer its date.
    if (isUniqueViolation(error)) {
      const open = await openDeletionRequest(record.accountId);
      if (open) return { mode: 'closed', deletionScheduledFor: new Date(open.scheduledFor) };
    }
    throw error;
  }

  await afterClose(record, requestId);
  return { mode: 'closed', deletionScheduledFor: scheduledFor };
}

/**
 * Archive one active project row of `accountId` and revoke its project-bound
 * tokens, in one transaction (a savepoint inside the caller's). The account
 * predicate is the ownership CAS: a project a transfer moved out of
 * `accountId` is left intact. Returns the archived row, or `undefined` when
 * no active row of `accountId` matched.
 */
export async function archiveProjectRow(projectId: string, accountId: string): Promise<typeof projects.$inferSelect | undefined> {
  return withDbTransaction(async () => {
    const now = new Date();
    const [archived] = await db
      .update(projects)
      .set({ status: 'archived', updatedAt: now })
      .where(and(eq(projects.projectId, projectId), eq(projects.accountId, accountId), eq(projects.status, 'active')))
      .returning();
    if (!archived) return undefined;
    await db
      .update(accountTokens)
      .set({ status: 'revoked', revokedAt: now })
      .where(and(eq(accountTokens.projectId, projectId), eq(accountTokens.accountId, accountId), eq(accountTokens.status, 'active')));
    return archived;
  });
}

/** Restore a `closing` workspace during the grace. Authorization (owners) is the caller's. */
export async function restoreWorkspace(input: { workspaceId: WorkspaceId; actorUserId: string }): Promise<WorkspaceRecord> {
  const record = await getWorkspace(input.workspaceId);
  if (!record) throw notFound(input.workspaceId);
  if (record.lifecycle !== 'closing') {
    throw new WorkspaceLifecycleError('workspace_not_deleting', 409, 'This workspace is not being deleted', record.workspaceId);
  }
  const request = await openDeletionRequest(record.accountId);
  if (!request || request.status !== 'pending') {
    throw new WorkspaceLifecycleError(
      'workspace_deletion_in_progress',
      409,
      'The deletion of this workspace has started and cannot be undone',
      record.workspaceId,
    );
  }

  const cancelled = await withDbTransaction(async () => {
    if (record.projectId) {
      await lockProjectRow(record.projectId);
      // Un-archive before the cancel: the open request keeps this row the
      // workspace's live row in between.
      await db
        .update(projects)
        .set({ status: 'active', updatedAt: new Date() })
        .where(and(eq(projects.projectId, record.projectId), eq(projects.accountId, record.accountId)));
    }
    // The owner's compare-and-set: false when the deletion worker claimed it first.
    if (!(await cancelDeletionRequest(request.id))) {
      throw new WorkspaceLifecycleError(
        'workspace_deletion_in_progress',
        409,
        'The deletion of this workspace has started and cannot be undone',
        record.workspaceId,
      );
    }
    const pausedAt = request.requestedAt ? new Date(request.requestedAt) : null;
    if (pausedAt) {
      await db
        .update(accounts)
        .set({ automationsPausedAt: null, automationsPausedBy: null })
        .where(and(eq(accounts.accountId, record.accountId), eq(accounts.automationsPausedAt, pausedAt)));
    }
    return true;
  });

  if (cancelled && request.reason === WORKSPACE_CLOSE_REASON_SUBSCRIPTION) {
    try {
      const { reactivateSubscription } = await import('../billing/services/subscriptions');
      await reactivateSubscription(record.accountId);
    } catch (error) {
      logger.error('[workspaces] restore: reactivate subscription failed', {
        workspace_id: record.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await bustIamCache(record.accountId);
  const restored = await getWorkspace(record.workspaceId);
  if (!restored) throw notFound(record.workspaceId);
  return restored;
}

/**
 * The account and project id a `setup_required` workspace provisions with:
 * project_id = workspace_id (C1). Refuses a workspace that is not project-less
 * or does not pay, and one whose id is already taken by an archived project
 * row.
 */
export async function prepareWorkspaceSetup(
  workspaceId: WorkspaceId,
): Promise<{ accountId: WorkspaceAccountKey; projectId: WorkspaceId }> {
  const record = await getWorkspace(workspaceId);
  if (!record) throw notFound(workspaceId);
  if (record.lifecycle !== 'dormant' || record.projectId !== null || !(await accountIsPaying(record.accountId))) {
    throw new WorkspaceLifecycleError(
      'workspace_setup_not_required',
      409,
      'This workspace is not waiting for setup',
      record.workspaceId,
    );
  }
  const [taken] = await db
    .select({ projectId: projects.projectId })
    .from(projects)
    .where(eq(projects.projectId, record.workspaceId))
    .limit(1);
  if (taken) {
    throw new WorkspaceLifecycleError(
      'workspace_has_project',
      409,
      'This workspace id is held by an archived project; restore it instead',
      record.workspaceId,
    );
  }
  return { accountId: record.accountId, projectId: asWorkspaceId(record.workspaceId) };
}

/** True when `error` is a lifecycle refusal (for route mapping). */
export function isWorkspaceLifecycleError(error: unknown): error is WorkspaceLifecycleError {
  return error instanceof WorkspaceLifecycleError;
}

/** Re-stamp the expand rows of one account (kortix.workspace_fill_account). Returns the row count. */
export async function fillWorkspaceIds(accountId: string): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`SELECT kortix.workspace_fill_account(${accountId}::uuid) AS n`);
  return Number(row?.n ?? 0);
}

