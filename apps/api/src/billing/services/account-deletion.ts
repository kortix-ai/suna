import { getStripe } from '../../shared/stripe';
import { BillingError } from '../../errors';
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

async function performDeletion(accountId: string) {
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
