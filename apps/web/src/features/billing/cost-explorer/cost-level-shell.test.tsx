import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CostLevelShell } from './cost-level-shell';

const baseRange = { preset: '30d' as const, from: 'F', to: 'T' };

// A real two-point series so the chart has enough data to actually render
// (CostChart itself renders nothing below two points — see cost-chart.tsx).
const summaryWithChartableSeries = {
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
  series: [
    { day: '2026-07-01', llm_cost: 1.5, compute_cost: 0.5, total_cost: 2 },
    { day: '2026-07-02', llm_cost: 2, compute_cost: 1, total_cost: 3 },
  ],
  models: [],
};

describe('CostLevelShell', () => {
  test('renders the range picker, tiles and the table slot', () => {
    const html = renderToStaticMarkup(
      <CostLevelShell
        range={baseRange}
        onRangeChange={() => {}}
        summary={undefined}
        isSummaryLoading={false}
        summaryError={null}
      >
        <div data-testid="table-slot">rows</div>
      </CostLevelShell>,
    );
    expect(html).toContain('Last 30 days');
    expect(html).toContain('table-slot');
  });

  test('surfaces a summary error instead of rendering empty tiles', () => {
    const html = renderToStaticMarkup(
      <CostLevelShell
        range={baseRange}
        onRangeChange={() => {}}
        summary={undefined}
        isSummaryLoading={false}
        summaryError={new Error('upstream unavailable')}
      >
        <div />
      </CostLevelShell>,
    );
    expect(html).toContain('upstream unavailable');
  });

  test('renders no error banner when summaryError is null', () => {
    const html = renderToStaticMarkup(
      <CostLevelShell
        range={baseRange}
        onRangeChange={() => {}}
        summary={undefined}
        isSummaryLoading={false}
        summaryError={null}
      >
        <div />
      </CostLevelShell>,
    );
    expect(html).not.toContain('Failed to load cost summary');
  });

  test('renders the chart when showChart is left unset and the series is chartable', () => {
    const html = renderToStaticMarkup(
      <CostLevelShell
        range={baseRange}
        onRangeChange={() => {}}
        summary={summaryWithChartableSeries}
        isSummaryLoading={false}
        summaryError={null}
      >
        <div />
      </CostLevelShell>,
    );
    expect(html).toContain('data-slot="chart"');
  });

  test('omits the chart when showChart is explicitly false, even with a chartable series', () => {
    const html = renderToStaticMarkup(
      <CostLevelShell
        range={baseRange}
        onRangeChange={() => {}}
        summary={summaryWithChartableSeries}
        isSummaryLoading={false}
        summaryError={null}
        showChart={false}
      >
        <div />
      </CostLevelShell>,
    );
    expect(html).not.toContain('data-slot="chart"');
  });

  test('renders the actual children content, not just a wrapper', () => {
    const html = renderToStaticMarkup(
      <CostLevelShell
        range={baseRange}
        onRangeChange={() => {}}
        summary={undefined}
        isSummaryLoading={false}
        summaryError={null}
      >
        <div data-testid="sentinel">unique-child-marker-42</div>
      </CostLevelShell>,
    );
    expect(html).toContain('unique-child-marker-42');
  });

  test('renders the controls slot beside the date range picker', () => {
    const html = renderToStaticMarkup(
      <CostLevelShell
        range={baseRange}
        onRangeChange={() => {}}
        summary={undefined}
        isSummaryLoading={false}
        summaryError={null}
        controls={<button type="button">export-marker</button>}
      >
        <div />
      </CostLevelShell>,
    );
    expect(html).toContain('export-marker');
  });
});
