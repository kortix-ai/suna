'use client';

import type { ProviderListResponse } from '@/hooks/runtime/use-runtime-sessions';
import type { HarnessAuthKind } from '@kortix/sdk';
import type { ModelPickerViewModel } from '@kortix/sdk/react';

import { HarnessModelSelector, type HarnessModelSelectorProps } from './harness-model-selector';
import { ModelPicker } from './model-picker/model-picker';
import { ModelSelector, type ModelDefaultControls } from './model-selector';
import { ReasoningEffortSelector } from './reasoning-effort-selector';
import type { FlatModel } from './session-chat-input';

export interface ComposerModelControlsProps {
  /**
   * `unified_model_picker`-flag picker. When set, renders exactly ONE
   * `ModelPicker` in place of `ModelSelector`/`HarnessModelSelector` for
   * every harness — mutually exclusive with `models`/`harnessModel` (both
   * legacy props are ignored while this is present). `undefined` (the
   * default) leaves the legacy fork completely untouched — flag-off is a
   * byte-identical render.
   */
  modelPicker?: {
    vm: ModelPickerViewModel;
    onConnect: (connectionId: HarnessAuthKind) => void;
    disabled?: boolean;
    onManageModels?: () => void;
    /** Empty-state fallback CTA — see `ModelPickerProps.onConnectFallback`. */
    onConnectFallback?: () => void;
    /** Empty-state Upgrade CTA — see `ModelPickerProps.showUpgradeOption`/`onUpgrade`. */
    showUpgradeOption?: boolean;
    onUpgrade?: () => void;
  };
  models: FlatModel[];
  selectedModel: { providerID: string; modelID: string } | null;
  onModelChange?: (model: { providerID: string; modelID: string } | null) => void;
  providers?: ProviderListResponse;
  /** Optional "set as default" controls for the model picker (account/per-agent). */
  modelDefaultControls?: ModelDefaultControls;
  /** Harness-owned default/custom model selection for Claude, Codex, and Pi. */
  harnessModel?: Pick<
    HarnessModelSelectorProps,
    | 'harness'
    | 'selectedModel'
    | 'onSelect'
    | 'presets'
    | 'connectionLabel'
    | 'connectionKind'
    | 'customAllowed'
    | 'disabled'
  >;
  /** If true, a concrete model must be selected before a chat/command send. */
  modelRequired?: boolean;
  /** Project ID — lets the reasoning-effort control read/write this
   *  project's per-model generation config (see reasoning-effort-selector.tsx). */
  projectId?: string;
}

/**
 * The composer toolbar's model-picking row: the legacy `ModelSelector` +
 * `HarnessModelSelector` fork (or the unified `ModelPicker` when the
 * `unified_model_picker` flag is on and `modelPicker` is supplied), followed
 * by the reasoning-effort control. Extracted verbatim from
 * `session-chat-input.tsx`'s bottom toolbar — see that file's render for
 * where `AgentSelector` sits just before this block.
 */
export function ComposerModelControls({
  modelPicker,
  models,
  selectedModel,
  onModelChange,
  providers,
  modelDefaultControls,
  harnessModel,
  modelRequired = false,
  projectId,
}: ComposerModelControlsProps) {
  return (
    <>
      {modelPicker ? (
        <ModelPicker
          vm={modelPicker.vm}
          onConnect={modelPicker.onConnect}
          disabled={modelPicker.disabled}
          onManageModels={modelPicker.onManageModels}
          onConnectFallback={modelPicker.onConnectFallback}
          showUpgradeOption={modelPicker.showUpgradeOption}
          onUpgrade={modelPicker.onUpgrade}
        />
      ) : (
        <>
          {(models.length > 0 || modelRequired) && onModelChange && (
            <ModelSelector
              models={models}
              selectedModel={selectedModel}
              onSelect={onModelChange}
              providers={providers}
              defaultControls={modelDefaultControls}
            />
          )}
          {harnessModel ? <HarnessModelSelector {...harnessModel} /> : null}
        </>
      )}
      {/* Reasoning-effort control. Renders nothing unless the selected
          model actually exposes a reasoning_options effort knob (see
          reasoning-effort-selector.tsx for why this is capability-
          gated off the live catalog). */}
      <ReasoningEffortSelector model={selectedModel} projectId={projectId} />
    </>
  );
}
