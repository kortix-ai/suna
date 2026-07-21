import { describe, expect, mock, test } from 'bun:test';
import { act, create } from 'react-test-renderer';

import type { FlatModel } from './session-chat-input';

// Same DOM-free harness `composer-chat-input.test.tsx` uses for composer
// wiring: no jsdom in this workspace, so `react-test-renderer` + manual
// `act()`. `ModelSelector` is stubbed to a props-capturing marker, so this
// file tests the WIRING/branching `ComposerModelControls` owns (whether the
// picker renders at all, catalog vs harness props) — not `ModelSelector`'s/
// `ReasoningEffortSelector`'s own rendering (that's each file's own test's
// job).
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <ComposerModelControls
        models={MODELS}
        selectedModel={SELECTED_MODEL}
        onModelChange={() => {}}
        {...props}
      />,
    );
  });
  return renderer!;
}

describe('ComposerModelControls', () => {
  test('mounts with representative catalog props: ONE ModelSelector renders in catalog mode', () => {
    resetCaptures();
    renderControls({ projectId: 'proj_1' });

    expect(capturedModelSelectorProps).not.toBeNull();
    expect(capturedModelSelectorProps!.models).toBe(MODELS);
    expect(capturedModelSelectorProps!.selectedModel).toBe(SELECTED_MODEL);
    expect(capturedModelSelectorProps!.harnessModel).toBeUndefined();
    expect(capturedReasoningEffortSelectorProps).not.toBeNull();
    expect(capturedReasoningEffortSelectorProps!.model).toBe(SELECTED_MODEL);
    expect(capturedReasoningEffortSelectorProps!.projectId).toBe('proj_1');
  });

  test('a harnessModel prop switches the SAME ModelSelector into harness mode, forwarded verbatim', () => {
    resetCaptures();
    const harnessModel = {
      harness: 'claude' as const,
      selectedModel: null,
      onSelect: () => {},
    };
    renderControls({ harnessModel });

    expect(capturedModelSelectorProps).not.toBeNull();
    expect(capturedModelSelectorProps!.harnessModel).toBe(harnessModel);
    expect(capturedModelSelectorProps!.models).toBeUndefined();
  });

  test('empty models + no modelRequired + no harnessModel: ModelSelector does not render, ReasoningEffortSelector still does', () => {
    resetCaptures();
    renderControls({ models: [], onModelChange: undefined });

    expect(capturedModelSelectorProps).toBeNull();
    expect(capturedReasoningEffortSelectorProps).not.toBeNull();
  });

  test('modelRequired renders ModelSelector even with an empty catalog', () => {
    resetCaptures();
    renderControls({ models: [], modelRequired: true });

    expect(capturedModelSelectorProps).not.toBeNull();
    expect(capturedModelSelectorProps!.models).toEqual([]);
  });
});
