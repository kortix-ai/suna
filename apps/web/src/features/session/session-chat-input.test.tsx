// Wiring proof for Task 14: `SessionChatInput` (the real composer, not a
// stub) must thread its `projectId` prop into the real `AgentSelector` it
// renders, so `useModelsPage(projectId)`'s per-harness connection status
// drives the "no model connected" dot in production — not just in
// `agent-selector.test.tsx`'s standalone harness. Needs a real DOM (same
// reason `agent-selector.test.tsx` does): `AgentSelector`'s `CommandPopover`
// portals through Radix `Popover`, which silently no-ops under this
// directory's usual DOM-free `react-test-renderer` harness.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, it, mock } = await import('bun:test');
const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react');
const ReactModule = await import('react');
const { TooltipProvider } = await import('@/components/ui/tooltip');

import type { Agent } from '@/hooks/runtime/use-runtime-sessions';

// Every OTHER direct child `SessionChatInput` renders is stubbed to a
// props-capturing/no-op marker — this file tests ONLY the `projectId` ->
// `AgentSelector` wiring, not `ComposerModelControls`'/`VoiceRecorder`'s/
// `ModelConnectionBar`'s own rendering (each has its own test).
mock.module('./composer-model-controls', () => ({
  ComposerModelControls: () => null,
}));
mock.module('./model-connection-gate', () => ({
  ModelConnectionBar: () => null,
}));
mock.module('./voice-recorder', () => ({
  VoiceRecorder: () => null,
}));
mock.module('./use-model-connection-gate', () => ({
  useModelConnectionGate: () => ({
    hasSelectableModels: true,
    entitlementsPending: false,
    openConnectProvider: () => {},
    openUpgrade: () => {},
    modal: null,
  }),
}));

mock.module('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
    prefetch: () => {},
  }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

mock.module('next-intl', () => ({
  useTranslations: () =>
    Object.assign((key: string) => key, {
      raw: (key: string) => key,
      rich: (key: string) => key,
      markup: (key: string) => key,
    }),
}));

// Same `next/image` stub `agent-selector.test.tsx` uses — `ProviderLogo`
// (the harness brand mark inside `AgentSelector`) renders `next/image`,
// which throws "Invalid URL" under happy-dom's fake page location.
mock.module('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const { src, alt, ...rest } = props;
    return ReactModule.createElement('img', { src, alt, ...rest });
  },
}));

// `AgentSelector` reads per-harness connection status off `useModelsPage()`.
// Capture the `projectId` it's called with (the actual wiring proof) and
// control the runtime fixture per test — same convention
// `agent-selector.test.tsx` uses.
type RuntimeFixture = { harness: string; status: string };
let modelsPageRuntimes: RuntimeFixture[] = [];
let capturedModelsPageProjectId: string | null | undefined = 'UNSET';
const actualSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...actualSdkReact,
  useModelsPage: (projectId: string | null | undefined) => {
    capturedModelsPageProjectId = projectId;
    return {
      runtimes: modelsPageRuntimes,
      connections: [],
      connectedProviderIds: [],
      canWrite: false,
      isLoading: false,
      isError: false,
    };
  },
}));

const { SessionChatInput } = await import('./session-chat-input');

afterEach(() => {
  cleanup();
  modelsPageRuntimes = [];
  capturedModelsPageProjectId = 'UNSET';
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const AGENTS: Agent[] = [
  { name: 'claude', harness: 'claude', description: 'Anthropic coding agent' },
  { name: 'kortix', harness: 'opencode', description: 'Model-agnostic OpenCode agent' },
];

function renderComposer(over: Partial<Parameters<typeof SessionChatInput>[0]> = {}) {
  return render(
    <TooltipProvider>
      <SessionChatInput
        onSend={() => {}}
        agents={AGENTS}
        selectedAgent="claude"
        onAgentChange={() => {}}
        {...over}
      />
    </TooltipProvider>,
  );
}

describe('SessionChatInput — projectId wiring into AgentSelector (Task 14)', () => {
  it('passes its projectId prop through to the real AgentSelector, which forwards it to useModelsPage', () => {
    renderComposer({ projectId: 'proj_composer_real' });

    expect(capturedModelsPageProjectId).toBe('proj_composer_real');
  });

  it('renders the "no model connected" dot for a disconnected harness through the REAL composer path (mocked useModelsPage only)', async () => {
    modelsPageRuntimes = [
      { harness: 'claude', status: 'ready' },
      { harness: 'opencode', status: 'needs-attention' },
    ];

    renderComposer({ projectId: 'proj_composer_real' });

    fireEvent.click(screen.getByTestId('agent-selector'));
    await flush();

    const kortixOption = screen
      .getAllByTestId('agent-option')
      .find((o) => o.getAttribute('data-agent') === 'kortix')!;
    const claudeOption = screen
      .getAllByTestId('agent-option')
      .find((o) => o.getAttribute('data-agent') === 'claude')!;

    expect(within(kortixOption).getByTestId('agent-connection-dot')).toBeTruthy();
    expect(within(claudeOption).queryByTestId('agent-connection-dot')).toBeNull();
  });

  it('omitting projectId forwards undefined (not a hardcoded value) into useModelsPage', () => {
    // This proves `AgentSelector`'s `projectId` prop is genuinely threaded
    // from `SessionChatInput`'s own prop, not hardcoded — when the composer
    // has no `projectId` (e.g. no project context yet), `useModelsPage`
    // receives `undefined`. This mock always echoes back whatever
    // `runtimes` fixture is set regardless of the `projectId` it's called
    // with, so it can't stand in for "no dots" degradation on its own — that
    // behavior lives in `useModelsPage`'s real disabled queries
    // (`packages/sdk/src/react/use-models-page.ts`: every underlying
    // `useQuery` is `enabled: Boolean(projectId)`), verified directly in
    // that module's own tests.
    renderComposer();

    expect(capturedModelsPageProjectId).toBeUndefined();
  });
});
