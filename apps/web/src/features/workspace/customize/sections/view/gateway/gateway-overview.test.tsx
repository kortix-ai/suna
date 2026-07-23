// `export {}` forces module mode: a file with no top-level import/export is a
// script to TS, where top-level `await` is rejected and `screen` below would
// merge with the ambient DOM `Screen` global instead of testing-library's type.
export {};

// Same `@happy-dom/global-registrator` + dynamic-import dance
// `gateway-view.test.tsx` establishes — a plain static
// `import { screen } from '@testing-library/react'` evaluates before
// `GlobalRegistrator` registers (ESM hoists static imports), leaving `screen`
// stuck on its permanently-throwing "no document" stub. Only dynamic
// `import()` under top-level `await` forces registration first.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');

// `GatewayOverview` also fires a raw `useQuery` (session-id → name lookup) —
// stubbed the same way `gateway-view.test.tsx` stubs `@tanstack/react-query`
// wholesale so the module boundary never touches the real query client.
const actualReactQuery = await import('@tanstack/react-query');
mock.module('@tanstack/react-query', () => ({
  ...actualReactQuery,
  useQuery: () => ({ data: undefined, isLoading: false, isPending: false, isError: false }),
}));

function okQuery(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: mock(() => {}),
    ...overrides,
  };
}

let overviewQuery = okQuery();
let seriesQuery = okQuery();
let breakdownQuery = okQuery();
let sessionsQuery = okQuery();
let errorsQuery = okQuery();

mock.module('@/hooks/projects/use-project-gateway', () => ({
  useGatewayOverview: () => overviewQuery,
  useGatewaySeries: () => seriesQuery,
  useGatewayBreakdown: () => breakdownQuery,
  useGatewaySessions: () => sessionsQuery,
  useGatewayErrors: () => errorsQuery,
}));

const { GatewayOverview } = await import('./gateway-overview');

afterEach(() => {
  cleanup();
  overviewQuery = okQuery();
  seriesQuery = okQuery();
  breakdownQuery = okQuery();
  sessionsQuery = okQuery();
  errorsQuery = okQuery();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('GatewayOverview — loading/error standardization', () => {
  test('shows a shape-matched skeleton (no stat labels yet) while the overview query loads', () => {
    overviewQuery = okQuery({ isLoading: true });
    const { container } = render(<GatewayOverview projectId="proj_1" />);

    expect(screen.queryByText('Total spend')).toBeNull();
    expect(screen.queryByText('Requests')).toBeNull();
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  test('a fetch error renders ErrorState with a Retry button instead of zeros', () => {
    const refetch = mock(() => {});
    overviewQuery = okQuery({ isError: true, error: new Error('network down'), refetch });
    render(<GatewayOverview projectId="proj_1" />);

    // Today's bug: silent zeros. This must NOT be what renders on error.
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();
  });

  test('clicking Retry calls refetch on the failed query', () => {
    const refetch = mock(() => {});
    overviewQuery = okQuery({ isError: true, error: new Error('network down'), refetch });
    render(<GatewayOverview projectId="proj_1" />);

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  test('a genuinely empty (but successful) window still renders real zeros, not an error', () => {
    overviewQuery = okQuery({ data: { requests: 0, errors: 0, total_cost: 0, input_tokens: 0, output_tokens: 0 } });
    render(<GatewayOverview projectId="proj_1" />);

    expect(screen.getByText('Total spend')).toBeDefined();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  // No mutations live in this component, but the same OR-combined isError
  // gate across 5 queries must not blank a working dashboard just because
  // one query (e.g. a background refetch) is in an error state while its
  // data is still present.
  test('isError on one query alongside still-present data on any query keeps rendering the dashboard, not ErrorState', () => {
    overviewQuery = okQuery({
      isError: true,
      error: new Error('refetch failed'),
      data: { requests: 0, errors: 0, total_cost: 0, input_tokens: 0, output_tokens: 0 },
    });
    render(<GatewayOverview projectId="proj_1" />);

    expect(screen.getByText('Total spend')).toBeDefined();
    expect(screen.queryByText("Couldn't load usage")).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});
