// `export {}` forces module mode: a file with no top-level import/export is a
// script to TS, where top-level `await` is rejected and `screen` below would
// merge with the ambient DOM `Screen` global instead of testing-library's type.
export {};

// Same `@happy-dom/global-registrator` + dynamic-import dance
// `runtime-view.test.tsx` / `models-view-runtime-link.test.tsx` establish — a
// plain static `import { screen } from '@testing-library/react'` evaluates
// before `GlobalRegistrator` registers (ESM hoists static imports), leaving
// `screen` stuck on its permanently-throwing "no document" stub. Only
// dynamic `import()` under top-level `await` forces registration first.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, render, screen } = await import('@testing-library/react');
const ReactModule = await import('react');

// `LlmManagementView` calls raw `useIsMutating`/`useQuery`/`useMutation`/
// `useQueryClient` directly (through itself and through `useModelDefaults`) —
// no `QueryClientProvider` in this DOM-free-by-default harness, mocked at the
// module boundary, same convention `runtime-view.test.tsx` uses.
const actualReactQuery = await import('@tanstack/react-query');
mock.module('@tanstack/react-query', () => ({
  ...actualReactQuery,
  useQuery: () => ({ data: undefined, isLoading: false, isPending: false, isError: false }),
  useMutation: () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
  useIsMutating: () => 0,
}));

let canWriteMock = true;
mock.module('@/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: canWriteMock, reason: null, isLoading: false, isError: false }),
}));

mock.module('@/hooks/projects/use-project-gateway', () => ({
  useGatewayKeys: () => ({ data: undefined, isError: false }),
}));

// Every heavy per-surface view is a real component with its own data
// fetching (spend charts, log tables, routing policy editors, …) — this
// suite is only about the shell (3 top-level tabs + sub-tab regrouping +
// deep-link routing), so each is stubbed to a plain marker, same convention
// `next/image` gets stubbed with below.
mock.module('@/features/workspace/customize/sections/llm-provider/models-view', () => ({
  ModelsView: () => ReactModule.createElement('div', null, 'ModelsView marker'),
}));
mock.module('@/features/workspace/customize/sections/view/gateway/gateway-overview', () => ({
  GatewayOverview: () => ReactModule.createElement('div', null, 'GatewayOverview marker'),
}));
mock.module('@/features/workspace/customize/sections/view/gateway/gateway-logs', () => ({
  GatewayLogs: () => ReactModule.createElement('div', null, 'GatewayLogs marker'),
}));
mock.module('@/features/workspace/customize/sections/view/gateway/gateway-budgets', () => ({
  GatewayBudgets: () => ReactModule.createElement('div', null, 'GatewayBudgets marker'),
}));
mock.module('@/features/workspace/customize/sections/view/gateway/gateway-routing', () => ({
  GatewayRouting: () => ReactModule.createElement('div', null, 'GatewayRouting marker'),
}));
mock.module('@/features/workspace/customize/sections/view/gateway/gateway-playground', () => ({
  GatewayPlayground: () => ReactModule.createElement('div', null, 'GatewayPlayground marker'),
}));
mock.module('@/features/workspace/customize/sections/view/gateway/gateway-keys', () => ({
  GatewayKeys: () => ReactModule.createElement('div', null, 'GatewayKeys marker'),
}));
mock.module('@/features/workspace/customize/sections/view/gateway/gateway-api-reference', () => ({
  GatewayApiReference: () => ReactModule.createElement('div', null, 'GatewayApiReference marker'),
}));
mock.module('@/features/session/model-selector', () => ({
  ModelSelector: () => null,
}));

const { LlmManagementView } = await import('./gateway-view');
const { useCustomizeStore } = await import('@/stores/customize-store');

const PROJECT_ID = 'proj_1';

afterEach(() => {
  cleanup();
  canWriteMock = true;
  useCustomizeStore.setState({ open: true, section: 'llm-management' });
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('LlmManagementView — Task 16 Models section IA (3 top-level tabs)', () => {
  test('shows exactly 3 top-level tabs labeled Models / Usage / Developer', () => {
    useCustomizeStore.setState({ open: true, section: 'llm-management' });
    render(<LlmManagementView projectId={PROJECT_ID} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Models', 'Usage', 'Developer']);
  });

  test('defaults to the Models tab', () => {
    useCustomizeStore.setState({ open: true, section: 'llm-management' });
    render(<LlmManagementView projectId={PROJECT_ID} />);

    expect(screen.getByText('ModelsView marker')).toBeDefined();
    expect(screen.queryByText('GatewayOverview marker')).toBeNull();
    expect(screen.queryByText('GatewayRouting marker')).toBeNull();
  });

  test('deep-linking to the llm-providers section also lands on Models', () => {
    useCustomizeStore.setState({ open: true, section: 'llm-providers' });
    render(<LlmManagementView projectId={PROJECT_ID} />);

    expect(screen.getByText('ModelsView marker')).toBeDefined();
  });

  test('deep-linking to llm-logs lands on Usage with the Activity sub-tab active', () => {
    useCustomizeStore.setState({ open: true, section: 'llm-logs' });
    render(<LlmManagementView projectId={PROJECT_ID} />);

    // Usage's sub-tab row is mounted (Radix only renders the active
    // top-level TabsContent's children), and Activity (-> GatewayLogs) is
    // the active sub-tab — Overview/Limits' panels stay unmounted.
    expect(screen.getByText('GatewayLogs marker')).toBeDefined();
    expect(screen.queryByText('GatewayOverview marker')).toBeNull();
    expect(screen.queryByText('GatewayBudgets marker')).toBeNull();
    expect(screen.getByText('Overview')).toBeDefined();
    expect(screen.getByText('Activity')).toBeDefined();
    expect(screen.getByText('Limits')).toBeDefined();
  });

  test('deep-linking to llm-overview lands on Usage with the Overview sub-tab active', () => {
    useCustomizeStore.setState({ open: true, section: 'llm-overview' });
    render(<LlmManagementView projectId={PROJECT_ID} />);

    expect(screen.getByText('GatewayOverview marker')).toBeDefined();
    expect(screen.queryByText('GatewayLogs marker')).toBeNull();
  });

  test('deep-linking to llm-budgets lands on Usage with the Limits sub-tab active', () => {
    useCustomizeStore.setState({ open: true, section: 'llm-budgets' });
    render(<LlmManagementView projectId={PROJECT_ID} />);

    expect(screen.getByText('GatewayBudgets marker')).toBeDefined();
    expect(screen.queryByText('GatewayOverview marker')).toBeNull();
  });

  test('deep-linking to llm-keys lands on Developer with the API access sub-tab active', () => {
    useCustomizeStore.setState({ open: true, section: 'llm-keys' });
    render(<LlmManagementView projectId={PROJECT_ID} />);

    expect(screen.getByText('GatewayKeys marker')).toBeDefined();
    expect(screen.getByText('GatewayApiReference marker')).toBeDefined();
    expect(screen.queryByText('GatewayRouting marker')).toBeNull();
    expect(screen.getByText('Routing')).toBeDefined();
    expect(screen.getByText('Playground')).toBeDefined();
    expect(screen.getByText('API access')).toBeDefined();
  });

  test('deep-linking to llm-api also lands on Developer with the API access sub-tab active', () => {
    useCustomizeStore.setState({ open: true, section: 'llm-api' });
    render(<LlmManagementView projectId={PROJECT_ID} />);

    expect(screen.getByText('GatewayKeys marker')).toBeDefined();
    expect(screen.getByText('GatewayApiReference marker')).toBeDefined();
  });
});
