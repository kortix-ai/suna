import type { ModelsPageConnection, ModelsPageRuntime, ModelsPageState } from '@kortix/sdk/react';

// Same `@happy-dom/global-registrator` + dynamic-import dance
// `runtime-view.test.tsx` / `agent-editor-runtime-link.test.tsx` establish —
// a plain static `import { screen } from '@testing-library/react'` evaluates
// before `GlobalRegistrator` registers (ESM hoists static imports), leaving
// `screen` stuck on its permanently-throwing "no document" stub. Only
// dynamic `import()` under top-level `await` forces registration first.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');

// `ModelsView` and its children (`ManageConnectionModal` in particular) call
// raw `useQuery`/`useMutation`/`useQueryClient` directly — no
// `QueryClientProvider` in this DOM-free-by-default harness — mocked at the
// module boundary, same convention `runtime-view.test.tsx` uses. Every
// unmatched query key resolves to empty/undefined data.
const actualReactQuery = await import('@tanstack/react-query');
mock.module('@tanstack/react-query', () => ({
  ...actualReactQuery,
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  useMutation: () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));

let modelsPageState: ModelsPageState = {
  runtimes: [],
  connections: [],
  canWrite: true,
  isLoading: false,
  isError: false,
};
const actualSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...actualSdkReact,
  useModelsPage: () => modelsPageState,
}));

// `ProviderLogo` (the harness mark on each runtime/connection row) renders
// `next/image`, whose `getImgProps` constructs a `URL` from the icon's
// relative asset path — happy-dom has no real page location to resolve that
// against and throws "Invalid URL", same stub `runtime-view.test.tsx` uses.
mock.module('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const ReactModule = require('react');
    const { src, alt, ...rest } = props;
    return ReactModule.createElement('img', { src, alt, ...rest });
  },
}));

const { ModelsView } = await import('./models-view');
const { useCustomizeStore } = await import('@/stores/customize-store');

const PROJECT_ID = 'proj_1';

const RUNTIME: ModelsPageRuntime = {
  id: 'claude',
  harness: 'claude',
  label: 'Claude Code',
  status: 'ready',
  selectedConnectionId: 'claude_subscription',
  modelSummary: 'Claude Sonnet',
  compatibleConnectionIds: ['claude_subscription'],
  blocker: null,
};

const CONNECTION: ModelsPageConnection = {
  id: 'claude_subscription',
  name: 'Claude subscription',
  kind: 'claude_subscription',
  status: 'ready',
  usedBy: ['claude'],
  catalogState: 'not-exposed',
  modelCount: null,
  statusReason: null,
};

afterEach(() => {
  cleanup();
  modelsPageState = { runtimes: [], connections: [], canWrite: true, isLoading: false, isError: false };
  useCustomizeStore.setState({ open: true, section: 'llm-management' });
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('ModelsView — "Manage runtimes ->" back-link (DISC-09 / WS5-P5-a)', () => {
  test('the Agent runtimes list carries a "Manage runtimes" link to the Runtime section', () => {
    modelsPageState = {
      runtimes: [RUNTIME],
      connections: [CONNECTION],
      canWrite: true,
      isLoading: false,
      isError: false,
    };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    expect(screen.getByText('Manage runtimes →')).toBeDefined();
  });

  test('clicking it switches the Customize overlay to the Runtime section without closing it', () => {
    modelsPageState = {
      runtimes: [RUNTIME],
      connections: [CONNECTION],
      canWrite: true,
      isLoading: false,
      isError: false,
    };
    useCustomizeStore.setState({ open: true, section: 'llm-management' });
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    fireEvent.click(screen.getByText('Manage runtimes →'));

    expect(useCustomizeStore.getState().open).toBe(true);
    expect(useCustomizeStore.getState().section).toBe('runtime');
  });

  test('no runtime rows means no "Agent runtimes" section, so the link is absent — nothing to cross-link from', () => {
    modelsPageState = {
      runtimes: [],
      connections: [CONNECTION],
      canWrite: true,
      isLoading: false,
      isError: false,
    };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    expect(screen.queryByText('Manage runtimes →')).toBeNull();
  });
});
