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

  test('surfaces the summary error message while the tiles show their loading skeleton, not empty tiles', () => {
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
    // "Instead of rendering empty tiles" is the claim in this test's name —
    // CostSummaryTiles renders its loading skeleton (not a blank/zeroed
    // tile) whenever `summary` is undefined, which this asserts directly
    // rather than just inferring it from the absence of a dollar figure.
    expect(html).toContain('aria-label="Loading cost summary"');
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

  // `summaryError` and `isSummaryLoading` are independent props (see the
  // JSDoc on `CostLevelShellProps.summaryError`) — a caller may hold a stale
  // error while a manual refetch is in flight. Pin that combination as
  // intentional: the shell must not suppress the banner just because a
  // refetch is loading, nor suppress the loading skeletons just because an
  // error is held.
  test('renders the error banner and the loading skeletons together when both are set (stale error during a refetch)', () => {
    const html = renderToStaticMarkup(
      <CostLevelShell
        range={baseRange}
        onRangeChange={() => {}}
        summary={undefined}
        isSummaryLoading={true}
        summaryError={new Error('stale-error-during-refetch')}
      >
        <div />
      </CostLevelShell>,
    );
    expect(html).toContain('stale-error-during-refetch');
    expect(html).toContain('aria-label="Loading cost summary"');
    expect(html).toContain('aria-label="Loading spend chart"');
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

  // Presence alone ("is `export-marker` in the tree somewhere") would still
  // pass if `{controls}` were moved anywhere else in the shell — e.g. beside
  // CostModelList. This asserts adjacency: the marker must fall inside the
  // control row, after the date picker's own trigger and before anything
  // that belongs to the body (the error banner, the tiles).
  test('renders the controls slot inside the control row, not merely somewhere in the tree', () => {
    const html = renderToStaticMarkup(
      <CostLevelShell
        range={baseRange}
        onRangeChange={() => {}}
        summary={undefined}
        isSummaryLoading={true}
        summaryError={new Error('controls-adjacency-error')}
        controls={<button type="button">export-marker</button>}
      >
        <div />
      </CostLevelShell>,
    );

    const pickerIndex = html.indexOf('data-slot="popover-trigger"');
    const controlsIndex = html.indexOf('export-marker');
    const errorIndex = html.indexOf('data-slot="alert"');
    const tilesIndex = html.indexOf('aria-label="Loading cost summary"');

    expect(pickerIndex).toBeGreaterThan(-1);
    expect(controlsIndex).toBeGreaterThan(-1);
    expect(errorIndex).toBeGreaterThan(-1);
    expect(tilesIndex).toBeGreaterThan(-1);

    expect(controlsIndex).toBeGreaterThan(pickerIndex);
    expect(controlsIndex).toBeLessThan(errorIndex);
    expect(controlsIndex).toBeLessThan(tilesIndex);
  });

  // The brief's primary requirement is the fixed top-to-bottom stack itself
  // — control row, error banner, tiles, chart, model list, then children.
  // Substring-presence checks (`toContain`) cannot fail on a reorder, so
  // this compares positions in the rendered HTML using markers each
  // component already owns (a `data-slot`, an `aria-label`, or — for
  // CostModelList, which emits neither — the row content it renders from
  // `models`, the same convention cost-model-list.test.tsx uses).
  //
  // Every optional gate is forced open (loading + a held error + a
  // populated model row) so all six blocks render in the same pass.
  test('renders the fixed stack in order: control row, error banner, tiles, chart, model list, children', () => {
    const summaryWithModelRow = {
      ...summaryWithChartableSeries,
      models: [{ provider: 'openai', model: 'order-marker-model', cost: 10, request_count: 3 }],
    };

    const html = renderToStaticMarkup(
      <CostLevelShell
        range={baseRange}
        onRangeChange={() => {}}
        summary={summaryWithModelRow}
        isSummaryLoading={true}
        summaryError={new Error('order-marker-error')}
      >
        <div data-testid="table-slot">order-marker-children</div>
      </CostLevelShell>,
    );

    const controlRowIndex = html.indexOf('data-slot="popover-trigger"');
    const errorBannerIndex = html.indexOf('data-slot="alert"');
    const tilesIndex = html.indexOf('aria-label="Loading cost summary"');
    const chartIndex = html.indexOf('aria-label="Loading spend chart"');
    const modelListIndex = html.indexOf('order-marker-model');
    const childrenIndex = html.indexOf('order-marker-children');

    expect(controlRowIndex).toBeGreaterThan(-1);
    expect(errorBannerIndex).toBeGreaterThan(-1);
    expect(tilesIndex).toBeGreaterThan(-1);
    expect(chartIndex).toBeGreaterThan(-1);
    expect(modelListIndex).toBeGreaterThan(-1);
    expect(childrenIndex).toBeGreaterThan(-1);

    expect(controlRowIndex).toBeLessThan(errorBannerIndex);
    expect(errorBannerIndex).toBeLessThan(tilesIndex);
    expect(tilesIndex).toBeLessThan(chartIndex);
    expect(chartIndex).toBeLessThan(modelListIndex);
    expect(modelListIndex).toBeLessThan(childrenIndex);
  });
});
