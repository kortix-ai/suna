'use client';

import Hint from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import type { HarnessAuthKind } from '@kortix/sdk';
import type { KortixHarness } from '@kortix/sdk/react';
import { harnessPresentation } from '@kortix/sdk/react';

import type { ProviderListResponse } from '@/hooks/runtime/use-runtime-sessions';

import {
  COMPOSER_PILL_DISABLED_CLASS,
  COMPOSER_PILL_TRIGGER_CLASS,
} from './composer-pill';
import { type ModelDefaultControls, ModelSelector } from './model-selector';
import { ReasoningEffortSelector } from './reasoning-effort-selector';
import type { FlatModel } from './session-chat-input';

/**
 * Static composer state for a harness that owns its default model (Claude
 * Code, Codex, Pi — `HARNESSES[id].ownsDefaultModel === true`, see
 * `packages/shared/src/harnesses.ts`). These harnesses never expose a
 * writable gateway/BYOK catalog to pick from and never support a live model
 * change mid-session — main's `ModelSelector` (a provider-grouped catalog
 * popover) has nothing to show them, so the composer renders a plain,
 * non-interactive label instead of a second picker component.
 */
export interface HarnessManagedModelState {
  harness: KortixHarness;
  /** An explicit launch-time override already recorded for this harness, if
   *  any (still applies even though this composer offers no control to set
   *  one). Falls back to the resolved connection/harness label when unset. */
  selectedModel?: string | null;
  connectionLabel?: string | null;
  connectionKind?: HarnessAuthKind | null;
  disabled?: boolean;
}

export interface ComposerModelControlsProps {
  models: FlatModel[];
  selectedModel: { providerID: string; modelID: string } | null;
  onModelChange?: (model: { providerID: string; modelID: string } | null) => void;
  providers?: ProviderListResponse;
  /** Optional "set as default" controls for the model picker (account/per-agent). */
  modelDefaultControls?: ModelDefaultControls;
  /** Static state for a harness that manages its own model — see
   *  {@link HarnessManagedModelState}. */
  harnessManagedModel?: HarnessManagedModelState;
  /** If true, a concrete model must be selected before a chat/command send. */
  modelRequired?: boolean;
  /** Project ID — lets the reasoning-effort control read/write this
   *  project's per-model generation config (see reasoning-effort-selector.tsx). */
  projectId?: string;
}

/**
 * The composer toolbar's model-picking row, followed by the reasoning-effort
 * control. Two mutually exclusive renders, decided here (never inside the
 * picker itself — main's `ModelSelector` stays a single provider-grouped
 * catalog popover with no mode switch):
 *
 * - `harnessManagedModel` set (Claude Code / Codex / Pi): a static label, no
 *   popover — see {@link HarnessManagedModelState}.
 * - otherwise: the ONE `ModelSelector`, gateway/BYOK catalog mode (OpenCode).
 *
 * Extracted verbatim from `session-chat-input.tsx`'s bottom toolbar — see
 * that file's render for where `AgentSelector` sits just before this block.
 */
export function ComposerModelControls({
  models,
  selectedModel,
  onModelChange,
  providers,
  modelDefaultControls,
  harnessManagedModel,
  modelRequired = false,
  projectId,
}: ComposerModelControlsProps) {
  return (
    <>
      {harnessManagedModel ? (
        <HarnessManagedModelLabel {...harnessManagedModel} />
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

/** Non-interactive pill reporting a harness-managed model state — see
 *  {@link HarnessManagedModelState}. Always disabled (per the pill law's
 *  "hide vs. disable-with-Hint" rule in `composer-pill.ts`): the capability
 *  ("this session has a model") exists, so the pill stays visible; picking
 *  one doesn't, so it never opens anything. */
function HarnessManagedModelLabel({
  harness,
  selectedModel,
  connectionLabel,
  disabled = true,
}: HarnessManagedModelState) {
  const presentation = harnessPresentation(harness);
  const label = selectedModel || connectionLabel || `${presentation.label} default`;
  return (
    <Hint side="top" label={`${presentation.label} manages its own model`} className="text-xs">
      <span
        aria-label={`${presentation.label} model`}
        data-testid="harness-managed-model-label"
        data-harness={harness}
        className={cn(COMPOSER_PILL_TRIGGER_CLASS, 'cursor-default', disabled && COMPOSER_PILL_DISABLED_CLASS)}
      >
        <span className="max-w-[120px] truncate">{label}</span>
      </span>
    </Hint>
  );
}
