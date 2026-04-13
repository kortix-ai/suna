import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createMockCreditAccount,
  createMockStripeClient,
  mockRegistry,
  registerGlobalMocks,
  resetMockRegistry,
} from './mocks';

// Register global mocks once
registerGlobalMocks();

// ─── Track calls ──────────────────────────────────────────────────────────────

let updateCreditAccountCalls: any[] = [];
let insertLedgerCalls: any[] = [];
let cancelSubscriptionCalls: string[] = [];

// Deletion repository state
let activeDeletionRequest: any = null;
let createdDeletionRequests: any[] = [];
let cancelledRequestIds: string[] = [];
let completedRequestIds: string[] = [];
let scheduledDeletionRequests: any[] = [];

beforeEach(() => {
  updateCreditAccountCalls = [];
  insertLedgerCalls = [];
  cancelSubscriptionCalls = [];

  activeDeletionRequest = null;
  createdDeletionRequests = [];
  cancelledRequestIds = [];
  completedRequestIds = [];
  scheduledDeletionRequests = [];
  resetMockRegistry();

  // Stripe client with cancel tracking
  mockRegistry.stripeClient = createMockStripeClient();
  mockRegistry.stripeClient.subscriptions.cancel = async (id: string) => {
    cancelSubscriptionCalls.push(id);
    return {};
  };

  // Credit account repo defaults
  mockRegistry.getCreditAccount = async () => createMockCreditAccount();
  mockRegistry.updateCreditAccount = async (id: string, data: any) => {
    updateCreditAccountCalls.push({ accountId: id, data });
  };

  // Transaction repo defaults
  mockRegistry.insertLedgerEntry = async (data: any) => {
    insertLedgerCalls.push(data);
    return { id: 'ledger_test', ...data };
  };

  // Account deletion repo defaults
  mockRegistry.getActiveDeletionRequest = async () => activeDeletionRequest;
  mockRegistry.createDeletionRequest = async (accountId: string, userId: string, scheduledFor: string, reason?: string) => {
    const req = {
      id: `del_${Date.now()}`,
      accountId,
      userId,
      scheduledFor,
      reason: reason ?? null,
      status: 'pending',
      requestedAt: new Date().toISOString(),
    };
    createdDeletionRequests.push(req);
    return req;
  };
  mockRegistry.cancelDeletionRequest = async (requestId: string) => {
    cancelledRequestIds.push(requestId);
  };
  mockRegistry.markDeletionCompleted = async (requestId: string) => {
    completedRequestIds.push(requestId);
  };
  mockRegistry.getScheduledDeletions = async () => scheduledDeletionRequests;
});

// Import AFTER mocking
const {
  requestAccountDeletion,
  getAccountDeletionStatus,
  cancelAccountDeletion,
  deleteAccountImmediately,
  processScheduledDeletions,
} = await import('../../billing/services/account-deletion');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('requestAccountDeletion', () => {
  test('creates request with 14-day grace period', async () => {
    const result = await requestAccountDeletion('acc_test_123', 'user_123', 'Testing');

    expect(result.success).toBe(true);
    expect(result.grace_period_days).toBe(14);
    expect(result.can_cancel).toBe(true);

    const scheduledDate = new Date(result.deletion_scheduled_for);
    const now = new Date();
    const diffDays = (scheduledDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(13);
    expect(diffDays).toBeLessThan(15);

    expect(createdDeletionRequests.length).toBe(1);
    expect(createdDeletionRequests[0].reason).toBe('Testing');
  });

  test('returns scheduled date and can_cancel=true', async () => {
    const result = await requestAccountDeletion('acc_test_123', 'user_123');

    expect(result.deletion_scheduled_for).toBeDefined();
    expect(result.can_cancel).toBe(true);
    expect(result.id).toBeDefined();
  });

  test('throws if active request already exists', async () => {
    activeDeletionRequest = {
      id: 'del_existing',
      accountId: 'acc_test_123',
      status: 'pending',
    };

    try {
      await requestAccountDeletion('acc_test_123', 'user_123');
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('already exists');
    }
  });
});

describe('getAccountDeletionStatus', () => {
  test('returns has_pending_deletion=true when active request exists', async () => {
    activeDeletionRequest = {
      id: 'del_123',
      accountId: 'acc_test_123',
      status: 'pending',
      scheduledFor: new Date(Date.now() + 86400000 * 14).toISOString(),
      requestedAt: new Date().toISOString(),
      reason: 'Test reason',
    };

    const result = await getAccountDeletionStatus('acc_test_123');

    expect(result.has_pending_deletion).toBe(true);
    expect(result.deletion_scheduled_for).toBeDefined();
    expect(result.requested_at).toBeDefined();
    expect(result.can_cancel).toBe(true);
  });

  test('returns has_pending_deletion=false when no request', async () => {
    activeDeletionRequest = null;

    const result = await getAccountDeletionStatus('acc_test_123');

    expect(result.has_pending_deletion).toBe(false);
    expect(result.deletion_scheduled_for).toBe(null);
  });
});

describe('cancelAccountDeletion', () => {
  test('marks request as cancelled', async () => {
    activeDeletionRequest = {
      id: 'del_to_cancel',
      accountId: 'acc_test_123',
      status: 'pending',
    };

    const result = await cancelAccountDeletion('acc_test_123');

    expect(result.success).toBe(true);
    expect(cancelledRequestIds.length).toBe(1);
    expect(cancelledRequestIds[0]).toBe('del_to_cancel');
  });

  test('throws if no active request', async () => {
    activeDeletionRequest = null;

    try {
      await cancelAccountDeletion('acc_test_123');
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('No active deletion request');
    }
  });
});

describe('deleteAccountImmediately', () => {
  test('cancels Stripe subscription', async () => {
    await deleteAccountImmediately('acc_test_123');

    expect(cancelSubscriptionCalls.length).toBe(1);
    expect(cancelSubscriptionCalls[0]).toBe('sub_test_123');
  });

  test('zeroes credit balance', async () => {
    await deleteAccountImmediately('acc_test_123');

    const update = updateCreditAccountCalls[0];
    expect(update.data.balance).toBe('0');
    expect(update.data.expiringCredits).toBe('0');
    expect(update.data.nonExpiringCredits).toBe('0');
    expect(update.data.dailyCreditsBalance).toBe('0');
  });

  test('creates forfeiture ledger entry', async () => {
    await deleteAccountImmediately('acc_test_123');

    expect(insertLedgerCalls.length).toBe(1);
    expect(Number(insertLedgerCalls[0].amount)).toBeLessThan(0);
    expect(insertLedgerCalls[0].type).toBe('forfeiture');
    expect(insertLedgerCalls[0].balanceAfter).toBe('0');
  });

  test('marks deletion request as completed if exists', async () => {
    activeDeletionRequest = {
      id: 'del_immediate',
      accountId: 'acc_test_123',
      status: 'pending',
    };

    await deleteAccountImmediately('acc_test_123');

    expect(completedRequestIds.length).toBe(1);
    expect(completedRequestIds[0]).toBe('del_immediate');
  });
});

describe('processScheduledDeletions', () => {
  test('finds due requests and processes each', async () => {
    scheduledDeletionRequests = [
      {
        id: 'del_scheduled_1',
        accountId: 'acc_test_123',
        status: 'pending',
        scheduledFor: new Date(Date.now() - 86400000).toISOString(),
      },
    ];

    const result = await processScheduledDeletions();

    expect(result.processed).toBe(1);
    expect(result.errors.length).toBe(0);
    expect(completedRequestIds.length).toBe(1);
  });

  test('skips when no due requests', async () => {
    scheduledDeletionRequests = [];

    const result = await processScheduledDeletions();

    expect(result.processed).toBe(0);
  });

  test('continues on error for individual accounts', async () => {
    // Make the first account fail by having getCreditAccount throw
    let callCount = 0;
    mockRegistry.getCreditAccount = async (id: string) => {
      callCount++;
      if (callCount === 1) throw new Error('DB error');
      return createMockCreditAccount();
    };

    scheduledDeletionRequests = [
      {
        id: 'del_fail',
        accountId: 'acc_fail',
        status: 'pending',
        scheduledFor: new Date(Date.now() - 86400000).toISOString(),
      },
      {
        id: 'del_ok',
        accountId: 'acc_ok',
        status: 'pending',
        scheduledFor: new Date(Date.now() - 86400000).toISOString(),
      },
    ];

    const result = await processScheduledDeletions();

    expect(result.errors.length).toBe(1);
    expect(result.processed).toBe(1);
  });
});
