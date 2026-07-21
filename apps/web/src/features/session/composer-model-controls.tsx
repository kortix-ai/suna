'use client';

import type { ProviderListResponse } from '@/hooks/runtime/use-runtime-sessions';

import {
  type HarnessModelSelection,
  type ModelDefaultControls,
  ModelSelector,
} from './model-selector';
import { ReasoningEffortSelector } from './reasoning-effort-selector';
import type { FlatModel } from './session-chat-input';

export interface ComposerModelControlsProps {
  models: FlatModel[];
  selectedModel: { providerID: string; modelID: string } | null;
  onModelChange?: (model: { providerID: string; modelID: string } | null) => void;
  providers?: ProviderListResponse;
  /** Optional "set as default" controls for the model picker (account/per-agent). */
  modelDefaultControls?: ModelDefaultControls;
  /** Harness-owned default/custom model selection for Claude, Codex, and Pi. */
  harnessModel?: HarnessModelSelection;
  /** If true, a concrete model must be selected before a chat/command send. */
  modelRequired?: boolean;
  /** Project ID — lets the reasoning-effort control read/write this
   *  project's per-model generation config (see reasoning-effort-selector.tsx). */
  projectId?: string;
}

/**
 * The composer toolbar's model-picking row: the ONE `ModelSelector` — gateway
 * catalog mode for OpenCode, harness-native mode (`harnessModel`) for Claude
 * Code / Codex / Pi — followed by the reasoning-effort control. Extracted
 * verbatim from `session-chat-input.tsx`'s bottom toolbar — see that file's
 * render for where `AgentSelector` sits just before this block.
 */
export function ComposerModelControls({
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
      {harnessModel ? (
        <ModelSelector harnessModel={harnessModel} />
      ) : (models.length > 0 || modelRequired) && onModelChange ? (
        <ModelSelector
          models={models}
          selectedModel={selectedModel}
          onSelect={onModelChange}
          providers={providers}
          defaultControls={modelDefaultControls}
        />
      ) : null}
      {/* Reasoning-effort control. Renders nothing unless the selected
          model actually exposes a reasoning_options effort knob (see
          reasoning-effort-selector.tsx for why this is capability-
          gated off the live catalog). */}
      <ReasoningEffortSelector model={selectedModel} projectId={projectId} />
    </>
  );
}
