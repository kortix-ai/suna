'use client';

import type { AcpSessionConfigOption, HarnessAuthKind } from '@kortix/sdk';
import type { KortixHarness } from '@kortix/sdk/react';

import type { ProviderListResponse } from '@/hooks/runtime/use-runtime-sessions';

import { AcpConfigOptionPill } from './acp-config-option-pills';
import { ModelSelector } from './model-selector';
import { ReasoningEffortSelector } from './reasoning-effort-selector';
import type { FlatModel } from './session-chat-input';
import { useModelConnectionGate } from './use-model-connection-gate';

/**
 * Composer state for a harness that owns its default model (Claude Code,
 * Codex — `HARNESSES[id].ownsDefaultModel === true`, see
 * `packages/shared/src/harnesses.ts`; Pi was reclassified catalog-driven
 * 2026-07-21 and no longer goes through this state at all — see
 * `agentModelPolicy`/`agentRequiresCatalogModel`,
 * `packages/sdk/src/react/harness-capabilities.ts`). These harnesses never
 * expose a writable gateway/BYOK catalog to pick from, so main's
 * `ModelSelector` (a provider-grouped catalog popover) has nothing to show
 * them — but that does NOT mean no model choice exists, and it NEVER means
 * "so show a dead label instead" (2026-07-22 decree: every harness, in every
 * state, renders a real interactive selector — the static
 * `HarnessManagedModelLabel` this comment used to describe is deleted).
 * `ownsDefaultModel` harnesses commonly advertise their OWN selectable model
 * list over the protocol itself, as a `session/new`/`session/load` `select`-
 * typed `configOptions` entry whose `id`/`category` mentions "model" (see
 * `findAcpModelConfigOption`, `acp-composer-adapters.ts`) — verified live
 * against real persisted sessions (`kortix.acp_session_envelopes`, local DB,
 * 2026-07-22): claude-agent-acp advertises `sonnet`/`opus`/`haiku`/`default`
 * (plus a `default`-valued "Custom model" entry — genuinely generic ids, not
 * a gap in this file's fallback), codex-acp advertises its full GPT-5.x line,
 * and `session/set_config_option` against either genuinely applies the choice
 * (a captured `configId: 'model', value: 'opus'` call against a real
 * claude-agent-acp session round-tripped `currentValue: 'opus'` back,
 * including surviving a `session/load` reconnect). So:
 *
 * - **Live, and the harness's own `configOptions` already include a writable
 *   model option**: {@link modelOption} is the LIVE option — picking a
 *   choice round-trips through `session/set_config_option` (ACP's own
 *   mechanism), never the gateway catalog.
 * - **Not live yet, or live but still bootstrapping (no writable option in
 *   `configOptions` yet)**: `composer-chat-input.tsx` resolves
 *   {@link modelOption} from a small pre-session store instead — either the
 *   last real advertised list this browser cached from an earlier LIVE
 *   session of the same harness, or (first time ever) a static,
 *   version-pinned fallback captured from a real payload (see
 *   `packages/sdk/src/react/use-harness-model-options-store.ts`). This
 *   resolves EVERY time for Claude Code/Codex (the fallback always exists for
 *   them) — picking a choice here has no live ACP session to round-trip
 *   through yet (or not one ready for it), so it persists into the per-agent
 *   deferred-pick store instead, applied automatically the instant a session
 *   for that agent goes live (see `composer-chat-input.tsx`'s deferred-apply
 *   effect). Its `currentValue` is stamped from, in priority order: the
 *   live session's own resolved value, the persisted deferred pick, or the
 *   option's own first advertised choice (verified live to equal the real
 *   harness bootstrap default for both claude and codex) — NEVER left unset,
 *   which used to render the trigger with an empty, chevron-only pill.
 *
 * `harnessManagedModel` itself is `undefined` for every catalog-driven
 * harness (OpenCode, Pi) and is guaranteed to carry a non-null
 * {@link modelOption} whenever it's set at all for claude/codex — there is no
 * third "declared, but nothing to render" state left for this file to handle.
 */
export interface HarnessManagedModelState {
  harness: KortixHarness;
  /** An explicit launch-time override already recorded for this harness, if
   *  any. Still read as the trigger's fallback current-value label before
   *  the live session's own `configOptions` has loaded. */
  selectedModel?: string | null;
  connectionLabel?: string | null;
  connectionKind?: HarnessAuthKind | null;
  disabled?: boolean;
  /** The harness's own model choice — live-writable ACP config option, or
   *  the pre-session cache/fallback stand-in — a `select`-typed option with
   *  at least one choice (see `findAcpModelConfigOption`). Always set
   *  whenever `harnessManagedModel` itself is set — see this interface's
   *  doc comment. */
  modelOption: AcpSessionConfigOption;
  /** Applies a picked choice — forwards to the live `AcpSession.setConfigOption`
   *  (`session/set_config_option`) call when live and writable, or persists
   *  into the per-agent deferred-pick store otherwise — keyed by
   *  {@link modelOption}'s own `id` (the harness's own config id, e.g.
   *  `'model'` — never a gateway model key). */
  onModelOptionChange: (value: unknown) => void;
}

export interface ComposerModelControlsProps {
  models: FlatModel[];
  selectedModel: { providerID: string; modelID: string } | null;
  onModelChange?: (model: { providerID: string; modelID: string } | null) => void;
  providers?: ProviderListResponse;
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
 * control. Exactly TWO mutually exclusive renders, decided here (never
 * inside a picker itself — main's `ModelSelector` stays a single
 * provider-grouped catalog popover with no mode switch) — 2026-07-22 decree:
 * every harness, in every state, renders a REAL interactive selector. There
 * is no third "static label" render left — see `HarnessManagedModelState`'s
 * doc comment for why `harnessManagedModel` is always either `undefined` or
 * fully populated (never "declared, but nothing to pick"):
 *
 * - `harnessManagedModel` set (Claude Code / Codex, live OR pre-session with
 *   a cached/fallback option resolved): {@link HarnessManagedModelSelector}.
 * - otherwise: the ONE `ModelSelector`, gateway/BYOK catalog mode
 *   (OpenCode, Pi — both live and pre-session; a live session's `models`
 *   feed comes from the SAME composer-capabilities catalog pre-session uses,
 *   never the ACP `configOptions` wire, so this is one control regardless of
 *   session state — see `composer-chat-input.tsx`).
 *
 * Extracted verbatim from `session-chat-input.tsx`'s bottom toolbar — see
 * that file's render for where `AgentSelector` sits just before this block.
 */
export function ComposerModelControls({
  models,
  selectedModel,
  onModelChange,
  providers,
  harnessManagedModel,
  modelRequired = false,
  projectId,
}: ComposerModelControlsProps) {
  return (
    <>
      {harnessManagedModel ? (
        <HarnessManagedModelSelector {...harnessManagedModel} />
      ) : (models.length > 0 || modelRequired) && onModelChange ? (
        <ModelSelector
          models={models}
          selectedModel={selectedModel}
          onSelect={onModelChange}
          providers={providers}
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

/** Interactive harness-native model selector — renders whenever a `model`
 *  session config option is resolved for the harness, live OR pre-session
 *  (see {@link HarnessManagedModelState}'s doc comment: live, it's the ACP
 *  session's own advertised option; pre-session, it's the cache/fallback
 *  `composer-chat-input.tsx` resolves via `use-harness-model-options-store.ts`).
 *  A thin harness-labeled wrapper around `AcpConfigOptionPill`
 *  (`acp-config-option-pills.tsx`) — the same popover pill the composer
 *  already uses for a live session's `mode`/`effort`/etc. config options, so
 *  "model" reads as one more entry in that family rather than a bespoke
 *  picker with its own interaction language. `onChange` goes straight to
 *  `onModelOptionChange` — live, that's `AcpSession.setConfigOption(
 *  modelOption.id, value)` (ACP's own mechanism); pre-session, there's no
 *  live session to round-trip through yet, so it persists into the per-agent
 *  deferred-pick store instead, applied automatically the moment a session
 *  for that agent goes live. Never the gateway catalog either way
 *  (`onModelChange` in `ComposerModelControlsProps` is for the OTHER,
 *  catalog-mode branch and is never called here). */
function HarnessManagedModelSelector({
  harness,
  modelOption,
  onModelOptionChange,
  disabled = false,
}: HarnessManagedModelState) {
  // Every model selector — catalog (OpenCode/Pi) OR harness-native
  // (Claude Code/Codex) — offers the same "connect a model service" (+) and
  // "manage models" affordances (2026-07-22 decree: no harness is a
  // second-class selector). The catalog `ModelSelector` renders them in its
  // search header; the harness-native pill has no search header, so they ride
  // as a popover footer instead — both routing through the SAME
  // `useModelConnectionGate` connect-modal host the catalog selector uses, so
  // there is one connect/manage surface regardless of harness.
  const { openConnectProvider } = useModelConnectionGate();
  // No extra `Hint` wrapper here: the harness's identity is already visible
  // one control to the left (`AgentSelector`) in the same toolbar row, and
  // `AcpConfigOptionPill` already wraps its OWN trigger in a `Hint` when
  // `disabled` — nesting a second tooltip around that would show two
  // overlapping hover explanations for one control. `data-harness` still
  // identifies which harness this pill belongs to for tests/debugging.
  return (
    <span data-testid="harness-managed-model-selector" data-harness={harness}>
      <AcpConfigOptionPill
        option={modelOption}
        onChange={onModelOptionChange}
        disabled={disabled}
        modelServiceActions={{
          onConnect: () => openConnectProvider('api-keys'),
          onManage: () => openConnectProvider(),
        }}
      />
    </span>
  );
}
