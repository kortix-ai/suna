import type { ModelsPageState } from '@kortix/sdk/react';

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
const { act, cleanup, render, screen } = await import('@testing-library/react');
const ReactModule = await import('react');

// `ApiKeyForm`/the subscription forms `ConnectModelModal` renders once a
// method is preselected call raw `useQuery`/`useMutation` directly — no
// `QueryClientProvider` in this DOM-free-by-default harness, same convention
// `runtime-view.test.tsx` uses.
const actualReactQuery = await import('@tanstack/react-query');
mock.module('@tanstack/react-query', () => ({
  ...actualReactQuery,
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  useMutation: () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));

let routeProjectId: string | undefined = 'proj_1';
mock.module('next/navigation', () => ({
  useParams: () => (routeProjectId ? { id: routeProjectId } : {}),
}));

let canWriteMock = true;
mock.module('@/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: canWriteMock, reason: null, isLoading: false, isError: false }),
}));

let modelsPageState: ModelsPageState = {
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

// `ProviderLogo` (each method row's mark) renders `next/image`, whose
// `getImgProps` constructs a `URL` from the icon's relative asset path —
// happy-dom has no real page location to resolve that against and throws
// "Invalid URL", same stub `runtime-view.test.tsx` uses.
mock.module('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const { src, alt, ...rest } = props;
    return ReactModule.createElement('img', { src, alt, ...rest });
  },
}));

const { ConnectModalHost, useConnectModal, useConnectModalStore } = await import('./connect-modal-host');

afterEach(() => {
  cleanup();
  routeProjectId = 'proj_1';
  canWriteMock = true;
  modelsPageState = {
    runtimes: [],
    connections: [],
    connectedProviderIds: [],
    canWrite: true,
    isLoading: false,
    isError: false,
  };
  useConnectModalStore.setState({
    isOpen: false,
    tab: undefined,
    providerId: undefined,
    connectKind: undefined,
    harnessFilter: null,
  });
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function Trigger() {
  const { open } = useConnectModal();
  return ReactModule.createElement(
    'button',
    { type: 'button', onClick: () => open({}) },
    'Open connect',
  );
}

describe('ConnectModalHost — the one root-mounted connect surface', () => {
  test('renders nothing when the store is closed', () => {
    render(ReactModule.createElement(ConnectModalHost));
    expect(screen.queryByText('Connect a model service')).toBeNull();
  });

  test('useConnectModal().open() opens the ConnectModelModal this host renders', () => {
    render(
      ReactModule.createElement(
        ReactModule.Fragment,
        null,
        ReactModule.createElement(Trigger),
        ReactModule.createElement(ConnectModalHost),
      ),
    );

    expect(screen.queryByText('Connect a model service')).toBeNull();

    act(() => {
      screen.getByText('Open connect').click();
    });

    expect(screen.getByText('Connect a model service')).toBeDefined();
  });

  test('a connectKind opens straight into that method\'s form, skipping the method list', () => {
    useConnectModalStore.setState({ isOpen: true, connectKind: 'anthropic_api_key' });
    render(ReactModule.createElement(ConnectModalHost));

    expect(screen.queryByText('Connect a model service')).toBeDefined();
    // The method list itself never rendered — jumped straight to the
    // Anthropic API-key form.
    expect(screen.queryByText('Claude via your own API key')).toBeNull();
  });

  test('renders nothing outside a project route — every migrated call site is project-scoped', () => {
    routeProjectId = undefined;
    useConnectModalStore.setState({ isOpen: true });
    render(ReactModule.createElement(ConnectModalHost));

    expect(screen.queryByText('Connect a model service')).toBeNull();
  });

  test('an off-project open() self-heals the store, so entering a project afterward does not pop the modal unbidden', () => {
    // e.g. the right-sidebar "Connect a model" quick action, which renders on
    // every non-share route and isn't gated on `requiresProject` — see
    // `sidebar-right.tsx` / `menu-registry.ts:619`.
    routeProjectId = undefined;
    const { rerender } = render(ReactModule.createElement(ConnectModalHost));

    act(() => {
      useConnectModalStore.getState().open({});
    });

    // Host still renders nothing off-project...
    expect(screen.queryByText('Connect a model service')).toBeNull();
    // ...but the store must not stay armed — a silent no-op with a side
    // effect is the bug this test guards against.
    expect(useConnectModalStore.getState().isOpen).toBe(false);

    // Entering a project afterward (client-side nav, same component instance
    // re-rendering with a route param) must not surface a surprise modal.
    routeProjectId = 'proj_1';
    rerender(ReactModule.createElement(ConnectModalHost));
    expect(screen.queryByText('Connect a model service')).toBeNull();
  });
});
