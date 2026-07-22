// `export {}` forces module mode so top-level `await` is legal (see the twin
// note in `models-view.test.tsx`).
export {};

const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, render, screen } = await import('@testing-library/react');
const ReactModule = await import('react');

// The modal calls raw react-query hooks with no provider in this DOM-free
// harness — mocked at the module boundary, same convention as
// `models-view.test.tsx`. `useIsMutating` returns 0 (no routing write in
// flight) so the default-model picker is never spuriously disabled.
const actualReactQuery = await import('@tanstack/react-query');
mock.module('@tanstack/react-query', () => ({
  ...actualReactQuery,
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  useMutation: () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
  useIsMutating: () => 0,
}));

// `useProjectModels` (the picker's catalog) — an empty catalog is fine; the
// picker is stubbed below and never reads it.
const actualSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...actualSdkReact,
  useProjectModels: () => [],
}));

// The project-default write path — the ONE thing this section owns.
let setProjectDefaultCalls = 0;
mock.module('@/hooks/runtime/use-model-defaults', () => ({
  useModelDefaults: () => ({
    projectDefault: undefined,
    accountDefault: undefined,
    platformDefault: undefined,
    effectiveDefault: undefined,
    setProjectDefault: async () => {
      setProjectDefaultCalls += 1;
    },
    isLoading: false,
    isUpdating: false,
  }),
}));

// The picker itself is out of scope — stub to a marker exposing the fallback
// label so the section's wiring is assertable without the catalog popover.
mock.module('@/features/session/model-selector', () => ({
  ModelSelector: ({ unsetLabel }: { unsetLabel?: string }) =>
    ReactModule.createElement(
      'button',
      { type: 'button', 'data-testid': 'default-model-selector' },
      unsetLabel ?? 'Default',
    ),
}));

mock.module('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const { src, alt, ...rest } = props;
    return ReactModule.createElement('img', { src, alt, ...rest });
  },
}));

const { ManageConnectionModal } = await import('./manage-connection-modal');

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

const noop = () => {};

afterEach(() => {
  cleanup();
  setProjectDefaultCalls = 0;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('ManageConnectionModal — Default model lives here (the one home)', () => {
  test('the Kortix (managed gateway) modal renders the Default model control with precedence copy', () => {
    render(
      <ManageConnectionModal
        projectId={PROJECT_ID}
        connection={MANAGED_GATEWAY}
        runtimes={[]}
        canWrite
        open
        onOpenChange={noop}
        onReconnect={noop}
      />,
    );

    expect(screen.getByText('Default model')).toBeDefined();
    expect(screen.getByTestId('default-model-selector')).toBeDefined();
    // Precedence, stated in plain words.
    expect(
      screen.getByText(/then this project default, then your\s+account default/i),
    ).toBeDefined();
  });

  test('a BYOK connection modal never shows the Default model control', () => {
    render(
      <ManageConnectionModal
        projectId={PROJECT_ID}
        connection={BYOK_CONNECTION}
        runtimes={[]}
        canWrite
        open
        onOpenChange={noop}
        onReconnect={noop}
      />,
    );

    expect(screen.queryByText('Default model')).toBeNull();
    expect(screen.queryByTestId('default-model-selector')).toBeNull();
  });

  test('a read-only viewer of the Kortix modal has no write path exposed', () => {
    render(
      <ManageConnectionModal
        projectId={PROJECT_ID}
        connection={MANAGED_GATEWAY}
        runtimes={[]}
        canWrite={false}
        open
        onOpenChange={noop}
        onReconnect={noop}
      />,
    );

    expect(screen.queryByText('Default model')).toBeNull();
    expect(screen.queryByTestId('default-model-selector')).toBeNull();
  });
});
