import type { AgentConfigResponse, ProjectConfigSummary } from '@kortix/sdk/projects-client';

// Same `@happy-dom/global-registrator` + dynamic-import dance
// `runtime-view.test.tsx` establishes — a plain static `import { screen }
// from '@testing-library/react'` evaluates before `GlobalRegistrator`
// registers (ESM hoists static imports), leaving `screen` stuck on its
// permanently-throwing "no document" stub. Only dynamic `import()` under
// top-level `await` forces registration first.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');

// `AgentConfigEditor`/`AgentEditorModal` call raw `useQuery`/`useMutation`
// directly (no `QueryClientProvider` in this DOM-free-by-default harness) —
// mocked at the module boundary, keyed by the query's first `queryKey`
// segment, same convention `runtime-view.test.tsx` uses.
let agentConfig: AgentConfigResponse = {
  agent: 'kortix',
  schema_version: 3,
  editable: true,
  default_agent: 'kortix',
  block: { runtime: 'claude' },
  runtimes: {
    claude: { harness: 'claude', config_dir: '.claude' },
    opencode: { harness: 'opencode' },
  },
};
const actualReactQuery = await import('@tanstack/react-query');
mock.module('@tanstack/react-query', () => ({
  ...actualReactQuery,
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === 'agent-config') {
      return { data: agentConfig, isLoading: false, isError: false };
    }
    // project-secrets / project-connectors — neither field this test drives.
    return { data: undefined, isLoading: false, isError: false };
  },
  useMutation: () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));

const { AgentConfigEditor } = await import('./agent-editor');
const { useCustomizeStore } = await import('@/stores/customize-store');

const PROJECT_ID = 'proj_1';
const AGENT: ProjectConfigSummary['agents'][number] = {
  name: 'kortix',
} as ProjectConfigSummary['agents'][number];

afterEach(() => {
  cleanup();
  agentConfig = {
    agent: 'kortix',
    schema_version: 3,
    editable: true,
    default_agent: 'kortix',
    block: { runtime: 'claude' },
    runtimes: {
      claude: { harness: 'claude', config_dir: '.claude' },
      opencode: { harness: 'opencode' },
    },
  };
  useCustomizeStore.setState({ open: true, section: 'agents' });
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('AgentConfigEditor — "Manage runtimes ->" cross-link', () => {
  test('the runtime profile field carries a "Manage runtimes" link', () => {
    render(
      <AgentConfigEditor projectId={PROJECT_ID} agent={AGENT} skillsOptions={[]} fallback={null} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit configuration' }));

    expect(screen.getByText('Manage runtimes →')).toBeDefined();
  });

  test('clicking it closes this modal — the runtime-profiles manager already lives in this same Agents section', () => {
    useCustomizeStore.setState({ open: true, section: 'agents' });
    render(
      <AgentConfigEditor projectId={PROJECT_ID} agent={AGENT} skillsOptions={[]} fallback={null} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit configuration' }));
    expect(screen.getByText(`Configure ${AGENT.name}`)).toBeDefined();

    fireEvent.click(screen.getByText('Manage runtimes →'));

    // There's no separate Runtime section to switch to anymore — the
    // profile manager (`runtime-profiles-manager.tsx`) is already visible in
    // this same Agents section's context, above the agent list. Closing this
    // modal is the whole cross-link; the overlay stays open and on 'agents'.
    expect(useCustomizeStore.getState().open).toBe(true);
    expect(useCustomizeStore.getState().section).toBe('agents');
    expect(screen.queryByText(`Configure ${AGENT.name}`)).toBeNull();
  });

  // A legacy v2 (schema_version 2) project renders the "Runtime (legacy v2)"
  // layer instead of "ACP runtime" — `RuntimeLayerFields`, not this link's
  // section — so there's no "Manage runtimes" cross-link to carry there.
  // Not exercised here: `RuntimeLayerFields` mounts the full composer
  // `ModelSelector` (routing/account/gateway hooks this DOM-free harness
  // doesn't stand up), which is unrelated surface to this cross-link change.
  // The link's placement is proven directly by the schemaVersion === 3
  // conditional in agent-editor.tsx, verified above.
});
