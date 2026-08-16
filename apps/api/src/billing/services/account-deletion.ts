import { and, eq, sql } from 'drizzle-orm';
import { appRuntimes, sessionSandboxes } from '@kortix/db';
import { getStripe } from '../../shared/stripe';
import { db } from '../../shared/db';
import { BillingError } from '../../errors';
import { getProvider, type ProviderName } from '../../platform/providers';
import { isAlreadyNotRunning, reconcileSandboxStoppedByExternalId } from '../../projects/sandbox-reaper';
import { AppHostingService, appRuntimeTarget } from '../../apps/hosting-service';
import { pauseComputeSession } from './compute-metering';
import { getCreditAccount, updateCreditAccount } from '../repositories/credit-accounts';
import { insertLedgerEntry } from '../repositories/transactions';
import {
  getActiveDeletionRequest,
  createDeletionRequest,
  cancelDeletionRequest,
  markDeletionCompleted,
  getScheduledDeletions,
} from '../repositories/account-deletion';

const GRACE_PERIOD_DAYS = 14;

export async function requestAccountDeletion(
  accountId: string,
  userId: string,
  reason?: string,
) {
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

export async function deleteAccountImmediately(accountId: string) {
  const request = await getActiveDeletionRequest(accountId);
  await performDeletion(accountId);
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
      await performDeletion(request.accountId);
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

/**
 * Stop every still-active sandbox owned by the account being deleted, right
 * now, while we still know who it belongs to. This closes the gap BEFORE the
 * row goes orphaned, rather than relying on the reaper's orphan-account
 * sweep (sandbox-reaper.ts) to notice later — same reasoning as that sweep's
 * bypass: the account is gone, so there is no customer whose in-flight turn
 * a stop could interrupt. Best-effort per box; one failure must not block
 * deletion or leave the rest of the account's boxes running.
 */
const STOP_CONCURRENCY = 6;

async function stopAccountSandboxes(accountId: string): Promise<void> {
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
      .where(and(eq(sessionSandboxes.accountId, accountId), eq(sessionSandboxes.status, 'active')));

    const targets = rows.filter((row) => !!row.externalId);
    // Bounded fan-out: this runs inline on DELETE /v1/account/delete-immediately,
    // whose caller aborts at 30s. A serial loop over a large account would
    // serialise that many provider round-trips into one request.
    for (let i = 0; i < targets.length; i += STOP_CONCURRENCY) {
      await Promise.all(
        targets.slice(i, i + STOP_CONCURRENCY).map(async (row) => {
          try {
            await getProvider(row.provider as ProviderName).stop(row.externalId as string);
          } catch (err) {
            if (!isAlreadyNotRunning(err)) {
              console.error(`[AccountDeletion] Failed to stop sandbox ${row.sandboxId} for ${accountId}:`, err instanceof Error ? err.message : err);
              return;
            }
            // Already stopped/gone on the provider side — proceed to reconcile.
          }
          await reconcileSandboxStoppedByExternalId(row.externalId as string).catch((err) =>
            console.warn(`[AccountDeletion] reconcile failed for sandbox ${row.sandboxId}:`, err instanceof Error ? err.message : err),
          );
        }),
      );
    }
  } catch (err) {
    console.error(`[AccountDeletion] sandbox teardown failed for ${accountId}:`, err instanceof Error ? err.message : err);
  }
}

async function removeAccountAppRuntimes(accountId: string): Promise<void> {
  try {
    const rows = await db.select({
      runtimeId: appRuntimes.runtimeId,
      hostingType: appRuntimes.hostingType,
      provider: appRuntimes.provider,
      externalId: appRuntimes.externalId,
    }).from(appRuntimes).where(and(
      eq(appRuntimes.accountId, accountId),
      // A previous deletion attempt already completed these rows.
      // Every other state can still own a provider-side resource.
      sql`${appRuntimes.status} <> 'deleted'`,
    ));
    const hosting = new AppHostingService();
    for (let i = 0; i < rows.length; i += STOP_CONCURRENCY) {
      await Promise.all(rows.slice(i, i + STOP_CONCURRENCY).map(async (runtime) => {
        try {
          await hosting.remove(appRuntimeTarget(runtime));
        } catch (error) {
          console.error(
            `[AccountDeletion] Failed to remove App runtime ${runtime.runtimeId} for ${accountId}:`,
            error instanceof Error ? error.message : error,
          );
        }
        const stoppedAt = new Date();
        await pauseComputeSession(runtime.runtimeId, stoppedAt).catch(() => {});
        await db.update(appRuntimes).set({
          status: 'deleted',
          stoppedAt,
          updatedAt: stoppedAt,
        }).where(eq(appRuntimes.runtimeId, runtime.runtimeId)).catch(() => {});
      }));
    }
  } catch (error) {
    // The environment-scoped managed-hosting reaper remains the recovery path.
    // Account deletion must not strand the remaining billing cleanup.
    console.error(
      `[AccountDeletion] App runtime teardown failed for ${accountId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

async function performDeletion(accountId: string) {
  await Promise.all([
    stopAccountSandboxes(accountId),
    removeAccountAppRuntimes(accountId),
  ]);

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
