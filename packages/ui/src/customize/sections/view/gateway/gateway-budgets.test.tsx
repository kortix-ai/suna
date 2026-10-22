import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { GatewayBudgetRow, GatewayBudgetsResponse } from '@kortix/sdk';

/**
 * The budgets panel reads every meter, percentage and alert from that budget's
 * own `spent_usd` (KRTX-1725). It used to divide month-to-date spend by the
 * limit, so a $20/day budget with $15 today and $280 this month read
 * "1400% used" under "Budget exceeded" while the gateway admitted requests.
 *
 * Spend and limits read in credits (1 credit = $0.01); the API keeps USD.
 */

let data: GatewayBudgetsResponse;
mock.module('@kortix/sdk/react', () => ({
  useGatewayBudgets: () => ({ data }),
  useSetGatewayBudget: () => ({ mutate: () => {}, isPending: false }),
  useDeleteGatewayBudget: () => ({ mutate: () => {}, isPending: false }),
}));

const { GatewayBudgetSection, budgetLimitInput, budgetLimitUsd } = await import('./gateway-budgets');

const RESET = '2026-10-14T00:00:00.000Z';
const budget = (row: Partial<GatewayBudgetRow>): GatewayBudgetRow => ({
  budget_id: crypto.randomUUID(),
  scope: 'project',
  subject_user_id: null,
  limit_usd: 20,
  period: 'day',
  action: 'block',
  period_start: '2026-10-13T00:00:00.000Z',
  resets_at: RESET,
  ...row,
});

function text(): string {
  return renderToStaticMarkup(<GatewayBudgetSection projectId="p1" canWrite />)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// The reset time is formatted in the viewer's zone: pin it. ICU versions join
// the date and the time with ", " or " at ".
const resets = (day: string) => new RegExp(`Resets ${day}(,| at) 12:00 AM UTC`);
let zone: string | undefined;
beforeAll(() => {
  zone = process.env.TZ;
  process.env.TZ = 'UTC';
});
afterAll(() => {
  // Bun keeps its Intl default zone after `delete process.env.TZ`: reassign.
  process.env.TZ = zone ?? 'UTC';
});

describe('GatewayBudgetSection', () => {
  test('a $20/day budget with $15 today and $280 this month reads 75% of the day, with no exceeded banner', () => {
    data = {
      project_spend: { requests: 900, cost: 280 },
      budgets: [budget({ spent_usd: 15 })],
      members: [],
    };
    const out = text();
    expect(out).toContain('1,500 of 2,000 credits today · Blocks requests at the limit');
    expect(renderToStaticMarkup(<GatewayBudgetSection projectId="p1" canWrite />)).toContain(
      'aria-valuenow="75"',
    );
    expect(out).toMatch(resets('Oct 14'));
    expect(out).not.toContain('Budget exceeded');
    expect(out).not.toContain('Approaching budget');
    expect(out).not.toContain('28,000');
    expect(out).not.toContain('$');
  });

  test("a member cap reads the spend of its own period, not the member's month", () => {
    data = {
      project_spend: { requests: 900, cost: 280 },
      budgets: [budget({ scope: 'member', subject_user_id: 'u1', limit_usd: 5, spent_usd: 1 })],
      members: [{ user_id: 'u1', email: 'alice@example.test', requests: 300, cost: 50, tokens: 1 }],
    };
    const out = text();
    expect(out).toContain('alice@example.test 100 20% of 500 credits');
    expect(out).not.toContain('Budget exceeded');
    expect(out).not.toContain('Approaching budget');
  });

  test('an exhausted member cap and an approaching weekly cap alert with their reset time', () => {
    data = {
      project_spend: { requests: 900, cost: 280 },
      budgets: [
        budget({ scope: 'member', subject_user_id: 'u1', limit_usd: 5, spent_usd: 6 }),
        budget({
          scope: 'project',
          limit_usd: 100,
          period: 'week',
          action: 'warn',
          spent_usd: 85,
          resets_at: '2026-10-19T00:00:00.000Z',
        }),
      ],
      members: [{ user_id: 'u1', email: 'alice@example.test', requests: 300, cost: 6, tokens: 1 }],
    };
    const out = text();
    expect(out).toContain('Budget exceeded');
    expect(out).toMatch(
      new RegExp(`alice@example\\.test — over limit · ${resets('Oct 14').source}`),
    );
    expect(out).toMatch(new RegExp(`Project — 85% used · ${resets('Oct 19').source}`));
    expect(out).toContain('8,500 of 10,000 credits this week · Warns at the limit, never blocks');
    expect(out).toContain('alice@example.test 600 120% of 500 credits');
  });

  test("a member cap with no spend this month alerts with its member's email and keeps a row to edit it", () => {
    data = {
      project_spend: { requests: 0, cost: 0 },
      budgets: [
        budget({
          scope: 'member',
          subject_user_id: 'u2',
          subject_email: 'quiet@example.test',
          period: 'week',
          limit_usd: 10,
          spent_usd: 9,
        }),
      ],
      members: [],
    };
    const out = text();
    expect(out).toContain('Approaching budget');
    expect(out).toContain('quiet@example.test — 90% used');
    expect(out).not.toContain('A member');
    // The row carries the cap and its Remove control.
    expect(out).toContain('quiet@example.test 900 90% of 1,000 credits Edit cap Remove');
  });

  describe('a server older than KRTX-1725 sends no spent_usd', () => {
    test('a monthly project cap reads month-to-date spend, so an exceeded cap still says so', () => {
      data = {
        project_spend: { requests: 900, cost: 60 },
        budgets: [budget({ period: 'month', limit_usd: 50, spent_usd: undefined })],
        members: [],
      };
      const out = text();
      expect(out).toContain('6,000 of 5,000 credits this month · Blocks requests at the limit');
      expect(out).toContain('Budget exceeded');
      expect(out).toContain('Project — over limit');
    });

    test("a monthly member cap reads the member's month-to-date spend", () => {
      data = {
        project_spend: { requests: 900, cost: 60 },
        budgets: [
          budget({
            scope: 'member',
            subject_user_id: 'u1',
            period: 'month',
            limit_usd: 5,
            spent_usd: undefined,
          }),
        ],
        members: [
          { user_id: 'u1', email: 'alice@example.test', requests: 3, cost: 4.5, tokens: 1 },
        ],
      };
      const out = text();
      expect(out).toContain('alice@example.test 450 90% of 500 credits');
      expect(out).toContain('alice@example.test — 90% used');
    });

    test('a daily cap shows its limit with no spend, percentage, meter or alert: its spend is unknown', () => {
      data = {
        project_spend: { requests: 900, cost: 280 },
        budgets: [budget({ limit_usd: 20, spent_usd: undefined })],
        members: [],
      };
      const markup = renderToStaticMarkup(<GatewayBudgetSection projectId="p1" canWrite />);
      const out = text();
      expect(out).toContain('2,000 credits per day · Blocks requests at the limit');
      expect(out).not.toContain('% used');
      expect(out).not.toContain('$');
      expect(out).not.toContain('Budget exceeded');
      expect(out).not.toContain('Approaching budget');
      expect(markup).not.toContain('role="meter"');
    });
  });
});

describe('the budget dialog takes credits and sends USD', () => {
  test('a limit typed in credits is sent as limit_usd = credits / 100', () => {
    expect(budgetLimitUsd('5000')).toBe(50);
    expect(budgetLimitUsd('150')).toBe(1.5);
    expect(budgetLimitUsd('1')).toBe(0.01);
  });

  test('an empty or zero limit is not a limit', () => {
    expect(budgetLimitUsd('')).toBeNull();
    expect(budgetLimitUsd('0')).toBeNull();
  });

  test('an existing budget prefills its USD limit as whole credits', () => {
    expect(budgetLimitInput({ limit_usd: 20 })).toBe('2000');
    expect(budgetLimitInput({ limit_usd: 12.345 })).toBe('1235');
    expect(budgetLimitInput(null)).toBe('');
  });
});
