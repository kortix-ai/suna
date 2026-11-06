import type { AccountState } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import en from '../../../translations/en.json';
import { AccountOverviewView } from './account-overview';
import { FreeGrantNotice, showsFreeGrantNotice } from './free-grant-notice';

/**
 * Review finding 10: a further workspace on Free reads "Free · Active · 0
 * credits" and never says why. The Plan tab, the hub's billing pane and the
 * billing modal print one line from `credits.free_grant`.
 */
function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
        {node}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function freeState(overrides: Partial<AccountState> & { eligible?: boolean; claimed?: string | null } = {}): AccountState {
  const { eligible = false, claimed = null, ...rest } = overrides;
  return {
    plan: { key: 'free', family: 'free', label: 'Free', sublabel: null, monthly_usd: null },
    subscription: { status: 'active', cancel_at_period_end: false, current_period_end: null, scheduled_change: null },
    has_active_subscription: false,
    billing_state: 'no_subscription',
    credits: { total: 0, monthly: 0, extra: 0, can_run: false, free_grant: { eligible, claimed_workspace_id: claimed } },
    tier: { monthly_credits: 0, can_purchase_credits: true },
    plan_comp: null,
    ...rest,
  } as unknown as AccountState;
}

describe('FreeGrantNotice', () => {
  test('a further workspace on Free says it has no free credits and states the rule', () => {
    const html = text(render(<FreeGrantNotice state={freeState()} />));
    expect(html).toContain('This workspace has no free credits. Each person gets monthly free credits in one workspace: the first one they create.');
    expect(html).toContain('Add credits or pick a plan to run sessions here.');
  });

  test('the workspace that holds the free credits is not named before its record loads', () => {
    const html = text(render(<FreeGrantNotice state={freeState({ claimed: '11111111-1111-4111-8111-111111111111' })} />));
    expect(html).toContain('Each person gets monthly free credits in one workspace: the first one they create.');
  });

  test('an eligible workspace, a paid plan and a comp print nothing', () => {
    expect(showsFreeGrantNotice(freeState({ eligible: true }))).toBe(false);
    expect(showsFreeGrantNotice(freeState({ has_active_subscription: true }))).toBe(false);
    expect(showsFreeGrantNotice(freeState({ plan_comp: { until: '2026-12-01T00:00:00.000Z', source: 'workspace_split' } }))).toBe(false);
    expect(showsFreeGrantNotice(undefined)).toBe(false);
  });

  test('the billing pane of a further workspace carries the line', () => {
    expect(text(render(<AccountOverviewView state={freeState()} />))).toContain('This workspace has no free credits.');
  });
});

describe('the split-off comp label', () => {
  test('a comped plan names the date it ends and that Free follows', () => {
    const state = {
      ...freeState({ eligible: false }),
      plan: { key: 'credits', family: 'credits', label: 'Credits', sublabel: null, monthly_usd: 300 },
      plan_comp: { until: '2026-12-01T00:00:00.000Z', source: 'workspace_split' },
    } as unknown as AccountState;
    expect(text(render(<AccountOverviewView state={state} />))).toContain('No charge until Dec 1, 2026, then Free');
  });
});
