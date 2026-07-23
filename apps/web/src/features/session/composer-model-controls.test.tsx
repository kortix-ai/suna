// Render suite for `ComposerModelControls` — the wiring/branching layer that
// decides which of the TWO mutually-exclusive model controls renders: main's
// `ModelSelector` (catalog mode, OpenCode/Pi — live or pre-session, one
// control either way) or the interactive `HarnessManagedModelSelector`
// (Claude Code / Codex, live or pre-session, always with a real modelOption —
// see `HarnessManagedModelState`'s doc comment). The static
// `HarnessManagedModelLabel` this file used to also cover is DELETED
// (2026-07-22 decree: every harness, in every state, renders a real
// interactive selector — never a dead label). `ModelSelector` itself is
// stubbed to a props-capturing marker (it has its own render suite via
// `model-selector.test.ts`'s pure-function coverage and the other
// `ModelSelector` call sites' tests) — this file only tests the branching
// `ComposerModelControls` owns. `HarnessManagedModelSelector` renders for
// real (a real `AcpConfigOptionPill` — no query/router dependency), so this
// needs a real DOM — same happy-dom + testing-library harness
// `model-selector.test.ts` used before it was folded into this restore. The
// empty export makes this file a module, so `await` is legal at the top
// level.
export {};

const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { TooltipProvider } = await import('@/components/ui/tooltip');

let capturedModelSelectorProps: Record<string, unknown> | null = null;
mock.module('./model-selector', () => ({
  ModelSelector: (props: Record<string, unknown>) => {
    capturedModelSelectorProps = props;
    return null;
  },
}));

let capturedReasoningEffortSelectorProps: Record<string, unknown> | null = null;
mock.module('./reasoning-effort-selector', () => ({
  ReasoningEffortSelector: (props: Record<string, unknown>) => {
    capturedReasoningEffortSelectorProps = props;
    return null;
  },
}));

// `HarnessManagedModelSelector` now consults `useModelConnectionGate` to wire
// its Connect + Manage footer (the same connect-modal host the catalog
// selector uses). Stub it to plain spies so the harness-native render tests
// stay a pure DOM test with no QueryClient/router/ConnectModalHost harness,
// AND so the footer wiring is assertable.
const connectProviderCalls: Array<unknown[]> = [];
mock.module('./use-model-connection-gate', () => ({
  useModelConnectionGate: () => ({
    openConnectProvider: (...args: unknown[]) => connectProviderCalls.push(args),
    openUpgrade: () => {},
    modal: null,
    hasSelectableModels: true,
    entitlementsPending: false,
    showUpgradeOption: true,
  }),
}));

const { ComposerModelControls } = await import('./composer-model-controls');
const { HARNESS_MODEL_OPTION_FALLBACK } = await import('@kortix/sdk/react');

/** Asserts + narrows a static fallback entry — used instead of a non-null
 *  assertion (Biome's `noNonNullAssertion`) in the pre-session tests below. */
function requireFallback(
  option: (typeof HARNESS_MODEL_OPTION_FALLBACK)[keyof typeof HARNESS_MODEL_OPTION_FALLBACK],
) {
  if (!option) throw new Error('expected a static harness model fallback entry');
  return option;
}
type FlatModel = Parameters<typeof ComposerModelControls>[0]['models'][number];

afterEach(() => {
  cleanup();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function resetCaptures() {
  capturedModelSelectorProps = null;
  capturedReasoningEffortSelectorProps = null;
  connectProviderCalls.length = 0;
}

const MODELS: FlatModel[] = [
  {
    providerID: 'anthropic',
    providerName: 'Anthropic',
    modelID: 'claude-sonnet-5',
    modelName: 'Claude Sonnet 5',
  },
];
const SELECTED_MODEL = { providerID: 'anthropic', modelID: 'claude-sonnet-5' };

function renderControls(props: Partial<Parameters<typeof ComposerModelControls>[0]> = {}) {
  return render(
    <TooltipProvider>
      <ComposerModelControls
        models={MODELS}
        selectedModel={SELECTED_MODEL}
        onModelChange={() => {}}
        {...props}
      />
    </TooltipProvider>,
  );
}

describe('ComposerModelControls — catalog mode (OpenCode, Pi — live or pre-session, same control)', () => {
  test('mounts with representative catalog props: ONE ModelSelector renders, never a harness-managed selector', () => {
    resetCaptures();
    renderControls({ projectId: 'proj_1' });

    expect(capturedModelSelectorProps).not.toBeNull();
    expect(capturedModelSelectorProps?.models).toBe(MODELS);
    expect(capturedModelSelectorProps?.selectedModel).toBe(SELECTED_MODEL);
    expect(capturedReasoningEffortSelectorProps).not.toBeNull();
    expect(capturedReasoningEffortSelectorProps?.model).toBe(SELECTED_MODEL);
    expect(capturedReasoningEffortSelectorProps?.projectId).toBe('proj_1');
    expect(screen.queryByTestId('harness-managed-model-selector')).toBeNull();
    expect(screen.queryByTestId('harness-managed-model-label')).toBeNull();
  });

  test('empty models + no modelRequired + no harnessManagedModel: nothing renders, ReasoningEffortSelector still does', () => {
    resetCaptures();
    renderControls({ models: [], onModelChange: undefined });

    expect(capturedModelSelectorProps).toBeNull();
    expect(capturedReasoningEffortSelectorProps).not.toBeNull();
    expect(screen.queryByTestId('harness-managed-model-label')).toBeNull();
  });

  test('modelRequired renders ModelSelector even with an empty catalog', () => {
    resetCaptures();
    renderControls({ models: [], modelRequired: true });

    expect(capturedModelSelectorProps).not.toBeNull();
    expect(capturedModelSelectorProps?.models).toEqual([]);
  });
});

// The static `HarnessManagedModelLabel` is deleted (2026-07-22 decree: every
// harness, in every state — pre-session, connecting, live — renders a REAL
// interactive selector, never a static "X manages its own model" pill).
// `harnessManagedModel` itself is now always either `undefined` (catalog
// harnesses: OpenCode, Pi, in every state) or a fully-populated object with a
// real `modelOption` (claude/codex) — there is no third "declared, nothing to
// render" shape left, so there is nothing here to unit-test beyond the
// selector-render coverage below.
describe('ComposerModelControls — the static label no longer exists', () => {
  test('no prop shape can produce #harness-managed-model-label — it is not in the module at all', async () => {
    const exports = await import('./composer-model-controls');
    expect((exports as Record<string, unknown>).HarnessManagedModelLabel).toBeUndefined();
  });
});

// Radix Popper measures its own position in an effect that settles a tick
// after a synchronous `act()` block returns — flush it after every
// interaction that can toggle the popover, matching
// `acp-config-option-pills.test.tsx`'s convention.
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

// Real payload shape (verified live against claude-agent-acp,
// `kortix.acp_session_envelopes`, dev DB, 2026-07-21).
const CLAUDE_MODEL_OPTION = {
  id: 'model',
  name: 'Model',
  type: 'select' as const,
  category: 'model',
  currentValue: 'default',
  options: [
    { name: 'Default (recommended)', value: 'default' },
    { name: 'Sonnet', value: 'sonnet' },
    { name: 'Opus', value: 'opus' },
    { name: 'Haiku', value: 'haiku' },
  ],
};

describe('ComposerModelControls — harness-native live selector (Claude Code / Codex, live session)', () => {
  test('a writable modelOption renders a REAL interactive selector', () => {
    resetCaptures();
    renderControls({
      harnessManagedModel: {
        harness: 'claude',
        modelOption: CLAUDE_MODEL_OPTION,
        onModelOptionChange: () => {},
      },
    });

    expect(capturedModelSelectorProps).toBeNull();
    expect(screen.queryByTestId('harness-managed-model-label')).toBeNull();
    const selector = screen.getByTestId('harness-managed-model-selector');
    expect(selector.getAttribute('data-harness')).toBe('claude');
    // The underlying pill shows the option's own current value, not the
    // static label's separately-derived `selectedModel`.
    expect(screen.getByText('Default (recommended)')).toBeTruthy();
  });

  test('picking a choice calls onModelOptionChange with the choice value — round-trips through ACP session/set_config_option, never the gateway catalog', async () => {
    resetCaptures();
    const onModelOptionChange = mock((_value: unknown) => {});
    renderControls({
      harnessManagedModel: {
        harness: 'claude',
        modelOption: CLAUDE_MODEL_OPTION,
        onModelOptionChange,
      },
    });

    fireEvent.click(screen.getByTestId('acp-config-option-pill'));
    await flush();
    fireEvent.click(screen.getByText('Opus'));
    await flush();

    expect(onModelOptionChange).toHaveBeenCalledWith('opus');
    // The catalog's own onModelChange must never fire for a harness-native pick.
    expect(capturedModelSelectorProps).toBeNull();
  });

  test('offers the SAME Connect + Manage-models actions as the catalog selector — every harness gets them, wired to the shared connect-modal host', async () => {
    resetCaptures();
    renderControls({
      harnessManagedModel: {
        harness: 'claude',
        modelOption: CLAUDE_MODEL_OPTION,
        onModelOptionChange: () => {},
      },
    });

    fireEvent.click(screen.getByTestId('acp-config-option-pill'));
    await flush();
    expect(screen.getByTestId('acp-model-connect-action')).toBeTruthy();
    expect(screen.getByTestId('acp-model-manage-action')).toBeTruthy();

    // "+" routes to the connect modal's api-keys tab (clicking closes the
    // popover, so reopen before the second action).
    fireEvent.click(screen.getByTestId('acp-model-connect-action'));
    await flush();
    fireEvent.click(screen.getByTestId('acp-config-option-pill'));
    await flush();
    // "Manage models" opens the same connect surface on its default view —
    // identical to `ModelSelector`'s header affordances.
    fireEvent.click(screen.getByTestId('acp-model-manage-action'));
    await flush();
    expect(connectProviderCalls).toEqual([['api-keys'], []]);
  });

  test('a modelOption with zero choices renders nothing from the selector wrapper (defensive — ComposerModelControls itself never passes one, per isWritableAcpModelConfigOption)', () => {
    resetCaptures();
    renderControls({
      harnessManagedModel: {
        harness: 'claude',
        modelOption: { ...CLAUDE_MODEL_OPTION, options: [] },
        onModelOptionChange: () => {},
      },
    });

    // `AcpConfigOptionPill` itself renders null for zero choices.
    expect(screen.queryByTestId('acp-config-option-pill')).toBeNull();
  });
});

describe('ComposerModelControls — pre-session (no live ACP session yet, static fallback)', () => {
  // `composer-chat-input.tsx` resolves the SAME `modelOption` shape
  // pre-session (from `use-harness-model-options-store.ts`'s cache/fallback)
  // as it does live — `ComposerModelControls` genuinely cannot tell the two
  // apart, and that's the point: ONE control, not a pre-session/live mode
  // switch. These tests exercise the real static fallback constant to prove
  // the "static fallback should never leave Claude/Codex on the dead label"
  // guarantee end-to-end.
  test('claude pre-session (no live session): the static fallback renders a REAL interactive selector, not the dead label', () => {
    resetCaptures();
    const fallback = requireFallback(HARNESS_MODEL_OPTION_FALLBACK.claude);
    renderControls({
      harnessManagedModel: {
        harness: 'claude',
        // No stored deferred pick yet — nothing chosen, an honest state.
        modelOption: { ...fallback, currentValue: undefined },
        onModelOptionChange: () => {},
      },
    });

    expect(screen.queryByTestId('harness-managed-model-label')).toBeNull();
    const selector = screen.getByTestId('harness-managed-model-selector');
    expect(selector.getAttribute('data-harness')).toBe('claude');
  });

  test('codex pre-session: the static fallback renders a REAL interactive selector too', () => {
    resetCaptures();
    const fallback = requireFallback(HARNESS_MODEL_OPTION_FALLBACK.codex);
    renderControls({
      harnessManagedModel: {
        harness: 'codex',
        modelOption: { ...fallback, currentValue: undefined },
        onModelOptionChange: () => {},
      },
    });

    expect(screen.queryByTestId('harness-managed-model-label')).toBeNull();
    expect(screen.getByTestId('harness-managed-model-selector').getAttribute('data-harness')).toBe(
      'codex',
    );
  });

  test("a stored deferred pick shows as the pill's current value pre-session", () => {
    resetCaptures();
    const fallback = requireFallback(HARNESS_MODEL_OPTION_FALLBACK.claude);
    renderControls({
      harnessManagedModel: {
        harness: 'claude',
        modelOption: { ...fallback, currentValue: 'opus' },
        onModelOptionChange: () => {},
      },
    });

    expect(screen.getByText('Opus')).toBeTruthy();
  });

  test('picking a choice pre-session calls onModelOptionChange (persists the deferred pick) without touching the catalog selector', async () => {
    resetCaptures();
    const fallback = requireFallback(HARNESS_MODEL_OPTION_FALLBACK.claude);
    const onModelOptionChange = mock((_value: unknown) => {});
    renderControls({
      harnessManagedModel: {
        harness: 'claude',
        modelOption: { ...fallback, currentValue: undefined },
        onModelOptionChange,
      },
    });

    fireEvent.click(screen.getByTestId('acp-config-option-pill'));
    await flush();
    fireEvent.click(screen.getByText('Haiku'));
    await flush();

    expect(onModelOptionChange).toHaveBeenCalledWith('haiku');
    expect(capturedModelSelectorProps).toBeNull();
  });

  test('a live-confirmed value later WINS over a stale pre-session pick — same control, honest state', () => {
    // Once live, `composer-chat-input.tsx` swaps `modelOption.currentValue`
    // to the harness's own confirmed value (never the deferred pick it may
    // have started from) — simulated here directly since ComposerModelControls
    // itself is source-agnostic.
    resetCaptures();
    const fallback = requireFallback(HARNESS_MODEL_OPTION_FALLBACK.claude);
    renderControls({
      harnessManagedModel: {
        harness: 'claude',
        // The harness settled on 'sonnet' even though a prior deferred pick
        // (say, 'opus') may have been rejected/superseded — the control must
        // show what actually happened, never the stale pick.
        modelOption: { ...fallback, currentValue: 'sonnet' },
        onModelOptionChange: () => {},
      },
    });

    expect(screen.getByText('Sonnet')).toBeTruthy();
    expect(screen.queryByText('Opus')).toBeNull();
  });
});

// 2026-07-22 decree, ship test: "component renders a selector for every
// harness × {pre-session, live}". `ComposerModelControls` itself can't tell
// pre-session from live (see the describe block above) — the matrix that
// actually matters is HOW `composer-chat-input.tsx` feeds it per harness, so
// this exercises every harness's REALISTIC prop shape in both states and
// asserts a real selector renders every time, never the (deleted) label.
describe('ComposerModelControls — always a selector, every harness × {pre-session, live}', () => {
  test('claude: pre-session (fallback, no pick) renders the native selector', () => {
    resetCaptures();
    const fallback = requireFallback(HARNESS_MODEL_OPTION_FALLBACK.claude);
    renderControls({
      harnessManagedModel: {
        harness: 'claude',
        modelOption: { ...fallback, currentValue: undefined },
        onModelOptionChange: () => {},
      },
    });
    expect(screen.getByTestId('harness-managed-model-selector')).toBeTruthy();
    expect(screen.queryByTestId('harness-managed-model-label')).toBeNull();
  });

  test('claude: live with a writable ACP model option renders the native selector', () => {
    resetCaptures();
    renderControls({
      harnessManagedModel: {
        harness: 'claude',
        modelOption: CLAUDE_MODEL_OPTION,
        onModelOptionChange: () => {},
      },
    });
    expect(screen.getByTestId('harness-managed-model-selector')).toBeTruthy();
    expect(screen.queryByTestId('harness-managed-model-label')).toBeNull();
  });

  test('codex: pre-session (fallback, no pick) renders the native selector', () => {
    resetCaptures();
    const fallback = requireFallback(HARNESS_MODEL_OPTION_FALLBACK.codex);
    renderControls({
      harnessManagedModel: {
        harness: 'codex',
        modelOption: { ...fallback, currentValue: undefined },
        onModelOptionChange: () => {},
      },
    });
    expect(screen.getByTestId('harness-managed-model-selector')).toBeTruthy();
    expect(screen.queryByTestId('harness-managed-model-label')).toBeNull();
  });

  test('codex: live with a writable ACP model option renders the native selector', () => {
    resetCaptures();
    const fallback = requireFallback(HARNESS_MODEL_OPTION_FALLBACK.codex);
    renderControls({
      harnessManagedModel: {
        harness: 'codex',
        modelOption: { ...fallback, currentValue: 'gpt-5.6-sol' },
        onModelOptionChange: () => {},
      },
    });
    expect(screen.getByTestId('harness-managed-model-selector')).toBeTruthy();
    expect(screen.queryByTestId('harness-managed-model-label')).toBeNull();
  });

  // OpenCode/Pi never construct `harnessManagedModel` at all (catalog-driven
  // — see `harness-capabilities.ts`'s `agentRequiresCatalogModel`) — their
  // "selector" IS the catalog `ModelSelector`, fed identically pre-session
  // and live by `composer-chat-input.tsx` (no more `live ? [] : …` gate —
  // see that file's fix). `ComposerModelControls` itself is state-agnostic,
  // so exercising "no harnessManagedModel, real models feed" once covers
  // both pre-session and live for both harnesses — there's nothing about
  // OpenCode vs. Pi, or live vs. pre-session, this component could branch on
  // even if it wanted to.
  test('opencode/pi: no harnessManagedModel + a real models feed renders the catalog ModelSelector (covers both pre-session and live)', () => {
    resetCaptures();
    renderControls({ harnessManagedModel: undefined, models: MODELS, selectedModel: SELECTED_MODEL });

    expect(screen.queryByTestId('harness-managed-model-selector')).toBeNull();
    expect(screen.queryByTestId('harness-managed-model-label')).toBeNull();
    expect(capturedModelSelectorProps).not.toBeNull();
    expect(capturedModelSelectorProps?.models).toBe(MODELS);
  });

  test('opencode/pi: an empty models feed (e.g. a live session whose capability catalog has not resolved yet) still renders — never a dead state, `modelRequired` forces the selector open on an empty catalog', () => {
    resetCaptures();
    renderControls({
      harnessManagedModel: undefined,
      models: [],
      selectedModel: null,
      modelRequired: true,
    });

    expect(capturedModelSelectorProps).not.toBeNull();
    expect(capturedModelSelectorProps?.models).toEqual([]);
  });
});
