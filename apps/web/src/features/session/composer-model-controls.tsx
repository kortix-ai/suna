'use client';

import Hint from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import type { AcpSessionConfigOption, HarnessAuthKind } from '@kortix/sdk';
import type { KortixHarness } from '@kortix/sdk/react';
import { harnessPresentation } from '@kortix/sdk/react';

import type { ProviderListResponse } from '@/hooks/runtime/use-runtime-sessions';

import { AcpConfigOptionPill } from './acp-config-option-pills';
import {
  COMPOSER_PILL_DISABLED_CLASS,
  COMPOSER_PILL_TRIGGER_CLASS,
} from './composer-pill';
import { type ModelDefaultControls, ModelSelector } from './model-selector';
import { ReasoningEffortSelector } from './reasoning-effort-selector';
import type { FlatModel } from './session-chat-input';

/**
 * Composer state for a harness that owns its default model (Claude Code,
 * Codex, Pi — `HARNESSES[id].ownsDefaultModel === true`, see
 * `packages/shared/src/harnesses.ts`). These harnesses never expose a
 * writable gateway/BYOK catalog to pick from, so main's `ModelSelector` (a
 * provider-grouped catalog popover) has nothing to show them — but that does
 * NOT mean no model choice exists. `ownsDefaultModel` harnesses that ARE
 * live (an active ACP session) commonly advertise their OWN selectable model
 * list over the protocol itself, as a `session/new`/`session/load` `select`-
 * typed `configOptions` entry whose `id`/`category` mentions "model" (see
 * `findAcpModelConfigOption`, `acp-composer-adapters.ts`) — verified live
 * against real persisted sessions (`kortix.acp_session_envelopes`, dev DB,
 * 2026-07-21): claude-agent-acp advertises `sonnet`/`opus`/`haiku`/`default`,
 * codex-acp advertises its full GPT-5.x line, and `session/set_config_option`
 * against either genuinely applies the choice (a captured `configId: 'model',
 * value: 'opus'` call against a real claude-agent-acp session round-tripped
 * `currentValue: 'opus'` back, including surviving a `session/load`
 * reconnect). So:
 *
 * - **Live, and the harness DID declare a model config option**: {@link modelOption}
 *   is set — the composer renders a real interactive selector
 *   ({@link HarnessManagedModelSelector}) instead of the label, and picking a
 *   choice round-trips through `session/set_config_option` (ACP's own
 *   mechanism), never the gateway catalog.
 * - **Not live yet (no ACP session to query), or live but the harness
 *   genuinely declared no model option**: {@link modelOption} is unset — the
 *   composer falls back to the honest, non-interactive
 *   {@link HarnessManagedModelLabel}. There is no protocol-level way to know a
 *   pre-launch harness's model list without a running session (Zed's own
 *   `AgentConnection::model_selector()` is likewise per-connection, never
 *   per-agent-definition — see docs/specs/2026-07-21-zed-acp-ux-comparison.md
 *   §1.2), so this is a real capability gap, not a UI omission — faking a
 *   selector here would silently no-op, which is worse than the label.
 */
export interface HarnessManagedModelState {
  harness: KortixHarness;
  /** An explicit launch-time override already recorded for this harness, if
   *  any. Falls back to the resolved connection/harness label when unset.
   *  Still read even when {@link modelOption} is set (as the trigger's
   *  fallback current-value label before the live session's own
   *  `configOptions` has loaded). */
  selectedModel?: string | null;
  connectionLabel?: string | null;
  connectionKind?: HarnessAuthKind | null;
  disabled?: boolean;
  /** The harness's own live, writable model choice — a `select`-typed ACP
   *  session config option with at least one choice (see
   *  `findAcpModelConfigOption`). When set, the composer renders
   *  {@link HarnessManagedModelSelector} instead of the static label. */
  modelOption?: AcpSessionConfigOption | null;
  /** Applies a picked choice — forwards to the live `AcpSession.setConfigOption`
   *  (`session/set_config_option`) call, keyed by {@link modelOption}'s own
   *  `id` (the harness's own config id, e.g. `'model'` — never a gateway
   *  model key). Required when {@link modelOption} is set. */
  onModelOptionChange?: (value: unknown) => void;
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
 * control. Three mutually exclusive renders, decided here (never inside a
 * picker itself — main's `ModelSelector` stays a single provider-grouped
 * catalog popover with no mode switch):
 *
 * - `harnessManagedModel.modelOption` set (Claude Code / Codex live, with a
 *   declared model config option): a real interactive selector — see
 *   {@link HarnessManagedModelSelector}.
 * - `harnessManagedModel` set with no `modelOption` (not live yet, or the
 *   harness declared none): a static label, no popover — see
 *   {@link HarnessManagedModelLabel}.
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
      {harnessManagedModel?.modelOption ? (
        <HarnessManagedModelSelector {...harnessManagedModel} />
      ) : harnessManagedModel ? (
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

/** Interactive harness-native model selector — renders when a LIVE ACP
 *  session's harness declared a writable `model` session config option (see
 *  {@link HarnessManagedModelState}'s doc comment for the live evidence this
 *  is built against). A thin harness-labeled wrapper around
 *  `AcpConfigOptionPill` (`acp-config-option-pills.tsx`) — the same popover
 *  pill the composer already uses for a live session's `mode`/`effort`/etc.
 *  config options, so "model" reads as one more entry in that family rather
 *  than a bespoke picker with its own interaction language. `onChange` goes
 *  straight to `AcpSession.setConfigOption(modelOption.id, value)` — ACP's
 *  own mechanism, never the gateway catalog (`onModelChange` in
 *  `ComposerModelControlsProps` is for the OTHER, catalog-mode branch and is
 *  never called here). */
function HarnessManagedModelSelector({
  harness,
  modelOption,
  onModelOptionChange,
  disabled = false,
}: HarnessManagedModelState) {
  if (!modelOption || !onModelOptionChange) return null;
  // No extra `Hint` wrapper here (unlike the static label below): the
  // harness's identity is already visible one control to the left
  // (`AgentSelector`) in the same toolbar row, and `AcpConfigOptionPill`
  // already wraps its OWN trigger in a `Hint` when `disabled` — nesting a
  // second tooltip around that would show two overlapping hover explanations
  // for one control. `data-harness` still identifies which harness this
  // pill belongs to for tests/debugging.
  return (
    <span data-testid="harness-managed-model-selector" data-harness={harness}>
      <AcpConfigOptionPill option={modelOption} onChange={onModelOptionChange} disabled={disabled} />
    </span>
  );
}

/** Non-interactive pill reporting a harness-managed model state — see
 *  {@link HarnessManagedModelState}. Always disabled (per the pill law's
 *  "hide vs. disable-with-Hint" rule in `composer-pill.ts`): the capability
 *  ("this session has a model") exists, so the pill stays visible; picking
 *  one doesn't, so it never opens anything. Renders only when the harness
 *  declared no writable model config option — see
 *  {@link HarnessManagedModelSelector} for the live/interactive case. */
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
