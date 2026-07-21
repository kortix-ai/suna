// Render suite for `ComposerModelControls` — the wiring/branching layer that
// decides which of the two mutually-exclusive model controls renders: main's
// `ModelSelector` (catalog mode, OpenCode) or the static
// `HarnessManagedModelLabel` (Claude Code / Codex / Pi — see
// `HarnessManagedModelState`'s doc comment). `ModelSelector` itself is
// stubbed to a props-capturing marker (it has its own render suite via
// `model-selector.test.ts`'s pure-function coverage and the other
// `ModelSelector` call sites' tests) — this file only tests the branching
// `ComposerModelControls` owns. `HarnessManagedModelLabel` renders for real
// (it's a plain `Hint`+`span`, no query/router dependency), so this needs a
// real DOM — same happy-dom + testing-library harness `model-selector.test.ts`
// used before it was folded into this restore. The empty export makes this
// file a module, so `await` is legal at the top level.
export {};

const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { cleanup, render, screen } = await import('@testing-library/react');
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
    expect(capturedModelSelectorProps!.models).toBe(MODELS);
    expect(capturedModelSelectorProps!.selectedModel).toBe(SELECTED_MODEL);
    expect(capturedReasoningEffortSelectorProps).not.toBeNull();
    expect(capturedReasoningEffortSelectorProps!.model).toBe(SELECTED_MODEL);
    expect(capturedReasoningEffortSelectorProps!.projectId).toBe('proj_1');
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
    expect(capturedModelSelectorProps!.models).toEqual([]);
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
