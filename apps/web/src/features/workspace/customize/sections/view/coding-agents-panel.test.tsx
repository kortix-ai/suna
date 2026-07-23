import type { ProjectConfigSummary, RuntimeProfilesResponse } from '@kortix/sdk/projects-client';

// Same `@happy-dom/global-registrator` + dynamic-import dance the neighbouring
// customize suites use (`agents-view.test.tsx`, `agent-editor-runtime-link.test.tsx`):
// a static `import { screen }` evaluates before `GlobalRegistrator` registers,
// leaving `screen` stuck on its permanently-throwing "no document" stub.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, beforeEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, render, screen, within } = await import('@testing-library/react');
const ReactModule = await import('react');
const { TooltipProvider } = await import('@/components/ui/tooltip');

// `ProviderLogo` renders `next/image`, whose `getImgProps` builds a `URL` from
// the icon's relative path — happy-dom has no page location to resolve that
// against and throws "Invalid URL".
mock.module('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const { src, alt, ...rest } = props;
    return ReactModule.createElement('img', { src, alt, ...rest });
  },
}));

let runtimeProfiles: RuntimeProfilesResponse = {
  schema_version: 3,
  editable: true,
  runtimes: {},
};
let agentConfig: any = {
  agent: 'kortix',
  schema_version: 3,
  editable: true,
  default_agent: 'kortix',
  block: { runtime: 'opencode' },
  runtimes: {},
};
const profileWrites: Array<Record<string, unknown>> = [];

const actualReactQuery = await import('@tanstack/react-query');
mock.module('@tanstack/react-query', () => ({
  ...actualReactQuery,
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === 'runtime-profiles') {
      return { data: runtimeProfiles, isLoading: false, isError: false };
    }
    if (queryKey[0] === 'agent-config') {
      return { data: agentConfig, isLoading: false, isError: false };
    }
    return { data: undefined, isLoading: false, isError: false };
  },
  // Record what each write would send so the toggle's *payload* is asserted,
  // not just that a click happened.
  useMutation: ({ mutationFn }: { mutationFn?: (vars: any) => unknown } = {}) => ({
    mutate: (vars: any) => {
      profileWrites.push(vars);
      void mutationFn?.(vars);
    },
    mutateAsync: async (vars: any) => {
      profileWrites.push(vars);
      return mutationFn?.(vars);
    },
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
  useIsMutating: () => 0,
}));

// The panel's writes go through the SDK client; stub it so no fetch is attempted.
const actualProjectsClient = await import('@kortix/sdk/projects-client');
mock.module('@kortix/sdk/projects-client', () => ({
  ...actualProjectsClient,
  getRuntimeProfiles: async () => runtimeProfiles,
  updateRuntimeProfiles: async () => runtimeProfiles,
  updateProjectDefaultAgent: async () => ({ ok: true, default_agent: 'kortix' }),
  enableAcpRuntimeProfiles: async () => runtimeProfiles,
}));

const { CodingAgentsPanel } = await import('./coding-agents-panel');

const PROJECT_ID = 'proj_1';

const config = (over: Partial<ProjectConfigSummary> = {}): ProjectConfigSummary => ({
  is_kortix_repo: true,
  signals: {},
  manifest_raw: null,
  runtime_configs: [],
  runtime_config_raw: null,
  runtime_default_agent: 'kortix',
  agent_source: 'declarative',
  agent_discovery: 'declarative',
  agents: [
    {
      name: 'kortix',
      path: 'kortix.yaml#agents.kortix',
      description: null,
      mode: null,
      harness: 'opencode',
      runtime: 'opencode',
    },
  ],
  skills: [],
  commands: [],
  env: { required: [], optional: [] },
  ...over,
});

function renderPanel(over: Partial<ProjectConfigSummary> = {}, canWrite = true) {
  render(
    <TooltipProvider>
      <CodingAgentsPanel projectId={PROJECT_ID} config={config(over)} canWrite={canWrite} />
    </TooltipProvider>,
  );
}

const row = (harness: string) =>
  screen
    .getAllByTestId('coding-agent-row')
    .find((el) => el.getAttribute('data-harness') === harness)!;

beforeEach(() => {
  profileWrites.length = 0;
  runtimeProfiles = {
    schema_version: 3,
    editable: true,
    runtimes: { opencode: { harness: 'opencode' }, claude: { harness: 'claude' } },
  };
  agentConfig = {
    agent: 'kortix',
    schema_version: 3,
    editable: true,
    default_agent: 'kortix',
    block: { runtime: 'opencode' },
    runtimes: runtimeProfiles.runtimes,
  };
});

afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

describe('CodingAgentsPanel', () => {
  test('a pre-v3 project gets the upsell, worded as coding agents — never "agent types"', () => {
    runtimeProfiles = { schema_version: 2, editable: false, runtimes: {} };
    renderPanel();

    expect(screen.getByRole('button', { name: 'Turn on coding agents' })).toBeDefined();
    expect(screen.queryByText('Agent types')).toBeNull();
    expect(screen.queryByText('Turn on runtime profiles')).toBeNull();
  });

  test('a read-only viewer sees the upsell with its action disabled', () => {
    runtimeProfiles = { schema_version: 2, editable: false, runtimes: {} };
    renderPanel({}, false);

    expect(
      screen.getByRole('button', { name: 'Turn on coding agents' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  test('every harness gets a row — including the ones this project has not turned on', () => {
    const rows = screen.queryAllByTestId('coding-agent-row');
    expect(rows).toHaveLength(0); // nothing rendered yet
    renderPanel();

    expect(
      screen.getAllByTestId('coding-agent-row').map((el) => el.getAttribute('data-harness')),
    ).toEqual(['claude', 'codex', 'opencode', 'pi']);
    // Turned-off harnesses are visible precisely so they can be turned on.
    expect(row('pi').getAttribute('data-enabled')).toBe('false');
    expect(row('claude').getAttribute('data-enabled')).toBe('true');
  });

  test('rows read as brands, never as the manifest slug that backs them', () => {
    runtimeProfiles = {
      schema_version: 3,
      editable: true,
      runtimes: { 'runtime-1': { harness: 'opencode' }, claude: { harness: 'claude' } },
    };
    renderPanel({
      agents: [
        {
          name: 'kortix',
          path: 'kortix.yaml#agents.kortix',
          description: null,
          mode: null,
          harness: 'opencode',
          runtime: 'runtime-1',
        },
      ],
    });

    expect(within(row('opencode')).getByText('OpenCode')).toBeDefined();
    // The slug is an implementation detail now — it must not reach the panel.
    expect(screen.queryByText('runtime-1')).toBeNull();
  });

  test('turning a harness on writes a profile keyed by the harness, with its default folder', () => {
    renderPanel();

    screen.getByRole('switch', { name: 'Turn on Codex' }).click();

    const write = profileWrites.at(-1) as { runtimes: Record<string, unknown>; message: string };
    expect(write.runtimes).toEqual({
      opencode: { harness: 'opencode' },
      claude: { harness: 'claude' },
      codex: { harness: 'codex', config_dir: '.codex' },
    });
    expect(write.message).toBe('Codex is ready to use');
  });

  test('turning an unused harness off drops it, no confirm needed', () => {
    renderPanel();

    screen.getByRole('switch', { name: 'Turn off Claude Code' }).click();

    const write = profileWrites.at(-1) as { runtimes: Record<string, unknown> };
    expect(write.runtimes).toEqual({ opencode: { harness: 'opencode' } });
  });

  test('a harness an agent runs on is locked, and says which agent to move', async () => {
    renderPanel();

    // `kortix` runs on OpenCode, so OpenCode cannot be turned off.
    const control = within(row('opencode')).getByRole('switch');
    expect(control.hasAttribute('disabled')).toBe(true);
    // No write is even attempted — the server would 400 on the dangling ref.
    control.click();
    expect(profileWrites).toHaveLength(0);
  });

  test('the default agent and its coding agent are both switchable from the header', () => {
    renderPanel();

    expect(screen.getByText('New chats start with')).toBeDefined();
    expect(screen.getByLabelText('Default agent')).toBeDefined();
    expect(screen.getByLabelText('Default coding agent')).toBeDefined();
  });

  test('the default harness shows a filled star, not another button competing with the rest', () => {
    renderPanel();

    expect(within(row('opencode')).getByTestId('coding-agent-default-marker')).toBeDefined();
    expect(
      within(row('opencode')).queryByRole('button', { name: /Make .* the default/ }),
    ).toBeNull();
    // A non-default, turned-ON harness offers the one-click star.
    expect(
      within(row('claude')).getByRole('button', { name: 'Make Claude Code the default' }),
    ).toBeDefined();
    // A turned-OFF harness cannot be made the default without turning it on.
    expect(within(row('pi')).queryByRole('button', { name: /Make .* the default/ })).toBeNull();
  });

  test('the star repoints the default agent, dropping the OpenCode-only sub-agent field', () => {
    agentConfig.block = { runtime: 'opencode', agent: 'build' };
    renderPanel();

    within(row('claude')).getByRole('button', { name: 'Make Claude Code the default' }).click();

    expect(profileWrites.at(-1)).toEqual({ runtime: 'claude' });
  });

  test('a read-only viewer can neither toggle nor set a default', () => {
    renderPanel({}, false);

    expect(within(row('pi')).getByRole('switch').hasAttribute('disabled')).toBe(true);
    expect(within(row('claude')).queryByRole('button', { name: /Make .* the default/ })).toBeNull();
  });

  test('a row is one line — the full description is a hover card, not stacked text', () => {
    renderPanel();

    // The short qualifier is inline beside the name…
    expect(within(row('claude')).getByText('Anthropic')).toBeDefined();
    // …while the sentence is not rendered into the row itself.
    expect(
      within(row('claude')).queryByText(
        'By Anthropic. Uses your Claude subscription or an Anthropic key.',
      ),
    ).toBeNull();
  });
});
