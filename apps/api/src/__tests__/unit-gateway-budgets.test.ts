import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { gatewayBudgets, gatewayRequestLogs } from '@kortix/db';
import type { AuthedPrincipal } from '@kortix/llm-gateway';

/**
 * BILLING-CORRECTNESS: checkBudget (the function gating every gateway
 * request's project/member spend cap) had zero unit tests, and its DB query
 * hard-filtered to `action = 'block'` — a 'warn' budget (a real, persisted,
 * API-creatable option) was fetched nowhere and did nothing at all. This file
 * covers: block vs warn (warn never blocks but IS reported), project vs
 * member scope, and the multi-budget mix. Period rollover (date_trunc at the
 * SQL level) is deliberately NOT covered here — spend is a mocked constant per
 * test, not a live time-bucketed query, so day/week/month boundary behavior
 * needs a real Postgres integration test; noted as a follow-up rather than
 * faked here.
 */

// One FIFO queue per (projectId, subjectUserId, period) key, in the exact
// call order spendForPeriod issues them in checkBudget's budget loop — avoids
// needing to introspect drizzle's `where` condition object, since the mock
// below never inspects it.
let spendQueue: number[] = [];
let budgetRows: Array<{
  scope: 'project' | 'member';
  subjectUserId: string | null;
  limitUsd: string;
  period: 'day' | 'week' | 'month';
  action: 'block' | 'warn';
}> = [];

mock.module('../shared/db', () => ({
  db: {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === gatewayBudgets) return budgetRows;
          if (table === gatewayRequestLogs) {
            const cost = spendQueue.length ? spendQueue.shift()! : 0;
            return [{ cost }];
          }
          throw new Error('unexpected table in mocked db.select().from()');
        },
      }),
    }),
  },
}));

const { checkBudget, __resetBudgetReservationsForTests } = await import('../llm-gateway/budgets');

function principal(overrides: Partial<AuthedPrincipal> = {}): AuthedPrincipal {
  return {
    userId: 'user-1',
    accountId: 'acct-1',
    projectId: 'project-1',
    ...overrides,
  };
}

describe('checkBudget', () => {
  beforeEach(() => {
    spendQueue = [];
    budgetRows = [];
    __resetBudgetReservationsForTests();
  });

  test('no project on the principal → never queries, never exceeded', async () => {
    const result = await checkBudget(principal({ projectId: undefined }));
    expect(result).toEqual({ exceeded: false });
  });

  test('no budgets configured for the project → not exceeded', async () => {
    budgetRows = [];
    const result = await checkBudget(principal());
    expect(result.exceeded).toBe(false);
    expect(result.warnings).toBeUndefined();
  });

  describe('action = "block"', () => {
    test('spend under the limit → not exceeded', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '50', period: 'day', action: 'block' },
      ];
      spendQueue = [10];
      const result = await checkBudget(principal());
      expect(result.exceeded).toBe(false);
    });

    test('spend at or over the limit → exceeded, with a human message', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '50', period: 'day', action: 'block' },
      ];
      spendQueue = [50];
      const result = await checkBudget(principal());
      expect(result.exceeded).toBe(true);
      expect(result.message).toContain('$50/day');
      expect(result.message).toContain("project's");
    });

    test('member-scope budget only applies to the matching member', async () => {
      budgetRows = [
        {
          scope: 'member',
          subjectUserId: 'user-1',
          limitUsd: '10',
          period: 'month',
          action: 'block',
        },
      ];
      spendQueue = [12];
      const mine = await checkBudget(principal({ userId: 'user-1' }));
      expect(mine.exceeded).toBe(true);
      expect(mine.message).toContain('Your');

      // A different member's budget row must be skipped entirely for THIS
      // caller — no spend query issued for it at all.
      spendQueue = [];
      const someoneElse = await checkBudget(principal({ userId: 'user-2' }));
      expect(someoneElse.exceeded).toBe(false);
    });

    test('the FIRST exceeded block budget short-circuits — later rows are not evaluated', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '10', period: 'day', action: 'block' },
        { scope: 'project', subjectUserId: null, limitUsd: '100', period: 'month', action: 'block' },
      ];
      spendQueue = [10]; // only one value queued — a second call would throw "empty queue -> 0", not fail, but assert call count instead
      const result = await checkBudget(principal());
      expect(result.exceeded).toBe(true);
      expect(spendQueue.length).toBe(0); // exactly one spend query was consumed
    });
  });

  describe('action = "warn" — the fixed silent no-op', () => {
    test('a warn budget over its limit is reported in `warnings`, never blocks', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '50', period: 'day', action: 'warn' },
      ];
      spendQueue = [75];
      const result = await checkBudget(principal());
      expect(result.exceeded).toBe(false);
      expect(result.warnings).toBeDefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]).toContain('$50/day');
    });

    test('a warn budget under its limit produces no warning', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '50', period: 'day', action: 'warn' },
      ];
      spendQueue = [10];
      const result = await checkBudget(principal());
      expect(result.exceeded).toBe(false);
      expect(result.warnings).toBeUndefined();
    });

    test('member-scope warn budget is scoped like a block budget (only the matching member sees it)', async () => {
      budgetRows = [
        {
          scope: 'member',
          subjectUserId: 'user-1',
          limitUsd: '5',
          period: 'week',
          action: 'warn',
        },
      ];
      spendQueue = [9];
      const mine = await checkBudget(principal({ userId: 'user-1' }));
      expect(mine.warnings).toHaveLength(1);

      spendQueue = [];
      const someoneElse = await checkBudget(principal({ userId: 'user-2' }));
      expect(someoneElse.warnings).toBeUndefined();
    });
  });

  describe('mixed block + warn budgets on the same project', () => {
    test('an exceeded warn budget evaluated before an exceeded block budget is carried on the block response', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '10', period: 'day', action: 'warn' },
        { scope: 'project', subjectUserId: null, limitUsd: '20', period: 'month', action: 'block' },
      ];
      spendQueue = [15, 25];
      const result = await checkBudget(principal());
      expect(result.exceeded).toBe(true);
      expect(result.warnings).toHaveLength(1);
    });

    test('a warn budget that is NOT exceeded alongside a block budget that IS exceeded reports only the block', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '100', period: 'day', action: 'warn' },
        { scope: 'project', subjectUserId: null, limitUsd: '20', period: 'month', action: 'block' },
      ];
      spendQueue = [5, 25];
      const result = await checkBudget(principal());
      expect(result.exceeded).toBe(true);
      expect(result.warnings).toBeUndefined();
    });

    test('two separate warn budgets both exceeded are both reported', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '10', period: 'day', action: 'warn' },
        { scope: 'project', subjectUserId: null, limitUsd: '50', period: 'month', action: 'warn' },
      ];
      spendQueue = [15, 60];
      const result = await checkBudget(principal());
      expect(result.exceeded).toBe(false);
      expect(result.warnings).toHaveLength(2);
    });
  });

  describe('in-flight admission reservation (BILLING-CORRECTNESS: concurrent check-then-act race)', () => {
    // Every concurrent checkBudget call under test reads the SAME `spent`
    // value from gatewayRequestLogs (nothing has settled yet — that's the
    // whole bug) but each call still gets its own spendForPeriod query, so we
    // queue that constant value once per call.
    test('N concurrent admissions against a nearly-full block budget are bounded, not all admitted', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '5', period: 'day', action: 'block' },
      ];
      const STALE_SPEND = 4.9; // $0.10 of headroom under the $5 cap
      const CONCURRENCY = 20;
      spendQueue = Array(CONCURRENCY).fill(STALE_SPEND);

      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => checkBudget(principal())),
      );
      const admitted = results.filter((r) => !r.exceeded).length;

      // Without the reservation, ALL 20 would read spend=4.9 < 5 and pass —
      // exactly the audit's "20 concurrent sessions" scenario. With a 0.5
      // reservation per admission, only a small, bounded number can be
      // admitted before the reservation itself pushes effective spend over
      // the cap.
      expect(admitted).toBeLessThan(CONCURRENCY);
      expect(admitted).toBeGreaterThan(0);
    });

    test('a reservation only affects the SAME project/member key — a different project is unaffected', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '1', period: 'day', action: 'block' },
      ];
      spendQueue = [0.9]; // admitted, reserves 0.5 for project-1
      const first = await checkBudget(principal({ projectId: 'project-1' }));
      expect(first.exceeded).toBe(false);

      spendQueue = [0.9]; // a totally different project's spend — must not see project-1's reservation
      const other = await checkBudget(principal({ projectId: 'project-2' }));
      expect(other.exceeded).toBe(false);
    });

    test('a warn-only budget never reserves — concurrent warn checks never affect each other', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '5', period: 'day', action: 'warn' },
      ];
      spendQueue = [10, 10, 10];
      const results = await Promise.all([
        checkBudget(principal()),
        checkBudget(principal()),
        checkBudget(principal()),
      ]);
      expect(results.every((r) => !r.exceeded)).toBe(true);
      expect(results.every((r) => (r.warnings?.length ?? 0) === 1)).toBe(true);
    });
  });
});
