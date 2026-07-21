'use client';

import type { ReactNode } from 'react';

import { findAcpModelConfigOption } from '@/features/session/acp-composer-adapters';
import type { HarnessManagedModelState } from '@/features/session/composer-model-controls';
import { deriveComposerBlockingAction } from '@/features/session/model-availability';
import {
  type AttachedFile,
  SessionChatInput,
  type TrackedMention,
} from '@/features/session/session-chat-input';
import { useModelStore } from '@/hooks/runtime/use-model-store';
import { useRuntimeConfig } from '@/hooks/runtime/use-runtime-config';
import { type ModelKey, useRuntimeLocal } from '@/hooks/runtime/use-runtime-local';
import {
  type Agent,
  type Command,
  type MessageWithParts,
  useRuntimeAgents,
  useRuntimeProviders,
  useRuntimeSessions,
} from '@/hooks/runtime/use-runtime-sessions';
import type { AcpSessionConfigOption, AcpUsageProjection, HarnessAuthKind } from '@kortix/sdk';
import type { FlatModel } from '@kortix/sdk/react';
import {
  agentHarness,
  agentRequiresCatalogModel,
  connectionDisplayName,
  formatModelString,
  harnessPresentation,
  useComposerCapabilities,
  useProjectConfig,
} from '@kortix/sdk/react';
import { CATALOG } from '@kortix/llm-catalog';

export interface ComposerOptions {
  agent?: string;
  model?: ModelKey;
  /** Harness-native model id, applied once when the ACP runtime launches. */
  runtimeModel?: string;
  connectionId?: HarnessAuthKind;
  modelSelection?: {
    kind: 'default' | 'preset' | 'custom';
    modelId?: string | null;
    connectionId?: HarnessAuthKind | null;
  };
}

export function boundSessionAgentName(value?: string | null): string | null {
  return value?.trim() || null;
}

// Stable empty-array reference for the `useModelStore(NO_MODELS)` call below —
// this composer only needs its `getRuntimeModel`/`setRuntimeModel` accessors,
// not the catalog-visibility machinery `useModelStore` also computes from
// `allModels`. A fresh `[]` literal every render would defeat that hook's own
// `useMemo`s (referential inequality on every render).
const NO_MODELS: FlatModel[] = [];

// Provider whose api-key auth kind serves BARE (non-namespaced) preset ids —
// see `modelPresets()` in apps/api/src/projects/lib/composer-capabilities.ts:
// `anthropic_api_key`/`openai_api_key` presets are the newest few models.dev
// entries for that ONE provider with no `<provider>/` prefix at all, unlike
// `managed_gateway`'s `kortix/<id>` or `native_config`'s `<provider>/<id>`.
const BARE_PRESET_PROVIDER_ID: Partial<Record<HarnessAuthKind, string>> = {
  anthropic_api_key: 'anthropic',
  openai_api_key: 'openai',
};

/**
 * The provider id a composer-capabilities preset resolves to for the model
 * picker.
 *
 * *** BUG THIS FIXES *** (verified live on a project routed through
 * `anthropic_api_key`: the server returned 6 real, `can_start: true`
 * presets, but the picker showed "No models available"). A bare preset id
 * (no `/`) used to default its `providerID` to the HARNESS name
 * (`activeHarness` — e.g. `'opencode'`), not the real upstream provider.
 * Main's `ModelSelector` filters BYOK visibility by the real provider id
 * parsed from connected secret names (`ANTHROPIC_API_KEY` → `'anthropic'`,
 * see `connectedGatewayProviderIdsFromSecretNames`) — a model tagged
 * `providerID: 'opencode'` can never match any connected provider, so every
 * preset silently disappeared.
 *
 * `preset.provider` (verified live on the running dev API: every
 * `modelPresets()` branch now stamps it — apps/api/src/projects/lib/
 * composer-capabilities.ts, the 2026-07-21 model-resolution refactor) is the
 * server's own ground truth and always wins when present. The `/`-split and
 * `connectionKind`-keyed fallbacks below only cover a preset from an older
 * (pre-refactor) API build that hasn't stamped the field yet — the SDK's
 * `ComposerCapabilities['model']['presets']` type (packages/sdk) hadn't
 * caught up to the field at the time of this fix, so it's read defensively
 * rather than relied on via the type.
 */
export function resolvePresetProviderId(input: {
  presetId: string;
  presetProvider?: string | null;
  connectionKind: HarnessAuthKind | null | undefined;
  harnessFallback: string;
}): string {
  if (input.presetProvider) return input.presetProvider;
  const slash = input.presetId.indexOf('/');
  if (slash > 0) return input.presetId.slice(0, slash);
  return (
    (input.connectionKind && BARE_PRESET_PROVIDER_ID[input.connectionKind]) || input.harnessFallback
  );
}

/**
 * Enrich a resolved provider/model id pair with the catalog's
 * `released`/`family` metadata so main's `useModelStore.isVisible` "latest
 * per family" heuristic can actually place it in the default (no-search)
 * view. Without this, every BYOK preset lacks `releaseDate` and degrades to
 * search-only — the provider-id fix alone (`resolvePresetProviderId`) is
 * necessary but not sufficient to make these models VISIBLE by default.
 * `kortix`-namespaced ids skip the lookup: the gateway catalog is keyed by
 * its own wire ids, not models.dev's.
 */
function catalogMetadata(providerID: string, modelID: string): { releaseDate?: string; family?: string } {
  if (providerID === 'kortix') return {};
  const provider = CATALOG.providers.find((entry) => entry.id === providerID);
  const model = provider?.models.find((entry) => entry.id === modelID);
  return { releaseDate: model?.released ?? undefined, family: model?.family };
}

/** A composer-capabilities preset, tagged with its real provider id and
 *  (when resolvable) catalog release metadata — see `resolvePresetProviderId`
 *  and `catalogMetadata`'s doc comments for the two bugs this fixes. */
export function presetToFlatModel(
  preset: { id: string; name: string; source: string; provider?: string | null },
  ctx: { connectionKind: HarnessAuthKind | null | undefined; harnessFallback: string },
): FlatModel & { providerSource: string } {
  const providerID = resolvePresetProviderId({
    presetId: preset.id,
    presetProvider: preset.provider,
    connectionKind: ctx.connectionKind,
    harnessFallback: ctx.harnessFallback,
  });
  const slash = preset.id.indexOf('/');
  const modelID = slash > 0 ? preset.id.slice(slash + 1) : preset.id;
  const { releaseDate, family } = catalogMetadata(providerID, modelID);
  return {
    providerID,
    providerName: preset.source,
    modelID,
    modelName: preset.name,
    providerSource: preset.source,
    releaseDate,
    family,
  };
}

/** Most rows the composer's model popover can mount before opening/typing
 *  visibly stutters — a `managed_gateway` preset list is the gateway's
 *  ENTIRE routable catalog (thousands of entries, unconditioned on what this
 *  project can actually reach — see `gatewayModelCatalog`), and main's
 *  `ModelSelector` has no cap of its own (it wasn't built against a catalog
 *  this size). Capping the FEED here — not inside the restored file — keeps
 *  every internal list in the picker's own render pipeline (open, search,
 *  filter) small everywhere, with no separate `useDeferredValue`/cap logic
 *  needed inside it. */
export const RENDERED_MODEL_CAP = 50;

/** Bound how many of an already-built `FlatModel[]` feed actually reach the
 *  picker, keeping the selected model present even when the cap would
 *  otherwise drop it (its check mark must never silently disappear). */
export function capFeedModels(
  models: FlatModel[],
  selected: { providerID: string; modelID: string } | null,
  cap: number = RENDERED_MODEL_CAP,
): FlatModel[] {
  if (models.length <= cap) return models;
  const visible = models.slice(0, cap);
  const alreadyVisible = selected
    ? visible.some((m) => m.providerID === selected.providerID && m.modelID === selected.modelID)
    : true;
  if (selected && !alreadyVisible) {
    const match = models.find(
      (m) => m.providerID === selected.providerID && m.modelID === selected.modelID,
    );
    if (match) visible.push(match);
  }
  return visible;
}

export function buildComposerOptions(input: {
  agent: Agent | undefined;
  lockedAgentName?: string | null;
  model?: ModelKey;
  runtimeModel?: string | null;
  connectionId?: HarnessAuthKind | null;
  presets?: Array<{ id: string }>;
}): ComposerOptions {
  const options: ComposerOptions = {};
  const agentName = input.lockedAgentName?.trim() || input.agent?.name;
  if (agentName) options.agent = agentName;
  if (agentRequiresCatalogModel(input.agent) && input.model) options.model = input.model;
  if (!agentRequiresCatalogModel(input.agent) && input.runtimeModel?.trim()) {
    options.runtimeModel = input.runtimeModel.trim();
  }
  const selectedModel = agentRequiresCatalogModel(input.agent)
    ? input.model
      ? formatModelString(input.model)
      : null
    : input.runtimeModel?.trim() || null;
  if (input.connectionId) options.connectionId = input.connectionId;
  if (input.connectionId || selectedModel) {
    options.modelSelection = {
      kind: selectedModel
        ? input.presets?.some((preset) => preset.id === selectedModel)
          ? 'preset'
          : 'custom'
        : 'default',
      modelId: selectedModel,
      connectionId: input.connectionId ?? null,
    };
  }
  return options;
}

/** Wiring for an already-started ACP session — passed instead of relying on
 *  the pre-session model derivation, since a live session's agent and
 *  (usually) its model are already fixed. See {@link ComposerChatInput}. */
export interface LiveAcpComposer {
  configOptions: AcpSessionConfigOption[];
  onConfigOptionChange: (id: string, value: unknown) => void;
  messages?: MessageWithParts[];
  acpUsage?: AcpUsageProjection | null;
  onStop?: () => void;
  onContextClick?: () => void;
  todos?: Array<{ id: string; content: string; status: string }>;
  queuedMessages?: { id: string; text: string }[];
  onQueueMessage?: (text: string, files?: AttachedFile[], mentions?: TrackedMention[]) => void;
  onRemoveQueuedMessage?: (id: string) => void;
  replyTo?: { text: string } | null;
  onClearReply?: () => void;
  lockForQuestion?: boolean;
  lockForApproval?: boolean;
  onCustomAnswer?: (text: string) => void;
  questionButtonLabel?: string | null;
  questionCanAct?: boolean;
  onQuestionAction?: () => void;
}

/**
 * The canonical "compose a first message" input: {@link SessionChatInput}
 * pre-wired with the Runtime model / agent / command selectors (the
 * catalog queries + per-session selection state). Used by the home composer
 * and the instant session shell so neither hand-rolls the selector wiring.
 *
 * The current selections are handed to `onSend` / `onCommand` as `options`, so
 * callers never need their own `useRuntimeLocal`.
 *
 * When `live` is set (an already-started ACP session), the model pill switches
 * from the pre-session gateway-catalog/harness-default derivation to the ACP
 * session's own config options: a model-typed option (see
 * `findAcpModelConfigOption`) drives a real live model change through it,
 * otherwise the pill renders read-only (showing the session's resolved
 * default) — a harness with no such option simply can't change its model after
 * launch. The full turn/queue/question/reply-context surface is also
 * forwarded here so `AcpSessionChat` never hand-wires `SessionChatInput`
 * itself.
 */
export function ComposerChatInput({
  onSend,
  onCommand,
  sessionId,
  projectId,
  isBusy,
  stopDisabled,
  isSending,
  disabled,
  autoFocus,
  placeholder,
  prefill,
  inputSlot,
  toolbarSlot,
  cardClassName,
  boundAgentName,
  clearOnSend,
  live,
  onFileSearch,
}: {
  onSend: (text: string, files: AttachedFile[] | undefined, options: ComposerOptions) => void;
  onCommand?: (command: Command, args: string | undefined, options: ComposerOptions) => void;
  sessionId?: string;
  projectId?: string;
  isBusy?: boolean;
  /** Show a disabled stop button while busy (e.g. the computer is still booting). */
  stopDisabled?: boolean;
  /** Send in flight, not yet settled — spinner in the send slot (see SessionChatInput.isSending). */
  isSending?: boolean;
  disabled?: boolean;
  /** Clear the composer optimistically on send. Set false on the project-home
   *  composer, whose send navigates it away (see SessionChatInput.clearOnSend). */
  clearOnSend?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  prefill?: {
    text: string;
    id: number;
    files?: AttachedFile[];
    mode?: 'replace' | 'merge';
  } | null;
  inputSlot?: ReactNode;
  toolbarSlot?: ReactNode;
  /** Extra classes for the input card (e.g. the project-home radius override). */
  cardClassName?: string;
  /** Immutable project-session agent. When set, sends are locked to this agent. */
  boundAgentName?: string | null;
  /** Present for an already-started ACP session — see {@link LiveAcpComposer}. */
  live?: LiveAcpComposer;
  onFileSearch?: (query: string) => Promise<string[]>;
}) {
  const { data: agents } = useRuntimeAgents({ projectId });
  const { data: providers, isLoading: providersLoading } = useRuntimeProviders();
  const { data: config } = useRuntimeConfig();
  const { data: mentionSessions } = useRuntimeSessions(!!live);
  const projectConfig = useProjectConfig(projectId);
  const commands: Command[] = (projectConfig?.commands ?? []).map((command) => ({
    ...command,
    id: command.name,
  }));
  const local = useRuntimeLocal({
    agents,
    providers,
    config,
    sessionId,
    boundAgentName,
    defaultAgentName: projectConfig?.runtime_default_agent,
  });
  // Agent/harness is a launch-time session binding. New-session composers have
  // no boundAgentName and remain switchable; an existing session exposes its
  // bound agent read-only so a later prompt cannot pretend to change harness.
  const lockedAgentName = boundSessionAgentName(boundAgentName);
  const catalogModelRequired = agentRequiresCatalogModel(local.agent.current);
  const activeHarness = agentHarness(local.agent.current);
  // Single-sourced off `agentRequiresCatalogModel` (not an independent
  // `!== 'opencode'` check) so the composer's render mode (catalog picker vs.
  // static harness-managed label) can never disagree with `buildComposerOptions`'s
  // send-time gateway-model-vs-runtime-model choice, which reads the same
  // predicate. No behavior change today (`agentRequiresCatalogModel` is still
  // OpenCode-only) — see docs/specs/2026-07-21-model-resolution-refactor-plan.md
  // for the in-flight decision to make Pi catalog-driven too; this keeps both
  // flags moving together automatically once that lands.
  const nativeHarness = activeHarness && !catalogModelRequired ? activeHarness : null;
  const capabilityAgentName = lockedAgentName ?? local.agent.current?.name ?? null;
  // Harness-native launch model (Claude/Codex/Pi) — persisted per AGENT NAME
  // in the shared SDK model store, not per harness: two agents on the same
  // harness must never share a remembered model, and switching agents/harness
  // policy must never carry a stale pick into the new context (fixes #4/#8).
  const runtimeModelStore = useModelStore(NO_MODELS);
  const runtimeModel =
    nativeHarness && capabilityAgentName
      ? (runtimeModelStore.getRuntimeModel(capabilityAgentName) ?? null)
      : null;
  const capability = useComposerCapabilities(projectId, capabilityAgentName);
  // Locked language for the resolved connection — never the raw auth-kind id
  // (`claude_subscription`) or a mechanical `replaceAll('_', ' ')` — shared by
  // the harness-managed model label and the blocking-action copy.
  const connectionKind = capability.data?.auth.active ?? null;
  const connectionLabel = connectionKind ? connectionDisplayName(connectionKind) : null;
  const harnessLabel = activeHarness ? harnessPresentation(activeHarness).label : null;
  const capabilityModelsRaw = (capability.data?.model.presets ?? []).map((preset) =>
    presetToFlatModel(preset, { connectionKind, harnessFallback: activeHarness ?? 'runtime' }),
  );
  const selectedCatalogModel =
    catalogModelRequired &&
    local.model.currentKey &&
    capabilityModelsRaw.some(
      (model) =>
        model.providerID === local.model.currentKey?.providerID &&
        model.modelID === local.model.currentKey?.modelID,
    )
      ? local.model.currentKey
      : null;
  // The gateway's `managed_gateway` preset list is its ENTIRE routable
  // catalog (thousands of entries, unconditioned on what this project can
  // actually reach — see `gatewayModelCatalog`). Main's `ModelSelector` has
  // no cap of its own; bound the FEED so every internal list in its render
  // pipeline (open, search, filter) stays small — see `capFeedModels`'s doc
  // comment for why this lives here instead of inside the restored file.
  const capabilityModels = capFeedModels(capabilityModelsRaw, selectedCatalogModel);

  // ── Live-session model pill ──────────────────────────────────────────────
  // A live session's model isn't "pick from the connected provider catalog" —
  // it's whatever the ACP session resolved at launch. This composer doesn't
  // wire up live mid-session model edits (Claude/Codex/Pi never support one;
  // OpenCode's `live_change` capability, when a session actually advertises a
  // writable option, is a follow-up — `findAcpModelConfigOption`/
  // `acpConfigOptionPresets` in `acp-composer-adapters.ts` already carry the
  // data for it), so every harness renders the same read-only
  // `HarnessManagedModelState` label while live, showing the session's
  // resolved model.
  const liveModelOption = live ? findAcpModelConfigOption(live.configOptions) : null;
  const liveResolvedModel =
    liveModelOption?.currentValue != null ? String(liveModelOption.currentValue) : null;
  const harnessManagedModel: HarnessManagedModelState | undefined = live
    ? activeHarness
      ? {
          harness: activeHarness,
          selectedModel: liveResolvedModel,
          connectionLabel,
          connectionKind,
          disabled: true,
        }
      : undefined
    : nativeHarness
      ? {
          harness: nativeHarness,
          selectedModel: runtimeModel,
          connectionLabel,
          connectionKind,
        }
      : undefined;

  // Server-authoritative auth/model preflight — the ONLY hard send gate for a
  // real project + resolved agent (composer-capabilities). `null` while live
  // (an already-started session can't be blocked from sending) or when there
  // is no capability signal at all (governed below by `composerCapabilityGoverned`).
  const composerBlockingReason = live
    ? null
    : capability.data?.can_start === false
      ? capability.data.blocking_reason
      : capability.error instanceof Error
        ? capability.error.message
        : null;
  const composerBlockingActionLabel = live
    ? null
    : deriveComposerBlockingAction({
        blockingReason: composerBlockingReason,
        authReady: capability.data?.auth.ready ?? false,
        harnessLabel,
        connectionLabel,
      });
  // "Connect Claude Code"/"Connect Codex" deep-links straight into that
  // harness's subscription form — the flagship connect method.
  const composerConnectKind =
    !live && capability.data?.auth.ready === false
      ? activeHarness === 'claude'
        ? ('claude_subscription' as const)
        : activeHarness === 'codex'
          ? ('codex_subscription' as const)
          : null
      : null;
  // Matches `useComposerCapabilities`'s own `enabled` condition — the query
  // only ever resolves real data for a real project + resolved agent, so that
  // is exactly when its blocking reason should be trusted as a hard gate.
  const composerCapabilityGoverned = !live && Boolean(projectId) && Boolean(capabilityAgentName);

  // Read at send-time so the latest selections are captured.
  const options = (): ComposerOptions => {
    return buildComposerOptions({
      agent: local.agent.current,
      lockedAgentName,
      model: selectedCatalogModel ?? undefined,
      runtimeModel,
      connectionId: capability.data?.auth.active,
      presets: capability.data?.model.presets,
    });
  };

  return (
    <SessionChatInput
      onSend={(text, files) => onSend(text, files, options())}
      onCommand={onCommand ? (cmd, args) => onCommand(cmd, args, options()) : undefined}
      clearOnSend={clearOnSend}
      isBusy={isBusy}
      stopDisabled={stopDisabled}
      isSending={isSending}
      disabled={disabled}
      autoFocus={autoFocus}
      placeholder={placeholder}
      prefill={prefill}
      inputSlot={inputSlot}
      toolbarSlot={toolbarSlot}
      cardClassName={cardClassName}
      sessionId={sessionId}
      projectId={projectId}
      providers={providers}
      onFileSearch={onFileSearch}
      agents={local.agent.list}
      selectedAgent={lockedAgentName ?? local.agent.current?.name ?? null}
      onAgentChange={lockedAgentName ? undefined : (name) => local.agent.set(name ?? undefined)}
      agentSelectorLocked={!!lockedAgentName}
      models={live ? [] : catalogModelRequired ? capabilityModels : []}
      selectedModel={live ? null : catalogModelRequired ? selectedCatalogModel : null}
      onModelChange={
        live
          ? undefined
          : catalogModelRequired
            ? (m) => local.model.set(m ?? undefined, { recent: true })
            : undefined
      }
      harnessManagedModel={harnessManagedModel}
      modelRequired={
        live ? false : capability.data ? !capability.data.model.default_allowed : false
      }
      modelsLoading={capability.isLoading || providersLoading}
      composerBlockingReason={composerBlockingReason}
      composerBlockingActionLabel={composerBlockingActionLabel}
      composerConnectKind={composerConnectKind}
      composerCapabilityGoverned={composerCapabilityGoverned}
      commands={commands}
      messages={live?.messages}
      acpUsage={live?.acpUsage}
      onStop={live?.onStop}
      onContextClick={live?.onContextClick}
      todos={live?.todos}
      mentionSessions={live ? (mentionSessions ?? []) : []}
      queuedMessages={live?.queuedMessages}
      onQueueMessage={live?.onQueueMessage}
      onRemoveQueuedMessage={live?.onRemoveQueuedMessage}
      replyTo={live?.replyTo}
      onClearReply={live?.onClearReply}
      lockForQuestion={live?.lockForQuestion}
      lockForApproval={live?.lockForApproval}
      onCustomAnswer={live?.onCustomAnswer}
      questionButtonLabel={live?.questionButtonLabel}
      questionCanAct={live?.questionCanAct}
      onQuestionAction={live?.onQuestionAction}
    />
  );
}
