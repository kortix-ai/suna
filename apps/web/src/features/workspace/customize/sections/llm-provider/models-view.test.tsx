// `export {}` forces module mode: a file with no top-level import/export is a
// script to TS, where top-level `await` is rejected and `screen` below would
// merge with the ambient DOM `Screen` global instead of testing-library's type.
export {};

// Same `@happy-dom/global-registrator` + dynamic-import dance
// `models-view-runtime-link.test.tsx` establishes — a plain static
// `import { screen } from '@testing-library/react'` evaluates before
// `GlobalRegistrator` registers (ESM hoists static imports), leaving `screen`
// stuck on its permanently-throwing "no document" stub. Only dynamic
// `import()` under top-level `await` forces registration first.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, render, screen } = await import('@testing-library/react');
const ReactModule = await import('react');

// `ModelsView` and its children (`ManageConnectionModal`, `useModelDefaults`,
// `useProjectModels`) call raw `useQuery`/`useMutation`/`useQueryClient`/
// `useIsMutating` directly — no `QueryClientProvider` in this DOM-free-by-
// default harness — mocked at the module boundary, same convention
// `models-view-runtime-link.test.tsx` uses.
const actualReactQuery = await import('@tanstack/react-query');
mock.module('@tanstack/react-query', () => ({
  ...actualReactQuery,
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  useMutation: () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
  useIsMutating: () => 0,
}));

let modelsPageState: import('@kortix/sdk/react').ModelsPageState = {
  runtimes: [],
  connections: [],
  connectedProviderIds: [],
  canWrite: true,
  isLoading: false,
  isError: false,
};
const actualSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...actualSdkReact,
  useModelsPage: () => modelsPageState,
}));

// The default-model picker itself (search, catalog fetch, upgrade/connect
// routing, …) is out of scope here — this suite is about ModelsView's own
// section shape, so the picker is stubbed to a marker exposing the two props
// that matter: the fallback label and the disabled flag.
mock.module('@/features/session/model-selector', () => ({
  ModelSelector: ({ unsetLabel, disabled }: { unsetLabel?: string; disabled?: boolean }) =>
    ReactModule.createElement(
      'button',
      { type: 'button', 'data-testid': 'default-model-selector', 'data-disabled': String(!!disabled) },
      unsetLabel ?? 'Default',
    ),
}));

// `ProviderLogo` (the harness mark on each runtime/connection row) renders
// `next/image`, whose `getImgProps` constructs a `URL` from the icon's
// relative asset path — happy-dom has no real page location to resolve that
// against and throws "Invalid URL", same stub `models-view-runtime-link.test.tsx`
// uses.
mock.module('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const { src, alt, ...rest } = props;
    return ReactModule.createElement('img', { src, alt, ...rest });
  },
}));

const { ModelsView } = await import('./models-view');

const PROJECT_ID = 'proj_1';

const MANAGED_GATEWAY: import('@kortix/sdk/react').ModelsPageConnection = {
  id: 'managed_gateway',
  name: 'Kortix',
  kind: 'managed_gateway',
  status: 'ready',
  usedBy: [],
  catalogState: 'available',
  modelCount: 12,
  statusReason: null,
};

const BYOK_CONNECTION: import('@kortix/sdk/react').ModelsPageConnection = {
  id: 'anthropic_api_key',
  name: 'Anthropic',
  kind: 'anthropic_api_key',
  status: 'ready',
  usedBy: [],
  catalogState: 'available',
  modelCount: 4,
  statusReason: null,
};

const resetState = () => {
  modelsPageState = {
    runtimes: [],
    connections: [],
    connectedProviderIds: [],
    canWrite: true,
    isLoading: false,
    isError: false,
  };
};

afterEach(() => {
  cleanup();
  resetState();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('ModelsView — "Default model" row (Task 17)', () => {
  test('renders a Default model Label + bordered row as the first section, with the selector', () => {
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    expect(screen.getByText('Default model')).toBeDefined();
    expect(screen.getByText("Used when an agent doesn't pick its own")).toBeDefined();
    expect(screen.getByTestId('default-model-selector')).toBeDefined();
  });

  test('the row carries the bg-popover / rounded-md / border / px-4 py-3 design-system classes', () => {
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    const row = screen.getByTestId('default-model-selector').closest('div.bg-popover');
    expect(row).not.toBeNull();
    expect(row?.className).toContain('rounded-md');
    expect(row?.className).toContain('border');
    expect(row?.className).toContain('px-4');
    expect(row?.className).toContain('py-3');
  });

  test('is omitted entirely for a read-only viewer (no write path to expose)', () => {
    render(<ModelsView projectId={PROJECT_ID} canWrite={false} />);

    expect(screen.queryByText('Default model')).toBeNull();
    expect(screen.queryByTestId('default-model-selector')).toBeNull();
  });
});

describe('ModelsView — "Your connections" section + honest empty state (Task 17)', () => {
  test('the connections section is labeled "Your connections", not "Connections"', () => {
    modelsPageState = { ...modelsPageState, connections: [BYOK_CONNECTION] };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    expect(screen.getByText('Your connections')).toBeDefined();
    expect(screen.queryByText('Connections')).toBeNull();
  });

  test('zero user connections + a healthy managed gateway: the reassurance empty state renders', () => {
    modelsPageState = { ...modelsPageState, connections: [MANAGED_GATEWAY] };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    expect(screen.getByText('Kortix models are included')).toBeDefined();
    expect(
      screen.getByText(
        'Optionally connect a Claude or ChatGPT subscription, or your own API key, to use those instead.',
      ),
    ).toBeDefined();
    // Two "Connect" affordances legitimately coexist: the section header's
    // toolbar action and the empty state's own CTA.
    expect(screen.getAllByText('Connect').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('No model services connected yet')).toBeNull();
  });

  test('the managed gateway unavailable: the legacy honest empty state renders instead', () => {
    modelsPageState = { ...modelsPageState, connections: [] };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    expect(screen.getByText('No model services connected yet')).toBeDefined();
    expect(screen.queryByText('Kortix models are included')).toBeNull();
  });

  test('user connections present: the full connection list renders, Kortix included, no empty state', () => {
    modelsPageState = { ...modelsPageState, connections: [MANAGED_GATEWAY, BYOK_CONNECTION] };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    expect(screen.queryByText('Kortix models are included')).toBeNull();
    expect(screen.queryByText('No model services connected yet')).toBeNull();
    expect(screen.getByText('Kortix')).toBeDefined();
    expect(screen.getByText('Anthropic')).toBeDefined();
  });

  test('a read-only viewer sees the reassurance state without a Connect action', () => {
    modelsPageState = { ...modelsPageState, connections: [MANAGED_GATEWAY], canWrite: false };
    render(<ModelsView projectId={PROJECT_ID} canWrite={false} />);

    expect(screen.getByText('Kortix models are included')).toBeDefined();
    expect(screen.queryByText('Connect')).toBeNull();
  });
});

describe('ModelsView — cross-links (Task 17 relabel check)', () => {
  test('runtimes-list cross-link reads "Manage agents →" (not "Manage runtimes →")', () => {
    modelsPageState = {
      ...modelsPageState,
      runtimes: [
        {
          id: 'claude',
          harness: 'claude',
          label: 'Claude Code',
          status: 'ready',
          selectedConnectionId: 'claude_subscription',
          modelSummary: 'Claude Sonnet',
          compatibleConnectionIds: ['claude_subscription'],
          blocker: null,
        },
      ],
      connections: [
        {
          id: 'claude_subscription',
          name: 'Claude subscription',
          kind: 'claude_subscription',
          status: 'ready',
          usedBy: ['claude'],
          catalogState: 'not-exposed',
          modelCount: null,
          statusReason: null,
        },
      ],
    };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    expect(screen.getByText('Manage agents →')).toBeDefined();
    expect(screen.queryByText('Manage runtimes →')).toBeNull();
  });
});
