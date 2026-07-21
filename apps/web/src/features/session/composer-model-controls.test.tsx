// Render suite for `ComposerModelControls` — the wiring/branching layer that
// decides which of the THREE mutually-exclusive model controls renders:
// main's `ModelSelector` (catalog mode, OpenCode), the interactive
// `HarnessManagedModelSelector` (Claude Code / Codex live, with a declared
// model config option), or the static `HarnessManagedModelLabel` (not live
// yet, or the harness declared none — see `HarnessManagedModelState`'s doc
// comment). `ModelSelector` itself is stubbed to a props-capturing marker (it
// has its own render suite via `model-selector.test.ts`'s pure-function
// coverage and the other `ModelSelector` call sites' tests) — this file only
// tests the branching `ComposerModelControls` owns. `HarnessManagedModelLabel`
// and `HarnessManagedModelSelector` render for real (a plain `Hint`+`span`,
// and a real `AcpConfigOptionPill` respectively — no query/router
// dependency), so this needs a real DOM — same happy-dom + testing-library
// harness `model-selector.test.ts` used before it was folded into this
// restore. The empty export makes this file a module, so `await` is legal at
// the top level.
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

describe('ComposerModelControls — catalog mode (OpenCode)', () => {
  test('mounts with representative catalog props: ONE ModelSelector renders, no harness label', () => {
    resetCaptures();
    renderControls({ projectId: 'proj_1' });

    expect(capturedModelSelectorProps).not.toBeNull();
    expect(capturedModelSelectorProps?.models).toBe(MODELS);
    expect(capturedModelSelectorProps?.selectedModel).toBe(SELECTED_MODEL);
    expect(capturedReasoningEffortSelectorProps).not.toBeNull();
    expect(capturedReasoningEffortSelectorProps?.model).toBe(SELECTED_MODEL);
    expect(capturedReasoningEffortSelectorProps?.projectId).toBe('proj_1');
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

describe('ComposerModelControls — harness-managed mode (Claude Code / Codex / Pi)', () => {
  test('a harnessManagedModel prop renders the static label INSTEAD of ModelSelector — never both, never a mode switch inside the picker', () => {
    resetCaptures();
    renderControls({
      harnessManagedModel: { harness: 'claude', connectionLabel: 'Claude subscription' },
    });

    expect(capturedModelSelectorProps).toBeNull();
    const label = screen.getByTestId('harness-managed-model-label');
    expect(label.textContent).toBe('Claude subscription');
    expect(label.getAttribute('data-harness')).toBe('claude');
  });

  test('an explicit recorded override takes priority over the connection label', () => {
    resetCaptures();
    renderControls({
      harnessManagedModel: {
        harness: 'codex',
        selectedModel: 'gpt-5.4',
        connectionLabel: 'ChatGPT subscription',
      },
    });

    expect(screen.getByTestId('harness-managed-model-label').textContent).toBe('gpt-5.4');
  });

  test('no connection and no override falls back to "<Harness> default"', () => {
    resetCaptures();
    renderControls({ harnessManagedModel: { harness: 'pi' } });

    expect(screen.getByTestId('harness-managed-model-label').textContent).toBe('Pi default');
  });

  test('the reasoning-effort control still renders alongside the harness label', () => {
    resetCaptures();
    renderControls({ harnessManagedModel: { harness: 'claude' } });

    expect(capturedReasoningEffortSelectorProps).not.toBeNull();
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
  test('a writable modelOption renders a REAL interactive selector, not the static label', () => {
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

  test('a live session whose harness declared NO model option falls back to the static label — never a selector with nothing to pick', () => {
    resetCaptures();
    renderControls({
      harnessManagedModel: {
        harness: 'claude',
        selectedModel: 'claude-sonnet-5',
        connectionLabel: 'Claude subscription',
        disabled: true,
        // No `modelOption` — the live session's harness advertised no
        // writable model config option (or none has loaded yet).
      },
    });

    expect(screen.queryByTestId('harness-managed-model-selector')).toBeNull();
    expect(screen.getByTestId('harness-managed-model-label').textContent).toBe('claude-sonnet-5');
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
