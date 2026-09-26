import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createMockCreditAccount,
  createMockStripeClient,
  fakeWallet,
  mockRegistry,
  registerGlobalMocks,
  registerWalletMock,
  resetMockRegistry,
} from './mocks';

// Register global mocks once
registerGlobalMocks();
registerWalletMock();

// ─── Track calls ──────────────────────────────────────────────────────────────

let updateCreditAccountCalls: any[] = [];
let cancelSubscriptionCalls: string[] = [];

// Deletion repository state
let activeDeletionRequest: any = null;
let createdDeletionRequests: any[] = [];
let cancelledRequestIds: string[] = [];
let completedRequestIds: string[] = [];
let scheduledDeletionRequests: any[] = [];

beforeEach(() => {
  updateCreditAccountCalls = [];
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
    expect(result.id).toBeString();
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

  test('a concurrent duplicate (unique violation on insert) answers like the pre-check', async () => {
    // Drizzle wraps the PostgresError; the SQLSTATE sits on `cause`.
    mockRegistry.createDeletionRequest = async () => {
      throw Object.assign(new Error('Failed query: insert into account_deletion_requests'), {
        cause: { code: '23505', constraint_name: 'uniq_account_deletion_requests_pending' },
      });
    };

    const err: any = await requestAccountDeletion('acc_test_123', 'user_123').catch((e) => e);
    expect(err?.name).toBe('BillingError');
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('already exists');
  });

  test('any other insert failure propagates unchanged', async () => {
    const boom = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    mockRegistry.createDeletionRequest = async () => {
      throw boom;
    };

    const err = await requestAccountDeletion('acc_test_123', 'user_123').catch((e) => e);
    expect(err).toBe(boom);
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
    expect(result.deletion_scheduled_for).toBe(activeDeletionRequest.scheduledFor);
    expect(result.requested_at).toBe(activeDeletionRequest.requestedAt);
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

  test('forfeits the credit balance, then closes the account row', async () => {
    await deleteAccountImmediately('acc_test_123');

    // The forfeiture row and the emptied buckets are pinned against real
    // PostgreSQL in tests/migration/wallet-ledger.test.ts.
    expect(fakeWallet.calls.forfeit).toEqual(['acc_test_123']);
    const update = updateCreditAccountCalls[0];
    expect(update.data).toMatchObject({ tier: 'free', stripeSubscriptionStatus: 'canceled', paymentStatus: 'deleted' });
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
