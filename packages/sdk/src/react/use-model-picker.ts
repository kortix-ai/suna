'use client';

import { useCallback, useMemo, useState } from 'react';

import type { AcpSessionConfigOption } from '../acp';
import { SDK_HARNESS_STABILITY } from '../acp/harness-mirror';
import type {
  ComposerCapabilities,
  ComposerModelCatalog,
  HarnessAuthKind,
  HarnessConnection,
} from '../core/rest/projects-client';
import {
  agentHarness,
  agentModelPolicy,
  harnessPresentation,
  type AgentModelPolicy,
  type KortixHarness,
} from './harness-capabilities';
import {
  useComposerCapabilities,
  useComposerModelCatalog,
  useHarnessConnections,
} from './use-composer-capabilities';
import { connectionDisplayName } from './use-models-page';

/**
 * `useModelPicker` — the unified model-first picker view-model.
 *
 * The catalog-vs-harness fork (`agentModelPolicy`) is resolved HERE and only
 * here: gateway-catalog agents (OpenCode today) get one group per provider;
 * harness-native agents (Claude/Codex/Pi) get one group named for the
 * harness itself, holding a "Default" auto item plus the harness's own
 * preset list, with the harness's custom-model entry surfaced through
 * `customEntry`. A component built on this view-model never re-derives the
 * fork — it only ever sees `groups`.
 */

export type ModelPickerItem = {
  /** `'providerID:modelID'` for a catalog/harness preset, `'auto'` for the
   *  harness-default item, or `` `custom:${id}` `` for a user-typed id. A
   *  disconnected-provider row (see the `'not-connected'` group) is never
   *  selectable and uses `` `connect:${connectionId}` `` instead — it is not
   *  one of the three selectable shapes above and must never reach `select()`. */
  key: string;
  kind: 'auto' | 'model' | 'custom';
  label: string;
  sublabel: string | null;
  providerId: string | null;
  experimental: boolean;
  liveSwap: boolean;
  selectable: boolean;
  free?: boolean;
};

export type ModelPickerGroup = {
  id: string;
  label: string;
  items: ModelPickerItem[];
  connectAction?: { connectionId: HarnessAuthKind; label: string } | null;
};

export type ModelPickerViewModel = {
  status: 'loading' | 'error' | 'ready';
  trigger: { label: string; sublabel: string | null; interactive: boolean };
  groups: ModelPickerGroup[];
  selectedKey: string | null;
  searchable: boolean;
  customEntry: {
    allowed: boolean;
    placeholder: string;
    validate(id: string): { ok: boolean; reason?: string };
  } | null;
  select(key: string): void;
};

export interface ModelPickerLiveSession {
  configOptions: AcpSessionConfigOption[] | null;
  setConfigOption(name: string, value: string): Promise<void>;
}

export interface UseModelPickerInput {
  projectId: string | null;
  agentName: string | null;
  connectionId?: HarnessAuthKind | null;
  liveSession?: ModelPickerLiveSession | null;
}

const SEARCHABLE_THRESHOLD = 8;

/** Mirrors apps/web's `acp-composer-adapters.ts` `findAcpModelConfigOption`/
 *  `isAcpModelConfigOption` heuristic — duplicated, not imported: the SDK
 *  never depends on a host app. Keep the two definitions in agreement by
 *  hand (both match any option whose id/category/name mentions "model"). */
function findModelConfigOption(
  options: readonly AcpSessionConfigOption[] | null | undefined,
): AcpSessionConfigOption | null {
  if (!options?.length) return null;
  return (
    options.find((option) => {
      const haystack = `${option.id} ${option.category ?? ''} ${option.name ?? ''}`.toLowerCase();
      return /\bmodel\b/.test(haystack);
    }) ?? null
  );
}

function parseModelId(id: string, fallbackProviderId: string): { providerId: string; modelId: string } {
  const slash = id.indexOf('/');
  return slash > 0
    ? { providerId: id.slice(0, slash), modelId: id.slice(slash + 1) }
    : { providerId: fallbackProviderId, modelId: id };
}

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

/** Inverse of the key shapes documented on {@link ModelPickerItem.key} — the
 *  raw value a harness ACP config option (or a future gateway mutation)
 *  expects, which is always bare (never provider-prefixed). */
function keyToValue(key: string): string {
  if (key === 'auto') return key;
  if (key.startsWith('custom:')) return key.slice('custom:'.length);
  const colon = key.indexOf(':');
  return colon > 0 ? key.slice(colon + 1) : key;
}

function capitalize(id: string): string {
  return id.length ? id[0]!.toUpperCase() + id.slice(1) : id;
}

function connectActionLabel(kind: HarnessAuthKind): string {
  return `Connect ${connectionDisplayName(kind)}`;
}

function validateCustomModelId(raw: string, policy: AgentModelPolicy): { ok: boolean; reason?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'Enter a model id.' };
  if (trimmed !== raw) return { ok: false, reason: 'Remove the leading/trailing whitespace.' };
  if (policy === 'harness' && /^kortix\//i.test(trimmed)) {
    return {
      ok: false,
      reason:
        'Drop the gateway prefix — this harness takes its own model id (e.g. claude-sonnet-4-6), not a Kortix gateway id.',
    };
  }
  if (!/^[\w.-]+(\/[\w.-]+)?$/.test(trimmed)) {
    return {
      ok: false,
      reason: 'Use a plain model id, or provider/model — letters, numbers, dot, dash, underscore only.',
    };
  }
  return { ok: true };
}

function firstSelectableKey(groups: ModelPickerGroup[]): string | null {
  for (const group of groups) {
    for (const item of group.items) {
      if (item.selectable) return item.key;
    }
  }
  return null;
}

function findItemByKey(groups: ModelPickerGroup[], key: string | null): ModelPickerItem | null {
  if (!key) return null;
  for (const group of groups) {
    for (const item of group.items) {
      if (item.key === key) return item;
    }
  }
  return null;
}

/** The live session's currently-active model, mapped back to one of our item
 *  keys by comparing bare model ids (live config-option values are always
 *  bare — see {@link keyToValue}). `null` when nothing matches, e.g. the
 *  session launched with a model outside the resolved preset list. */
function selectedKeyFromLiveValue(groups: ModelPickerGroup[], liveModelOption: AcpSessionConfigOption | null): string | null {
  if (liveModelOption?.currentValue == null) return null;
  const value = String(liveModelOption.currentValue);
  for (const group of groups) {
    for (const item of group.items) {
      if (item.kind === 'model' && keyToValue(item.key) === value) return item.key;
    }
  }
  return null;
}

interface BuildInput {
  capabilities: ComposerCapabilities | undefined;
  capabilitiesLoading: boolean;
  capabilitiesError: boolean;
  catalogModels: ComposerModelCatalog['models'] | undefined;
  catalogLoading: boolean;
  connections: HarnessConnection[] | undefined;
  connectionsLoading: boolean;
  liveModelOption: AcpSessionConfigOption | null;
  hasLiveSession: boolean;
  pendingKey: string | null;
  select(key: string): void;
}

/** Pure derivation — no React, no query client. Exported so the projection
 *  can be exercised without mocking `@tanstack/react-query`, matching
 *  `projectModelsPageState` in `use-models-page.ts`. */
export function buildModelPickerViewModel(input: BuildInput): ModelPickerViewModel {
  const {
    capabilities,
    capabilitiesLoading,
    capabilitiesError,
    catalogModels,
    catalogLoading,
    connections,
    connectionsLoading,
    liveModelOption,
    hasLiveSession,
    pendingKey,
    select,
  } = input;

  const status: ModelPickerViewModel['status'] = capabilitiesError
    ? 'error'
    : capabilitiesLoading || catalogLoading || connectionsLoading || !capabilities
      ? 'loading'
      : 'ready';

  if (!capabilities) {
    return {
      status,
      trigger: { label: 'Select a model', sublabel: null, interactive: false },
      groups: [],
      selectedKey: null,
      searchable: false,
      customEntry: null,
      select,
    };
  }

  const harness: KortixHarness | null = agentHarness(capabilities.agent);
  const policy = agentModelPolicy(capabilities.agent);
  const experimental = harness ? SDK_HARNESS_STABILITY[harness] === 'experimental' : false;
  const liveWritable = Boolean(liveModelOption);
  const connectionLabel = capabilities.auth.active ? connectionDisplayName(capabilities.auth.active) : null;
  const models = catalogModels ?? capabilities.model.presets;

  function liveSwapFor(): boolean {
    return hasLiveSession ? liveWritable : capabilities!.model.live_change;
  }

  function autoItem(harnessId: KortixHarness): ModelPickerItem {
    return {
      key: 'auto',
      kind: 'auto',
      label: 'Default',
      sublabel: `${harnessPresentation(harnessId).label} chooses`,
      providerId: null,
      experimental,
      liveSwap: liveSwapFor(),
      selectable: true,
    };
  }

  const groups: ModelPickerGroup[] = [];

  if (policy === 'harness' && harness) {
    const items: ModelPickerItem[] = [];
    if (capabilities.model.default_allowed) items.push(autoItem(harness));
    for (const preset of models) {
      const { providerId, modelId } = parseModelId(preset.id, harness);
      items.push({
        key: modelKey(providerId, modelId),
        kind: 'model',
        label: preset.name,
        sublabel: connectionLabel ? `via ${connectionLabel}` : null,
        providerId,
        experimental,
        liveSwap: liveSwapFor(),
        selectable: true,
      });
    }
    if (items.length) groups.push({ id: harness, label: harnessPresentation(harness).label, items, connectAction: null });
  } else {
    // Catalog policy — grouped by provider, never folded into one harness bucket.
    if (capabilities.model.default_allowed && harness) {
      groups.push({ id: 'default', label: 'Default', items: [autoItem(harness)], connectAction: null });
    }
    const byProvider = new Map<string, ModelPickerItem[]>();
    for (const preset of models) {
      const { providerId, modelId } = parseModelId(preset.id, harness ?? 'catalog');
      const item: ModelPickerItem = {
        key: modelKey(providerId, modelId),
        kind: 'model',
        label: preset.name,
        sublabel: connectionLabel ? `via ${connectionLabel}` : null,
        providerId,
        experimental,
        liveSwap: liveSwapFor(),
        selectable: true,
      };
      const bucket = byProvider.get(providerId);
      if (bucket) bucket.push(item);
      else byProvider.set(providerId, [item]);
    }
    for (const [providerId, items] of byProvider) {
      groups.push({ id: providerId, label: capitalize(providerId), items, connectAction: null });
    }
  }

  // Trailing not-connected group — every connection compatible with this
  // agent's harness that isn't ready yet. Never selectable; the group's
  // single `connectAction` (the first disconnected connection) is the
  // primary CTA when there's exactly one, which covers today's real
  // connection matrix (at most one non-native route per harness besides the
  // managed gateway).
  if (harness && connections?.length) {
    const disconnected = connections.filter(
      (connection) => connection.compatible_harnesses.includes(harness) && !connection.ready,
    );
    if (disconnected.length) {
      const items: ModelPickerItem[] = disconnected.map((connection) => ({
        key: `connect:${connection.id}`,
        kind: 'model',
        label: connectionDisplayName(connection.kind),
        sublabel: connection.reason,
        providerId: null,
        experimental: false,
        liveSwap: false,
        selectable: false,
      }));
      const first = disconnected[0]!;
      groups.push({
        id: 'not-connected',
        label: 'Not connected',
        items,
        connectAction: { connectionId: first.id, label: connectActionLabel(first.kind) },
      });
    }
  }

  const totalItems = groups.reduce((sum, group) => sum + group.items.length, 0);
  const selectedKey =
    pendingKey ?? (hasLiveSession ? selectedKeyFromLiveValue(groups, liveModelOption) : null) ?? firstSelectableKey(groups);
  const selectedItem = findItemByKey(groups, selectedKey);

  return {
    status,
    trigger: {
      label: selectedItem?.label ?? 'Select a model',
      sublabel: selectedItem?.sublabel ?? null,
      interactive: status === 'ready' && (!hasLiveSession || liveWritable),
    },
    groups,
    selectedKey,
    searchable: totalItems >= SEARCHABLE_THRESHOLD,
    customEntry: {
      allowed: capabilities.model.custom_allowed,
      placeholder: harness ? harnessPresentation(harness).customModelPlaceholder : 'provider/model',
      validate: (id: string) => validateCustomModelId(id, policy),
    },
    select,
  };
}

/**
 * The unified model-first picker view-model. Consumes the three existing
 * composer query hooks + `agentModelPolicy` and folds catalog-vs-harness
 * into one shape — a component built on this never branches on harness. No
 * new fetches: this is a pure derivation over data those three hooks already
 * own, plus (when live) the ACP session's own advertised config options.
 */
export function useModelPicker(input: UseModelPickerInput): ModelPickerViewModel {
  const capabilitiesQuery = useComposerCapabilities(input.projectId, input.agentName, input.connectionId ?? null);
  const catalogQuery = useComposerModelCatalog(input.projectId, input.agentName, input.connectionId ?? null);
  const connectionsQuery = useHarnessConnections(input.projectId);

  // Pre-session (or non-writable-live) selections have no other owner — the
  // hook takes no selection input and there is no gateway-write hook in its
  // consumes list — so this local state IS the source of truth for "what the
  // user picked" until a host wires a persistence layer on top. The live
  // path never touches it: a writable ACP session routes straight through
  // `liveSession.setConfigOption` instead (see `select` below).
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const liveSession = input.liveSession ?? null;
  const liveModelOption = useMemo(
    () => findModelConfigOption(liveSession?.configOptions),
    [liveSession?.configOptions],
  );

  const select = useCallback(
    (key: string) => {
      if (liveModelOption && liveSession) {
        void liveSession.setConfigOption(liveModelOption.id, keyToValue(key)).catch(() => {});
        return;
      }
      setPendingKey(key);
    },
    [liveModelOption, liveSession],
  );

  return useMemo(
    () =>
      buildModelPickerViewModel({
        capabilities: capabilitiesQuery.data,
        capabilitiesLoading: capabilitiesQuery.isLoading,
        capabilitiesError: capabilitiesQuery.isError,
        catalogModels: catalogQuery.data?.models,
        catalogLoading: catalogQuery.isLoading,
        connections: connectionsQuery.data?.connections,
        connectionsLoading: connectionsQuery.isLoading,
        liveModelOption,
        hasLiveSession: Boolean(liveSession),
        pendingKey,
        select,
      }),
    [
      capabilitiesQuery.data,
      capabilitiesQuery.isLoading,
      capabilitiesQuery.isError,
      catalogQuery.data,
      catalogQuery.isLoading,
      connectionsQuery.data,
      connectionsQuery.isLoading,
      liveModelOption,
      liveSession,
      pendingKey,
      select,
    ],
  );
}
