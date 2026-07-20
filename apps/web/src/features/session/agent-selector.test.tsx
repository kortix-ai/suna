// Component-render suite for `AgentSelector` — extracted verbatim out of
// `session-chat-input.tsx` (Task 13). Follows the `model-picker.test.tsx`
// precedent: `CommandPopover` portals its content through Radix `Popover`,
// which silently no-ops under this directory's usual `react-test-renderer`
// harness, so this file needs a REAL DOM. `GlobalRegistrator.register()` must
// run before `@testing-library/react` is evaluated (ESM hoists static
// imports above ordinary statements), hence the dynamic `import()`s under a
// top-level `await`.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, it, mock } = await import('bun:test');
const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const ReactModule = await import('react');

import type { Agent } from '@/hooks/runtime/use-runtime-sessions';

// `ProviderLogo` (the harness brand mark) renders `next/image`, whose
// `getImgProps` builds a `URL` from the icon's relative asset path —
// happy-dom has no real page location to resolve that against and throws
// "Invalid URL" (same stub `connect-modal-host.test.tsx` uses).
mock.module('next/image', () => ({
  default: (props: Record<string, unknown>) => {
    const { src, alt, ...rest } = props;
    return ReactModule.createElement('img', { src, alt, ...rest });
  },
}));

// `AgentSelector` calls `useTranslations('hardcodedUi')` (`next-intl`)
// unconditionally at the top of its render body — identity passthrough,
// same convention `acp-chat-item-row.test.tsx` uses.
mock.module('next-intl', () => ({
  useTranslations: () =>
    Object.assign((key: string) => key, {
      raw: (key: string) => key,
      rich: (key: string) => key,
      markup: (key: string) => key,
    }),
}));

// `AgentSelector` reads per-harness connection status off `useModelsPage()`
// (Task 8) to drive the row-level "no model connected" dot. Spread the real
// module so `agentHarness`/`agentHarnessPresentation`/`harnessPresentation`
// (which the component also imports from here) stay live — only
// `useModelsPage` itself is stubbed, both to avoid needing a real
// `QueryClientProvider` in this DOM-only suite and to control per-test
// runtime fixtures directly (same convention `reasoning-effort-selector.test.tsx`
// uses for `useGatewayRoutingPolicy`).
type RuntimeFixture = { harness: string; status: string };
let modelsPageRuntimes: RuntimeFixture[] = [];
const actualSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...actualSdkReact,
  useModelsPage: () => ({
    runtimes: modelsPageRuntimes,
    connections: [],
    connectedProviderIds: [],
    canWrite: false,
    isLoading: false,
    isError: false,
  }),
}));

const { AgentSelector } = await import('./agent-selector');

afterEach(() => {
  cleanup();
  modelsPageRuntimes = [];
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

// Radix `Popper`'s content measures its own position in an effect that
// settles a tick after a synchronous `act()` block returns — flush it after
// every interaction that can toggle the popover, so no caller sees an
// "update not wrapped in act()" warning from a later, uncontrolled commit
// (same helper `model-picker.test.tsx` uses).
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const AGENTS: Agent[] = [
  { name: 'claude', harness: 'claude', description: 'Anthropic coding agent' },
  { name: 'kortix', harness: 'opencode', description: 'Model-agnostic OpenCode agent' },
  { name: 'ghost', harness: 'opencode', hidden: true },
  { name: 'planner', harness: 'opencode', mode: 'subagent' },
];

function renderSelector(over: Partial<Parameters<typeof AgentSelector>[0]> = {}) {
  const onSelect = mock((_agentName: string | null) => {});
  render(
    <TooltipProvider>
      <AgentSelector agents={AGENTS} selectedAgent="claude" onSelect={onSelect} {...over} />
    </TooltipProvider>,
  );
  return { onSelect };
}

describe('AgentSelector', () => {
  it('renders the trigger with the selected agent name and harness', () => {
    renderSelector();
    const trigger = screen.getByTestId('agent-selector');
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute('data-harness')).toBe('claude');
    expect(within(trigger).getByText('claude')).toBeTruthy();
  });

  it('lists only primary agents (hidden and subagent entries excluded) as agent-option rows', async () => {
    renderSelector();
    fireEvent.click(screen.getByTestId('agent-selector'));
    await flush();

    const options = screen.getAllByTestId('agent-option');
    expect(options).toHaveLength(2);
    expect(options.map((o) => o.getAttribute('data-agent')).sort()).toEqual(['claude', 'kortix']);
  });

  it('selecting an option calls onSelect with the agent name and closes the popover', async () => {
    const { onSelect } = renderSelector();
    fireEvent.click(screen.getByTestId('agent-selector'));
    await flush();

    const kortixOption = screen
      .getAllByTestId('agent-option')
      .find((o) => o.getAttribute('data-agent') === 'kortix');
    expect(kortixOption).toBeTruthy();
    fireEvent.click(kortixOption!);
    await flush();

    expect(onSelect).toHaveBeenCalledWith('kortix');
    expect(screen.queryAllByTestId('agent-option')).toHaveLength(0);
  });

  it('locked (disabled) state shows a Lock icon on the trigger and never opens the popover', async () => {
    renderSelector({ disabled: true });
    const trigger = screen.getByTestId('agent-selector');
    expect(trigger.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(trigger);
    await flush();

    expect(screen.queryAllByTestId('agent-option')).toHaveLength(0);
  });
});

// Every agent here is `opencode` — the single-harness case the brief pins as
// unchanged (existing behavior: a flat list, no group headers).
const SINGLE_HARNESS_AGENTS: Agent[] = [
  { name: 'kortix', harness: 'opencode', description: 'Model-agnostic OpenCode agent' },
  { name: 'reviewer', harness: 'opencode', description: 'Review-focused OpenCode agent' },
];

describe('AgentSelector — harness grouping', () => {
  it('single-harness project renders a flat list with no group headers', async () => {
    renderSelector({ agents: SINGLE_HARNESS_AGENTS, selectedAgent: 'kortix' });
    fireEvent.click(screen.getByTestId('agent-selector'));
    await flush();

    expect(screen.getAllByTestId('agent-option')).toHaveLength(2);
    expect(screen.queryAllByTestId('agent-group-heading')).toHaveLength(0);
  });

  it('agents spanning more than one harness always render group headers with a harness icon + label', async () => {
    renderSelector();
    fireEvent.click(screen.getByTestId('agent-selector'));
    await flush();

    const headings = screen.getAllByTestId('agent-group-heading');
    // AGENTS spans `claude` and `opencode` — two groups.
    expect(headings).toHaveLength(2);
    for (const heading of headings) {
      // `ProviderLogo`'s wrapper is `aria-hidden` (decorative brand mark),
      // so query the DOM directly rather than through the accessibility tree.
      expect(heading.querySelector('img')).toBeTruthy();
    }
    expect(headings.map((h) => h.textContent).join(' ')).toMatch(/claude/i);
    expect(headings.map((h) => h.textContent).join(' ')).toMatch(/opencode/i);
  });
});

describe('AgentSelector — connection status dot', () => {
  it('shows the dot + "No model connected" hint only for agents on a disconnected harness', async () => {
    modelsPageRuntimes = [
      { harness: 'claude', status: 'ready' },
      { harness: 'opencode', status: 'needs-attention' },
    ];
    renderSelector();
    fireEvent.click(screen.getByTestId('agent-selector'));
    await flush();

    const claudeOption = screen
      .getAllByTestId('agent-option')
      .find((o) => o.getAttribute('data-agent') === 'claude')!;
    const kortixOption = screen
      .getAllByTestId('agent-option')
      .find((o) => o.getAttribute('data-agent') === 'kortix')!;

    expect(within(claudeOption).queryByTestId('agent-connection-dot')).toBeNull();
    expect(within(kortixOption).getByTestId('agent-connection-dot')).toBeTruthy();
  });

  it('does not show a dot while the harness status is still "checking"', async () => {
    modelsPageRuntimes = [
      { harness: 'claude', status: 'ready' },
      { harness: 'opencode', status: 'checking' },
    ];
    renderSelector();
    fireEvent.click(screen.getByTestId('agent-selector'));
    await flush();

    const kortixOption = screen
      .getAllByTestId('agent-option')
      .find((o) => o.getAttribute('data-agent') === 'kortix')!;
    expect(within(kortixOption).queryByTestId('agent-connection-dot')).toBeNull();
  });

  it('selection is still allowed on a disconnected-harness agent — the dot is presentational only', async () => {
    modelsPageRuntimes = [
      { harness: 'claude', status: 'ready' },
      { harness: 'opencode', status: 'needs-attention' },
    ];
    const { onSelect } = renderSelector();
    fireEvent.click(screen.getByTestId('agent-selector'));
    await flush();

    const kortixOption = screen
      .getAllByTestId('agent-option')
      .find((o) => o.getAttribute('data-agent') === 'kortix')!;
    fireEvent.click(kortixOption);
    await flush();

    expect(onSelect).toHaveBeenCalledWith('kortix');
  });
});
