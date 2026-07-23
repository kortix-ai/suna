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

let logsQuery = okQuery();

mock.module('@/hooks/projects/use-project-gateway', () => ({
  useGatewayLogs: () => logsQuery,
  useGatewayLog: () => okQuery(),
}));

const { GatewayLogs } = await import('./gateway-logs');

afterEach(() => {
  cleanup();
  logsQuery = okQuery();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('GatewayLogs — loading/error standardization', () => {
  test('shows a shape-matched skeleton (no rows, no empty copy) while logs load', () => {
    logsQuery = okQuery({ isLoading: true });
    const { container } = render(<GatewayLogs projectId="proj_1" />);

    expect(screen.queryByText('No requests yet')).toBeNull();
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  test('a fetch error renders ErrorState with a Retry button instead of the empty-logs copy', () => {
    const refetch = mock(() => {});
    logsQuery = okQuery({ isError: true, error: new Error('network down'), refetch });
    render(<GatewayLogs projectId="proj_1" />);

    expect(screen.queryByText('No requests yet')).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();
  });

  test('clicking Retry calls refetch on the failed query', () => {
    const refetch = mock(() => {});
    logsQuery = okQuery({ isError: true, error: new Error('network down'), refetch });
    render(<GatewayLogs projectId="proj_1" />);

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  test('a genuinely empty (but successful) response renders the real empty state, not an error', () => {
    logsQuery = okQuery({ data: { logs: [] } });
    render(<GatewayLogs projectId="proj_1" />);

    expect(screen.getByText('No requests yet')).toBeDefined();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});
