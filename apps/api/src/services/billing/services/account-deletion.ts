import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  accountDeletionRequests,
  accountMembers,
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
  sessionEnvironments,
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
import { getSupabase } from '../../../lib/supabase';
import { forgetUserJwtLiveness } from '../../auth/jwt-liveness';
import { getStripe } from '../stripe';
import { db } from '../../../lib/db';
import { BillingError } from '../errors';
import { isUniqueViolation } from '../../../lib/postgres-errors';
import { tryGetProvider } from '../../platform/providers';
import { KORTIX_REMOVAL_INTENT_KEY } from '../../sandboxes/runtime-identity';
import {
  isAlreadyNotRunning,
  reconcileSandboxRemovedByExternalId,
  reconcileSandboxStoppedByExternalId,
} from '../../sandboxes/sandbox-reaper';
import { getCreditAccount, updateCreditAccount } from '../repositories/credit-accounts';
import { wallet } from '../wallet';
import {
  getActiveDeletionRequest,
  createDeletionRequest,
  cancelDeletionRequest,
  markDeletionCompleted,
  getScheduledDeletions,
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
 * `userId` widens the sandbox sweep to every account this user OWNS, not just
 * the one the route resolved. Optional so existing callers keep compiling, but
 * the route should always pass it — without it a user's team-account sandboxes
 * survive the deletion. See `reclaimableAccountIds`.
 */
export async function deleteAccountImmediately(accountId: string, userId?: string) {
  const request = await getActiveDeletionRequest(accountId);
  await performDeletion(accountId, userId ?? request?.userId);
  // The account's data goes before the auth identity: a failure here must not
  // sign a user out of an account whose data survived (the browser signs out
  // only when the route answered success).
  await deleteAccountData(accountId);
  const deletingUserId = userId ?? request?.userId;
  if (deletingUserId) {
    const { error } = await getSupabase().auth.admin.deleteUser(deletingUserId);
    if (error) throw error;
    forgetUserJwtLiveness(deletingUserId);
  }
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

  for (const request of requests) {
    try {
      // The request row carries the requester, so the scheduled path gets the
      // same owner-wide sweep as the immediate one.
      await performDeletion(request.accountId, request.userId);
      await markDeletionCompleted(request.id);
      processed++;
    } catch (err) {
      const msg = `Error deleting account ${request.accountId}: ${(err as Error).message}`;
      console.error(`[AccountDeletion] ${msg}`);
      errors.push(msg);
    }
  }

  console.log(`[AccountDeletion] Processed: ${processed}, Errors: ${errors.length}`);
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
 * through `resolveAccountId` (services/accounts/resolve-account.ts), which returns the
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
    const owned = await db
      .select({ accountId: accountMembers.accountId })
      .from(accountMembers)
      .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountRole, 'owner')));
    for (const row of owned) if (row.accountId) ids.add(row.accountId);
  } catch (err) {
    // Degrade to the single account rather than skipping teardown entirely.
    console.error(
      `[AccountDeletion] owned-account lookup failed for user ${userId}:`,
      err instanceof Error ? err.message : err,
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
            console.warn(
              `[AccountDeletion] failed to stamp removal intent for sandbox ${row.sandboxId}:`,
              err instanceof Error ? err.message : err,
            ),
          );

          if (provider) {
            try {
              await provider.stop(externalId);
              summary.stopped++;
            } catch (err) {
              if (!isAlreadyNotRunning(err)) {
                summary.errors++;
                console.error(
                  `[AccountDeletion] Failed to stop sandbox ${row.sandboxId}:`,
                  err instanceof Error ? err.message : err,
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
                console.error(
                  `[AccountDeletion] Failed to remove sandbox ${row.sandboxId}:`,
                  err instanceof Error ? err.message : err,
                );
              } else {
                summary.removed++;
              }
            }
          } else {
            summary.errors++;
            console.error(
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
            console.warn(
              `[AccountDeletion] removed-reconcile failed for sandbox ${row.sandboxId}:`,
              err instanceof Error ? err.message : err,
            );
            await reconcileSandboxStoppedByExternalId(externalId).catch((fallbackErr) => {
              summary.errors++;
              console.warn(
                `[AccountDeletion] stopped-reconcile also failed for sandbox ${row.sandboxId}:`,
                fallbackErr instanceof Error ? fallbackErr.message : fallbackErr,
              );
            });
          }
        }),
      );
    }
  } catch (err) {
    summary.errors++;
    console.error(
      `[AccountDeletion] sandbox teardown failed for ${accountIds.join(', ')}:`,
      err instanceof Error ? err.message : err,
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
    console.error(
      `[AccountDeletion] session settle failed for ${accountIds.join(', ')}:`,
      err instanceof Error ? err.message : err,
    );
  }

  console.log(
    `[AccountDeletion] reclaim: accounts=${summary.accounts} boxes=${summary.boxes} stopped=${summary.stopped} removed=${summary.removed} sessions=${summary.sessionsSettled} errors=${summary.errors}`,
  );
  return summary;
}

async function performDeletion(accountId: string, userId?: string) {
  await reclaimAccountSandboxes(await reclaimableAccountIds(accountId, userId));

  const account = await getCreditAccount(accountId);

  // Cancel Stripe subscription if active
  if (account?.stripeSubscriptionId) {
    try {
      const stripe = getStripe();
      await stripe.subscriptions.cancel(account.stripeSubscriptionId);
    } catch (err) {
      console.error(`[AccountDeletion] Failed to cancel Stripe subscription for ${accountId}:`, err);
    }
  }

  // Record any remaining balance as forfeited and empty every bucket.
  await wallet.forfeit(accountId);

  await updateCreditAccount(accountId, {
    tier: 'free',
    stripeSubscriptionStatus: 'canceled',
    paymentStatus: 'deleted',
  } as any);

  console.log(`[AccountDeletion] Account deleted: ${accountId}`);
}

/**
 * Delete the account row and every row the database cascade cannot reach, in
 * one transaction: either the account and all of its data go, or nothing does.
 *
 * A bare `DELETE FROM accounts` aborts the moment its cascade fires a
 * non-cascading FK edge (ON DELETE NO ACTION / RESTRICT) against rows that
 * still exist — e.g. `project_session_connector_bindings` RESTRICTs the
 * connector deletes, a `usage_events` row NO-ACTIONs the project deletes. The
 * sweep therefore runs three ordered passes inside one transaction:
 *
 *   1. child rows whose non-cascading edges would abort the cascade, each
 *      edge's child before its parent;
 *   2. the pure orphans — tables keyed by `account_id` with no foreign key to
 *      `accounts` at all;
 *   3. the accounts row itself, whose FK cascade takes the 90+ remaining
 *      tables (projects, sessions, memberships, IAM, PATs, OAuth, chat
 *      threads, gateway state…) with it.
 *
 * Retained on purpose, matching `performDeletion`'s `paymentStatus='deleted'`
 * marker: the audit trail (`audit_events` with its partitions, legacy store
 * and reconciliation state) and the financial records (`billing_customers`,
 * `credit_accounts`, `credit_ledger`, `credit_purchases`, `credit_usage`)
 * outlive the account. `prompt_attachments` and `connector_attachments` stay
 * with their existing TTL sweeps, which own both their rows and their Storage
 * objects — deleting the rows here would orphan their objects forever.
 */
async function deleteAccountData(accountId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Scopes for the child rows that carry no account_id of their own.
    const accountProjects = tx
      .select({ projectId: projects.projectId })
      .from(projects)
      .where(eq(projects.accountId, accountId));
    const accountSessions = tx
      .select({ sessionId: projectSessions.sessionId })
      .from(projectSessions)
      .where(eq(projectSessions.accountId, accountId));
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
    await tx.delete(connectorCalls).where(eq(connectorCalls.accountId, accountId));
    await tx.delete(connectorConnections).where(eq(connectorConnections.accountId, accountId));
    await tx.delete(changeRequests).where(eq(changeRequests.accountId, accountId));
    await tx.delete(gatewayRequestLogs).where(eq(gatewayRequestLogs.accountId, accountId));
    await tx.delete(sessionLifecycleCommands).where(eq(sessionLifecycleCommands.accountId, accountId));
    await tx.delete(usageEvents).where(eq(usageEvents.accountId, accountId));
    await tx.delete(reviewItems).where(inArray(reviewItems.projectId, accountProjects));
    await tx.delete(projectTriggerExecutions).where(inArray(projectTriggerExecutions.projectId, accountProjects));
    await tx.delete(projectTriggerRuntime).where(inArray(projectTriggerRuntime.projectId, accountProjects));
    await tx.delete(sandboxComputeSessions).where(eq(sandboxComputeSessions.accountId, accountId));
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
    await tx.delete(sessionEnvironments).where(eq(sessionEnvironments.accountId, accountId));
    await tx.delete(sessionTurns).where(inArray(sessionTurns.sessionId, accountSessions));
    await tx.delete(sessionPendingQuestions).where(inArray(sessionPendingQuestions.sessionId, accountSessions));
    await tx.delete(providerEvents).where(eq(providerEvents.accountId, accountId));
    await tx.delete(legacySandboxMigrations).where(eq(legacySandboxMigrations.accountId, accountId));
    await tx.delete(sunaAccountMigrations).where(eq(sunaAccountMigrations.accountId, accountId));
    await tx.delete(platformUserRoles).where(eq(platformUserRoles.accountId, accountId));
    await tx.delete(impersonationGrants).where(eq(impersonationGrants.targetAccountId, accountId));
    await tx.delete(accountDeletionRequests).where(eq(accountDeletionRequests.accountId, accountId));

    // Pass 3 — the row itself: the FK cascade takes every remaining table.
    await tx.delete(accounts).where(eq(accounts.accountId, accountId));
  });
}
