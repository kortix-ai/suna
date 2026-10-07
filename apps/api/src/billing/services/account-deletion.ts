import { and, eq, inArray, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import {
  accountDeletionRequests,
  accounts,
  appDeploymentEvents,
  appDeployments,
  apps,
  changeRequests,
  connectorCalls,
  connectorConnections,
  gatewayRequestLogs,
  impersonationGrants,
  kortixApiKeys,
  legacySandboxMigrations,
  platformUserRoles,
  projectSessionConnectorBindings,
  projectSessions,
  projectTriggerExecutions,
  projectTriggerRuntime,
  projects,
  providerEvents,
  reviewItems,
  sandboxes,
  sandboxComputeSessions,
  sessionLifecycleCommands,
  sessionPendingQuestions,
  sessionSandboxes,
  sessionTurns,
  sunaAccountMigrations,
  tunnelAuditLogs,
  tunnelConnections,
  tunnelDeviceAuthRequests,
  usageEvents,
} from '@kortix/db';
import { getSupabase } from '../../shared/supabase';
import { forgetUserJwtLiveness } from '../../shared/jwt-liveness';
import { getStripe } from '../../shared/stripe';
import { db } from '../../shared/db';
import { logger } from '../../lib/logger';
import { ownedAccountRows } from '../../iam/membership-read';
import { BillingError } from '../../errors';
import { isUniqueViolation } from '../../shared/postgres-errors';
import { tryGetProvider } from '../../platform/providers';
import { KORTIX_REMOVAL_INTENT_KEY } from '../../projects/runtime-identity';
import {
  isAlreadyNotRunning,
  reconcileSandboxRemovedByExternalId,
  reconcileSandboxStoppedByExternalId,
} from '../../projects/sandbox-reaper';
import { getCreditAccount, updateCreditAccount } from '../repositories/credit-accounts';
import { wallet } from '../wallet';
import {
  getActiveDeletionRequest,
  createDeletionRequest,
  cancelDeletionRequest,
  markDeletionCompleted,
  countOverdueBacklog,
  getScheduledDeletions,
  claimDeletionRequest,
  releaseDeletionRequest,
} from '../repositories/account-deletion';

const GRACE_PERIOD_DAYS = 14;
const ACTIVE_DELETION_REQUEST_EXISTS = 'An active deletion request already exists for this account';

export async function requestAccountDeletion(
  accountId: string,
  userId: string,
  reason?: string,
) {
  const existing = await getActiveDeletionRequest(accountId);
  if (existing) {
    throw new BillingError(ACTIVE_DELETION_REQUEST_EXISTS);
  }

  const scheduledFor = new Date(Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let request: Awaited<ReturnType<typeof createDeletionRequest>>;
  try {
    request = await createDeletionRequest(accountId, userId, scheduledFor, reason);
  } catch (err) {
    // A concurrent request inserted its pending row after our read.
    // uniq_account_deletion_requests_pending refuses the second one; answer it
    // the same way as the read above.
    if (isUniqueViolation(err)) throw new BillingError(ACTIVE_DELETION_REQUEST_EXISTS);
    throw err;
  }

  return {
    success: true,
    id: request.id,
    message: 'Account deletion scheduled successfully',
    deletion_scheduled_for: scheduledFor,
    can_cancel: true,
    grace_period_days: GRACE_PERIOD_DAYS,
  };
}

export async function getAccountDeletionStatus(accountId: string) {
  const request = await getActiveDeletionRequest(accountId);

  if (!request) {
    return {
      has_pending_deletion: false,
      deletion_scheduled_for: null,
      requested_at: null,
      can_cancel: false,
    };
  }

  return {
    has_pending_deletion: true,
    deletion_scheduled_for: request.scheduledFor,
    requested_at: request.requestedAt,
    can_cancel: true,
  };
}

export async function cancelAccountDeletion(accountId: string) {
  const request = await getActiveDeletionRequest(accountId);
  if (!request) {
    throw new BillingError('No active deletion request found');
  }

  await cancelDeletionRequest(request.id);

  return { success: true, message: 'Account deletion cancelled' };
}

/**
 * The one deletion routine. The immediate path and the scheduled worker both
 * run it, in this order, so neither can leave a login or data behind:
 *
 *   1. `performDeletion`: sandboxes, Stripe cancel, wallet forfeit.
 *   2. `deleteAccountData`: the account's rows. Data goes before the auth
 *      identity: a failure here must not sign a user out of an account whose
 *      data survived (the browser signs out only when the route answered
 *      success).
 *   3. The Supabase auth user, when the account is the requester's personal
 *      account.
 *
 * The requester's login goes only with their personal account, whose id is
 * the user id (`bootstrapPersonalAccount`). Deleting any other account keeps
 * the requester's login and leaves the sandboxes of their other accounts
 * alone: a team account the requester owns, or a request an operator made
 * while acting as a customer (impersonation refuses these routes now, but a
 * pending row from before keeps the operator as its requester).
 *
 * Every step is idempotent and throws on failure, so the caller can retry the
 * whole routine. The caller owns the request row (`completed` only after this
 * returns).
 */
async function runAccountDeletion(accountId: string, userId?: string, requestId?: string) {
  const requester = userId === accountId ? userId : undefined;
  await performDeletion(accountId, requester);
  await deleteAccountData(accountId, requestId);
  if (requester) {
    const { error } = await getSupabase().auth.admin.deleteUser(requester);
    // A user the auth schema no longer has (an admin-side delete, or a retry
    // after step 3 already ran) is the state this step produces.
    if (error && !isAuthUserNotFound(error)) throw error;
    forgetUserJwtLiveness(requester);
  }
}

function isAuthUserNotFound(error: { status?: number; code?: string }): boolean {
  return error.status === 404 || error.code === 'user_not_found';
}

/**
 * `userId` is the requester. When the account is their personal account, the
 * sandbox sweep widens to every account they OWN and their login is deleted
 * (see `runAccountDeletion`). Optional so existing callers keep compiling, but
 * the route should always pass it — without it a user's team-account sandboxes
 * survive the deletion. See `reclaimableAccountIds`.
 */
export async function deleteAccountImmediately(accountId: string, userId?: string) {
  const request = await getActiveDeletionRequest(accountId);
  await runAccountDeletion(accountId, userId ?? request?.userId, request?.id);
  if (request) {
    await markDeletionCompleted(request.id);
  }

  return { success: true, message: 'Account deleted' };
}

export async function processScheduledDeletions(): Promise<{
  processed: number;
  errors: string[];
}> {
  const requests = await getScheduledDeletions();
  let processed = 0;
  const errors: string[] = [];

  for (const candidate of requests) {
    // Claim each request atomically right before its irreversible work: the
    // batch was loaded earlier, so a cancel or another replica's claim since
    // then must win.
    const request = await claimDeletionRequest(candidate.id);
    if (!request) continue;
    try {
      // The request row carries the requester, so the scheduled path gets the
      // same owner-wide sweep as the immediate one.
      await runAccountDeletion(request.accountId, request.userId, request.id);
      await markDeletionCompleted(request.id);
      processed++;
    } catch (err) {
      const msg = `Error deleting account ${request.accountId}: ${(err as Error).message}`;
      logger.error('[AccountDeletion] scheduled deletion failed', {
        requestId: request.id,
        accountId: request.accountId,
        error: err instanceof Error ? err.message : String(err),
      });
      errors.push(msg);
      // Back to `pending`: the next tick retries the failed step.
      await releaseDeletionRequest(request.id).catch((releaseErr) =>
        logger.error(`[AccountDeletion] release failed for ${request.id}:`, { error: String(releaseErr) }),
      );
    }
  }

  const backlog = await countOverdueBacklog();
  if (backlog > 0) {
    logger.warn(`[AccountDeletion] ${backlog} pending request(s) are past the overdue window and wait for a person`);
  }
  logger.info(`[AccountDeletion] Processed: ${processed}, Errors: ${errors.length}`);
  return { processed, errors };
}

const STOP_CONCURRENCY = 8;

/**
 * Sandbox rows that may still map to a box the provider is charging for.
 *
 * `active` alone is NOT the right filter, which is how this leaked. A box that
 * died mid-provision (`provisioning`) or whose last control-plane call errored
 * (`error`) still exists at the provider and still bills; only `stopped` and
 * `archived` are terminal. The release-gate incident that motivated this found
 * 47 sessions in exactly these non-`active` states with live Daytona boxes.
 */
const RECLAIMABLE_SANDBOX_STATUSES = ['provisioning', 'active', 'error'] as const;

/** `project_sessions` states that still claim the session is doing something. */
const LIVE_SESSION_STATUSES = [
  'queued',
  'branching',
  'provisioning',
  'running',
] as const;

export interface SandboxReclaimSummary {
  accounts: number;
  boxes: number;
  stopped: number;
  removed: number;
  sessionsSettled: number;
  errors: number;
}

/**
 * Every account this user OWNS, including the account passed in.
 *
 * Deletion used to sweep exactly one account: the route resolves the caller
 * through `resolveAccountId` (shared/resolve-account.ts), which returns the
 * user's EARLIEST-JOINED membership and nothing else. A user who owned a team
 * account created after their personal one therefore had every team sandbox
 * survive the deletion, still running and still billing, with no account left
 * to attribute them to. That is the second half of the release-gate leak.
 *
 * Scoped to `account_role = 'owner'` on purpose, NOT to bare membership:
 * deleting your own account must never tear down sandboxes in someone else's
 * team that you merely belong to. Owner is the same authority the route already
 * requires (ACCOUNT_ACTIONS.ACCOUNT_DELETE), so this widens the sweep to
 * exactly the accounts the caller could have deleted one at a time anyway.
 */
export async function reclaimableAccountIds(
  accountId: string,
  userId?: string,
): Promise<string[]> {
  const ids = new Set<string>([accountId]);
  if (!userId) return [...ids];
  try {
    const owned = await ownedAccountRows(userId);
    for (const row of owned) if (row.accountId) ids.add(row.accountId);
  } catch (err) {
    // Degrade to the single account rather than skipping teardown entirely.
    logger.error(
      `[AccountDeletion] owned-account lookup failed for user ${userId}:`, { error: err instanceof Error ? err.message : err },
    );
  }
  return [...ids];
}

/**
 * Stop AND remove every sandbox owned by the accounts being deleted, right now,
 * while we still know who they belong to.
 *
 * `stop()` alone was not enough. A stopped box still exists at the provider,
 * still holds the disk, still counts against the org quota, and — the part that
 * actually broke the release gate — can be woken again by anything holding its
 * connector token. So each box is stopped, then REMOVED, then reconciled
 * through `reconcileSandboxRemovedByExternalId`, which settles billing, flips
 * `session_sandboxes` AND `project_sessions` to `stopped` in one transaction,
 * and revokes the session's connector token so no surviving agent process can
 * authenticate with it.
 *
 * Best-effort per box: one provider failure must never block deletion, abort
 * the remaining boxes, or leave the row claiming to be alive.
 */
async function markRemovalIntent(sandboxId: string): Promise<void> {
  await db
    .update(sessionSandboxes)
    .set({
      metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify({
        [KORTIX_REMOVAL_INTENT_KEY]: new Date().toISOString(),
      })}::jsonb`,
    })
    .where(eq(sessionSandboxes.sandboxId, sandboxId));
}

async function reclaimAccountSandboxes(accountIds: string[]): Promise<SandboxReclaimSummary> {
  const summary: SandboxReclaimSummary = {
    accounts: accountIds.length,
    boxes: 0,
    stopped: 0,
    removed: 0,
    sessionsSettled: 0,
    errors: 0,
  };
  // Deletion must never fail because teardown did. Every failure mode here —
  // the lookup itself, a provider stop, a reconcile — degrades to "leave the
  // box for the reaper's orphan sweep", which is exactly what this path
  // existed to avoid needing, not something it may block deletion over.
  try {
    const rows = await db
      .select({
        sandboxId: sessionSandboxes.sandboxId,
        provider: sessionSandboxes.provider,
        externalId: sessionSandboxes.externalId,
      })
      .from(sessionSandboxes)
      .where(
        and(
          inArray(sessionSandboxes.accountId, accountIds),
          inArray(sessionSandboxes.status, [...RECLAIMABLE_SANDBOX_STATUSES]),
          isNotNull(sessionSandboxes.externalId),
        ),
      );

    const targets = rows.filter((row) => !!row.externalId);
    summary.boxes = targets.length;

    // Bounded fan-out: this runs inline on DELETE /v1/account/delete-immediately,
    // whose caller aborts at 30s. A serial loop over a large account would
    // serialise that many provider round-trips into one request.
    for (let i = 0; i < targets.length; i += STOP_CONCURRENCY) {
      await Promise.all(
        targets.slice(i, i + STOP_CONCURRENCY).map(async (row) => {
          const externalId = row.externalId as string;
          // `tryGetProvider`, not `getProvider`: a provider whose API key is
          // unset on this deployment must not throw and skip the box — the row
          // still has to be settled so nothing keeps billing against it.
          const provider = tryGetProvider(row.provider as string);

          // Stamp the intent BEFORE the provider call: its `removed` webhook can
          // arrive before this request settles the row, and must not read as a
          // lost runtime.
          await markRemovalIntent(row.sandboxId).catch((err) =>
            logger.warn(
              `[AccountDeletion] failed to stamp removal intent for sandbox ${row.sandboxId}:`, { error: err instanceof Error ? err.message : err },
            ),
          );

          if (provider) {
            try {
              await provider.stop(externalId);
              summary.stopped++;
            } catch (err) {
              if (!isAlreadyNotRunning(err)) {
                summary.errors++;
                logger.error(
                  `[AccountDeletion] Failed to stop sandbox ${row.sandboxId}:`, { error: err instanceof Error ? err.message : err },
                );
              } else {
                summary.stopped++;
              }
            }

            // Remove even when the stop failed: a box we could not park is
            // exactly the box that must not survive this deletion.
            try {
              await provider.remove(externalId);
              summary.removed++;
            } catch (err) {
              if (!isAlreadyNotRunning(err)) {
                summary.errors++;
                logger.error(
                  `[AccountDeletion] Failed to remove sandbox ${row.sandboxId}:`, { error: err instanceof Error ? err.message : err },
                );
              } else {
                summary.removed++;
              }
            }
          } else {
            summary.errors++;
            logger.error(
              `[AccountDeletion] No provider client for ${row.provider}; settling sandbox ${row.sandboxId} without a provider call`,
            );
          }

          // Reconcile regardless of what the provider did. `removed` is the
          // stronger settle — it revokes the session's connector token, which
          // is the credential a surviving agent process would otherwise keep
          // using. Fall back to the stopped reconcile so a failure here still
          // leaves the row terminal rather than eternally `active`.
          try {
            await reconcileSandboxRemovedByExternalId(externalId);
          } catch (err) {
            logger.warn(
              `[AccountDeletion] removed-reconcile failed for sandbox ${row.sandboxId}:`, { error: err instanceof Error ? err.message : err },
            );
            await reconcileSandboxStoppedByExternalId(externalId).catch((fallbackErr) => {
              summary.errors++;
              logger.warn(
                `[AccountDeletion] stopped-reconcile also failed for sandbox ${row.sandboxId}:`, { error: fallbackErr instanceof Error ? fallbackErr.message : fallbackErr },
              );
            });
          }
        }),
      );
    }
  } catch (err) {
    summary.errors++;
    logger.error(
      `[AccountDeletion] sandbox teardown failed for ${accountIds.join(', ')}:`, { error: err instanceof Error ? err.message : err },
    );
  }

  // Settle sessions the sandbox sweep could not reach: a session that never got
  // a `session_sandboxes` row, or whose row had no `external_id`, still shows as
  // `running` forever. Those are the rows the manual playbook had to fix by
  // hand. Terminal statuses are left alone.
  try {
    const settled = await db
      .update(projectSessions)
      .set({ status: 'stopped', updatedAt: new Date() })
      .where(
        and(
          inArray(projectSessions.accountId, accountIds),
          inArray(projectSessions.status, [...LIVE_SESSION_STATUSES]),
        ),
      )
      .returning({ sessionId: projectSessions.sessionId });
    summary.sessionsSettled = settled.length;
  } catch (err) {
    summary.errors++;
    logger.error(
      `[AccountDeletion] session settle failed for ${accountIds.join(', ')}:`, { error: err instanceof Error ? err.message : err },
    );
  }

  logger.info(
    `[AccountDeletion] reclaim: accounts=${summary.accounts} boxes=${summary.boxes} stopped=${summary.stopped} removed=${summary.removed} sessions=${summary.sessionsSettled} errors=${summary.errors}`,
  );
  return summary;
}

async function performDeletion(accountId: string, userId?: string) {
  await reclaimAccountSandboxes(await reclaimableAccountIds(accountId, userId));

  const account = await getCreditAccount(accountId);

  // Cancel the Stripe subscription. A failure aborts the deletion: the request
  // must not read `completed` while the customer is still billed.
  if (account?.stripeSubscriptionId && account.stripeSubscriptionStatus !== 'canceled') {
    try {
      await getStripe().subscriptions.cancel(account.stripeSubscriptionId);
    } catch (err) {
      // Already gone at Stripe: the state we want.
      if ((err as { code?: string }).code !== 'resource_missing') {
        logger.error(`[AccountDeletion] Failed to cancel Stripe subscription for ${accountId}:`, { error: String(err) });
        throw err;
      }
    }
  }

  // Record any remaining balance as forfeited and empty every bucket.
  await wallet.forfeit(accountId);

  await updateCreditAccount(accountId, {
    tier: 'free',
    stripeSubscriptionStatus: 'canceled',
    paymentStatus: 'deleted',
  } as any);

  logger.info(`[AccountDeletion] Account deleted: ${accountId}`);
}

const DELETE_CHUNK_ROWS = 5_000;

/**
 * Delete the rows of `table` matching `where`, `DELETE_CHUNK_ROWS` at a time,
 * each chunk its own statement and transaction. A single statement over
 * millions of rows exceeds the statement timeout, bloats WAL and holds row
 * locks against the account's live writers. Idempotent: a retry deletes what
 * is left.
 */
async function deleteInChunks(table: PgTable, where: SQL): Promise<void> {
  for (;;) {
    const rows = (await db.execute(sql`
      WITH gone AS (
        DELETE FROM ${table}
         WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT ${DELETE_CHUNK_ROWS})
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM gone
    `)) as unknown as Array<{ n: number }>;
    if (!rows[0] || rows[0].n < DELETE_CHUNK_ROWS) return;
  }
}

/**
 * Delete the account row and every row the database cascade cannot reach.
 *
 * A bare `DELETE FROM accounts` aborts the moment its cascade fires a
 * non-cascading FK edge (ON DELETE NO ACTION / RESTRICT) against rows that
 * still exist — e.g. `project_session_connector_bindings` RESTRICTs the
 * connector deletes, a `usage_events` row NO-ACTIONs the project deletes. The
 * sweep therefore runs ordered passes:
 *
 *   0. the unbounded tables (gateway logs, usage, calls, turns, ...) in
 *      bounded chunks OUTSIDE the transaction, so the largest accounts do not
 *      fail on every retry;
 *   1. in one transaction, child rows whose non-cascading edges would abort
 *      the cascade, each edge's child before its parent;
 *   2. the pure orphans — tables keyed by `account_id` with no foreign key to
 *      `accounts` at all;
 *   3. the accounts row itself, whose FK cascade takes the 90+ remaining
 *      tables (projects, sessions, memberships, IAM, PATs, OAuth, chat
 *      threads, gateway state…) with it.
 *
 * Every pass is idempotent: a failure leaves a partial account that the next
 * run finishes.
 *
 * Retained on purpose, matching `performDeletion`'s `paymentStatus='deleted'`
 * marker: the audit trail (`audit_events` with its partitions, legacy store
 * and reconciliation state), the financial records (`billing_customers`,
 * `credit_accounts`, `credit_ledger`, `credit_purchases`, `credit_usage`) and
 * the deletion request row (`keepRequestId`, the completion receipt) outlive
 * the account. `prompt_attachments` and `connector_attachments` stay with
 * their existing TTL sweeps, which own both their rows and their Storage
 * objects — deleting the rows here would orphan their objects forever.
 */
async function deleteAccountData(accountId: string, keepRequestId?: string): Promise<void> {
  // Pass 0 — bounded chunks. Children before parents, as in pass 1.
  const inAccountSessions = (sessionIdColumn: AnyPgColumn) =>
    sql`${sessionIdColumn} IN (SELECT ${projectSessions.sessionId} FROM ${projectSessions} WHERE ${eq(projectSessions.accountId, accountId)})`;
  await deleteInChunks(connectorCalls, eq(connectorCalls.accountId, accountId));
  await deleteInChunks(gatewayRequestLogs, eq(gatewayRequestLogs.accountId, accountId));
  await deleteInChunks(usageEvents, eq(usageEvents.accountId, accountId));
  await deleteInChunks(sandboxComputeSessions, eq(sandboxComputeSessions.accountId, accountId));
  await deleteInChunks(sessionLifecycleCommands, eq(sessionLifecycleCommands.accountId, accountId));
  await deleteInChunks(sessionTurns, inAccountSessions(sessionTurns.sessionId));
  await deleteInChunks(sessionPendingQuestions, inAccountSessions(sessionPendingQuestions.sessionId));

  await db.transaction(async (tx) => {
    // Scopes for the child rows that carry no account_id of their own.
    const accountProjects = tx
      .select({ projectId: projects.projectId })
      .from(projects)
      .where(eq(projects.accountId, accountId));
    const accountApps = tx.select({ appId: apps.appId }).from(apps).where(eq(apps.accountId, accountId));
    const accountDeployments = tx
      .select({ deploymentId: appDeployments.deploymentId })
      .from(appDeployments)
      .where(inArray(appDeployments.appId, accountApps));

    // Pass 1 — children of non-cascading FK edges, before anything they
    // reference. (usage_events, connector_calls, review_items and the rest
    // are cascade children of the account themselves; sweeping them early
    // keeps their NO ACTION / RESTRICT edges into projects, project_sessions,
    // connectors and connector_connections from aborting the final DELETE.)
    await tx.delete(projectSessionConnectorBindings).where(eq(projectSessionConnectorBindings.accountId, accountId));
    await tx.delete(connectorConnections).where(eq(connectorConnections.accountId, accountId));
    await tx.delete(changeRequests).where(eq(changeRequests.accountId, accountId));
    await tx.delete(reviewItems).where(inArray(reviewItems.projectId, accountProjects));
    await tx.delete(projectTriggerExecutions).where(inArray(projectTriggerExecutions.projectId, accountProjects));
    await tx.delete(projectTriggerRuntime).where(inArray(projectTriggerRuntime.projectId, accountProjects));
    await tx.delete(appDeploymentEvents).where(inArray(appDeploymentEvents.deploymentId, accountDeployments));
    await tx.delete(appDeployments).where(inArray(appDeployments.appId, accountApps));

    // Pass 2 — the orphans: account rows no foreign key can reach. Ordered by
    // their own NO ACTION edges (tunnel device auth and the connector
    // bindings before the tunnels, the tunnels before the sandboxes).
    await tx.delete(tunnelDeviceAuthRequests).where(eq(tunnelDeviceAuthRequests.accountId, accountId));
    await tx.delete(tunnelAuditLogs).where(eq(tunnelAuditLogs.accountId, accountId));
    await tx.delete(tunnelConnections).where(eq(tunnelConnections.accountId, accountId));
    await tx.delete(sandboxes).where(eq(sandboxes.accountId, accountId));
    await tx.delete(kortixApiKeys).where(eq(kortixApiKeys.accountId, accountId));
    await tx.delete(sessionSandboxes).where(eq(sessionSandboxes.accountId, accountId));
    await tx.delete(providerEvents).where(eq(providerEvents.accountId, accountId));
    await tx.delete(legacySandboxMigrations).where(eq(legacySandboxMigrations.accountId, accountId));
    await tx.delete(sunaAccountMigrations).where(eq(sunaAccountMigrations.accountId, accountId));
    await tx.delete(platformUserRoles).where(eq(platformUserRoles.accountId, accountId));
    await tx.delete(impersonationGrants).where(eq(impersonationGrants.targetAccountId, accountId));
    await tx
      .delete(accountDeletionRequests)
      .where(
        and(
          eq(accountDeletionRequests.accountId, accountId),
          keepRequestId ? ne(accountDeletionRequests.id, keepRequestId) : undefined,
        ),
      );

    // Pass 3 — the row itself: the FK cascade takes every remaining table.
    await tx.delete(accounts).where(eq(accounts.accountId, accountId));
  });
}
