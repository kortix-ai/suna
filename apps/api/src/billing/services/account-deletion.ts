import { accountMembers, projectSessions, sessionEnvironments, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { BillingError } from '../../errors';
import { tryGetProvider } from '../../platform/providers';
import { deleteSessionEnvironment } from '../../platform/services/session-environment-teardown';
import {
  isAlreadyNotRunning,
  reconcileSandboxRemovedByExternalId,
  reconcileSandboxStoppedByExternalId,
} from '../../projects/sandbox-reaper';
import { db } from '../../shared/db';
import { getStripe } from '../../shared/stripe';
import {
  cancelDeletionRequest,
  createDeletionRequest,
  getActiveDeletionRequest,
  getScheduledDeletions,
  markDeletionCompleted,
} from '../repositories/account-deletion';
import { getCreditAccount, updateCreditAccount } from '../repositories/credit-accounts';
import { insertLedgerEntry } from '../repositories/transactions';

const GRACE_PERIOD_DAYS = 14;

export async function requestAccountDeletion(accountId: string, userId: string, reason?: string) {
  const existing = await getActiveDeletionRequest(accountId);
  if (existing) {
    throw new BillingError('An active deletion request already exists for this account');
  }

  const scheduledFor = new Date(Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const request = await createDeletionRequest(accountId, userId, scheduledFor, reason);

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
export const RECLAIMABLE_SANDBOX_STATUSES = ['provisioning', 'active', 'error'] as const;

/** `project_sessions` states that still claim the session is doing something. */
export const LIVE_SESSION_STATUSES = ['queued', 'branching', 'provisioning', 'running'] as const;

export interface SandboxReclaimSummary {
  accounts: number;
  boxes: number;
  environments: number;
  environmentsDeleted: number;
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
export async function reclaimableAccountIds(accountId: string, userId?: string): Promise<string[]> {
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
async function reclaimAccountSandboxes(accountIds: string[]): Promise<SandboxReclaimSummary> {
  const summary: SandboxReclaimSummary = {
    accounts: accountIds.length,
    boxes: 0,
    environments: 0,
    environmentsDeleted: 0,
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

  try {
    const environments = await db
      .select({ sessionId: sessionEnvironments.sessionId })
      .from(sessionEnvironments)
      .where(inArray(sessionEnvironments.accountId, accountIds));
    summary.environments = environments.length;
    summary.boxes += environments.length;
    for (let i = 0; i < environments.length; i += STOP_CONCURRENCY) {
      await Promise.all(
        environments.slice(i, i + STOP_CONCURRENCY).map(async ({ sessionId }) => {
          try {
            await deleteSessionEnvironment(sessionId);
            summary.environmentsDeleted++;
          } catch (err) {
            summary.errors++;
            console.error(
              `[AccountDeletion] Failed to delete environment for session ${sessionId}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }),
      );
    }
  } catch (err) {
    summary.errors++;
    console.error(
      `[AccountDeletion] environment teardown failed for ${accountIds.join(', ')}:`,
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
    `[AccountDeletion] reclaim: accounts=${summary.accounts} boxes=${summary.boxes} environments=${summary.environments} environments_deleted=${summary.environmentsDeleted} stopped=${summary.stopped} removed=${summary.removed} sessions=${summary.sessionsSettled} errors=${summary.errors}`,
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
      console.error(
        `[AccountDeletion] Failed to cancel Stripe subscription for ${accountId}:`,
        err,
      );
    }
  }

  // Record forfeiture ledger entry for any remaining balance
  const currentBalance = account ? Number(account.balance) : 0;
  if (currentBalance > 0) {
    await insertLedgerEntry({
      accountId,
      amount: String(-currentBalance),
      balanceAfter: '0',
      type: 'forfeiture',
      description: 'Account deletion: credit balance forfeited',
      isExpiring: false,
    });
  }

  // Zero out all credit balances
  await updateCreditAccount(accountId, {
    balance: '0',
    expiringCredits: '0',
    nonExpiringCredits: '0',
    dailyCreditsBalance: '0',
    tier: 'free',
    stripeSubscriptionStatus: 'canceled',
    paymentStatus: 'deleted',
  } as any);

  console.log(`[AccountDeletion] Account deleted: ${accountId}`);
}
