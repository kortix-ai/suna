import { describe, expect, mock, test } from 'bun:test';
import { act, create } from 'react-test-renderer';

import type { ModelPickerViewModel } from '@kortix/sdk/react';
import type { FlatModel } from './session-chat-input';

// Same DOM-free harness `composer-chat-input.test.tsx` uses for composer
// wiring: no jsdom in this workspace, so `react-test-renderer` + manual
// `act()`. Every child `ComposerModelControls` can render is stubbed to a
// props-capturing marker, so this file tests the WIRING/branching this
// component owns (which pill fork renders, what props each gets) — not
// `ModelPicker`'s/`ModelSelector`'s/`HarnessModelSelector`'s/
// `ReasoningEffortSelector`'s own rendering (that's each file's own test's
// job).
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedModelPickerProps: Record<string, unknown> | null = null;
mock.module('./model-picker/model-picker', () => ({
  ModelPicker: (props: Record<string, unknown>) => {
    capturedModelPickerProps = props;
    return null;
  },
}));

let capturedModelSelectorProps: Record<string, unknown> | null = null;
mock.module('./model-selector', () => ({
  ModelSelector: (props: Record<string, unknown>) => {
    capturedModelSelectorProps = props;
    return null;
  },
}));

let capturedHarnessModelSelectorProps: Record<string, unknown> | null = null;
mock.module('./harness-model-selector', () => ({
  HarnessModelSelector: (props: Record<string, unknown>) => {
    capturedHarnessModelSelectorProps = props;
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
  capturedModelPickerProps = null;
  capturedModelSelectorProps = null;
  capturedHarnessModelSelectorProps = null;
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
  test('mounts with representative props — legacy fork (no modelPicker): ModelSelector renders, ModelPicker does not', () => {
    resetCaptures();
    renderControls({ projectId: 'proj_1' });

    expect(capturedModelPickerProps).toBeNull();
    expect(capturedModelSelectorProps).not.toBeNull();
    expect(capturedModelSelectorProps!.models).toBe(MODELS);
    expect(capturedModelSelectorProps!.selectedModel).toBe(SELECTED_MODEL);
    expect(capturedHarnessModelSelectorProps).toBeNull();
    expect(capturedReasoningEffortSelectorProps).not.toBeNull();
    expect(capturedReasoningEffortSelectorProps!.model).toBe(SELECTED_MODEL);
    expect(capturedReasoningEffortSelectorProps!.projectId).toBe('proj_1');
  });

  test('legacy fork with a harnessModel prop also renders HarnessModelSelector, forwarded verbatim', () => {
    resetCaptures();
    const harnessModel = {
      harness: 'claude' as const,
      selectedModel: null,
      onSelect: () => {},
    };
    renderControls({ harnessModel });

    expect(capturedModelPickerProps).toBeNull();
    expect(capturedHarnessModelSelectorProps).not.toBeNull();
    expect(capturedHarnessModelSelectorProps).toEqual(harnessModel);
  });

  test('unified_model_picker shape: modelPicker set renders exactly ONE ModelPicker, never ModelSelector/HarnessModelSelector', () => {
    resetCaptures();
    const vm = { status: 'ready' } as unknown as ModelPickerViewModel;
    const onConnect = () => {};
    renderControls({
      modelPicker: { vm, onConnect, disabled: true, onManageModels: () => {} },
      harnessModel: { harness: 'claude', selectedModel: null, onSelect: () => {} },
    });

    expect(capturedModelPickerProps).not.toBeNull();
    expect(capturedModelPickerProps!.vm).toBe(vm);
    expect(capturedModelPickerProps!.onConnect).toBe(onConnect);
    expect(capturedModelPickerProps!.disabled).toBe(true);
    expect(capturedModelSelectorProps).toBeNull();
    expect(capturedHarnessModelSelectorProps).toBeNull();
    // Reasoning-effort control is independent of the picker fork.
    expect(capturedReasoningEffortSelectorProps).not.toBeNull();
  });

  test('modelPicker empty-state CTAs (onConnectFallback/showUpgradeOption/onUpgrade) forward verbatim to ModelPicker', () => {
    resetCaptures();
    const vm = { status: 'ready' } as unknown as ModelPickerViewModel;
    const onConnect = () => {};
    const onConnectFallback = () => {};
    const onUpgrade = () => {};
    renderControls({
      modelPicker: { vm, onConnect, onConnectFallback, showUpgradeOption: true, onUpgrade },
    });

    expect(capturedModelPickerProps).not.toBeNull();
    expect(capturedModelPickerProps!.onConnectFallback).toBe(onConnectFallback);
    expect(capturedModelPickerProps!.showUpgradeOption).toBe(true);
    expect(capturedModelPickerProps!.onUpgrade).toBe(onUpgrade);
  });

  test('empty models + no modelRequired + no harnessModel: neither legacy selector renders, ReasoningEffortSelector still does', () => {
    resetCaptures();
    renderControls({ models: [], onModelChange: undefined });

    expect(capturedModelSelectorProps).toBeNull();
    expect(capturedHarnessModelSelectorProps).toBeNull();
    expect(capturedReasoningEffortSelectorProps).not.toBeNull();
  });
});
