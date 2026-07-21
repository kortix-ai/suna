'use client';

import { type ReactNode, useEffect, useRef } from 'react';

import {
  findAcpModelConfigOption,
  isWritableAcpModelConfigOption,
  otherAcpConfigOptions,
  resolveDeferredModelApply,
  shouldAttemptDeferredModelApply,
} from '@/features/session/acp-composer-adapters';
import { AcpConfigOptionPill, AcpConfigOptionSegment } from '@/features/session/acp-config-option-pills';
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
import { CATALOG } from '@kortix/llm-catalog';
import type { AcpSessionConfigOption, AcpUsageProjection, HarnessAuthKind } from '@kortix/sdk';
import type { FlatModel } from '@kortix/sdk/react';
import {
  agentHarness,
  agentRequiresCatalogModel,
  connectionDisplayName,
  formatModelString,
  harnessPresentation,
  useComposerCapabilities,
  useHarnessConfigOptionsCache,
  useHarnessModelOptionsCache,
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
function catalogMetadata(
  providerID: string,
  modelID: string,
): { releaseDate?: string; family?: string } {
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

/**
 * Persisted-selection keys for the composer-capabilities catalog picker
 * (OpenCode/Pi — `catalogModelRequired`). Deliberately namespaced apart from
 * `useRuntimeLocal`'s own selection keys (`${providerMode}:${agentName}`,
 * `scopedModelSelectionKey`) — those are validated inside `useRuntimeLocal`
 * against `flattenModels(providers)` (the gateway's own `/model-picker`
 * catalog, where every model's `providerID` is the literal string `'kortix'`
 * — see `GATEWAY_PROVIDER_IDS`/`projectLlmCatalogToProviderList`), a
 * completely different identity vocabulary than composer-capabilities
 * presets (`presetToFlatModel`'s resolved REAL provider id, e.g.
 * `providerID: 'anthropic'` for a bare `anthropic_api_key` preset — see its
 * doc comment).
 *
 * *** THE REGRESSION THIS FIXES *** (live-reproduced 2026-07-21): clicking a
 * model in the picker called `local.model.set(model, ...)`
 * (`useRuntimeLocal`, packages/sdk/src/react/use-runtime-local.ts), which
 * persists fine, but `local.model.currentKey` — read right back as the
 * picker's `selectedModel` — only resolves through
 * `explicitModelKey`/`isModelValid`, both gated on `flatModels =
 * flattenModels(providers)`. That catalog's entries are ALWAYS `providerID:
 * 'kortix'`; a composer-capabilities model like `{providerID: 'anthropic',
 * modelID: 'claude-sonnet-5'}` never appears in it, so `isModelValid` always
 * returns false for it and `currentKey` reverts to some unrelated fallback
 * (or `undefined`) instead of the model just clicked. The picker's trigger
 * label — driven by matching `selectedModel` against the rendered list —
 * never shows the pick, no matter how many times you click.
 *
 * The fix: OpenCode/Pi's catalog selection never goes through
 * `useRuntimeLocal.model` at all. It's tracked here, in the SAME identity
 * vocabulary as what's actually rendered (`capabilityModelsRaw`), persisted
 * through the raw (validity-agnostic) `useModelStore` KV surface
 * (`getSelectedModel`/`setSelectedModel`/`getSessionModel`/`setSessionModel`
 * — already instantiated in this file as `runtimeModelStore` for the
 * harness-native launch model). A distinct key prefix means a value written
 * under either scheme is simply invisible to the other — never crashes,
 * never wedges on a foreign shape.
 */
export function catalogAgentModelKey(agentName: string): string {
  return `composer-capabilities-model:${agentName}`;
}

export function catalogSessionModelKey(sessionId: string): string {
  return `composer-capabilities-model:${sessionId}`;
}

/** The harness's own bootstrap default for a `model` config option — its
 *  first advertised choice. Verified live (`kortix.acp_session_envelopes`,
 *  local DB, 2026-07-22) to equal the REAL `currentValue` a fresh
 *  claude-agent-acp/codex-acp session settles on with no prior pick (codex:
 *  `gpt-5.6-sol`, options[0]; claude: `default`, options[0]) — used as the
 *  last-resort stand-in for a pre-session/still-bootstrapping pill's
 *  `currentValue` so it's never left unset (see `harnessManagedModel` below
 *  and `acp-config-option-pills.tsx`'s own blank-pill fallback). */
export function firstModelOptionValue(
  option: Pick<AcpSessionConfigOption, 'options'> | null | undefined,
): string | undefined {
  const first = option?.options?.[0] as Record<string, unknown> | undefined;
  if (!first) return undefined;
  if (first.value != null) return String(first.value);
  if (first.id != null) return String(first.id);
  return undefined;
}

/** Persisted-pick key for a pre-session pick of a native harness's OTHER
 *  (non-model) config option — `mode`/`effort`/etc. — reusing the SAME
 *  `runtimeModelStore.getRuntimeModel`/`setRuntimeModel` KV surface the
 *  harness-native MODEL pick uses (`packages/sdk/src/react/use-model-store.ts`),
 *  just under a composite key so it never collides with a real agent name or
 *  with that model slot. Generic across every option id a harness advertises
 *  — one mechanism, not a per-option store. */
export function otherConfigOptionDeferredKey(agentName: string, optionId: string): string {
  return `${agentName}::config-option:${optionId}`;
}

/**
 * The composer-capabilities catalog picker's resolved explicit selection: the
 * persisted per-session pick (survives reload for THIS session) if set, else
 * the per-agent pick — validated against the catalog actually rendered
 * (`models`, i.e. `capabilityModelsRaw`/`capabilityModels`). A persisted value
 * that doesn't resolve to any model in the current preset list — a stale pick
 * from a prior agent/connection, an older catalog shape, or (pre-fix) a value
 * written under `useRuntimeLocal`'s unrelated vocabulary — degrades to
 * `undefined` so the picker falls back to its default/unset state instead of
 * wedging on a dead id.
 */
export function resolveExplicitCatalogModel(input: {
  sessionModel: ModelKey | undefined;
  agentModel: ModelKey | undefined;
  models: FlatModel[];
}): ModelKey | undefined {
  const candidate = input.sessionModel ?? input.agentModel;
  if (!candidate) return undefined;
  const valid = input.models.some(
    (m) => m.providerID === candidate.providerID && m.modelID === candidate.modelID,
  );
  return valid ? candidate : undefined;
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
  // The catalog picker's persisted selection — see `catalogAgentModelKey`'s
  // doc comment for why this is tracked independently of `local.model.*`
  // (`useRuntimeLocal`'s own selection state is validated against a
  // DIFFERENT catalog/identity vocabulary and can never round-trip a
  // composer-capabilities pick back out).
  const catalogAgentKey = capabilityAgentName ? catalogAgentModelKey(capabilityAgentName) : null;
  const catalogSessionKey = sessionId ? catalogSessionModelKey(sessionId) : null;
  const persistedCatalogAgentModel = catalogAgentKey
    ? runtimeModelStore.getSelectedModel(catalogAgentKey)
    : undefined;
  const persistedCatalogSessionModel = catalogSessionKey
    ? runtimeModelStore.getSessionModel(catalogSessionKey)
    : undefined;
  const selectedCatalogModel = catalogModelRequired
    ? (resolveExplicitCatalogModel({
        sessionModel: persistedCatalogSessionModel,
        agentModel: persistedCatalogAgentModel,
        models: capabilityModelsRaw,
      }) ?? null)
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
  // it's whatever the ACP session resolved at launch, PLUS whatever the
  // harness itself lets you change afterward over the protocol's own
  // mechanism (`session/set_config_option`) — see `HarnessManagedModelState`'s
  // doc comment (`composer-model-controls.tsx`) for the live evidence that
  // claude-agent-acp/codex-acp genuinely advertise + apply this, unlike the
  // stale assumption this comment used to carry. `isWritableAcpModelConfigOption`
  // is what decides "real selector" vs. "static label" — the SAME predicate
  // both branches below key off, so the composer's render mode and this
  // derivation can never disagree.
  const liveModelOption = live ? findAcpModelConfigOption(live.configOptions) : null;
  // Scoped to `ownsDefaultModel` harnesses (`!catalogModelRequired` — the
  // SAME predicate `nativeHarness` above is keyed on) even though the
  // underlying ACP mechanism is harness-neutral and a catalog-driven harness
  // (OpenCode) can ALSO advertise a `model` configOption (verified live:
  // captured `config_option_update` from a real OpenCode session). Fix 1's
  // scope is Claude Code/Codex specifically, and OpenCode's live model
  // editing is a different surface (its own catalog picker, currently
  // unwired for live sessions) owned by a different lane — this predicate is
  // what keeps that surface untouched here rather than silently gaining a
  // second, ACP-native model control alongside whatever OpenCode's own path
  // does or doesn't do.
  const liveModelOptionWritable =
    !catalogModelRequired && isWritableAcpModelConfigOption(liveModelOption);
  const liveResolvedModel =
    liveModelOption?.currentValue != null ? String(liveModelOption.currentValue) : null;
  // Same lock signals `acp-session-chat.tsx`'s `configOptionsDisabled` gates
  // its OTHER config-option pills (mode/effort) on — no session yet handled
  // separately below (`live` only exists once bootstrap has produced
  // `configOptions` in the first place), a terminal error, an in-flight turn,
  // or a pending question/approval all mean "don't let the user change the
  // model right now" just as much as they mean "don't let them send".
  const liveModelOptionDisabled =
    Boolean(disabled) ||
    Boolean(isBusy) ||
    Boolean(live?.lockForQuestion) ||
    Boolean(live?.lockForApproval);

  // ── Pre-session model choices (cache + static fallback) ─────────────────
  // Claude Code/Codex never expose the ACP `model` config option until a
  // session is actually LIVE (`liveModelOption` above) — but the composer the
  // user types into BEFORE that exists is exactly when they're most likely to
  // try to pick one. `harnessModelOptions` answers "what would this harness
  // advertise" with no live session at all: the last real advertised list
  // this browser cached from an earlier live session of the SAME harness, or
  // (when this browser has never seen one) a static, version-pinned fallback
  // captured from a real live payload — see `use-harness-model-options-store.ts`
  // for the full policy and its evidence. `null` only for a harness this
  // store genuinely knows nothing about (never claude/codex, since the
  // fallback always exists for them) — the composer keeps its honest static
  // label in that case, same as before this store existed.
  const harnessModelOptions = useHarnessModelOptionsCache();
  const preSessionModelOption = nativeHarness ? harnessModelOptions.resolve(nativeHarness) : null;

  // Cache a LIVE session's own advertised `model` option the instant it
  // arrives, so the NEXT pre-session composer for this harness (a fresh
  // session, a different tab) sees the real thing instead of only the static
  // fallback. `cache()` itself no-ops when the shape hasn't actually changed
  // (see the store's `sameCachedOption` check), so this doesn't write
  // localStorage on every unrelated live-session render.
  useEffect(() => {
    if (!activeHarness || !liveModelOptionWritable || !liveModelOption) return;
    harnessModelOptions.cache(activeHarness, liveModelOption);
  }, [activeHarness, liveModelOptionWritable, liveModelOption, harnessModelOptions]);

  // ── Deferred-apply: a pre-session pick, sent the moment the session goes live ──
  // The seam: the FIRST render where a live session's `configOptions` include
  // a genuinely writable `model` option (`liveModelOptionWritable` flipping
  // true — upstream, that's `AcpSession.performBootstrap`'s `this.patch({
  // ready: true, configOptions: result.configOptions, ... })` in
  // `packages/sdk/src/acp/session.ts`, the first place the harness's real
  // advertised list ever lands). At that instant, if the user picked a model
  // BEFORE the session existed (`runtimeModelStore.getRuntimeModel`, the same
  // per-agent store the live selector's own `onModelOptionChange` seeds — see
  // below), send it through the real `session/set_config_option` round-trip
  // so the session actually launches with what was picked instead of quietly
  // reverting to the harness default. `resolveDeferredModelApply` (see its
  // doc comment) is what keeps this from ever misbehaving: it drops the pick
  // silently when the harness didn't actually advertise it (a stale pick from
  // an old adapter version) and no-ops when it already matches — so the
  // control never shows a lie, and a value the harness rejects at apply time
  // is simply never sent, leaving the pill to reflect whatever the harness
  // actually settled on. Fires AT MOST ONCE per `sessionId` — a later
  // out-of-band change (the user picking something else live, or the harness
  // itself changing it via a `config_option_update`) must never be
  // overwritten by re-sending a now-stale deferred pick.
  const deferredApplyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!live || !nativeHarness || !capabilityAgentName) return;
    if (
      !shouldAttemptDeferredModelApply({
        sessionId,
        alreadyAttemptedSessionId: deferredApplyRef.current,
        optionAvailable: liveModelOptionWritable && !!liveModelOption,
      })
    ) {
      return;
    }
    deferredApplyRef.current = sessionId ?? null;
    // `shouldAttemptDeferredModelApply`'s `optionAvailable` already implies
    // `liveModelOption` is non-null (the check above returned `true`) — this
    // re-check is for TypeScript's narrowing, not runtime behavior.
    if (!liveModelOption) return;
    const deferredValue = runtimeModelStore.getRuntimeModel(capabilityAgentName);
    const toApply = resolveDeferredModelApply({ deferredValue, option: liveModelOption });
    if (toApply) live.onConfigOptionChange(liveModelOption.id, toApply);
  }, [
    live,
    nativeHarness,
    capabilityAgentName,
    liveModelOptionWritable,
    liveModelOption,
    sessionId,
    runtimeModelStore,
  ]);

  // ── Pre-session pills for every OTHER advertised config option ──────────
  // 2026-07-22 extension: "the model selector when the session is started
  // and when it's not started should always be identical" — mode/effort/
  // reasoning_effort/fast-mode/etc. pills exist LIVE already
  // (`acp-session-chat.tsx`'s `otherConfigOptions`, unchanged by this file)
  // but had no pre-session equivalent at all, so a fresh composer could only
  // ever show the model pill. `harnessConfigOptions` is the SAME cache-first/
  // fallback-second policy `harnessModelOptions` above established for
  // `model`, generalized to the array of everything ELSE
  // (`use-harness-config-options-store.ts`) — one mechanism, not a
  // per-option copy-paste. `[]` for catalog harnesses (this store doesn't
  // speak for them) and for a native harness this store has no cache/
  // fallback for (never claude/codex).
  const harnessConfigOptions = useHarnessConfigOptionsCache();
  const preSessionOtherConfigOptions = nativeHarness ? harnessConfigOptions.resolve(nativeHarness) : [];

  // Deferred-apply, generalized: the SAME `resolveDeferredModelApply`/
  // `shouldAttemptDeferredModelApply` pair the model pill uses above is
  // already option-agnostic (keys off `option.id`/`option.options`, never
  // hardcodes "model") — reused here per-option via a Map instead of a
  // single ref, since there can be several. Fires AT MOST ONCE per
  // (sessionId, optionId) pair, same guarantee as the model deferred-apply.
  const otherDeferredApplyRef = useRef<Map<string, string | null>>(new Map());
  useEffect(() => {
    if (!live || !nativeHarness || !capabilityAgentName) return;
    for (const option of otherAcpConfigOptions(live.configOptions, liveModelOption)) {
      const alreadyAttemptedSessionId = otherDeferredApplyRef.current.get(option.id) ?? null;
      if (
        !shouldAttemptDeferredModelApply({
          sessionId,
          alreadyAttemptedSessionId,
          optionAvailable: isWritableAcpModelConfigOption(option),
        })
      ) {
        continue;
      }
      otherDeferredApplyRef.current.set(option.id, sessionId ?? null);
      const deferredValue = runtimeModelStore.getRuntimeModel(
        otherConfigOptionDeferredKey(capabilityAgentName, option.id),
      );
      const toApply = resolveDeferredModelApply({ deferredValue, option });
      if (toApply) live.onConfigOptionChange(option.id, toApply);
    }
  }, [live, nativeHarness, capabilityAgentName, liveModelOption, sessionId, runtimeModelStore]);

  // Pre-session render rows — live rendering of these same option ids stays
  // owned by `acp-session-chat.tsx`'s existing `otherConfigOptions` (its own
  // pending-spinner/optimistic-revert plumbing around the REAL
  // `setConfigOption` promise stays untouched here — this file only fires
  // `live.onConfigOptionChange` as a one-shot boot-time apply above, never as
  // an interactive pill's own `onChange`). Pre-session, there is no live
  // pending state to manage — picking a choice just persists the deferred
  // value, applied automatically by the effect above the instant the
  // session's own writable match arrives.
  const otherConfigOptionRows =
    !live && nativeHarness
      ? preSessionOtherConfigOptions.map((cached) => {
          const deferredKey = capabilityAgentName
            ? otherConfigOptionDeferredKey(capabilityAgentName, cached.id)
            : null;
          const deferredValue = deferredKey ? runtimeModelStore.getRuntimeModel(deferredKey) : undefined;
          const option: AcpSessionConfigOption = {
            ...cached,
            currentValue: deferredValue ?? firstModelOptionValue(cached) ?? undefined,
          };
          return {
            option,
            onChange: (value: unknown) => {
              if (typeof value === 'string' && deferredKey) {
                runtimeModelStore.setRuntimeModel(deferredKey, value);
              }
            },
          };
        })
      : [];

  // Same trigger anatomy `acp-session-chat.tsx`'s LIVE `otherConfigOptions`
  // block uses (`select` → `AcpConfigOptionPill`, `mode` →
  // `AcpConfigOptionSegment`) — pre-session only; live rendering of these
  // same option ids stays owned by that file so its pending-spinner/
  // optimistic-revert plumbing around the real `setConfigOption` promise is
  // never duplicated or forked. The RESULT is the same pill family in the
  // same toolbar slot either way — see this block's own doc comment above.
  const otherConfigOptionsSlot = otherConfigOptionRows.length ? (
    <div className="flex items-center gap-0.5">
      {otherConfigOptionRows.map(({ option, onChange }) =>
        option.type === 'mode' ? (
          <AcpConfigOptionSegment key={option.id} option={option} onChange={onChange} />
        ) : (
          <AcpConfigOptionPill key={option.id} option={option} onChange={onChange} />
        ),
      )}
    </div>
  ) : null;

  // `harnessManagedModel` is ALWAYS either `undefined` (catalog harnesses —
  // OpenCode, Pi — in every state, and a native harness this store has no
  // cache/fallback for, which should be impossible for claude/codex) or a
  // fully-populated `HarnessManagedModelState` with a real `modelOption` —
  // 2026-07-22 decree: no state ever falls through to a dead label.
  //
  // *** THE BUG THIS FIXES *** (live-reproduced on BOTH OpenCode and Pi,
  // 2026-07-22): the old version keyed the live branch on `activeHarness`
  // (any harness with an ACP session) rather than `nativeHarness`
  // (`!catalogModelRequired` — only claude/codex). Since
  // `liveModelOptionWritable` is unconditionally `false` for a catalog
  // harness (`!catalogModelRequired &&
  // isWritableAcpModelConfigOption(liveModelOption)`), EVERY live OpenCode
  // or Pi session fell into the "no modelOption" branch and rendered the
  // (now-deleted) static label — "OpenCode manages its own model" / "Pi
  // manages its own model" — even though both are gateway/catalog-driven and
  // were never meant to hit this branch at all. Keying on `nativeHarness`
  // instead means a catalog harness never constructs `harnessManagedModel`
  // in the first place, live or not — it always falls through to
  // `ComposerModelControls`'s OTHER branch, the same catalog `ModelSelector`
  // pre-session uses (see the `models`/`selectedModel`/`onModelChange`
  // derivation below, no longer forced empty while live either).
  const harnessManagedModel: HarnessManagedModelState | undefined = !nativeHarness
    ? undefined
    : live && liveModelOptionWritable && liveModelOption
      ? {
          harness: nativeHarness,
          selectedModel: liveResolvedModel,
          connectionLabel,
          connectionKind,
          disabled: liveModelOptionDisabled,
          modelOption: liveModelOption,
          onModelOptionChange: (value) => {
            live.onConfigOptionChange(liveModelOption.id, value);
            // Seed the harness-native launch-model store (the SAME
            // per-agent namespace the pre-session branch reads via
            // `runtimeModel` below — see `getRuntimeModel`/`setRuntimeModel`'s
            // doc comment, packages/sdk/src/react/use-model-store.ts) so a
            // FUTURE fresh session for this agent launches with the
            // last-picked model instead of resetting to the harness
            // default. Best-effort/optimistic: this is a convenience seed
            // for the NEXT session's launch env, not the live session's own
            // source of truth (that's always the ACP `configOptions`
            // round-trip above) — a value that fails to apply server-side
            // only means the seed is briefly wrong, never that this
            // session's actual model silently changed.
            if (typeof value === 'string' && capabilityAgentName) {
              runtimeModelStore.setRuntimeModel(capabilityAgentName, value);
            }
          },
        }
      : preSessionModelOption
        ? {
            harness: nativeHarness,
            // Live-but-not-yet-writable (still bootstrapping) prefers the
            // session's own in-flight resolved value over the stored
            // deferred pick — pre-session, there's no live value yet, so the
            // deferred pick is all there is.
            selectedModel: live ? (liveResolvedModel ?? runtimeModel) : runtimeModel,
            connectionLabel,
            connectionKind,
            // Live-but-not-yet-writable still gates on the same busy/error/
            // lock signals as the writable branch (nothing to round-trip
            // through yet either way); pure pre-session is never disabled.
            disabled: live ? liveModelOptionDisabled : false,
            // Same control as the live-writable case
            // (`HarnessManagedModelSelector`, via `ComposerModelControls`'s
            // single render branch) — `currentValue` is stamped from, in
            // priority order: the live session's own in-flight value, the
            // stored deferred pick, or the option's own first advertised
            // choice (verified live to equal the harness's real bootstrap
            // default for both claude and codex — see
            // `acp-config-option-pills.tsx`'s own blank-pill fallback for
            // the second half of this guarantee). Never left unset.
            modelOption: {
              ...preSessionModelOption,
              currentValue:
                (live ? (liveResolvedModel ?? runtimeModel) : runtimeModel) ??
                firstModelOptionValue(preSessionModelOption) ??
                undefined,
            },
            onModelOptionChange: (value) => {
              // No live, writable ACP session to round-trip through yet —
              // persist the pick in the SAME per-agent store the live path
              // seeds (`getRuntimeModel`/`setRuntimeModel`), applied
              // automatically the moment a session for this agent goes live
              // (see the deferred-apply effect above).
              if (typeof value === 'string' && capabilityAgentName) {
                runtimeModelStore.setRuntimeModel(capabilityAgentName, value);
              }
            },
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
      toolbarSlot={
        otherConfigOptionsSlot || toolbarSlot ? (
          <>
            {otherConfigOptionsSlot}
            {toolbarSlot}
          </>
        ) : undefined
      }
      cardClassName={cardClassName}
      sessionId={sessionId}
      projectId={projectId}
      providers={providers}
      onFileSearch={onFileSearch}
      agents={local.agent.list}
      selectedAgent={lockedAgentName ?? local.agent.current?.name ?? null}
      onAgentChange={lockedAgentName ? undefined : (name) => local.agent.set(name ?? undefined)}
      agentSelectorLocked={!!lockedAgentName}
      // No `live ?` gate here (2026-07-22 fix, same bug as
      // `harnessManagedModel` above): a catalog harness's (OpenCode, Pi)
      // model control is the SAME `ModelSelector`, fed by the SAME
      // composer-capabilities catalog, whether or not a session is live —
      // `useComposerCapabilities` above isn't gated on `live` either, so
      // `capabilityModels`/`selectedCatalogModel` are already populated by
      // the time a session goes live. Forcing these to empty/null/undefined
      // while live used to leave the composer with NOTHING to render for a
      // live catalog-harness session (the catalog branch had zero models,
      // and `harnessManagedModel` was undefined too before that fix) — which
      // is exactly what made `ComposerModelControls` fall through to a dead
      // state. Picking a model on a live catalog session persists to the
      // same per-agent/per-session store pre-session does (below) — there is
      // no live ACP round-trip for a catalog pick (unlike claude/codex's
      // `session/set_config_option`); that remains a known gap, tracked
      // separately, not a regression this fix introduces.
      models={catalogModelRequired ? capabilityModels : []}
      selectedModel={catalogModelRequired ? selectedCatalogModel : null}
      onModelChange={
        catalogModelRequired
          ? (m) => {
              // Persist in the SAME identity vocabulary the catalog is
              // rendered in — see `catalogAgentModelKey`'s doc comment.
              // `m` can be `null` (ModelSelector's onSelect signature
              // allows clearing); either way both slots are written so
              // per-session takes priority over per-agent on next read.
              if (catalogAgentKey)
                runtimeModelStore.setSelectedModel(catalogAgentKey, m ?? undefined);
              if (catalogSessionKey)
                runtimeModelStore.setSessionModel(catalogSessionKey, m ?? undefined);
              if (m) runtimeModelStore.pushRecent(m);
            }
          : undefined
      }
      harnessManagedModel={harnessManagedModel}
      modelRequired={capability.data ? !capability.data.model.default_allowed : false}
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
