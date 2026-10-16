import type { AccountState } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CreditsView } from '@/features/workspace/settings/tabs/credits-tab';

import en from '../../../translations/en.json';
import { AccountOverviewView } from './account-overview';

/**
 * Both balance cards — the account Billing tab and the settings Credits pane —
 * lead with credits (1 credit = $0.01) and print the dollar equivalent under
 * them. Spend this period reads in credits too. The plan's monthly price stays
 * in dollars: it is a price, not an amount the account holds.
 */
function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
      {node}
    </NextIntlClientProvider>,
  );
}

function state(total: number): AccountState {
  return {
    plan: { key: 'credits', family: 'credits', label: 'Credits', sublabel: null, monthly_usd: 3000 },
    subscription: {
      status: 'active',
      cancel_at_period_end: false,
      current_period_end: 1_794_657_600,
      scheduled_change: null,
    },
    credits: { total, monthly: 0, extra: total, can_run: total > 0 },
    tier: { monthly_credits: 0 },
    usage_this_period: {
      compute_usd: 112.29,
      llm_usd: 54.2,
      total_usd: 166.49,
      period_start: '2026-10-14T00:00:00.000Z',
      period_end: '2026-11-14T00:00:00.000Z',
    },
  } as unknown as AccountState;
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('AccountOverviewView', () => {
  test('the balance is credits, with the dollar equivalent under it', () => {
    const out = text(render(<AccountOverviewView state={state(868.15)} />));
    expect(out).toContain('86,815 credits');
    expect(out).toContain('≈ $868.15');
    expect(out).not.toContain('Available balance $');
  });

  test('spend this period is credits: compute, LLM and the total', () => {
    const out = text(render(<AccountOverviewView state={state(868.15)} />));
    expect(out).toContain('11,229 credits');
    expect(out).toContain('5,420 credits');
    expect(out).toContain('Spent this period 16,649 credits');
    expect(out).not.toContain('$166.49');
  });

  test('the plan price stays in dollars and the renewal date shows', () => {
    const out = text(render(<AccountOverviewView state={state(868.15)} />));
    expect(out).toContain('$3,000/mo');
    expect(out).toContain('Renews Nov 14');
  });

  test('a negative balance is red credits, and the dollar line says owed', () => {
    const html = render(<AccountOverviewView state={state(-3.2)} />);
    expect(html).toContain('text-kortix-red');
    expect(text(html)).toContain('-320 credits');
    expect(text(html)).toContain('≈ $3.20 owed');
  });
});

describe('CreditsView', () => {
  test('the balance and spend this period read in credits', () => {
    const out = text(render(<CreditsView state={state(868.15)} />));
    expect(out).toContain('86,815 credits');
    expect(out).toContain('≈ $868.15');
    expect(out).toContain('11,229 credits');
    expect(out).toContain('16,649 credits');
    expect(out).not.toContain('$166.49');
  });

  test('one credit reads singular', () => {
    const out = text(render(<CreditsView state={state(0.01)} />));
    expect(out).toContain('1 credit ');
  });
});
