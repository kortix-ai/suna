import { describe, expect, test } from 'bun:test';
import {
  type AuditReconciliationFailureState,
  describeAuditReconciliationFailure,
  nextAuditReconciliationCursor,
  nextAuditReconciliationFailureDecision,
} from './audit-reconciliation-worker';

describe('reconciliation failure warning', () => {
  test('reports the driver SQLSTATE without leaking SQL or bound account IDs', () => {
    const cause = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    const wrapper = Object.assign(new Error('Failed query: SELECT secret params: account-id'), {
      cause,
    });
    expect(describeAuditReconciliationFailure(wrapper)).toBe(
      'sqlstate=42P01 relation does not exist',
    );
  });
  test('degrades safely without a driver cause', () => {
    expect(describeAuditReconciliationFailure(null)).toBe('no error message available');
  });
});

describe('nextAuditReconciliationCursor', () => {
  test('repeats an account until every bounded source page is complete', () => {
    expect(
      nextAuditReconciliationCursor('account-before', {
        accountId: 'account-large',
        result: { inserted: 1_000, complete: false, by_source: { connector_calls: 1_000 } },
      }),
    ).toBe('account-before');
  });

  test('advances only after the current account is complete', () => {
    expect(
      nextAuditReconciliationCursor('account-before', {
        accountId: 'account-complete',
        result: { inserted: 12, complete: true, by_source: { provider_events: 12 } },
      }),
    ).toBe('account-complete');
  });

  test('resets the scan after the last account', () => {
    expect(nextAuditReconciliationCursor('account-last', { accountId: null, result: null })).toBe(
      null,
    );
  });
});

describe('nextAuditReconciliationFailureDecision', () => {
  const initial: AuditReconciliationFailureState = {
    consecutiveFailures: 0,
    failingAccountId: null,
  };

  // Regression: a page that keeps failing on the same account (e.g. a
  // statement timeout from an unindexed source table) was retried every 5s
  // forever — `tick()`'s catch path never advanced the cursor past it. That
  // burned I/O on every API replica and starved unrelated audit_events
  // inserts. The fix bounds both the retry rate and the stall.

  test('the first failure on an account waits the base delay and does not skip', () => {
    const decision = nextAuditReconciliationFailureDecision(initial, 'account-a');
    expect(decision.delayMs).toBe(5_000);
    expect(decision.skipToAccountId).toBeNull();
    expect(decision.state).toEqual({ consecutiveFailures: 1, failingAccountId: 'account-a' });
  });

  test('repeated failures on the same account escalate the delay: 5s, 30s, 120s', () => {
    let state: AuditReconciliationFailureState = initial;
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      const decision = nextAuditReconciliationFailureDecision(state, 'account-a');
      state = decision.state;
      delays.push(decision.delayMs);
    }
    expect(delays).toEqual([5_000, 30_000, 120_000]);
  });

  test('the third consecutive failure on the same account skips forward past it', () => {
    let state: AuditReconciliationFailureState = initial;
    let decision = nextAuditReconciliationFailureDecision(state, 'account-a');
    state = decision.state;
    decision = nextAuditReconciliationFailureDecision(state, 'account-a');
    state = decision.state;
    decision = nextAuditReconciliationFailureDecision(state, 'account-a');

    expect(decision.skipToAccountId).toBe('account-a');
    expect(decision.state).toEqual({ consecutiveFailures: 0, failingAccountId: null });
  });

  test('skipping resets the streak, so the account after it starts a fresh escalation', () => {
    const state: AuditReconciliationFailureState = {
      consecutiveFailures: 2,
      failingAccountId: 'account-a',
    };
    const skipDecision = nextAuditReconciliationFailureDecision(state, 'account-a');
    expect(skipDecision.skipToAccountId).toBe('account-a');

    const nextDecision = nextAuditReconciliationFailureDecision(skipDecision.state, 'account-b');
    expect(nextDecision.delayMs).toBe(5_000);
    expect(nextDecision.skipToAccountId).toBeNull();
  });

  test('a failure on a different account resets the streak instead of escalating', () => {
    const decision = nextAuditReconciliationFailureDecision(
      { consecutiveFailures: 2, failingAccountId: 'account-a' },
      'account-b',
    );
    expect(decision.delayMs).toBe(5_000);
    expect(decision.skipToAccountId).toBeNull();
    expect(decision.state).toEqual({ consecutiveFailures: 1, failingAccountId: 'account-b' });
  });

  test('a success resets the streak (the caller passes the initial state back after a good page)', () => {
    // tick() resets its state to `initial` on success; the very next failure
    // after a recovery must therefore start over at the base delay.
    const decision = nextAuditReconciliationFailureDecision(initial, 'account-a');
    expect(decision.delayMs).toBe(5_000);
  });

  test('a failure that cannot be attributed to an account (e.g. the account-lookup query itself) never skips and stays at the base delay', () => {
    let state: AuditReconciliationFailureState = initial;
    for (let i = 0; i < 3; i++) {
      const decision = nextAuditReconciliationFailureDecision(state, null);
      expect(decision.skipToAccountId).toBeNull();
      expect(decision.delayMs).toBe(5_000);
      state = decision.state;
    }
  });
});
