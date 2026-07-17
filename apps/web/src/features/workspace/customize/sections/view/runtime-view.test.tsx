import type { RuntimeProfilesResponse } from '@kortix/sdk/projects-client';
import type { ModelsPageState } from '@kortix/sdk/react';

// Same `@happy-dom/global-registrator` + dynamic-import dance
// `model-picker.test.tsx`/`permission-prompt.test.tsx` establish: a plain
// `import { GlobalRegistrator } from '@happy-dom/global-registrator';
// GlobalRegistrator.register()` followed by a static `import { screen } from
// '@testing-library/react'` still evaluates testing-library BEFORE
// registration runs (ESM hoists static imports), so `screen` gets stuck on
// its permanently-throwing "no document" stub. Only dynamic `import()` under
// top-level `await` forces registration first.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, fireEvent, render, screen, within } = await import('@testing-library/react');

// `RuntimeView` calls raw `useQuery`/`useMutation`/`useQueryClient` directly
// (same as the `RuntimeProfilesEditor` it was extracted from) — there is no
// `QueryClientProvider` in this harness, so `@tanstack/react-query` is mocked
// at the module boundary, same convention `permission-prompt.test.tsx` /
// `acp-session-perf.test.tsx` use for hooks that need a query client this
// DOM-free-by-default harness has no reason to mount. `useQuery` is keyed by
// the query's first `queryKey` segment so both call sites reading
// `['runtime-profiles', projectId]` (the primary rows AND the Advanced
// editor) see the same fixture.
let runtimeProfiles: RuntimeProfilesResponse = {
  schema_version: 3,
  editable: true,
  runtimes: {},
};
const actualReactQuery = await import('@tanstack/react-query');
mock.module('@tanstack/react-query', () => ({
  ...actualReactQuery,
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === 'runtime-profiles') {
      return { data: runtimeProfiles, isLoading: false, isError: false };
    }
    return { data: undefined, isLoading: false, isError: false };
  },
  useMutation: () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));

// `useModelsPage` (connection state per harness) is the one hook this file
// spreads-the-real-module-and-overrides — every other `@kortix/sdk/react`
// export (`harnessPresentation`, `connectionDisplayName`, used by the pure
// `runtime-view-model.ts` this component renders through) stays real, per
// the mandated-test convention `permission-prompt.test.tsx` documents.
let modelsPageState: ModelsPageState = {
  runtimes: [],
  connections: [],
  canWrite: false,
  isLoading: false,
  isError: false,
};
const actualSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...actualSdkReact,
  useModelsPage: () => modelsPageState,
}));

// Mutable like `runtimeProfiles`/`modelsPageState` above (not a fixed
// factory) so the WS5-P2-b read-only test can flip it per-test instead of
// re-mocking a module that's already been imported.
let canWriteMock = true;
mock.module('@/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: canWriteMock, reason: null, isLoading: false, isError: false }),
}));

// `ProviderLogo` (the harness mark on each row) renders `next/image`, whose
// `getImgProps` constructs a `URL` from the icon's relative asset path —
// happy-dom has no real page location to resolve that against and throws
// "Invalid URL" (a happy-dom/next interaction, unrelated to anything this
// section renders). Stubbed to a plain `<img>`, same as any other
// browser-chrome dependency this DOM-free-by-default harness stubs out.
mock.module('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const ReactModule = require('react');
    const { src, alt, ...rest } = props;
    return ReactModule.createElement('img', { src, alt, ...rest });
  },
}));

const { RuntimeView } = await import('./runtime-view');
const { useCustomizeStore } = await import('@/stores/customize-store');

const PROJECT_ID = 'proj_1';

afterEach(() => {
  cleanup();
  runtimeProfiles = { schema_version: 3, editable: true, runtimes: {} };
  modelsPageState = { runtimes: [], connections: [], canWrite: false, isLoading: false, isError: false };
  canWriteMock = true;
  useCustomizeStore.setState({ open: true, section: 'runtime' });
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function setRuntimes(runtimes: RuntimeProfilesResponse['runtimes']) {
  runtimeProfiles = { schema_version: 3, editable: true, runtimes };
}

describe('RuntimeView — Runtime customize section (WS5-P2-a)', () => {
  test('renders one row per declared runtime, each carrying the harness label', () => {
    setRuntimes({
      'runtime-1': { harness: 'claude', config_dir: '.claude' },
      'runtime-2': { harness: 'opencode', config_dir: '.kortix/opencode' },
    });
    render(<RuntimeView projectId={PROJECT_ID} />);

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('Claude Code')).toBeDefined();
    expect(screen.getByText('OpenCode')).toBeDefined();
  });

  test('only non-stable harnesses carry the Experimental badge', () => {
    setRuntimes({
      'runtime-1': { harness: 'claude' }, // experimental
      'runtime-2': { harness: 'opencode' }, // stable
    });
    render(<RuntimeView projectId={PROJECT_ID} />);

    const rows = screen.getAllByRole('listitem');
    const claudeRow = rows.find((row) => within(row).queryByText('Claude Code'));
    const opencodeRow = rows.find((row) => within(row).queryByText('OpenCode'));
    expect(claudeRow).toBeDefined();
    expect(opencodeRow).toBeDefined();
    expect(within(claudeRow!).getByText('Experimental')).toBeDefined();
    expect(within(opencodeRow!).queryByText('Experimental')).toBeNull();
  });

  test('a harness with a ready connection shows "Connected"; an unconnected one shows "Not connected"', () => {
    setRuntimes({
      'runtime-1': { harness: 'claude' },
      'runtime-2': { harness: 'codex' },
    });
    modelsPageState = {
      ...modelsPageState,
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
    render(<RuntimeView projectId={PROJECT_ID} />);

    const rows = screen.getAllByRole('listitem');
    const claudeRow = rows.find((row) => within(row).queryByText('Claude Code'));
    const codexRow = rows.find((row) => within(row).queryByText('Codex'));
    expect(within(claudeRow!).getByText('Connected')).toBeDefined();
    expect(within(codexRow!).getByText('Not connected')).toBeDefined();
  });

  test(
    'a harness with a ready connection but zero routed agents still shows "Connected" — regression ' +
      'test for the WS5-P2-a review Important finding: the badge must derive from harness-scoped ' +
      'connection state (`ModelsPageState.connections`), not from `useModelsPage(...).runtimes`, ' +
      'which is agent-presence-gated and empty here on purpose',
    () => {
      setRuntimes({ 'runtime-1': { harness: 'claude' } });
      modelsPageState = {
        ...modelsPageState,
        // Deliberately empty — no agent is routed to `claude` yet, which is
        // the normal state right after enabling harnesses. The old
        // `runtimes`-derived badge read this as "Not connected"; the fix
        // must not.
        runtimes: [],
        connections: [
          {
            id: 'claude_subscription',
            name: 'Claude subscription',
            kind: 'claude_subscription',
            status: 'ready',
            usedBy: [],
            catalogState: 'not-exposed',
            modelCount: null,
            statusReason: null,
          },
        ],
      };
      render(<RuntimeView projectId={PROJECT_ID} />);

      const claudeRow = screen.getAllByRole('listitem').find((row) => within(row).queryByText('Claude Code'));
      expect(within(claudeRow!).getByText('Connected')).toBeDefined();
    },
  );

  test('primary DOM carries no manifest jargon — no schema_version, kortix.yaml/toml, profile slugs, or config-dir paths', () => {
    setRuntimes({
      'runtime-1': { harness: 'claude', config_dir: '.claude' },
      'runtime-2': { harness: 'opencode', config_dir: '.kortix/opencode' },
    });
    const { container } = render(<RuntimeView projectId={PROJECT_ID} />);
    const html = container.innerHTML;

    expect(html).not.toContain('schema_version');
    expect(html).not.toContain('kortix.yaml');
    expect(html).not.toContain('kortix.toml');
    expect(html).not.toContain('[[agents]]');
    expect(html).not.toContain('.claude');
    expect(html).not.toContain('.kortix/opencode');
    // The profile-slug keys themselves (jargon identity) never surface either.
    expect(html).not.toContain('runtime-1');
    expect(html).not.toContain('runtime-2');
  });

  test('the Advanced disclosure is collapsed by default and reveals the jargon once opened', () => {
    setRuntimes({
      'runtime-1': { harness: 'claude', config_dir: '.claude' },
    });
    render(<RuntimeView projectId={PROJECT_ID} />);

    // Collapsed: none of the manifest-level detail is in the DOM yet.
    expect(screen.queryByText(/kortix\.yaml/)).toBeNull();
    expect(screen.queryByText('.claude', { exact: false })).toBeNull();

    fireEvent.click(screen.getByText('Advanced'));

    expect(screen.getByText(/kortix\.yaml/)).toBeDefined();
    expect(screen.getByText('runtime-1')).toBeDefined();
    expect(screen.getByText('.claude')).toBeDefined();
  });

  test('the reframed banner links to the standalone Files route — a path, not a dead end', () => {
    setRuntimes({ 'runtime-1': { harness: 'claude' } });
    render(<RuntimeView projectId={PROJECT_ID} />);

    const link = screen.getByRole('link', { name: /open files/i });
    expect(link.getAttribute('href')).toBe(`/projects/${PROJECT_ID}/files`);
  });

  test('a not-yet-editable project shows the enable-harnesses upsell instead of rows', () => {
    runtimeProfiles = { schema_version: 2, editable: false, runtimes: {} };
    render(<RuntimeView projectId={PROJECT_ID} />);

    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.getByText('Turn on every harness')).toBeDefined();
    expect(screen.queryByText('Advanced')).toBeNull();
  });
});

// ─── WS5-P2-b: guided runtime -> connect -> model flow ─────────────────────

describe('RuntimeView — guided connect -> model flow (WS5-P2-b)', () => {
  test('a Not-connected row\'s Connect opens ConnectModelModal pre-filtered to that harness\'s authKinds', () => {
    setRuntimes({ 'runtime-1': { harness: 'claude' } });
    render(<RuntimeView projectId={PROJECT_ID} />);

    const claudeRow = screen.getAllByRole('listitem').find((row) => within(row).queryByText('Claude Code'));
    fireEvent.click(within(claudeRow!).getByRole('button', { name: 'Connect' }));

    // The modal opened, on the method list (no initialKind was passed).
    expect(screen.getByText('Connect a model service')).toBeDefined();

    // claude's authKinds are claude_subscription + anthropic_api_key +
    // native_config (see @kortix/shared/harnesses) — only those method rows
    // are offered.
    expect(screen.getByText('Claude Pro, Max, Team, or Enterprise')).toBeDefined();
    expect(screen.getByText('Claude via your own API key')).toBeDefined();

    // codex's methods (codex_subscription, openai_api_key) are NOT
    // compatible with claude and must not appear.
    expect(screen.queryByText('ChatGPT Plus, Pro, Business, Edu, or Enterprise')).toBeNull();
    expect(screen.queryByText('GPT models via your own API key')).toBeNull();
  });

  test('a Connected row shows "Choose model" instead of "Connect"', () => {
    setRuntimes({ 'runtime-1': { harness: 'claude' } });
    modelsPageState = {
      ...modelsPageState,
      connections: [
        {
          id: 'claude_subscription',
          name: 'Claude subscription',
          kind: 'claude_subscription',
          status: 'ready',
          usedBy: [],
          catalogState: 'not-exposed',
          modelCount: null,
          statusReason: null,
        },
      ],
    };
    render(<RuntimeView projectId={PROJECT_ID} />);

    const claudeRow = screen.getAllByRole('listitem').find((row) => within(row).queryByText('Claude Code'));
    expect(within(claudeRow!).getByRole('button', { name: 'Choose model' })).toBeDefined();
    expect(within(claudeRow!).queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  test('"Choose model" closes the Customize overlay — the composer\'s model picker lives on the project page behind it', () => {
    setRuntimes({ 'runtime-1': { harness: 'claude' } });
    modelsPageState = {
      ...modelsPageState,
      connections: [
        {
          id: 'claude_subscription',
          name: 'Claude subscription',
          kind: 'claude_subscription',
          status: 'ready',
          usedBy: [],
          catalogState: 'not-exposed',
          modelCount: null,
          statusReason: null,
        },
      ],
    };
    useCustomizeStore.setState({ open: true, section: 'runtime' });
    render(<RuntimeView projectId={PROJECT_ID} />);

    const claudeRow = screen.getAllByRole('listitem').find((row) => within(row).queryByText('Claude Code'));
    fireEvent.click(within(claudeRow!).getByRole('button', { name: 'Choose model' }));

    expect(useCustomizeStore.getState().open).toBe(false);
  });

  test('a read-only viewer (canWrite false) sees neither Connect nor Choose model', () => {
    canWriteMock = false;
    setRuntimes({ 'runtime-1': { harness: 'claude' }, 'runtime-2': { harness: 'codex' } });
    modelsPageState = {
      ...modelsPageState,
      connections: [
        {
          id: 'claude_subscription',
          name: 'Claude subscription',
          kind: 'claude_subscription',
          status: 'ready',
          usedBy: [],
          catalogState: 'not-exposed',
          modelCount: null,
          statusReason: null,
        },
      ],
    };
    render(<RuntimeView projectId={PROJECT_ID} />);

    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose model' })).toBeNull();
  });
});
