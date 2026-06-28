'use client';

/**
 * React port of the SolidJS `context/local.tsx` from the OpenCode reference app.
 *
 * Provides unified agent + model + variant state management with:
 * - Per-agent model selection persisted to localStorage (survives refresh/new tabs)
 * - Fallback chain: persisted selection -> agent.model -> config.model -> recent -> provider default
 * - Agent switching auto-sets model when agent has a configured model
 * - Recent model list persisted via useModelStore
 * - Variant persistence via useModelStore
 */

import { flattenModels, type FlatModel } from '@/features/session/session-chat-input';
import { accountStateSelectors, useAccountState } from '@/hooks/billing';
import { featureFlags } from '@/lib/feature-flags';
import { AUTO_DEFAULT_MODEL_ID, AUTO_MODEL_ID } from '@kortix/shared/llm-catalog';
import { listProjectSecrets } from '@/lib/projects-client';
import type { Agent, Config, ProviderListResponse } from '@opencode-ai/sdk/v2/client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  connectedGatewayProviderIdsFromSecretNames,
  normalizeProviderList,
} from './provider-selection';
import { useModelDefaults, type UseModelDefaults } from './use-model-defaults';
import { useModelStore, type ModelKey } from './use-model-store';

export type { ModelKey };

// ============================================================================
// Types
// ============================================================================

export interface UseOpenCodeLocalOptions {
  agents?: Agent[];
  providers?: ProviderListResponse;
  config?: Config;
  /** Session ID — used to persist agent selection per-session in localStorage */
  sessionId?: string;
}

export interface OpenCodeLocalAgent {
  /** Currently selected agent (or first available) */
  current: Agent | undefined;
  /** List of visible (non-hidden) agents, including subagents */
  list: Agent[];
  /** Set agent by name */
  set: (name: string | undefined) => void;
  /** Cycle to next/previous agent */
  move: (direction: 1 | -1) => void;
}

export interface OpenCodeLocalModel {
  /** Current resolved model (ephemeral override -> agent.model -> fallback) */
  current: FlatModel | undefined;
  /** Current model as ModelKey — for DISPLAY in the picker (the resolved default). */
  currentKey: ModelKey | undefined;
  /** Wire model to SEND: `auto` when on the default (gateway resolves it), else the explicit pick. */
  sendKey: ModelKey | undefined;
  /** True when no explicit pick is active — the picker shows currentKey as the resolved default. */
  onDefault: boolean;
  /** Recent models (enriched) */
  recent: FlatModel[];
  /** All available models */
  list: FlatModel[];
  /** Set model (optionally push to recent, or mark as auto-seeded from message) */
  set: (model: ModelKey | undefined, options?: { recent?: boolean; autoSeed?: boolean }) => void;
  /** Check if a model is visible */
  visible: (model: ModelKey) => boolean;
  /** Set visibility for a model */
  setVisibility: (model: ModelKey, visible: boolean) => void;
  /** Cycle through recent models */
  cycle: (direction: 1 | -1) => void;
  /** Whether this session has an explicit per-session model selection in localStorage */
  hasSessionModel: boolean;
  /** Server-backed account/agent default model management (gateway source of truth). */
  defaults: UseModelDefaults;
  /** Variant management */
  variant: {
    current: string | undefined;
    list: string[];
    set: (value: string | undefined) => void;
    cycle: () => void;
  };
}

export interface OpenCodeLocal {
  agent: OpenCodeLocalAgent;
  model: OpenCodeLocalModel;
}

// ============================================================================
// Helpers
// ============================================================================

function uniqueBy<T>(arr: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of arr) {
    const k = key(item);
    if (!seen.has(k)) {
      seen.add(k);
      result.push(item);
    }
  }
  return result;
}

/**
 * Normalize a model value into a ModelKey.
 * Handles:
 *   - object: { providerID: string; modelID: string }
 *   - string: "providerID/modelID"
 * Returns undefined if the input is not a recognizable model.
 */
export function parseModelKey(model: unknown): ModelKey | undefined {
  if (!model) return undefined;
  if (typeof model === 'object' && model !== null) {
    const obj = model as Record<string, unknown>;
    if (typeof obj.providerID === 'string' && typeof obj.modelID === 'string') {
      return { providerID: obj.providerID, modelID: obj.modelID };
    }
  }
  if (typeof model === 'string') {
    const idx = model.indexOf('/');
    if (idx > 0 && idx < model.length - 1) {
      return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
    }
  }
  return undefined;
}

/**
 * Format a ModelKey as OpenCode's string model override. Native OpenCode models
 * are bare ids; provider-prefixed managed/BYOK models keep provider/model form.
 */
export function formatModelString(model: ModelKey): string {
  if (model.providerID === 'opencode') return model.modelID;
  return `${model.providerID}/${model.modelID}`;
}

export function formatPromptModel(model: ModelKey): ModelKey {
  return model;
}

export function resolveHiddenAutoModel(
  resolved: ModelKey | undefined,
  {
    enableAutoModel,
    isModelValid,
  }: {
    enableAutoModel: boolean;
    isModelValid: (model: ModelKey) => boolean;
  },
): ModelKey | undefined {
  if (
    enableAutoModel ||
    resolved?.providerID !== 'kortix' ||
    resolved.modelID !== AUTO_MODEL_ID
  ) {
    return resolved;
  }

  const explicit = { providerID: 'kortix', modelID: AUTO_DEFAULT_MODEL_ID };
  return isModelValid(explicit) ? explicit : undefined;
}

export type ModelProviderMode = 'native' | 'gateway';

export function modelProviderMode(providers: ProviderListResponse | undefined): ModelProviderMode {
  if (!providers) return 'native';
  const normalized = normalizeProviderList(providers);
  return normalized.connected?.includes('kortix') ? 'gateway' : 'native';
}

export function scopedModelSelectionKey(
  key: string | undefined,
  mode: ModelProviderMode,
): string | undefined {
  return key ? `${mode}:${key}` : undefined;
}

// ============================================================================
// Hook
// ============================================================================

export function useOpenCodeLocal({
  agents: rawAgents,
  providers,
  config,
  sessionId,
}: UseOpenCodeLocalOptions): OpenCodeLocal {
  // ---- Flatten models from providers (shared with the chat input). ----
  const flatModels = useMemo<FlatModel[]>(() => flattenModels(providers), [providers]);
  const params = useParams();
  const projectId = typeof params?.id === 'string' ? params.id : null;
  const providerMode = useMemo(() => modelProviderMode(providers), [providers]);
  // Server-backed account/agent default model (the gateway is the source of truth).
  const modelDefaults = useModelDefaults(projectId);
  const { data: accountState } = useAccountState();
  const freeTier = useMemo(() => {
    const tierKey = accountStateSelectors.tierKey(accountState).toLowerCase();
    const hasActiveSubscription = !!accountState?.subscription?.subscription_id;
    return (tierKey === 'free' || tierKey === 'none') && !hasActiveSubscription;
  }, [accountState]);
  const secretsQuery = useQuery({
    queryKey: ['project-secrets', projectId],
    queryFn: () => listProjectSecrets(projectId as string),
    enabled: !!projectId && providerMode === 'gateway',
    staleTime: 10_000,
  });
  const connectedProviderIds = useMemo(() => {
    if (providerMode !== 'gateway') return undefined;
    const data = secretsQuery.data;
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    return connectedGatewayProviderIdsFromSecretNames(
      new Set(items.map((secret: { name: string }) => secret.name)),
    );
  }, [providerMode, secretsQuery.data]);

  // ---- Model store (persisted: visibility, recent, variant) ----
  const modelStore = useModelStore(flatModels, {
    connectedProviderIds,
    freeTier: providerMode === 'gateway' && freeTier,
  });

  // ---- Model validation: a model is valid only if it's in the flattened list,
  // which is already filtered to connected + gateway-only providers. This keeps
  // default/recent resolution from ever selecting a native (bypass) model. ----
  const isModelValid = useCallback(
    (model: ModelKey): boolean =>
      flatModels.some((m) => m.providerID === model.providerID && m.modelID === model.modelID) &&
      modelStore.isVisible(model),
    [flatModels, modelStore],
  );

  // ---- First valid model from a list of fallback sources ----
  const getFirstValidModel = useCallback(
    (...modelFns: (() => ModelKey | undefined)[]): ModelKey | undefined => {
      for (const modelFn of modelFns) {
        const model = modelFn();
        if (!model) continue;
        if (isModelValid(model)) return model;
      }
      return undefined;
    },
    [isModelValid],
  );

  // ---- Find FlatModel from ModelKey ----
  const findModel = useCallback(
    (key: ModelKey): FlatModel | undefined =>
      flatModels.find((m) => m.modelID === key.modelID && m.providerID === key.providerID),
    [flatModels],
  );

  const isModelDefaultVisible = useCallback(
    (model: ModelKey): boolean => modelStore.isVisible(model),
    [modelStore],
  );

  // ---- Agent state — persisted per-session in localStorage so switching tabs preserves selection ----
  // Project-only agents (orchestrator/project-maintainer/worker) are hidden
  // when the project paradigm is off; their bodies reference project
  // tools that aren't registered in default mode.
  const visibleAgents = useMemo<Agent[]>(() => {
    // Keep in sync with use-visible-agents.ts:PROJECT_ONLY_AGENTS.
    const projectOnlyAgents = new Set(['project-manager']);
    return (Array.isArray(rawAgents) ? rawAgents : []).filter(
      (a) => !a.hidden && (featureFlags.enableProjects || !projectOnlyAgents.has(a.name)),
    );
  }, [rawAgents]);

  // Resolve the current agent name with a two-tier priority:
  //   1. Per-session slot (sessionAgentName[sessionId]) — sticky for THIS session
  //   2. Global lastAgentName — the agent the user most recently picked anywhere.
  //      Used by the dashboard (no sessionId) and as the seed for brand-new
  //      sessions, so reloading the dashboard or starting a new chat doesn't
  //      reset to the first agent in the list.
  const sessionAgentName = sessionId ? modelStore.getSessionAgentName(sessionId) : undefined;
  const currentAgentName = sessionAgentName ?? modelStore.lastAgentName;
  const scopedSessionModelKey = useMemo(
    () => scopedModelSelectionKey(sessionId, providerMode),
    [sessionId, providerMode],
  );

  const setCurrentAgentName = useCallback(
    (name: string | undefined) => {
      if (sessionId) {
        modelStore.setSessionAgentName(sessionId, name);
      }
      // Always update the global "last used" slot so the dashboard and any
      // future sessions pick up the user's most recent choice. Skipped only
      // when clearing (name === undefined) and we're in a session, since
      // clearing a session slot shouldn't wipe the global default.
      if (name !== undefined || !sessionId) {
        modelStore.setLastAgentName(name);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, modelStore.setSessionAgentName, modelStore.setLastAgentName],
  );

  // Resolve current agent (matching SolidJS: find by name or fall back to first)
  const currentAgent = useMemo<Agent | undefined>(() => {
    if (visibleAgents.length === 0) return undefined;
    if (currentAgentName) {
      const found = visibleAgents.find((a) => a.name === currentAgentName);
      if (found) return found;
    }
    return visibleAgents[0];
  }, [visibleAgents, currentAgentName]);

  // ---- Per-agent model overrides (persisted to localStorage so selection survives refresh/new tabs) ----

  // ---- Fallback model (matching SolidJS local.tsx:94-126) ----
  const fallbackModel = useMemo<ModelKey | undefined>(() => {
    // Priority 1: Config model (from opencode.json)
    if (config?.model) {
      const parts = config.model.split('/');
      if (parts.length >= 2) {
        const [providerID, ...rest] = parts;
        const modelID = rest.join('/');
        if (isModelValid({ providerID, modelID })) {
          return { providerID, modelID };
        }
      }
    }

    // Priority 2: Most recent valid model from persisted recent list
    for (const item of modelStore.recent) {
      if (isModelValid(item)) {
        return item;
      }
    }

    // Priority 3: Provider defaults -> first model of first connected provider
    if (providers) {
      const defaults = providers.default || {};
      const all = Array.isArray(providers.all) ? providers.all : [];
      const connectedIds = Array.isArray(providers.connected) ? providers.connected : [];
      const connected = all.filter((p) => connectedIds.includes(p.id));
      for (const p of connected) {
        const configured = defaults[p.id];
        if (configured) {
          const key = { providerID: p.id, modelID: configured };
          if (isModelValid(key) && isModelDefaultVisible(key)) return key;
        }
        for (const modelID of Object.keys(p.models)) {
          const key = { providerID: p.id, modelID };
          if (isModelValid(key) && isModelDefaultVisible(key)) return key;
        }
      }
    }

    return undefined;
  }, [config?.model, modelStore.recent, providers, isModelValid, isModelDefaultVisible]);

  // ---- Current model resolution ----
  // The LLM gateway is the source of truth for the default model. The client
  // distinguishes an EXPLICIT per-conversation/per-agent pick from being "on the
  // default":
  //   • explicit pick (per-session / per-agent localStorage) → sent as-is.
  //   • on default → the client sends `auto` (kortix/auto) and trusts the gateway
  //     to resolve the per-agent → account → platform default server-side.
  // For DISPLAY we still surface a concrete model: the server-configured default
  // (agent → account → platform, via useModelDefaults), falling back to the
  // legacy globalDefault cache / agent.model / provider fallback.

  // Explicit per-conversation/per-agent picks (highest priority, localStorage).
  const explicitModelKey = useMemo<ModelKey | undefined>(
    () =>
      getFirstValidModel(
        // Per-session model (user's explicit choice in this session — survives reload)
        () =>
          scopedSessionModelKey ? modelStore.getSessionModel(scopedSessionModelKey) : undefined,
        // Back-compat: the old unscoped slot, only if valid in the current mode.
        () => (sessionId ? modelStore.getSessionModel(sessionId) : undefined),
        // Per-agent model (persisted across sessions for this agent)
        () =>
          currentAgent
            ? modelStore.getSelectedModel(`${providerMode}:${currentAgent.name}`)
            : undefined,
        () => (currentAgent ? modelStore.getSelectedModel(currentAgent.name) : undefined),
      ),
    [currentAgent, sessionId, scopedSessionModelKey, providerMode, modelStore, getFirstValidModel],
  );

  // The server-configured default for the current agent (agent → account →
  // platform), validated against the catalog. Used for DISPLAY of "on default".
  const serverDefaultKey = useMemo<ModelKey | undefined>(() => {
    const candidate = modelDefaults.resolveDefaultFor(currentAgent?.name);
    return candidate && isModelValid(candidate) ? candidate : undefined;
  }, [modelDefaults, currentAgent?.name, isModelValid]);

  // Display key: explicit pick → server default → legacy globalDefault cache →
  // agent.model → provider fallback. Never the synthetic `auto`.
  const currentModelKey = useMemo<ModelKey | undefined>(() => {
    const resolved =
      explicitModelKey ??
      getFirstValidModel(
        () => serverDefaultKey,
        () => modelStore.globalDefault,
        () => (currentAgent?.model as ModelKey | undefined),
        () => fallbackModel,
      );
    return resolveHiddenAutoModel(resolved, {
      enableAutoModel: featureFlags.enableAutoModel,
      isModelValid,
    });
  }, [
    explicitModelKey,
    serverDefaultKey,
    currentAgent,
    modelStore,
    getFirstValidModel,
    isModelValid,
    fallbackModel,
  ]);

  // True when the user hasn't made an explicit pick — the picker shows the
  // resolved default with a "Default" badge and the client sends `auto`.
  const onDefaultModel = !explicitModelKey;

  // Wire key actually SENT to opencode/the gateway. On default we send `auto`
  // (when the catalog offers it — paid tiers) so the gateway resolves the
  // account/agent default; otherwise the concrete display key.
  const sendModelKey = useMemo<ModelKey | undefined>(() => {
    if (explicitModelKey) return explicitModelKey;
    const auto: ModelKey = { providerID: 'kortix', modelID: AUTO_MODEL_ID };
    return isModelValid(auto) ? auto : currentModelKey;
  }, [explicitModelKey, isModelValid, currentModelKey]);

  const currentModel = useMemo<FlatModel | undefined>(
    () => (currentModelKey ? findModel(currentModelKey) : undefined),
    [currentModelKey, findModel],
  );

  // ---- Recent models (enriched) ----
  const recentModels = useMemo<FlatModel[]>(
    () => modelStore.recent.map(findModel).filter(Boolean) as FlatModel[],
    [modelStore.recent, findModel],
  );

  // ---- Model set (persists selection to localStorage) ----
  const setModel = useCallback(
    (model: ModelKey | undefined, options?: { recent?: boolean; autoSeed?: boolean }) => {
      // When auto-seeding from a message and globalDefault is set, skip —
      // the user's setup wizard choice takes precedence over message-seeded models.
      if (options?.autoSeed && modelStore.globalDefault && isModelValid(modelStore.globalDefault)) {
        return;
      }

      const next = model ?? fallbackModel;
      if (currentAgent && next) {
        modelStore.setSelectedModel(`${providerMode}:${currentAgent.name}`, next);
      }
      // Also persist per-session so the selection survives page reload
      if (scopedSessionModelKey && next) {
        modelStore.setSessionModel(scopedSessionModelKey, next);
      }
      if (model) {
        modelStore.setVisibility(model, true);
      }
      if (options?.recent && model) {
        modelStore.pushRecent(model);
        // Per-session and per-agent overrides already take priority in the
        // resolution chain, so there's no need to clear globalDefault here.
        // The user's onboarding/settings choice should persist as the default
        // for NEW sessions even when they change model in an existing session.
      }
    },
    [currentAgent, scopedSessionModelKey, providerMode, fallbackModel, modelStore, isModelValid],
  );

  // ---- Agent set (matching SolidJS local.tsx:52-63) ----
  const setAgent = useCallback(
    (name: string | undefined) => {
      if (visibleAgents.length === 0) {
        setCurrentAgentName(undefined);
        return;
      }
      if (name && visibleAgents.some((a) => a.name === name)) {
        setCurrentAgentName(name);
        return;
      }
      setCurrentAgentName(visibleAgents[0]?.name);
    },
    [visibleAgents, setCurrentAgentName],
  );

  // ---- Agent move (matching SolidJS local.tsx:64-81) ----
  // Uses a ref to call setModel without creating circular deps
  const setModelRef = useRef(setModel);
  setModelRef.current = setModel;

  const moveAgent = useCallback(
    (direction: 1 | -1) => {
      if (visibleAgents.length === 0) {
        setCurrentAgentName(undefined);
        return;
      }
      const currentIdx = visibleAgents.findIndex((a) => a.name === currentAgentName);
      let next = (currentIdx === -1 ? 0 : currentIdx) + direction;
      if (next < 0) next = visibleAgents.length - 1;
      if (next >= visibleAgents.length) next = 0;
      const value = visibleAgents[next];
      if (!value) return;
      setCurrentAgentName(value.name);
      if (value.model) {
        setModelRef.current({
          providerID: value.model.providerID,
          modelID: value.model.modelID,
        });
      }
    },
    [visibleAgents, currentAgentName, setCurrentAgentName],
  );

  // ---- When agent changes externally (via setAgent), auto-set model if agent has one ----
  // Only applies when there's no persisted selection for this agent yet AND no global default.
  const prevAgentRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!currentAgent) return;
    if (prevAgentRef.current === currentAgent.name) return;
    prevAgentRef.current = currentAgent.name;
    // Don't override if user already has a persisted selection for this agent
    const persisted = modelStore.getSelectedModel(currentAgent.name);
    if (persisted && isModelValid(persisted)) return;
    // Don't override if user set a global default during onboarding setup
    if (modelStore.globalDefault && isModelValid(modelStore.globalDefault)) return;
    if (currentAgent.model) {
      if (isModelValid(currentAgent.model as ModelKey)) {
        setModel(
          {
            providerID: currentAgent.model.providerID,
            modelID: currentAgent.model.modelID,
          },
          { autoSeed: true },
        );
      }
    }
    // Only trigger on agent change — intentionally exclude setModel/modelStore from deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentAgent?.name, isModelValid]);

  // ---- Cycle through recent models (matching SolidJS local.tsx:142-163) ----
  const cycleModel = useCallback(
    (direction: 1 | -1) => {
      if (!currentModel || recentModels.length === 0) return;
      const index = recentModels.findIndex(
        (x) => x.providerID === currentModel.providerID && x.modelID === currentModel.modelID,
      );
      if (index === -1) return;
      let next = index + direction;
      if (next < 0) next = recentModels.length - 1;
      if (next >= recentModels.length) next = 0;
      const val = recentModels[next];
      if (!val) return;
      setModel({ providerID: val.providerID, modelID: val.modelID });
    },
    [currentModel, recentModels, setModel],
  );

  // ---- Variant management (matching SolidJS local.tsx:186-217) ----
  const variantCurrent = useMemo<string | undefined>(() => {
    if (!currentModel) return undefined;
    return modelStore.getVariant({
      providerID: currentModel.providerID,
      modelID: currentModel.modelID,
    });
  }, [currentModel, modelStore]);

  const variantList = useMemo<string[]>(() => {
    if (!currentModel?.variants) return [];
    return Object.keys(currentModel.variants);
  }, [currentModel]);

  const setVariant = useCallback(
    (value: string | undefined) => {
      if (!currentModel) return;
      modelStore.setVariant(
        { providerID: currentModel.providerID, modelID: currentModel.modelID },
        value,
      );
    },
    [currentModel, modelStore],
  );

  const cycleVariant = useCallback(() => {
    if (variantList.length === 0) return;
    if (!variantCurrent) {
      setVariant(variantList[0]);
      return;
    }
    const index = variantList.indexOf(variantCurrent);
    if (index === -1 || index === variantList.length - 1) {
      setVariant(undefined); // wrap back to default
      return;
    }
    setVariant(variantList[index + 1]);
  }, [variantList, variantCurrent, setVariant]);

  // ---- Per-session model exists check ----
  const hasSessionModel = useMemo<boolean>(() => {
    if (!scopedSessionModelKey) return false;
    return !!modelStore.getSessionModel(scopedSessionModelKey);
  }, [scopedSessionModelKey, modelStore]);

  // ---- Assemble return value ----
  return {
    agent: {
      current: currentAgent,
      list: visibleAgents,
      set: setAgent,
      move: moveAgent,
    },
    model: {
      current: currentModel,
      currentKey: currentModelKey,
      // The wire model to SEND: `auto` when on the default (gateway resolves it),
      // otherwise the explicit pick. Callers should send this, not currentKey.
      sendKey: sendModelKey,
      // True when no explicit pick is active — the picker shows currentKey as the
      // resolved default and the wire send is `auto`.
      onDefault: onDefaultModel,
      recent: recentModels,
      list: flatModels,
      set: setModel,
      visible: modelStore.isVisible,
      setVisibility: modelStore.setVisibility,
      cycle: cycleModel,
      hasSessionModel,
      // Server-backed account/agent default management (gateway source of truth).
      defaults: modelDefaults,
      variant: {
        current: variantCurrent,
        list: variantList,
        set: setVariant,
        cycle: cycleVariant,
      },
    },
  };
}
