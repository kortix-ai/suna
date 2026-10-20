import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { gatewayBudgets, gatewayRequestLogs, gatewaySpendDaily } from '@kortix/db';
import type { AuthedPrincipal } from '@kortix/llm-gateway';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * BILLING-CORRECTNESS: checkBudget (the function gating every gateway
 * request's project/member spend cap) had zero unit tests, and its DB query
 * hard-filtered to `action = 'block'` — a 'warn' budget (a real, persisted,
 * API-creatable option) was fetched nowhere and did nothing at all. This file
 * covers: block vs warn (warn never blocks but IS reported), project vs
 * member scope, and the multi-budget mix. Period rollover is NOT covered here
 * — spend is a mocked constant per test, not a live time-bucketed query. The
 * day/week/month boundaries run against real Postgres in
 * integration-gateway-budget-meters-http.test.ts.
 */

// One FIFO queue per (projectId, subjectUserId, period) key, in the exact
// call order budgetSpends issues them in checkBudget's budget loop — avoids
// needing to introspect drizzle's `where` condition object, since the mock
// below never inspects it.
let spendQueue: number[] = [];
// The rendered SQL of the money expression each spend query selected, so a
// test can assert WHICH cost the budget gate is actually measuring — not just
// that it issued a query. See the total-spend test at the bottom.
let spendExpressions: string[] = [];
// True: a day of the window is still pending, so budgetSpends falls back from
// gateway_spend_daily to the log SUM. False: the running total answers alone.
let pendingDay = true;
// The table of every spend statement issued, in order.
let spendStatements: string[] = [];
let budgetRows: Array<{
  budgetId?: string;
  scope: 'project' | 'member';
  subjectUserId: string | null;
  limitUsd: string;
  period: 'day' | 'week' | 'month';
  action: 'block' | 'warn';
}> = [];

mock.module('../shared/db', () => ({
  db: {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        // The real SQL of both paths runs against PostgreSQL in
        // llm-gateway/gateway-spend-daily.integration.test.ts.
        where: async () => {
          if (table === gatewayBudgets) return budgetRows;
          if (table !== gatewaySpendDaily && table !== gatewayRequestLogs) {
            throw new Error('unexpected table in mocked db.select().from()');
          }
          spendStatements.push(table === gatewaySpendDaily ? 'daily' : 'logs');
          if (table === gatewaySpendDaily && pendingDay) return [{ pending: true }];
          // One statement for every budget: one `b<i>` field per budget, in order.
          const row: Record<string, unknown> = { pending: false };
          for (const [key, expression] of Object.entries(fields ?? {})) {
            if (!/^b\d+$/.test(key)) continue;
            if (table === gatewayRequestLogs) spendExpressions.push(new PgDialect().sqlToQuery(expression as SQL).sql);
            row[key] = spendQueue.length ? spendQueue.shift()! : 0;
          }
          return [row];
        },
      }),
    }),
  },
}));

const { checkBudget, releaseBudgetReservation, __resetBudgetReservationsForTests } = await import(
  '../llm-gateway/budgets'
);

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
    spendExpressions = [];
    spendStatements = [];
    pendingDay = true;
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
      expect(result.message).toContain('5,000 credits/day');
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
      spendQueue = [10, 0];
      const result = await checkBudget(principal());
      expect(result.exceeded).toBe(true);
      expect(result.message).toContain('1,000 credits/day');
      expect(spendStatements).toHaveLength(2); // one daily-total probe + one log SUM for both budgets
    });
  });

  describe('action = "warn" — the fixed silent no-op', () => {
    test('a warn budget over its limit is reported in `warnings`, never blocks', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '50', period: 'day', action: 'warn' },
      ];
      spendQueue = [75];
      const result = await checkBudget(principal(), 'warn');
      expect(result.exceeded).toBe(false);
      expect(result.warnings).toBeDefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]).toContain('5,000 credits/day');
    });

    test('a warn budget under its limit produces no warning', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '50', period: 'day', action: 'warn' },
      ];
      spendQueue = [10];
      const result = await checkBudget(principal(), 'warn');
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
      const mine = await checkBudget(principal({ userId: 'user-1' }), 'warn');
      expect(mine.warnings).toHaveLength(1);

      spendQueue = [];
      const someoneElse = await checkBudget(principal({ userId: 'user-2' }), 'warn');
      expect(someoneElse.warnings).toBeUndefined();
    });
  });

  describe('mixed block + warn budgets on the same project', () => {
    test('admission evaluates only block budgets: a warn budget costs no spend query', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '10', period: 'day', action: 'warn' },
        { scope: 'project', subjectUserId: null, limitUsd: '20', period: 'month', action: 'block' },
      ];
      spendQueue = [25];
      const result = await checkBudget(principal());
      expect(result.exceeded).toBe(true);
      expect(result.warnings).toBeUndefined();
      expect(spendExpressions).toHaveLength(1);
    });

    test('a warn-only project issues no spend query at admission', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '10', period: 'day', action: 'warn' },
      ];
      spendQueue = [15];
      expect(await checkBudget(principal())).toEqual({ exceeded: false });
      expect(spendExpressions).toHaveLength(0);
    });

    test('settlement evaluates only warn budgets: never blocks, never reserves', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '10', period: 'day', action: 'warn' },
        { scope: 'project', subjectUserId: null, limitUsd: '20', period: 'month', action: 'block' },
      ];
      budgetRows[0]!.budgetId = 'warn-1';
      budgetRows[1]!.budgetId = 'block-1';
      spendQueue = [15, 25];
      const result = await checkBudget(principal(), 'warn');
      expect(result.exceeded).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.crossings?.map((c) => c.action)).toEqual(['warn']);
      expect(spendExpressions).toHaveLength(1);
    });

    test('two separate warn budgets both exceeded are both reported', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '10', period: 'day', action: 'warn' },
        { scope: 'project', subjectUserId: null, limitUsd: '50', period: 'month', action: 'warn' },
      ];
      spendQueue = [15, 60];
      const result = await checkBudget(principal(), 'warn');
      expect(result.exceeded).toBe(false);
      expect(result.warnings).toHaveLength(2);
    });
  });

  describe('in-flight admission reservation (BILLING-CORRECTNESS: concurrent check-then-act race)', () => {
    // Every concurrent checkBudget call under test reads the SAME `spent`
    // value from gatewayRequestLogs (nothing has settled yet — that's the
    // whole bug) but each call still gets its own budgetSpends query, so we
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

    test('settled requests release their reservation: sequential calls under a low budget keep running', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '2', period: 'day', action: 'block' },
      ];
      // 30 sequential calls with real spend near $0: each one settles before
      // the next is admitted. The held $0.50 per call used to deny the 5th.
      for (let i = 0; i < 30; i++) {
        spendQueue = [0.01 * i];
        const result = await checkBudget(principal());
        expect(result.exceeded).toBe(false);
        releaseBudgetReservation('project-1', 'user-1');
      }
    });

    test('a member budget reservation is released by that member\'s settlement', async () => {
      budgetRows = [
        { scope: 'member', subjectUserId: 'user-1', limitUsd: '1', period: 'day', action: 'block' },
      ];
      spendQueue = [0.4];
      expect((await checkBudget(principal())).exceeded).toBe(false);
      spendQueue = [0.4];
      // In flight: 0.4 spent + 0.5 reserved + this admission's check → still 0.9 < 1.
      expect((await checkBudget(principal())).exceeded).toBe(false);
      spendQueue = [0.4];
      // Two reservations held: 0.4 + 1.0 >= 1 → denied.
      expect((await checkBudget(principal())).exceeded).toBe(true);
      releaseBudgetReservation('project-1', 'user-1');
      releaseBudgetReservation('project-1', 'user-1');
      spendQueue = [0.4];
      expect((await checkBudget(principal())).exceeded).toBe(false);
    });

    test('a warn-only budget never reserves — concurrent warn checks never affect each other', async () => {
      budgetRows = [
        { scope: 'project', subjectUserId: null, limitUsd: '5', period: 'day', action: 'warn' },
      ];
      spendQueue = [10, 10, 10];
      const results = await Promise.all([
        checkBudget(principal(), 'warn'),
        checkBudget(principal(), 'warn'),
        checkBudget(principal(), 'warn'),
      ]);
      expect(results.every((r) => !r.exceeded)).toBe(true);
      expect(results.every((r) => (r.warnings?.length ?? 0) === 1)).toBe(true);
    });
  });
});

/**
 * BILLING-CORRECTNESS: the gate measured spend with `sum(final_cost)`, which is
 * what KORTIX billed. A BYOK route resolves to `billingMode: 'none'` with
 * `markup: 0` (resolve-candidates.ts), so `final_cost` is 0 on every one of its
 * requests — a "$50/month" budget on a BYOK project could never reach its limit
 * and was silently inert no matter how many tokens the project burned.
 *
 * Asserted on the rendered SQL rather than on a mocked number: the number comes
 * from `spendQueue` here, so only the expression itself can prove which cost
 * the gate reads. See shared/llm-spend.ts.
 */
describe('checkBudget spend measurement', () => {
  beforeEach(() => {
    spendQueue = [];
    spendExpressions = [];
    spendStatements = [];
    pendingDay = true;
    budgetRows = [];
    __resetBudgetReservationsForTests();
  });

  test('measures TOTAL spend, so a BYOK project budget is enforceable', async () => {
    budgetRows = [
      {
        scope: 'project',
        subjectUserId: null,
        limitUsd: '50',
        period: 'month',
        action: 'block',
      },
    ];
    spendQueue = [10];

    await checkBudget(principal());

    expect(spendExpressions).toHaveLength(1);
    const [expression] = spendExpressions;
    // The BYOK side — absent from the old `sum(final_cost)` query entirely.
    expect(expression).toContain('upstream_cost_precise');
    // The Kortix-billed side, still counted.
    expect(expression).toContain('final_cost_precise');
    // ...and excluded on managed rows, where the upstream price is Kortix's own
    // cost of goods and was never the caller's spend.
    expect(expression).toContain("'credits'");
  });

  test('a BYOK project whose total spend passes the limit is blocked', async () => {
    budgetRows = [
      { scope: 'project', subjectUserId: null, limitUsd: '5', period: 'month', action: 'block' },
    ];
    // All of it provider-billed: under the old final_cost-only measurement this
    // same project reported 0 and sailed through every check.
    spendQueue = [12.6];

    const result = await checkBudget(principal());

    expect(result.exceeded).toBe(true);
    expect(result.message).toContain('1,260 credits used this month');
  });
});

/**
 * BILLING-CORRECTNESS: once no day of the window is pending, the admission
 * gate decides on the running total gateway_spend_daily alone, in ONE
 * statement for every budget of the action (no log SUM, no second round trip).
 */
describe('checkBudget on the running total', () => {
  beforeEach(() => {
    spendQueue = [];
    spendExpressions = [];
    spendStatements = [];
    pendingDay = false;
    budgetRows = [];
    __resetBudgetReservationsForTests();
  });

  test('a block budget past its limit denies the request from one daily-total statement', async () => {
    budgetRows = [
      { scope: 'project', subjectUserId: null, limitUsd: '100', period: 'month', action: 'block' },
      { scope: 'member', subjectUserId: 'user-1', limitUsd: '5', period: 'day', action: 'block' },
    ];
    spendQueue = [20, 6];
    const result = await checkBudget(principal());
    expect(spendStatements).toEqual(['daily']);
    expect(result.exceeded).toBe(true);
    expect(result.message).toContain('Your gateway budget (500 credits/day)');
    expect(result.message).toContain('600 credits used this day');
  });

  test('under every limit → admitted, still one statement', async () => {
    budgetRows = [
      { scope: 'project', subjectUserId: null, limitUsd: '100', period: 'month', action: 'block' },
      { scope: 'project', subjectUserId: null, limitUsd: '10', period: 'week', action: 'block' },
    ];
    spendQueue = [20, 2];
    expect((await checkBudget(principal())).exceeded).toBe(false);
    expect(spendStatements).toEqual(['daily']);
  });

  test('a pending day falls back to the log SUM for the decision', async () => {
    pendingDay = true;
    budgetRows = [{ scope: 'project', subjectUserId: null, limitUsd: '5', period: 'day', action: 'block' }];
    spendQueue = [7];
    const result = await checkBudget(principal());
    expect(spendStatements).toEqual(['daily', 'logs']);
    expect(result.exceeded).toBe(true);
  });
});
