import { describe, expect, test } from 'bun:test';
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import {
  kortixBilledSpendSql,
  providerBilledSpendSql,
  rowProviderBilledSpendSql,
  rowTotalSpendSql,
  splitLlmSpend,
  totalSpendSql,
} from './llm-spend';

const render = (fragment: SQL) => new PgDialect().sqlToQuery(fragment).sql;

// The whole point of this module: "what did you spend" is NOT final_cost. The
// three billing modes route money to different payees, so each one has its own
// answer, and summing final_cost alone reports $0 for every BYOK deployment.
describe('splitLlmSpend', () => {
  test('credits: you paid Kortix — upstream_cost is Kortix COGS, never yours', () => {
    expect(
      splitLlmSpend({ billingMode: 'credits', upstreamCost: 0.0423, finalCost: 0.0846 }),
    ).toEqual({ kortix_cost: 0.0846, provider_cost: 0, total_cost: 0.0846 });
  });

  test('none (BYOK self-host / free tier): you paid the provider directly', () => {
    expect(splitLlmSpend({ billingMode: 'none', upstreamCost: 0.0423, finalCost: 0 })).toEqual({
      kortix_cost: 0,
      provider_cost: 0.0423,
      total_cost: 0.0423,
    });
  });

  test('platform-fee (BYOK on cloud): you paid the provider AND the Kortix fee', () => {
    expect(
      splitLlmSpend({ billingMode: 'platform-fee', upstreamCost: 0.05, finalCost: 0.005 }),
    ).toEqual({ kortix_cost: 0.005, provider_cost: 0.05, total_cost: 0.055 });
  });

  // billing_mode is nullable and predates the column. A legacy row that billed
  // something was a managed (credits) call; one that billed nothing was BYOK.
  // Guessing "BYOK" for every legacy row would double-count managed spend.
  test('legacy null billing_mode with a charge is treated as credits', () => {
    expect(splitLlmSpend({ billingMode: null, upstreamCost: 0.02, finalCost: 0.04 })).toEqual({
      kortix_cost: 0.04,
      provider_cost: 0,
      total_cost: 0.04,
    });
  });

  test('legacy null billing_mode with no charge is treated as BYOK', () => {
    expect(splitLlmSpend({ billingMode: null, upstreamCost: 0.02, finalCost: 0 })).toEqual({
      kortix_cost: 0,
      provider_cost: 0.02,
      total_cost: 0.02,
    });
  });

  // Numeric columns arrive from postgres as strings.
  test('accepts the numeric-as-string values drizzle returns', () => {
    expect(
      splitLlmSpend({ billingMode: 'none', upstreamCost: '0.0423000000', finalCost: '0' }),
    ).toEqual({ kortix_cost: 0, provider_cost: 0.0423, total_cost: 0.0423 });
  });

  test('a codex-subscription row (no per-request price) spends nothing', () => {
    expect(splitLlmSpend({ billingMode: 'none', upstreamCost: 0, finalCost: 0 })).toEqual({
      kortix_cost: 0,
      provider_cost: 0,
      total_cost: 0,
    });
  });
});

describe('spend SQL expressions', () => {
  test('the provider-side expression zeroes credits rows instead of leaking COGS', () => {
    const rendered = render(rowProviderBilledSpendSql);
    expect(rendered).toContain('upstream_cost_precise');
    expect(rendered).toContain("'credits'");
    expect(rendered).toContain('then 0');
  });

  test('the row total adds the provider side to the Kortix side', () => {
    const rendered = render(rowTotalSpendSql);
    expect(rendered).toContain('final_cost_precise');
    expect(rendered).toContain('upstream_cost_precise');
  });

  test('every aggregate coalesces to a float8 so an empty window reads 0, not null', () => {
    for (const aggregate of [totalSpendSql, kortixBilledSpendSql, providerBilledSpendSql]) {
      const rendered = render(aggregate);
      expect(rendered).toContain('coalesce(sum(');
      expect(rendered).toContain('::float8');
    }
  });

  test('the Kortix-billed aggregate is final_cost alone', () => {
    const rendered = render(kortixBilledSpendSql);
    expect(rendered).toContain('final_cost_precise');
    expect(rendered).not.toContain('upstream_cost_precise');
  });
});
