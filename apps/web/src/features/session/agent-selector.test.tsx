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
// The real zustand store — the picker's "Manage agents" button drives the
// Customize overlay through it, so assert on actual store state rather than a
// mock (no provider needed; it's a plain module-level store).
const { useCustomizeStore } = await import('@/stores/customize-store');
const CUSTOMIZE_INITIAL = useCustomizeStore.getState();

afterEach(() => {
  cleanup();
  modelsPageRuntimes = [];
  useCustomizeStore.setState({
    open: false,
    section: CUSTOMIZE_INITIAL.section,
    membersTab: CUSTOMIZE_INITIAL.membersTab,
  });
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

// Radix `HoverCard` runs even focus-triggered opens through its `openDelay`
// timer (250ms in `CommandItemHoverCard`) — wait it out in real time.
async function flushHoverOpen() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
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
  it('renders the trigger with the selected agent shown as its brand name', () => {
    renderSelector();
    const trigger = screen.getByTestId('agent-selector');
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute('data-harness')).toBe('claude');
    // Single-agent harnesses (Claude Code, Codex, Pi) read as the brand,
    // never as the raw agent name ("claude").
    expect(within(trigger).getByText('Claude Code')).toBeTruthy();
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

  it('locked (disabled) state never opens the popover', async () => {
    renderSelector({ disabled: true });
    const trigger = screen.getByTestId('agent-selector');
    expect(trigger.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(trigger);
    await flush();

    expect(screen.queryAllByTestId('agent-option')).toHaveLength(0);
  });

  // 2026-07-22 decree: "Remove that little lock around the model, the agent,
  // always. Just on hover, keep the 'agent is fixed for the session' info."
  // — the lock GLYPH is gone; the locked semantics live only in the
  // trigger's wrapping `Hint` tooltip.
  it('locked (disabled) state renders no icon glyph on the trigger — no lock, no chevron (nothing to open)', () => {
    renderSelector({ disabled: true });
    const trigger = screen.getByTestId('agent-selector');
    // Only the harness brand mark (an `<img>`, stubbed from `next/image`)
    // remains — no trailing `<svg>` icon (lucide's `Lock` or `ChevronDown`).
    expect(trigger.querySelectorAll('svg')).toHaveLength(0);
    expect(trigger.querySelector('img')).toBeTruthy();
  });

  it('unlocked state keeps the ChevronDown (popover really does open)', () => {
    renderSelector({ disabled: false });
    const trigger = screen.getByTestId('agent-selector');
    expect(trigger.querySelectorAll('svg')).toHaveLength(1);
  });

  it('locked (disabled) state still exposes the "fixed for this session" explanation via the Hint tooltip prop, not a rendered glyph', async () => {
    renderSelector({ disabled: true });
    const trigger = screen.getByTestId('agent-selector');
    // Radix mounts `TooltipContent` into a portal only once open — focusing
    // the trigger (kept hoverable/focusable even though the popover itself
    // is gated shut, see the component's own comment) opens it with this
    // suite's `delayDuration={0}` `TooltipProvider`.
    fireEvent.focus(trigger);
    await flushHoverOpen();

    // Radix renders the tooltip's text twice (the visible bubble plus a
    // visually-hidden accessibility mirror) — assert at least one is present.
    expect(
      screen.getAllByText('Agent is fixed for this session — start a new session to switch').length,
    ).toBeGreaterThan(0);
  });
});

describe('AgentSelector — "Manage agents" button', () => {
  it('sits in the search row and opens the Customize overlay on the Agents section, closing the popover', async () => {
    renderSelector();
    fireEvent.click(screen.getByTestId('agent-selector'));
    await flush();

    // Lives inside the command input row, not the agent list — it's a way OUT
    // of the picker, never something Enter/arrow keys can land on.
    const configure = screen.getByTestId('agent-selector-configure');
    expect(configure.closest('[data-slot="command-input-wrapper"]')).toBeTruthy();

    fireEvent.click(configure);
    await flush();

    const state = useCustomizeStore.getState();
    expect(state.open).toBe(true);
    expect(state.section).toBe('agents');
    // The picker gets out of the overlay's way.
    expect(screen.queryAllByTestId('agent-option')).toHaveLength(0);
  });

  it('is hidden when the Customize overlay is already open (this picker is embedded in the Channels section)', async () => {
    act(() => {
      useCustomizeStore.setState({ open: true, section: 'channels' });
    });
    renderSelector();
    fireEvent.click(screen.getByTestId('agent-selector'));
    await flush();

    // Rows still render — only the "go to Customize" escape hatch is dropped,
    // so a half-filled channels form can't be yanked to another section.
    expect(screen.getAllByTestId('agent-option').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('agent-selector-configure')).toBeNull();
  });
});

describe('AgentSelector — uniform flat list', () => {
  it('never renders group headings — one flat list of logo + name rows', async () => {
    renderSelector();
    fireEvent.click(screen.getByTestId('agent-selector'));
    await flush();

    expect(screen.queryAllByTestId('agent-group-heading')).toHaveLength(0);

    // Every row shares the same anatomy: a harness logo and a name.
    // `ProviderLogo`'s wrapper is `aria-hidden` (decorative brand mark),
    // so query the DOM directly rather than through the accessibility tree.
    for (const option of screen.getAllByTestId('agent-option')) {
      expect(option.querySelector('img')).toBeTruthy();
    }
  });

  it('single-agent harnesses read as the brand, with no badge or description chrome', async () => {
    renderSelector();
    fireEvent.click(screen.getByTestId('agent-selector'));
    await flush();

    const claudeOption = screen
      .getAllByTestId('agent-option')
      .find((o) => o.getAttribute('data-agent') === 'claude')!;
    expect(within(claudeOption).getByText('Claude Code')).toBeTruthy();
    // No redundant chrome: the harness IS the agent.
    expect(within(claudeOption).queryByText('Anthropic coding agent')).toBeNull();
    expect(within(claudeOption).queryByText(/^Claude$/)).toBeNull();
  });

  it('OpenCode agents read as themselves, with no description chrome', async () => {
    renderSelector();
    fireEvent.click(screen.getByTestId('agent-selector'));
    await flush();

    const kortixOption = screen
      .getAllByTestId('agent-option')
      .find((o) => o.getAttribute('data-agent') === 'kortix')!;
    expect(within(kortixOption).getByText('kortix')).toBeTruthy();
    expect(within(kortixOption).queryByText('Model-agnostic OpenCode agent')).toBeNull();
  });

  it('an OpenCode row surfaces its manifest description in a hover card', async () => {
    renderSelector();
    fireEvent.click(screen.getByTestId('agent-selector'));
    await flush();

    const kortixOption = screen
      .getAllByTestId('agent-option')
      .find((o) => o.getAttribute('data-agent') === 'kortix')!;
    // Radix HoverCard also opens on keyboard focus — the deterministic way to
    // trigger it in tests (no simulated pointer geometry needed).
    fireEvent.focus(kortixOption);
    await flushHoverOpen();

    const card = screen.getByTestId('agent-hover-card');
    expect(card.textContent).toContain('kortix');
    expect(card.textContent).toContain('Model-agnostic OpenCode agent');
  });

  it('a brand row hover card explains the harness', async () => {
    renderSelector();
    fireEvent.click(screen.getByTestId('agent-selector'));
    await flush();

    const claudeOption = screen
      .getAllByTestId('agent-option')
      .find((o) => o.getAttribute('data-agent') === 'claude')!;
    fireEvent.focus(claudeOption);
    await flushHoverOpen();

    const card = screen.getByTestId('agent-hover-card');
    expect(card.textContent).toContain('Claude Code');
    expect(card.textContent).toContain("Anthropic's coding harness");
  });

  it('brand rows come before OpenCode agents', async () => {
    renderSelector();
    fireEvent.click(screen.getByTestId('agent-selector'));
    await flush();

    const options = screen.getAllByTestId('agent-option');
    expect(options.map((o) => o.getAttribute('data-agent'))).toEqual(['claude', 'kortix']);
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
