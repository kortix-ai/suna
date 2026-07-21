import type { ProjectConfigSummary } from '@kortix/sdk/projects-client';

// Same `@happy-dom/global-registrator` + dynamic-import dance
// `runtime-view.test.tsx` / `agent-editor-runtime-link.test.tsx` establish — a
// plain static `import { screen } from '@testing-library/react'` evaluates
// before `GlobalRegistrator` registers (ESM hoists static imports), leaving
// `screen` stuck on its permanently-throwing "no document" stub. Only dynamic
// `import()` under top-level `await` forces registration first.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, render, screen, within } = await import('@testing-library/react');
const ReactModule = await import('react');

const AGENTS: ProjectConfigSummary['agents'] = [
  {
    name: 'claude-reviewer',
    path: 'kortix.yaml#agents.claude-reviewer',
    description: null,
    mode: null,
    harness: 'claude',
    runtime: 'claude',
  },
  {
    name: 'kortix',
    path: 'kortix.yaml#agents.kortix',
    description: null,
    mode: null,
    harness: 'opencode',
    runtime: 'opencode',
  },
  {
    name: 'legacy-agent',
    path: '.opencode/agents/legacy-agent.md',
    description: null,
    mode: null,
    harness: null,
  },
];

const CONFIG: ProjectConfigSummary = {
  is_kortix_repo: true,
  signals: {},
  manifest_raw: null,
  runtime_configs: [],
  runtime_config_raw: null,
  runtime_default_agent: null,
  agent_source: 'declarative',
  agent_discovery: 'declarative',
  agents: AGENTS,
  skills: [],
  commands: [],
  env: { required: [], optional: [] },
};

// `AgentsView` (via `ConfigEntityView`) and its detail-pane children
// (`AgentConfigEditor`, `AgentModel`, `AgentAssignments`,
// `RuntimeProfilesManager`) all call raw `useQuery`/`useMutation`/
// `useQueryClient` directly — no `QueryClientProvider` in this
// DOM-free-by-default harness — mocked at the module boundary, keyed by the
// query's first `queryKey` segment, same convention `runtime-view.test.tsx` /
// `agent-editor-runtime-link.test.tsx` use. Only `project-detail` (the config
// this section renders) returns real fixture data; every other key resolves
// to empty/undefined, which each reader already treats as its own loading/
// absent state (no crash).
const actualReactQuery = await import('@tanstack/react-query');
mock.module('@tanstack/react-query', () => ({
  ...actualReactQuery,
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === 'project-detail') {
      return { data: { config: CONFIG }, isLoading: false, isError: false };
    }
    return { data: undefined, isLoading: false, isError: false };
  },
  useMutation: () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
  useIsMutating: () => 0,
}));

let canWriteMock = true;
mock.module('@/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: canWriteMock, reason: null, isLoading: false, isError: false }),
}));

// `useConfigureThread`'s "New"/"Edit" triggers spin up a real project
// session via `useNewProjectSession`, which reads `useRouter()` — no Next
// app-router is mounted in this harness, and this suite never clicks New/Edit,
// so the hook is stubbed to a no-op, same technique
// `models-view-runtime-link.test.tsx` uses for its own out-of-scope heavy
// dependency (`ModelSelector`).
mock.module('@/hooks/projects/use-new-project-session', () => ({
  useNewProjectSession: () => () => {},
}));

// The per-agent model picker (`AgentModel`) pulls in a heavy dependency graph
// (billing, live catalog revision, project secrets, …) irrelevant to this
// suite, which is only about the harness badge on the row/detail — stub it to
// a no-op, same convention `models-view-runtime-link.test.tsx` uses.
mock.module('@/features/session/model-selector', () => ({
  ModelSelector: () => null,
}));

// `ProviderLogo` (the harness mark this suite asserts on) renders
// `next/image`, whose `getImgProps` constructs a `URL` from the icon's
// relative asset path — happy-dom has no real page location to resolve that
// against and throws "Invalid URL", same stub `runtime-view.test.tsx` uses.
mock.module('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const { src, alt, ...rest } = props;
    return ReactModule.createElement('img', { src, alt, ...rest });
  },
}));

const { AgentsView } = await import('./agents-view');
// `EntityDetail`'s toolbar (Copy/Edit) renders `Hint` (`Tooltip` under the
// hood), which throws outside a `TooltipProvider` — the app mounts one near
// its root; this harness supplies its own, same as `multi-harness-toggle.test.tsx`.
const { TooltipProvider } = await import('@/components/ui/tooltip');

const PROJECT_ID = 'proj_1';

function renderAgentsView() {
  return render(
    <TooltipProvider>
      <AgentsView projectId={PROJECT_ID} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  canWriteMock = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe('AgentsView — per-agent harness badge', () => {
  test('each agent row carries its resolved harness label; an agent with no resolved harness carries none', () => {
    renderAgentsView();

    const list = screen.getByRole('navigation', { name: 'Agents list' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);

    const claudeRow = rows.find((row) => within(row).queryByText('claude-reviewer'));
    const opencodeRow = rows.find((row) => within(row).queryByText('kortix'));
    const legacyRow = rows.find((row) => within(row).queryByText('legacy-agent'));

    expect(within(claudeRow!).getByText('Claude Code')).toBeDefined();
    expect(within(opencodeRow!).getByText('OpenCode')).toBeDefined();
    // No resolved harness (a legacy / Runtime-discovered agent) → no badge,
    // never a placeholder claiming a harness that isn't actually known.
    expect(within(legacyRow!).queryByText('Claude Code')).toBeNull();
    expect(within(legacyRow!).queryByText('OpenCode')).toBeNull();
  });

  test("the selected agent's detail header repeats its harness badge", () => {
    renderAgentsView();

    // The split layout previews the first visible agent by default.
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings[0]?.textContent).toBe('claude-reviewer');
    expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(1);
  });
});

describe('AgentsView — nav shows only Agents + Skills', () => {
  test('the Build rail group is exactly Agents and Skills — no Commands, no standalone Runtime', async () => {
    const { GROUPS } = await import('../../rail-groups');
    const build = GROUPS.find((g) => g.label === 'Build');
    expect(build?.items.map((item) => item.section)).toEqual(['agents', 'skills']);
  });
});
