// `export {}` forces module mode: a file with no top-level import/export is a
// script to TS, where top-level `await` is rejected and `screen` below would
// merge with the ambient DOM `Screen` global instead of testing-library's type.
export {};

// Same `@happy-dom/global-registrator` + dynamic-import dance
// `models-view-runtime-link.test.tsx` establishes — a plain static
// `import { screen } from '@testing-library/react'` evaluates before
// `GlobalRegistrator` registers (ESM hoists static imports), leaving `screen`
// stuck on its permanently-throwing "no document" stub. Only dynamic
// `import()` under top-level `await` forces registration first.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const ReactModule = await import('react');

// `ModelsView` and its children (`ManageConnectionModal`, `useModelDefaults`,
// `useProjectModels`) call raw `useQuery`/`useMutation`/`useQueryClient`/
// `useIsMutating` directly — no `QueryClientProvider` in this DOM-free-by-
// default harness — mocked at the module boundary. Every unmatched query key
// resolves to empty/undefined data.
const actualReactQuery = await import('@tanstack/react-query');
mock.module('@tanstack/react-query', () => ({
  ...actualReactQuery,
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  useMutation: () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: async () => {}, cancelQueries: async () => {} }),
  useIsMutating: () => 0,
}));

let modelsPageState: import('@kortix/sdk/react').ModelsPageState = {
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

// The default-model picker itself (search, catalog fetch, upgrade/connect
// routing, …) is out of scope here — this suite is about ModelsView's own
// structure, so the picker is stubbed to a marker exposing the fallback label.
mock.module('@/features/session/model-selector', () => ({
  ModelSelector: ({ unsetLabel, disabled }: { unsetLabel?: string; disabled?: boolean }) =>
    ReactModule.createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'default-model-selector',
        'data-disabled': String(!!disabled),
      },
      unsetLabel ?? 'Default',
    ),
}));

// `ProviderLogo` renders `next/image`, whose `getImgProps` builds a `URL` from
// the icon's relative asset path — happy-dom has no page location to resolve
// that against and throws "Invalid URL".
mock.module('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const { src, alt, ...rest } = props;
    return ReactModule.createElement('img', { src, alt, ...rest });
  },
}));

const { ModelsView } = await import('./models-view');

const PROJECT_ID = 'proj_1';

const MANAGED_GATEWAY: import('@kortix/sdk/react').ModelsPageConnection = {
  id: 'managed_gateway',
  name: 'Kortix',
  kind: 'managed_gateway',
  status: 'ready',
  usedBy: ['opencode'],
  catalogState: 'available',
  modelCount: 12,
  statusReason: null,
};

const CLAUDE_SUB: import('@kortix/sdk/react').ModelsPageConnection = {
  id: 'claude_subscription',
  name: 'Claude subscription',
  kind: 'claude_subscription',
  status: 'ready',
  usedBy: ['claude'],
  catalogState: 'not-exposed',
  modelCount: null,
  statusReason: null,
};

const ANTHROPIC_KEY: import('@kortix/sdk/react').ModelsPageConnection = {
  id: 'anthropic_api_key',
  name: 'Anthropic',
  kind: 'anthropic_api_key',
  status: 'ready',
  usedBy: [],
  catalogState: 'available',
  modelCount: 4,
  statusReason: null,
};

const CLAUDE_RUNTIME: import('@kortix/sdk/react').ModelsPageRuntime = {
  id: 'claude',
  harness: 'claude',
  label: 'Claude Code',
  status: 'ready',
  selectedConnectionId: 'claude_subscription',
  modelSummary: 'Claude subscription · Harness default',
  compatibleConnectionIds: ['claude_subscription'],
  blocker: null,
};

const OPENCODE_RUNTIME: import('@kortix/sdk/react').ModelsPageRuntime = {
  id: 'opencode',
  harness: 'opencode',
  label: 'OpenCode',
  status: 'ready',
  selectedConnectionId: 'managed_gateway',
  modelSummary: 'Kortix · Automatic',
  compatibleConnectionIds: ['managed_gateway', 'anthropic_api_key'],
  blocker: null,
};

const resetState = () => {
  modelsPageState = {
    runtimes: [],
    connections: [],
    connectedProviderIds: [],
    canWrite: true,
    isLoading: false,
    isError: false,
  };
};

afterEach(() => {
  cleanup();
  resetState();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function expandServicesDrawer() {
  fireEvent.click(screen.getByRole('button', { name: /Model services/ }));
}

describe('ModelsView — one agent-centric list, plain language', () => {
  test('the primary list is "Your agents"; the old jargon labels are gone', () => {
    modelsPageState = {
      ...modelsPageState,
      runtimes: [CLAUDE_RUNTIME],
      connections: [MANAGED_GATEWAY, CLAUDE_SUB],
    };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    expect(screen.getByText('Your agents')).toBeDefined();
    // The two circular section names from the old page are gone.
    expect(screen.queryByText('Agent runtimes')).toBeNull();
    expect(screen.queryByText('Your connections')).toBeNull();
    // Plain header copy — no "agent runtime" jargon.
    expect(
      screen.getByText('See what each of your agents runs on, and change it anytime.'),
    ).toBeDefined();
  });

  test('a subscription-backed agent states plainly that it manages its own model, not a dead end', () => {
    modelsPageState = {
      ...modelsPageState,
      runtimes: [CLAUDE_RUNTIME],
      connections: [CLAUDE_SUB],
    };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    expect(screen.getByText('Claude Code')).toBeDefined();
    expect(screen.getByText(/Claude Code chooses the model/)).toBeDefined();
    // The service paying is an inline button (chip), not a dead end.
    expect(screen.getByRole('button', { name: 'Claude subscription' })).toBeDefined();
  });

  test('a BYOK-backed agent reads "uses your default model"; a Kortix one reads "chosen automatically"', () => {
    modelsPageState = {
      ...modelsPageState,
      runtimes: [
        { ...OPENCODE_RUNTIME, selectedConnectionId: 'anthropic_api_key' },
        {
          ...OPENCODE_RUNTIME,
          id: 'pi',
          harness: 'pi',
          label: 'Pi',
          selectedConnectionId: 'managed_gateway',
        },
      ],
      connections: [MANAGED_GATEWAY, ANTHROPIC_KEY],
    };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    expect(screen.getByText(/uses your default model/)).toBeDefined();
    // Pi picks its own model even though it runs on Kortix.
    expect(screen.getByText(/Pi chooses the model/)).toBeDefined();
  });
});

describe('ModelsView — the "Change connection" action stays on every agent row', () => {
  test('a ready agent row still exposes the connection switcher', () => {
    modelsPageState = {
      ...modelsPageState,
      runtimes: [CLAUDE_RUNTIME],
      connections: [CLAUDE_SUB],
    };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    // ConnectionSelect renders its "Change" trigger — `setActiveHarnessConnection`
    // is still reachable from the agent row.
    expect(screen.getByText('Change')).toBeDefined();
  });
});

describe('ModelsView — services are secondary and collapsed by default', () => {
  test('the "Connections" label shows, but service rows stay hidden until expanded', () => {
    modelsPageState = {
      ...modelsPageState,
      runtimes: [OPENCODE_RUNTIME],
      connections: [MANAGED_GATEWAY, ANTHROPIC_KEY],
    };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    expect(screen.getByText('Connections')).toBeDefined();
    // Collapsed: the "Manage"/"View" service-row actions are not in the DOM yet,
    // so the page reads as one list — the agents — at a glance.
    expect(screen.queryByText('Manage')).toBeNull();
  });

  test('expanding the drawer reveals every service, Kortix included, each with a Manage action', () => {
    modelsPageState = {
      ...modelsPageState,
      runtimes: [OPENCODE_RUNTIME],
      connections: [MANAGED_GATEWAY, ANTHROPIC_KEY],
    };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    expandServicesDrawer();

    // Kortix and the BYOK key both appear as manageable service rows (Kortix
    // also names the agent chip above, hence getAllByText).
    expect(screen.getAllByText('Kortix').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Anthropic')).toBeDefined();
    expect(screen.getAllByText('Manage').length).toBeGreaterThanOrEqual(2);
    // Connecting a new service is reachable from inside the drawer too.
    expect(screen.getByText('Connect a service')).toBeDefined();
  });
});

describe('ModelsView — every preserved capability is reachable', () => {
  test('connecting is reachable from the header action', () => {
    modelsPageState = { ...modelsPageState, runtimes: [CLAUDE_RUNTIME], connections: [CLAUDE_SUB] };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    // Header "Connect" (+ the drawer one once expanded) — both open the modal.
    expect(screen.getAllByText('Connect').length).toBeGreaterThanOrEqual(1);
  });

  test('disconnect is reachable: clicking an agent’s service chip opens its Manage sheet', () => {
    modelsPageState = { ...modelsPageState, runtimes: [CLAUDE_RUNTIME], connections: [CLAUDE_SUB] };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    fireEvent.click(screen.getByRole('button', { name: 'Claude subscription' }));

    // The Manage sheet is modal-only content — its Disconnect action proves the
    // `ManageConnectionModal` path is intact.
    expect(screen.getByText('Disconnect')).toBeDefined();
  });

  test('the project default model is reachable via the Kortix service’s Manage sheet', () => {
    modelsPageState = {
      ...modelsPageState,
      runtimes: [OPENCODE_RUNTIME],
      connections: [MANAGED_GATEWAY],
    };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    // OpenCode runs on Kortix — click that chip to open the managed-gateway
    // Manage sheet, which owns the "Default model" control.
    fireEvent.click(screen.getByRole('button', { name: 'Kortix' }));

    expect(screen.getByText('Default model')).toBeDefined();
    expect(screen.getByTestId('default-model-selector')).toBeDefined();
  });
});

describe('ModelsView — the standalone inline "Default model" panel stays gone', () => {
  test('no Default model control renders on the page itself (only inside the Kortix sheet)', () => {
    modelsPageState = {
      ...modelsPageState,
      runtimes: [OPENCODE_RUNTIME],
      connections: [MANAGED_GATEWAY],
    };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    // The sheet is closed on first paint, so the control is not on the page.
    expect(screen.queryByText('Default model')).toBeNull();
    expect(screen.queryByTestId('default-model-selector')).toBeNull();
  });
});

describe('ModelsView — read-only viewer', () => {
  test('no write actions; service chips degrade to plain text', () => {
    modelsPageState = {
      ...modelsPageState,
      runtimes: [CLAUDE_RUNTIME],
      connections: [CLAUDE_SUB],
      canWrite: false,
    };
    render(<ModelsView projectId={PROJECT_ID} canWrite={false} />);

    expect(screen.queryByText('Connect')).toBeNull();
    expect(screen.queryByText('Change')).toBeNull();
    // The chip is text now, not a button.
    expect(screen.queryByRole('button', { name: 'Claude subscription' })).toBeNull();
    expect(screen.getByText('Claude subscription')).toBeDefined();
  });
});

describe('ModelsView — empty + cross-links', () => {
  test('no agents: an empty state points the user at the Agents section', () => {
    modelsPageState = { ...modelsPageState, runtimes: [], connections: [MANAGED_GATEWAY] };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    expect(screen.getByText('No agents yet')).toBeDefined();
    expect(screen.getByText('Go to Agents')).toBeDefined();
    // With no rows there's nothing to cross-link from, so the arrow link is absent.
    expect(screen.queryByText('Manage agents →')).toBeNull();
  });

  test('with agents present, the "Manage agents →" link is shown', () => {
    modelsPageState = { ...modelsPageState, runtimes: [CLAUDE_RUNTIME], connections: [CLAUDE_SUB] };
    render(<ModelsView projectId={PROJECT_ID} canWrite />);

    expect(screen.getByText('Manage agents →')).toBeDefined();
  });
});
