import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CostSummaryTiles, formatPeriodDelta } from './cost-summary-tiles';

describe('formatPeriodDelta', () => {
  test('reports a rise against the prior window', () => {
    expect(formatPeriodDelta(46.42, 37.74)).toEqual({ label: '+23%', direction: 'up' });
  });

  test('reports a fall', () => {
    expect(formatPeriodDelta(50, 100)).toEqual({ label: '-50%', direction: 'down' });
  });

  test('returns null when the prior window had no spend', () => {
    expect(formatPeriodDelta(10, 0)).toBeNull();
  });

  test('reports flat when unchanged', () => {
    expect(formatPeriodDelta(10, 10)).toEqual({ label: '0%', direction: 'flat' });
  });

  test('returns null when the prior window was negative (corrupt data guard)', () => {
    expect(formatPeriodDelta(10, -5)).toBeNull();
  });
});

const baseSummary = {
  totals: {
    llm_cost: 12.4,
    compute_cost: 34.02,
    total_cost: 46.42,
    request_count: 100,
    compute_seconds: 3600,
    session_count: 41,
    project_count: 3,
  },
  previous: { total_cost: 37.74 },
  series: [],
  models: [],
};

describe('CostSummaryTiles', () => {
  test('renders the total and the delta against the prior window', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={false} extraTiles={[]} summary={baseSummary} />,
    );
    expect(html).toContain('$46.42');
    expect(html).toContain('+23%');
  });

  test('renders LLM and compute tiles without a delta of their own', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={false} extraTiles={[]} summary={baseSummary} />,
    );
    expect(html).toContain('$12.40');
    expect(html).toContain('$34.02');
    // Only the total tile shows a period delta — "%" must appear exactly once.
    expect(html.match(/%/g)?.length ?? 0).toBe(1);
  });

  test('never renders the delta as a coloured badge or with green/red text', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={false} extraTiles={[]} summary={baseSummary} />,
    );
    expect(html).not.toContain('data-slot="badge"');

    // Scoped to the delta paragraph's own class attribute — a global
    // `not.toContain('data-slot="badge"')` alone would still pass if the
    // delta were colour-coded directly (e.g. `text-kortix-red` on the <p>)
    // without ever introducing a Badge. Extract that paragraph's className
    // and assert no direction-coded colour landed on it specifically.
    const deltaParagraph = html.match(/<p class="([^"]*)">\+23% vs prior period<\/p>/);
    expect(deltaParagraph).not.toBeNull();
    expect(deltaParagraph![1]).not.toMatch(/text-kortix-(green|red)/);
  });

  test('suppresses the delta entirely when the prior window had no spend', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles
        isLoading={false}
        extraTiles={[]}
        summary={{ ...baseSummary, previous: { total_cost: 0 } }}
      />,
    );
    expect(html).toContain('$46.42');
    expect(html).not.toContain('%');
  });

  test('renders extra caller-supplied tiles alongside the fixed three', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles
        isLoading={false}
        extraTiles={[
          { label: 'Sessions', value: '41' },
          { label: 'Projects', value: '3' },
        ]}
        summary={baseSummary}
      />,
    );
    expect(html).toContain('Sessions');
    expect(html).toContain('41');
    expect(html).toContain('Projects');
  });

  test('shows a skeleton instead of figures while loading, never a spinner icon', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={true} extraTiles={[]} summary={undefined} />,
    );
    expect(html).not.toContain('$46.42');
    expect(html).not.toContain('animate-spin');
    expect(html).toContain('animate-pulse');
  });

  test('renders a loading skeleton when no summary is available yet, even if isLoading is stale-false', () => {
    const html = renderToStaticMarkup(
      <CostSummaryTiles isLoading={false} extraTiles={[]} summary={undefined} />,
    );
    expect(html).toContain('animate-pulse');
  });
});
