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

let budgetsQuery = okQuery();

mock.module('@/hooks/projects/use-project-gateway', () => ({
  useGatewayBudgets: () => budgetsQuery,
  useSetGatewayBudget: () => ({ mutate: () => {}, isPending: false }),
  useDeleteGatewayBudget: () => ({ mutate: () => {}, isPending: false }),
}));

const { GatewayBudgets } = await import('./gateway-budgets');

afterEach(() => {
  cleanup();
  budgetsQuery = okQuery();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('GatewayBudgets — loading/error standardization', () => {
  test('shows a shape-matched skeleton (no panel titles yet) while budgets load', () => {
    budgetsQuery = okQuery({ isLoading: true });
    const { container } = render(<GatewayBudgets projectId="proj_1" />);

    expect(screen.queryByText('Project budget')).toBeNull();
    expect(screen.queryByText('Members')).toBeNull();
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  test('a fetch error renders ErrorState with a Retry button instead of an empty budget of $0', () => {
    const refetch = mock(() => {});
    budgetsQuery = okQuery({ isError: true, error: new Error('network down'), refetch });
    render(<GatewayBudgets projectId="proj_1" />);

    expect(screen.queryByText('Project budget')).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();
  });

  test('clicking Retry calls refetch on the failed query', () => {
    const refetch = mock(() => {});
    budgetsQuery = okQuery({ isError: true, error: new Error('network down'), refetch });
    render(<GatewayBudgets projectId="proj_1" />);

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  test('a genuinely empty (but successful) response still renders the real panels, not an error', () => {
    budgetsQuery = okQuery({ data: { budgets: [], members: [], project_spend: { cost: 0 } } });
    render(<GatewayBudgets projectId="proj_1" />);

    expect(screen.getByText('Project budget')).toBeDefined();
    expect(screen.getByText('No member activity yet.')).toBeDefined();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  // The mutations here (set/delete budget) invalidate this same query on
  // success. If that refetch fails, React Query flips isError true while
  // `data` still holds the last-good response — the working panel must keep
  // rendering, not get replaced by a full-page ErrorState.
  test('isError alongside still-present data (a failed background refetch) keeps rendering the panels, not ErrorState', () => {
    budgetsQuery = okQuery({
      isError: true,
      error: new Error('refetch failed'),
      data: { budgets: [], members: [], project_spend: { cost: 0 } },
    });
    render(<GatewayBudgets projectId="proj_1" />);

    expect(screen.getByText('Project budget')).toBeDefined();
    expect(screen.getByText('No member activity yet.')).toBeDefined();
    expect(screen.queryByText("Couldn't load budgets")).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});
