'use client';

import { type ReactNode, useCallback, useMemo } from 'react';

import {
  acpConfigOptionPresets,
  findAcpModelConfigOption,
} from '@/features/session/acp-composer-adapters';
import { deriveComposerBlockingAction } from '@/features/session/model-availability';
import {
  type AttachedFile,
  type TrackedMention,
  SessionChatInput,
} from '@/features/session/session-chat-input';
import { useModelConnectionGate } from '@/features/session/use-model-connection-gate';
import { useUnifiedModelPickerEnabled } from '@/hooks/projects/use-unified-model-picker-enabled';
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
import type { FlatModel, ModelPickerGroup } from '@kortix/sdk/react';
import {
  agentHarness,
  agentRequiresCatalogModel,
  connectionDisplayName,
  formatModelString,
  harnessPresentation,
  parseModelKey,
  useComposerCapabilities,
  useModelPicker,
  useProjectConfig,
} from '@kortix/sdk/react';

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

/**
 * A pre-session pick made through the unified `ModelPicker`, translated back
 * to whichever persistence seam the LEGACY pickers already use for the same
 * job — `useRuntimeLocal`'s per-session gateway `ModelKey` for a catalog
 * (OpenCode) agent, `useModelStore`'s per-agent-name harness-native model
 * string for a harness (Claude/Codex/Pi) agent. `useModelPicker`'s own
 * `select()` has no persistence seam of its own (see the hook's doc comment
 * on its local `pendingKey` state) — it only drives the picker's OWN
 * immediate re-render (checkmark, trigger label). This function is the other
 * half: what the composer must additionally do so the pick actually reaches
 * `buildComposerOptions` at send-time, exactly like the legacy pickers do
 * today. Pure and exported so the key-shape parsing (documented on
 * `ModelPickerItem.key`) is unit-tested without mounting the composer.
 */
export type UnifiedModelPickSelection =
  | { kind: 'catalog'; model: ModelKey | undefined }
  | { kind: 'harness'; modelId: string | undefined }
  | { kind: 'noop' };

export function resolveUnifiedModelPickSelection(
  key: string,
  input: { catalogModelRequired: boolean; groups: ModelPickerGroup[] },
): UnifiedModelPickSelection {
  const item = input.groups
    .flatMap((group) => group.items)
    .find((candidate) => candidate.key === key);
  if (key === 'auto' || item?.kind === 'auto') {
    return input.catalogModelRequired
      ? { kind: 'catalog', model: undefined }
      : { kind: 'harness', modelId: undefined };
  }
  if (key.startsWith('custom:')) {
    const raw = key.slice('custom:'.length);
    if (!input.catalogModelRequired) return { kind: 'harness', modelId: raw };
    const parsed = parseModelKey(raw);
    return parsed ? { kind: 'catalog', model: parsed } : { kind: 'noop' };
  }
  if (!item) return { kind: 'noop' };
  // `ModelPickerItem.key` is documented as `${providerId}:${modelId}` for a
  // 'model' item — strip the item's own `providerId` prefix (never blind
  // colon-split) so a provider id can never collide with a colon inside the
  // model id itself.
  const modelId = item.providerId ? key.slice(item.providerId.length + 1) : key;
  if (input.catalogModelRequired) {
    return item.providerId
      ? { kind: 'catalog', model: { providerID: item.providerId, modelID: modelId } }
      : { kind: 'noop' };
  }
  return { kind: 'harness', modelId };
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
  const nativeHarness = activeHarness && activeHarness !== 'opencode' ? activeHarness : null;
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
  const capabilityModels = (capability.data?.model.presets ?? []).map((preset) => {
    const slash = preset.id.indexOf('/');
    const providerID = slash > 0 ? preset.id.slice(0, slash) : (activeHarness ?? 'runtime');
    const modelID = slash > 0 ? preset.id.slice(slash + 1) : preset.id;
    return {
      providerID,
      providerName: preset.source,
      modelID,
      modelName: preset.name,
      providerSource: preset.source,
    };
  });
  const selectedCatalogModel =
    catalogModelRequired &&
    local.model.currentKey &&
    capabilityModels.some(
      (model) =>
        model.providerID === local.model.currentKey?.providerID &&
        model.modelID === local.model.currentKey?.modelID,
    )
      ? local.model.currentKey
      : null;

  // ── Live-session model pill ──────────────────────────────────────────────
  // Always rendered via HarnessModelSelector (never the gateway-catalog
  // ModelSelector) — a live session's model isn't "pick from the connected
  // provider catalog", it's "does this ACP session expose a writable model
  // config option". Presence of that option is the ONLY thing that makes it
  // interactive; otherwise it's a read-only label of the session's resolved
  // model, matching every other harness's actual capability (Claude/Codex/Pi
  // never support a live model change; opencode's `live_change` says whether
  // this launched session actually advertised one).
  const liveModelOption = live ? findAcpModelConfigOption(live.configOptions) : null;
  // The ACP session's own advertised config options are ground truth for
  // "can this session's model change live" — more authoritative than the
  // agent-level `composer-capabilities` policy prediction, which describes
  // what a NEW session would support, not necessarily this launched one.
  const liveModelWritable = !!liveModelOption;
  // Locked language for the resolved connection — never the raw auth-kind id
  // (`claude_subscription`) or a mechanical `replaceAll('_', ' ')` — shared by
  // the live and pre-session harness-model pills and the blocking-action copy.
  const connectionKind = capability.data?.auth.active ?? null;
  const connectionLabel = connectionKind ? connectionDisplayName(connectionKind) : null;
  const harnessLabel = activeHarness ? harnessPresentation(activeHarness).label : null;
  const liveHarnessModel = live
    ? {
        harness: activeHarness ?? 'opencode',
        selectedModel:
          liveModelOption?.currentValue != null ? String(liveModelOption.currentValue) : null,
        onSelect: (model: string | null) => {
          if (!liveModelWritable || !liveModelOption || !model) return;
          live.onConfigOptionChange(liveModelOption.id, model);
        },
        presets: liveModelOption
          ? acpConfigOptionPresets(liveModelOption)
          : (capability.data?.model.presets ?? []),
        connectionLabel,
        connectionKind,
        disabled: !liveModelWritable,
      }
    : undefined;

  // ── Unified model picker (`unified_model_picker` flag) ──────────────────
  // Flag OFF: every input below stays inert (`projectId`/`agentName` forced
  // null keeps `useModelPicker`'s own queries disabled) and `unifiedModelPicker`
  // is `undefined`, so `SessionChatInput` renders the untouched legacy fork.
  // Flag ON: exactly one `ModelPicker` renders for every harness — the same
  // component for claude/codex/pi and opencode alike.
  const unifiedModelPickerEnabled = useUnifiedModelPickerEnabled(projectId ?? '');
  const unifiedLiveSession = useMemo(
    () =>
      unifiedModelPickerEnabled && live
        ? {
            configOptions: live.configOptions,
            setConfigOption: async (id: string, value: string) => {
              live.onConfigOptionChange(id, value);
            },
          }
        : null,
    [unifiedModelPickerEnabled, live?.configOptions, live?.onConfigOptionChange],
  );
  const modelPickerVm = useModelPicker({
    projectId: unifiedModelPickerEnabled ? (projectId ?? null) : null,
    agentName: unifiedModelPickerEnabled ? capabilityAgentName : null,
    liveSession: unifiedLiveSession,
  });
  // Pre-session persistence: `useModelPicker.select()` has no seam of its
  // own (its `pendingKey` is local-only, see the hook's doc comment) — reuse
  // the EXACT same two seams the legacy pickers already persist through
  // (`local.model.set` for catalog agents, `runtimeModelStore.setRuntimeModel`
  // for harness-native agents) so a pre-session pick made in the unified
  // picker still reaches `buildComposerOptions` at send-time. A live,
  // writable session skips this entirely — `modelPickerVm.select` already
  // routed the pick through `live.setConfigOption` above.
  const handleUnifiedModelSelect = useCallback(
    (key: string) => {
      modelPickerVm.select(key);
      if (live) return;
      const resolved = resolveUnifiedModelPickSelection(key, {
        catalogModelRequired,
        groups: modelPickerVm.groups,
      });
      if (resolved.kind === 'catalog') {
        local.model.set(resolved.model, { recent: true });
      } else if (resolved.kind === 'harness' && capabilityAgentName) {
        runtimeModelStore.setRuntimeModel(capabilityAgentName, resolved.modelId);
      }
    },
    [
      modelPickerVm,
      live,
      catalogModelRequired,
      capabilityAgentName,
      local.model,
      runtimeModelStore,
    ],
  );
  // Same "where should Connect route to" gate `ModelSelector` uses — kept as
  // its own instance here (not threaded from `SessionChatInput`, which owns
  // a private one for its `composerConnectKind` banner) so `ModelPicker`'s
  // "Not connected" group's Connect action opens the identical dialog.
  const { openConnectProvider, modal: unifiedConnectionModal } = useModelConnectionGate();
  const unifiedModelPicker = unifiedModelPickerEnabled
    ? {
        vm: { ...modelPickerVm, select: handleUnifiedModelSelect },
        onConnect: (connectionId: HarnessAuthKind) =>
          openConnectProvider(undefined, { connectKind: connectionId }),
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
    <>
      {unifiedConnectionModal}
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
        harnessModel={
          live
            ? liveHarnessModel
            : nativeHarness
              ? {
                  harness: nativeHarness,
                  selectedModel: runtimeModel,
                  onSelect: (model) =>
                    capabilityAgentName &&
                    runtimeModelStore.setRuntimeModel(capabilityAgentName, model ?? undefined),
                  presets: capability.data?.model.presets ?? [],
                  connectionLabel,
                  connectionKind,
                  customAllowed: capability.data?.model.custom_allowed ?? true,
                }
              : undefined
        }
        modelPicker={unifiedModelPicker}
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
    </>
  );
}
