// Render suite for `MultiHarnessToggle` — the `experimental_harnesses`
// experiment surfaced inside the connect modal. Same happy-dom +
// dynamic-import harness as `connect-modal-host.test.tsx`. The empty export
// makes this file a module so top-level `await` is legal and the local
// `screen` binding can't collide with the DOM global.
export {};

const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, it, mock } = await import('bun:test');
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');

let canWriteMock = true;
mock.module('@/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: canWriteMock, reason: null, isLoading: false, isError: false }),
}));

type FeatureFixture = { key: string; available: boolean; enabled: boolean };
let featuresFixture: FeatureFixture[] = [];
let updateCalls: Array<{ projectId: string; key: string; next: boolean }> = [];
const actualProjectsClient = await import('@kortix/sdk/projects-client');
mock.module('@kortix/sdk/projects-client', () => ({
  ...actualProjectsClient,
  getProjectDetail: async () => ({
    project: { project_id: 'proj_1', experimental_features: featuresFixture },
  }),
  updateExperimentalFeature: async (projectId: string, key: string, next: boolean) => {
    updateCalls.push({ projectId, key, next });
    return { project_id: projectId, experimental_features: featuresFixture };
  },
}));

const { MultiHarnessToggle } = await import('./multi-harness-toggle');

afterEach(() => {
  cleanup();
  canWriteMock = true;
  featuresFixture = [];
  updateCalls = [];
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function renderToggle() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MultiHarnessToggle projectId="proj_1" />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  // Let the project-detail query resolve.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const FEATURE_ON: FeatureFixture = {
  key: 'experimental_harnesses',
  available: true,
  enabled: true,
};

describe('MultiHarnessToggle', () => {
  it('renders name, Experimental badge, description, and a switch reflecting the flag', async () => {
    featuresFixture = [{ ...FEATURE_ON, enabled: false }];
    await renderToggle();

    const row = await screen.findByTestId('multi-harness-toggle');
    expect(row.textContent).toContain('Multi-harness');
    expect(row.textContent).toContain('Experimental');
    expect(row.textContent).toContain('Claude Code, Codex, and Pi');
    expect(screen.getByTestId('multi-harness-switch').getAttribute('aria-checked')).toBe('false');
  });

  it('renders nothing when the platform reports the experiment unavailable (or absent)', async () => {
    featuresFixture = [{ ...FEATURE_ON, available: false }];
    await renderToggle();
    expect(screen.queryByTestId('multi-harness-toggle')).toBeNull();

    cleanup();
    featuresFixture = [];
    await renderToggle();
    expect(screen.queryByTestId('multi-harness-toggle')).toBeNull();
  });

  it('flipping the switch writes the experimental_harnesses flag', async () => {
    featuresFixture = [{ ...FEATURE_ON, enabled: false }];
    await renderToggle();

    fireEvent.click(await screen.findByTestId('multi-harness-switch'));
    // react-query runs the mutationFn in a microtask — let it land.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateCalls).toEqual([
      { projectId: 'proj_1', key: 'experimental_harnesses', next: true },
    ]);
  });

  it('non-writers see the state but the switch is disabled', async () => {
    canWriteMock = false;
    featuresFixture = [FEATURE_ON];
    await renderToggle();

    const switchEl = (await screen.findByTestId('multi-harness-switch')) as HTMLButtonElement;
    expect(switchEl.disabled).toBe(true);
    fireEvent.click(switchEl);
    expect(updateCalls).toHaveLength(0);
  });
});
