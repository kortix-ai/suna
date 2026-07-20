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
const { ApiError } = await import('@kortix/sdk');

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

let keysQuery = okQuery();

mock.module('@/hooks/projects/use-project-gateway', () => ({
  useGatewayKeys: () => keysQuery,
  useCreateGatewayKey: () => ({ mutate: () => {}, isPending: false }),
  useRevokeGatewayKey: () => ({ mutate: () => {}, isPending: false, variables: undefined }),
}));
// `GatewayKeys` also renders `GatewayApiReference` inside the reveal-key
// dialog — irrelevant to the error/loading branches under test here, stubbed
// the same way `gateway-api-access.test.tsx` stubs it.
mock.module('@/features/workspace/customize/sections/view/gateway/gateway-api-reference', () => ({
  GatewayApiReference: () => null,
}));

const { GatewayKeys } = await import('./gateway-keys');

afterEach(() => {
  cleanup();
  keysQuery = okQuery();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('GatewayKeys — loading/error standardization', () => {
  test('a 403 shows the admin-access copy with no retry and no permission-name leak', () => {
    keysQuery = okQuery({
      isError: true,
      error: new ApiError('Forbidden', { status: 403 }),
    });
    render(<GatewayKeys projectId="proj_1" canWrite={false} />);

    expect(screen.getByText('API keys need admin access')).toBeDefined();
    expect(screen.getByText('Ask a project admin.')).toBeDefined();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.queryByText(/permission/i)).toBeNull();
  });

  test('a non-403 error shows the generic failure copy with a Retry button', () => {
    const refetch = mock(() => {});
    keysQuery = okQuery({
      isError: true,
      error: new ApiError('Internal error', { status: 500 }),
      refetch,
    });
    render(<GatewayKeys projectId="proj_1" canWrite={false} />);

    expect(screen.getByText("Couldn't load API keys")).toBeDefined();
    const retry = screen.getByRole('button', { name: /retry/i });
    expect(retry).toBeDefined();
    fireEvent.click(retry);
    expect(refetch).toHaveBeenCalled();
  });

  test('a plain (non-ApiError) error also falls back to the generic failure copy with Retry', () => {
    keysQuery = okQuery({ isError: true, error: new Error('boom') });
    render(<GatewayKeys projectId="proj_1" canWrite={false} />);

    expect(screen.getByText("Couldn't load API keys")).toBeDefined();
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();
  });

  test('a successful, genuinely empty response still shows the real empty state, not an error', () => {
    keysQuery = okQuery({ data: { keys: [], gateway_url: null } });
    render(<GatewayKeys projectId="proj_1" canWrite={false} />);

    expect(screen.getByText('No keys yet')).toBeDefined();
    expect(screen.queryByText('API keys need admin access')).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  // T18 follow-up: `GatewayKeys` used to own a whole tab (its own flex-grow +
  // scroll region). It now mounts stacked inside `GatewayApiAccess`'s single
  // scroll column (see gateway-api-access.tsx) alongside the API reference
  // block below it — a nested `flex-1 overflow-y-auto` here would fight the
  // parent for height and squeeze that sibling block. Guard both the success
  // and error roots directly (gateway-api-access.test.tsx stubs this
  // component to a marker, so it can't see these classes from there).
  test('does not claim its own scroll region — no flex-1/overflow-y-auto on its root', () => {
    keysQuery = okQuery({ data: { keys: [], gateway_url: null } });
    const { container } = render(<GatewayKeys projectId="proj_1" canWrite={false} />);

    const root = container.firstElementChild as HTMLElement;
    expect(root.className).not.toContain('flex-1');
    expect(root.className).not.toContain('overflow-y-auto');
  });

  test('the error root also does not claim its own scroll region', () => {
    keysQuery = okQuery({ isError: true, error: new Error('boom') });
    const { container } = render(<GatewayKeys projectId="proj_1" canWrite={false} />);

    const root = container.firstElementChild as HTMLElement;
    expect(root.className).not.toContain('flex-1');
    expect(root.className).not.toContain('overflow-y-auto');
  });

  // `createKey`/`revokeKey` invalidate this same query on success. If that
  // refetch fails, React Query flips isError true while `data` still holds
  // the last-good keys list — the working list must keep rendering, not get
  // replaced by a full-page ErrorState.
  test('isError alongside still-present data (a failed background refetch) keeps rendering the list, not ErrorState', () => {
    keysQuery = okQuery({
      isError: true,
      error: new Error('refetch failed'),
      data: { keys: [], gateway_url: null },
    });
    render(<GatewayKeys projectId="proj_1" canWrite={false} />);

    expect(screen.getByText('No keys yet')).toBeDefined();
    expect(screen.queryByText("Couldn't load API keys")).toBeNull();
    expect(screen.queryByText('API keys need admin access')).toBeNull();
  });
});
