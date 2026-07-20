import { describe, expect, mock, test } from 'bun:test';
import { act, create } from 'react-test-renderer';

// Same DOM-free harness `composer-chat-input.test.tsx` uses: no jsdom in this
// workspace, so `react-test-renderer` + manual `act()`. Every hook
// `useModelConnectionGate` calls is mocked below, so nothing here ever
// touches a real React Query client, Next router, or Radix component.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useParams: () => ({ id: 'proj_1' }),
}));

// `useModelConnectionGate` reads its own project-secrets query directly off
// `@tanstack/react-query` — stub `useQuery` away from a real QueryClient the
// same way `runtime-view.test.tsx` does, spreading the real module (`@kortix
// /sdk/react`'s barrel imports `useMutation` et al. at load time, so a
// partial replacement breaks unrelated modules pulled in transitively).
const actualReactQuery = await import('@tanstack/react-query');
mock.module('@tanstack/react-query', () => ({
  ...actualReactQuery,
  useQuery: () => ({ data: undefined, isPending: false, isError: false }),
}));

let llmGatewayEnabled = true;
mock.module('@/hooks/runtime/use-project-llm-gateway-enabled', () => ({
  useProjectLlmGatewayEnabled: () => ({
    llmGatewayEnabled,
    query: { data: { project: { account_id: 'acc_1' } }, isPending: false },
  }),
}));

mock.module('@/features/workspace/customize/sections/llm-provider/use-live-catalog', () => ({
  useLlmProviderCatalogRevision: () => 0,
}));

const actualBilling = await import('@/hooks/billing');
mock.module('@/hooks/billing', () => ({
  ...actualBilling,
  useAccountState: () => ({ data: undefined, isPending: false }),
}));

mock.module('@/lib/config', () => ({
  isBillingEnabled: () => false,
}));

const openUpgradeDialogMock = mock((_opts?: unknown) => {});
mock.module('@/stores/upgrade-dialog-store', () => ({
  useUpgradeDialogStore: (selector: (s: { openUpgradeDialog: typeof openUpgradeDialogMock }) => unknown) =>
    selector({ openUpgradeDialog: openUpgradeDialogMock }),
}));

// The spy this test exists to exercise: `openCustomize` must never be called
// by `openConnectProvider` anymore (the old gateway-ON branch's Customize
// deep link is gone).
const openCustomizeMock = mock((_section?: string, _opts?: unknown) => {});
mock.module('@/stores/customize-store', () => ({
  useCustomizeStore: (selector: (s: { openCustomize: typeof openCustomizeMock }) => unknown) =>
    selector({ openCustomize: openCustomizeMock }),
}));

// The other half of the spy: `openConnectProvider` must open the shared
// connect-modal store instead — assert on ITS `open`, not a locally-rendered
// modal.
const connectModalOpenMock = mock((_opts?: unknown) => {});
mock.module('@/features/workspace/customize/sections/llm-provider/connect-modal-host', () => ({
  useConnectModal: () => ({ open: connectModalOpenMock, close: mock(() => {}) }),
}));

const { useModelConnectionGate } = await import('./use-model-connection-gate');

function Harness({ onReady }: { onReady: (api: ReturnType<typeof useModelConnectionGate>) => void }) {
  const api = useModelConnectionGate();
  onReady(api);
  return null;
}

function mountGate() {
  let api!: ReturnType<typeof useModelConnectionGate>;
  act(() => {
    create(<Harness onReady={(a) => (api = a)} />);
  });
  return api;
}

describe('useModelConnectionGate — one connect surface (kills the three-way branch)', () => {
  test('gateway ON, in a project: openConnectProvider does not call openCustomize, and opens the connect-modal store instead', () => {
    llmGatewayEnabled = true;
    openCustomizeMock.mockClear();
    connectModalOpenMock.mockClear();

    const { openConnectProvider } = mountGate();
    act(() => {
      openConnectProvider();
    });

    expect(openCustomizeMock).not.toHaveBeenCalled();
    expect(connectModalOpenMock).toHaveBeenCalledTimes(1);
    expect(connectModalOpenMock).toHaveBeenCalledWith({ tab: undefined, connectKind: undefined });
  });

  test('gateway OFF, in a project: still routes through the same store, not a locally-hosted modal', () => {
    llmGatewayEnabled = false;
    openCustomizeMock.mockClear();
    connectModalOpenMock.mockClear();

    const { openConnectProvider } = mountGate();
    act(() => {
      openConnectProvider(undefined, { connectKind: 'anthropic_api_key' as never });
    });

    expect(openCustomizeMock).not.toHaveBeenCalled();
    expect(connectModalOpenMock).toHaveBeenCalledTimes(1);
    expect(connectModalOpenMock).toHaveBeenCalledWith({ tab: undefined, connectKind: 'anthropic_api_key' });
  });

  test('`modal` is no longer a locally-rendered element — the connect surface is root-mounted, not per-hook-caller', () => {
    llmGatewayEnabled = true;
    const { modal } = mountGate();
    expect(modal).toBeNull();
  });
});
