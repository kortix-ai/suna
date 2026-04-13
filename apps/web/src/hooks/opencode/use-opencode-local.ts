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

import { useMemo, useCallback, useRef, useEffect } from 'react';
import { useModelStore, type ModelKey } from './use-model-store';
import type { FlatModel } from '@/components/session/session-chat-input';
import type { Agent, ProviderListResponse, Config } from '@opencode-ai/sdk/v2/client';

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
  /** Current model as ModelKey (for sending to API) */
  currentKey: ModelKey | undefined;
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
 * Format a ModelKey as a string "providerID/modelID" for command endpoints.
 */
export function formatModelString(model: ModelKey): string {
  return `${model.providerID}/${model.modelID}`;
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
  // ---- Flatten models from providers (only connected) ----
  const flatModels = useMemo<FlatModel[]>(() => {
    if (!providers) return [];
    const all = Array.isArray(providers.all) ? providers.all : [];
    const connected = Array.isArray(providers.connected) ? providers.connected : [];
    const result: FlatModel[] = [];
    for (const p of all) {
      if (!connected.includes(p.id)) continue;
      for (const [modelID, model] of Object.entries(p.models)) {
        const caps = (model as any).capabilities;
        const modalities = (model as any).modalities;
        result.push({
          providerID: p.id,
          providerName: p.name,
          modelID,
          modelName: (model.name || modelID).replace('(latest)', '').trim(),
          variants: model.variants,
          capabilities: caps ? {
            reasoning: caps.reasoning ?? false,
            vision: caps.input?.image ?? false,
            toolcall: caps.toolcall ?? false,
          } : {
            reasoning: (model as any).reasoning ?? false,
            vision: modalities?.input?.includes('image') ?? false,
            toolcall: (model as any).tool_call ?? false,
          },
          contextWindow: (model as any).limit?.context,
          releaseDate: (model as any).release_date,
          family: (model as any).family,
          cost: (model as any).cost ? {
            input: (model as any).cost.input ?? 0,
            output: (model as any).cost.output ?? 0,
          } : undefined,
          providerSource: (p as any).source,
        });
      }
    }
    return result;
  }, [providers]);

  // ---- Model store (persisted: visibility, recent, variant) ----
  const modelStore = useModelStore(flatModels);

  // ---- Model validation (matches SolidJS web app: checks model exists AND provider is connected) ----
  const isModelValid = useCallback(
    (model: ModelKey): boolean => {
      if (!providers) return false;
      const all = Array.isArray(providers.all) ? providers.all : [];
      const connected = Array.isArray(providers.connected) ? providers.connected : [];
      const provider = all.find((x) => x.id === model.providerID);
      return (
        !!provider?.models[model.modelID] &&
        connected.includes(model.providerID)
      );
    },
    [providers],
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

  // ---- Agent state — persisted per-session in localStorage so switching tabs preserves selection ----
  const visibleAgents = useMemo<Agent[]>(
    () => (Array.isArray(rawAgents) ? rawAgents : []).filter((a) => !a.hidden),
    [rawAgents],
  );

  // Resolve the current agent name with a two-tier priority:
  //   1. Per-session slot (sessionAgentName[sessionId]) — sticky for THIS session
  //   2. Global lastAgentName — the agent the user most recently picked anywhere.
  //      Used by the dashboard (no sessionId) and as the seed for brand-new
  //      sessions, so reloading the dashboard or starting a new chat doesn't
  //      reset to the first agent in the list.
  const sessionAgentName = sessionId ? modelStore.getSessionAgentName(sessionId) : undefined;
  const currentAgentName = sessionAgentName ?? modelStore.lastAgentName;

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
          if (isModelValid(key)) return key;
        }
        const first = Object.values(p.models)[0];
        if (!first) continue;
        const key = { providerID: p.id, modelID: first.id };
        if (isModelValid(key)) return key;
      }
    }

    return undefined;
  }, [config?.model, modelStore.recent, providers, isModelValid]);

  // ---- Current model resolution ----
  // Priority: per-session > per-agent > globalDefault > agent.model > fallback
  // Per-session and per-agent overrides take priority over globalDefault so that
  // explicit per-conversation choices are respected. globalDefault is the user's
  // chosen default for NEW conversations (set during onboarding or settings).
  const currentModelKey = useMemo<ModelKey | undefined>(() => {
    if (!currentAgent) return undefined;
    return getFirstValidModel(
      // 1. Per-session model (user's explicit choice in this session — survives reload)
      () => sessionId ? modelStore.getSessionModel(sessionId) : undefined,
      // 2. Per-agent model (persisted across sessions for this agent)
      () => modelStore.getSelectedModel(currentAgent.name),
      // 3. User's global default (set during onboarding or settings)
      () => modelStore.globalDefault,
      // 4. Agent's configured default model
      () => currentAgent.model as ModelKey | undefined,
      // 5. Global fallback (config.model > recent > first connected)
      () => fallbackModel,
    );
  }, [currentAgent, sessionId, modelStore, getFirstValidModel, fallbackModel]);

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
        modelStore.setSelectedModel(currentAgent.name, next);
      }
      // Also persist per-session so the selection survives page reload
      if (sessionId && next) {
        modelStore.setSessionModel(sessionId, next);
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
    [currentAgent, sessionId, fallbackModel, modelStore, isModelValid],
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
        setModel({
          providerID: currentAgent.model.providerID,
          modelID: currentAgent.model.modelID,
        }, { autoSeed: true });
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
    return modelStore.getVariant({ providerID: currentModel.providerID, modelID: currentModel.modelID });
  }, [currentModel, modelStore]);

  const variantList = useMemo<string[]>(() => {
    if (!currentModel?.variants) return [];
    return Object.keys(currentModel.variants);
  }, [currentModel]);

  const setVariant = useCallback(
    (value: string | undefined) => {
      if (!currentModel) return;
      modelStore.setVariant({ providerID: currentModel.providerID, modelID: currentModel.modelID }, value);
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
    if (!sessionId) return false;
    return !!modelStore.getSessionModel(sessionId);
  }, [sessionId, modelStore]);

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
      recent: recentModels,
      list: flatModels,
      set: setModel,
      visible: modelStore.isVisible,
      setVisibility: modelStore.setVisibility,
      cycle: cycleModel,
      hasSessionModel,
      variant: {
        current: variantCurrent,
        list: variantList,
        set: setVariant,
        cycle: cycleVariant,
      },
    },
  };
}
