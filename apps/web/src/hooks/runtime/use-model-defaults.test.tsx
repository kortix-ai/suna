// `export {}` forces module mode: a file with no top-level import/export is a
// script to TS, where top-level `await` is rejected — same reason every other
// happy-dom + dynamic-import suite in this repo (`models-view.test.tsx`,
// `gateway-view.test.tsx`, ...) opens this way.
export {};

// Same `@happy-dom/global-registrator` dance those suites establish — a real
// DOM is required here (this test drives real `useMutation`/`useQuery`/
// `useIsMutating` state transitions through `act`/`waitFor`, not a static
// `renderToStaticMarkup` snapshot), so nothing that touches `document` at
// import time can be a static import above the `GlobalRegistrator.register()`
// call.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { act, renderHook, waitFor } = await import('@testing-library/react');
const ReactModule = await import('react');

/**
 * Regression coverage for the Task 17 fix-wave finding: `gateway-view.tsx`
 * used to mount its OWN `useModelDefaults(projectId)` instance and read that
 * instance's `isUpdating` to gate `GatewayRouting`'s `projectDefaultPending`.
 * But the project-default mutation only ever fires through `models-view.tsx`'s
 * instance now (Task 17 relocated the picker there) — and `useMutation().isPending`
 * is per-hook-instance, not shared across every `useModelDefaults` call for the
 * same project. So gateway-view's own `isUpdating` was a permanent no-op: it
 * could never observe a mutation some OTHER component's hook instance fired.
 *
 * The fix gives the set/clear mutations an explicit shared `mutationKey`
 * (`modelDefaultsKey(projectId)`, exported from `./use-model-defaults`) so any
 * consumer — owner or not — can observe an in-flight write via
 * `useIsMutating({ mutationKey })`.
 *
 * This suite exercises the REAL hook (no `@tanstack/react-query` mocking, real
 * `QueryClient`) with two independent `useModelDefaults`/`useIsMutating`
 * instances under one `QueryClientProvider` — mirroring exactly how
 * `models-view.tsx` (the mutation owner) and `gateway-view.tsx` (the observer)
 * share a project's query cache in the live tree. Only the network layer
 * (`@kortix/sdk/projects-client`) is mocked, with a controllable in-flight
 * `setModelDefault` so the test can assert the observer sees "pending" while
 * the owner's write hasn't resolved yet.
 */

let resolveSetModelDefault: (() => void) | null = null;

mock.module('@kortix/sdk/projects-client', () => ({
  getModelDefaults: async () => ({
    platformDefault: 'kortix/glm-5.2',
    accountDefault: null,
    agentDefaults: {},
    projectDefault: null,
    resolvedForCaller: null,
    freeTier: false,
  }),
  setModelDefault: (_projectId: string, input: { scope: string; model: string }) =>
    new Promise((resolve) => {
      resolveSetModelDefault = () => resolve({ ok: true, scope: input.scope, model: input.model });
    }),
  clearModelDefault: async () => ({ ok: true }),
}));

const { QueryClient, QueryClientProvider, useIsMutating } = await import('@tanstack/react-query');
const { useModelDefaults, modelDefaultsKey } = await import('./use-model-defaults');

const PROJECT_ID = 'proj_1';

function makeWrapper(queryClient: InstanceType<typeof QueryClient>) {
  return ({ children }: { children: import('react').ReactNode }) =>
    ReactModule.createElement(QueryClientProvider, { client: queryClient }, children);
}

afterEach(() => {
  resolveSetModelDefault = null;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('useModelDefaults — shared mutationKey cross-instance visibility (Task 17 fix wave)', () => {
  test('a second hook instance observes an in-flight setProjectDefault fired through a different instance', async () => {
    const queryClient = new QueryClient();
    const wrapper = makeWrapper(queryClient);

    // Stands in for `models-view.tsx` — the mutation owner.
    const owner = renderHook(() => useModelDefaults(PROJECT_ID), { wrapper });
    // Stands in for `gateway-view.tsx` post-fix: no `useModelDefaults` call at
    // all, only the shared-key `useIsMutating` observer.
    const observer = renderHook(
      () => useIsMutating({ mutationKey: modelDefaultsKey(PROJECT_ID) }) > 0,
      { wrapper },
    );

    await waitFor(() => expect(owner.result.current.isLoading).toBe(false));
    expect(observer.result.current).toBe(false);
    expect(owner.result.current.isUpdating).toBe(false);

    let setPromise!: Promise<void>;
    act(() => {
      setPromise = owner.result.current.setProjectDefault({
        providerID: 'kortix',
        modelID: 'glm-5.2',
      });
    });

    // The write is in flight only through the OWNER's hook instance — the
    // OBSERVER's independent instance must still see it via the shared key.
    // (This is the assertion that fails under the pre-fix code: without an
    // explicit `mutationKey`, `useIsMutating({ mutationKey: modelDefaultsKey(...) })`
    // never matches the owner's mutation and stays permanently 0/false.)
    await waitFor(() => expect(observer.result.current).toBe(true));
    expect(owner.result.current.isUpdating).toBe(true);

    await act(async () => {
      resolveSetModelDefault?.();
      await setPromise;
    });

    await waitFor(() => expect(observer.result.current).toBe(false));
    expect(owner.result.current.isUpdating).toBe(false);
  });

  test('the observer never fires for an unrelated project id (mutationKey is project-scoped)', async () => {
    const queryClient = new QueryClient();
    const wrapper = makeWrapper(queryClient);

    const owner = renderHook(() => useModelDefaults(PROJECT_ID), { wrapper });
    const observer = renderHook(
      () => useIsMutating({ mutationKey: modelDefaultsKey('some-other-project') }) > 0,
      { wrapper },
    );

    await waitFor(() => expect(owner.result.current.isLoading).toBe(false));

    let setPromise!: Promise<void>;
    act(() => {
      setPromise = owner.result.current.setProjectDefault({
        providerID: 'kortix',
        modelID: 'glm-5.2',
      });
    });

    await waitFor(() => expect(owner.result.current.isUpdating).toBe(true));
    expect(observer.result.current).toBe(false);

    await act(async () => {
      resolveSetModelDefault?.();
      await setPromise;
    });
  });
});
