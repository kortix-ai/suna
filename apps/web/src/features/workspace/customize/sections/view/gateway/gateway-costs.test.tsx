import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import type { GatewayModelStat, GatewaySeriesPoint } from '@kortix/sdk';

import { CostSection, MetricTab, ShareBar, fmtCredits, fmtMs, weightedP50 } from '@kortix/ui/customize/sections/view/gateway/_metrics';
import { MemberRow } from '@kortix/ui/customize/sections/view/gateway/gateway-budgets';
import { mostSpend } from '@kortix/ui/customize/sections/view/gateway/gateway-overview';
import { uiSourcePath } from '@/test-utils/read-source';

function point(day: string, requests: number, p50: number): GatewaySeriesPoint {
  return {
    day,
    requests,
    errors: 0,
    cost: 0,
    kortix_cost: 0,
    provider_cost: 0,
    input_tokens: 0,
    output_tokens: 0,
    p50,
    p95: p50,
    p99: p50,
  };
}

function model(name: string, cost: number): GatewayModelStat {
  return { model: name, provider: 'test', requests: 1, errors: 0, cost, kortix_cost: cost, provider_cost: 0 } as GatewayModelStat;
}

describe('Costs — the latency headline', () => {
  test('weights each day’s p50 by its requests, and skips empty days', () => {
    expect(weightedP50([point('2026-10-01', 1, 1000), point('2026-10-02', 3, 3000), point('2026-10-03', 0, 99999)])).toBe(2500);
  });

  test('no requests → no number', () => {
    expect(weightedP50([])).toBeNull();
    expect(weightedP50([point('2026-10-01', 0, 500)])).toBeNull();
  });

  test('reads as ms under a second, seconds above', () => {
    expect(fmtMs(840)).toBe('840ms');
    expect(fmtMs(2800)).toBe('2.8s');
  });
});

describe('Costs — spend reads in credits', () => {
  test('a USD amount reads as credits (1 credit = $0.01)', () => {
    expect(fmtCredits(18.42)).toBe('1,842');
    expect(fmtCredits(0.004)).toBe('0.4');
    expect(fmtCredits(0.00001)).toBe('<0.01');
    expect(fmtCredits(0)).toBe('0');
    expect(fmtCredits(1234.5, 'de-DE')).toBe('123.450');
  });
});

describe('Costs — Most spend', () => {
  test('top models by spend with shares, the rest folded into one row', () => {
    const out = mostSpend([model('a', 1), model('b', 6), model('c', 2), model('d', 1)], 2);
    expect(out.named.map((r) => r.model.model)).toEqual(['b', 'c']);
    expect(out.named.map((r) => r.share)).toEqual([60, 20]);
    expect(out.rest).toEqual({ cost: 2, share: 20 });
  });

  test('no fold row when every model is named', () => {
    expect(mostSpend([model('a', 1)], 5).rest).toBeNull();
  });
});

describe('Costs — the metric picker', () => {
  test('a tab carries its label and window total, and says when it is selected', () => {
    const on = renderToStaticMarkup(
      <MetricTab label="Spend" value="1,842" unit="credits" selected onSelect={() => {}} />,
    );
    expect(on).toContain('role="tab"');
    expect(on).toContain('aria-selected="true"');
    expect(on.replace(/<[^>]+>/g, ' ')).toMatch(/1,842\s+credits/);
    expect(on).toContain('border-b-foreground');
    const off = renderToStaticMarkup(<MetricTab label="Tokens" value="60.1M" selected={false} onSelect={() => {}} />);
    expect(off).toContain('aria-selected="false"');
    expect(off).not.toContain('border-b-foreground');
  });

  test('a share bar draws one segment per part', () => {
    const out = renderToStaticMarkup(
      <ShareBar segments={[{ pct: 40, color: 'red' }, { pct: 20, color: 'blue' }]} />,
    );
    expect(out.match(/width:\d+%/g)?.length).toBe(2);
  });

  test('a section is a title row (title, description, action) over its panel', () => {
    const out = renderToStaticMarkup(
      <CostSection title="Budget" description="Cap what this project can spend" action={<button type="button">Set budget</button>}>
        <div data-panel="" />
      </CostSection>,
    );
    expect(out.indexOf('Budget')).toBeLessThan(out.indexOf('Cap what this project can spend'));
    expect(out.indexOf('Set budget')).toBeLessThan(out.indexOf('data-panel'));
  });
});

describe('Costs — member caps', () => {
  const member = { user_id: 'u1', email: 'maya@example.com', cost: 14.4 } as Parameters<typeof MemberRow>[0]['member'];
  const budget = {
    budget_id: 'b1',
    scope: 'member',
    subject_user_id: 'u1',
    limit_usd: 20,
    period: 'month',
    action: 'block',
  } as Parameters<typeof MemberRow>[0]['budget'];

  test('a capped member shows a meter, the share of the cap, Edit cap and Remove', () => {
    const out = renderToStaticMarkup(
      <MemberRow
        member={member}
        budget={budget}
        spend={{ spent: 14.4, pct: 72 }}
        canWrite
        onSetCap={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(out).toContain('role="meter"');
    expect(out).toContain('1,440');
    expect(out).toContain('72% of 2,000 credits');
    expect(out).toContain('Edit cap');
    expect(out).toContain('Remove');
  });

  test("a capped member reads the cap's own period spend, not this month's", () => {
    const daily = { ...budget, period: 'day' } as typeof budget;
    const out = renderToStaticMarkup(
      <MemberRow
        member={member}
        budget={daily}
        spend={{ spent: 5, pct: 25 }}
        canWrite
        onSetCap={() => {}}
        onRemove={() => {}}
      />,
    );
    expect(out).toContain('>500<');
    expect(out).toContain('25% of 2,000 credits');
    expect(out).not.toContain('1,440');
  });

  test('a cap whose period spend is unknown shows its limit and no meter', () => {
    const out = renderToStaticMarkup(
      <MemberRow member={member} budget={budget} canWrite onSetCap={() => {}} onRemove={() => {}} />,
    );
    expect(out.replace(/<[^>]+>/g, ' ')).toMatch(/2,000\s+credits\s+per month/);
    expect(out).not.toContain('role="meter"');
  });

  test('an uncapped member says No cap and offers Set cap', () => {
    const out = renderToStaticMarkup(
      <MemberRow member={member} budget={null} canWrite onSetCap={() => {}} onRemove={() => {}} />,
    );
    expect(out).toContain('No cap');
    expect(out).toContain('Set cap');
    expect(out).not.toContain('role="meter"');
  });

  test('read-only members get no controls', () => {
    const out = renderToStaticMarkup(
      <MemberRow member={member} budget={budget} canWrite={false} onSetCap={() => {}} onRemove={() => {}} />,
    );
    expect(out).not.toContain('Edit cap');
    expect(out).not.toContain('<button');
  });
});

describe('Costs — segmented controls come from the design system', () => {
  const budgets = readFileSync(uiSourcePath('customize/sections/view/gateway/gateway-budgets.tsx'), 'utf8');
  const metrics = readFileSync(uiSourcePath('customize/sections/view/gateway/_metrics.tsx'), 'utf8');

  test('the budget dialog’s Period and At limit use Tabs, named by their labels', () => {
    expect(budgets).not.toContain('FilterBar');
    expect(budgets).toContain('<TabsList className="w-full" aria-label={label}>');
    expect(budgets).toContain("label={tI18nComplete.raw('text6e795d4d3cc2')}");
    expect(budgets).toContain("label={tI18nComplete.raw('textcfac8a356cfe')}");
  });

  test('the 7d/30d/90d window uses Tabs too', () => {
    expect(metrics).not.toContain('FilterBar');
    expect(metrics).toContain('<TabsList size="xs">');
  });
});
