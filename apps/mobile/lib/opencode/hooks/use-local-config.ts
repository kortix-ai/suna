/**
 * Local config — the persisted picks (per-agent model, thinking level, last-used agent) and
 * the thread's resolution through `@kortix/sdk`.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useMemo, useState } from 'react';
import {
  composerSelectableAgents,
  resolveComposerAgent,
  resolveComposerModel,
  resolveModelDefault,
  type ModelDefaultsResponse,
} from '@kortix/sdk';
import type { Agent, FlatModel, ProviderListResponse } from './use-opencode-data';

// ─── Persistent store ────────────────────────────────────────────────────────

interface LocalConfigState {
  /** The agent last picked or sent with on project home (web's last-used agent). A thread shows it only while its roster loads. */
  selectedAgent: string | null;
  /** Per-agent model selections: agentName -> { providerID, modelID } */
  agentModels: Record<string, { providerID: string; modelID: string }>;
  /** Per-model variant selections: "providerID/modelID" -> variantName */
  modelVariants: Record<string, string>;
  /** Legacy setup-wizard default model. Nothing sets it now; a stored one ranks
   *  below `/model-defaults` (`resolveComposerModel`'s `globalDefault`). */
  globalDefault: { providerID: string; modelID: string } | null;

  setAgent: (name: string | null) => void;
  setModelForAgent: (
    agentName: string,
    model: { providerID: string; modelID: string },
  ) => void;
  setVariant: (modelKey: string, variant: string | null) => void;
  /** Set the global default model — clears all per-agent selections so it
   *  takes effect everywhere immediately */
  setGlobalDefault: (model: { providerID: string; modelID: string } | null) => void;
}

export const useLocalConfigStore = create<LocalConfigState>()(
  persist(
    (set) => ({
      selectedAgent: null,
      agentModels: {},
      modelVariants: {},
      globalDefault: null,

      setAgent: (name) => set({ selectedAgent: name }),

      setModelForAgent: (agentName, model) =>
        set((s) => ({
          agentModels: { ...s.agentModels, [agentName]: model },
        })),

      setVariant: (modelKey, variant) =>
        set((s) => {
          const newVariants = { ...s.modelVariants };
          if (variant === null) {
            delete newVariants[modelKey];
          } else {
            newVariants[modelKey] = variant;
          }
          return { modelVariants: newVariants };
        }),

      setGlobalDefault: (model) =>
        set({
          globalDefault: model,
          // Clear all per-agent selections so the global default takes effect
          // everywhere immediately. Without this, stale per-agent data from
          // previous interactions would override the user's setup choice.
          agentModels: {},
        }),
    }),
    {
      name: 'opencode-local-config',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

// ─── Resolved config hook ────────────────────────────────────────────────────

export interface ResolvedConfig {
  agent: Agent | null;
  /** The roster web's thread lists (subagents included, for @mentions); the Agent tab drops subagents. */
  agents: Agent[];
  model: FlatModel | null;
  modelKey: { providerID: string; modelID: string } | null;
  variant: string | null;
  variants: string[];
  setAgent: (name: string) => void;
  setModel: (providerID: string, modelID: string) => void;
  setVariant: (variant: string | null) => void;
}

/**
 * A thread's agent, model, and thinking level. The lists and the resolution
 * are `@kortix/sdk`'s (`composerSelectableAgents`, `resolveComposerAgent`,
 * `resolveModelDefault`, `resolveComposerModel`), fed web's inputs; this hook
 * only adds mobile's persisted picks.
 *
 * Agent: this thread's pick, else the agent of its latest assistant turn, else
 * the session's bound agent, else the project default, else the first. The
 * pick lives for this screen only; after a reload the latest turn carries it.
 * Model: the persisted per-agent pick, else `/model-defaults` (agent →
 * project → account → platform), else the legacy global default, else the
 * agent's own model, the runtime config model, and the provider default.
 */
export function useResolvedConfig(i: {
  /** The raw roster. Undefined while it loads. */
  agents: Agent[] | undefined;
  /** The agent the session was created with (`agent_name`). */
  boundAgent?: string | null;
  /** The agent of the session's latest assistant message. */
  latestAgent?: string | null;
  defaultAgent?: string | null;
  models: FlatModel[];
  providers?: ProviderListResponse;
  modelDefaults?: ModelDefaultsResponse;
  configModel?: string;
}): ResolvedConfig {
  const store = useLocalConfigStore();
  const [pickedAgent, setPickedAgent] = useState<string | null>(null);

  const agents = useMemo(
    () => composerSelectableAgents(i.agents, { includeSubagents: true }),
    [i.agents],
  );
  const agentName = resolveComposerAgent({
    agents: i.agents,
    boundAgent: i.boundAgent,
    defaultAgent: i.defaultAgent,
    selectedAgent: pickedAgent ?? i.latestAgent,
  }).selected;
  // A bound agent outside the roster still runs server-side: name it.
  const agent = agentName ? (agents.find((a) => a.name === agentName) ?? ({ name: agentName } as Agent)) : null;

  const agentSlot = agentName ?? '_default';
  const { model: modelKey } = resolveComposerModel({
    models: i.models,
    picks: [store.agentModels[agentSlot]],
    serverDefault: resolveModelDefault(i.modelDefaults, agentName ?? undefined),
    globalDefault: store.globalDefault ?? undefined,
    agentModel: agent?.model,
    configModel: i.configModel,
    providers: i.providers,
  });
  const model = modelKey
    ? (i.models.find((m) => m.providerID === modelKey.providerID && m.modelID === modelKey.modelID) ?? null)
    : null;

  // ── Variant ──
  const variantKey = model ? `${model.providerID}/${model.modelID}` : '';
  const variants = model?.variants ? Object.keys(model.variants) : [];
  const variant = variantKey ? (store.modelVariants[variantKey] ?? null) : null;

  const setModel = (providerID: string, modelID: string) => {
    store.setModelForAgent(agentSlot, { providerID, modelID });
    // An explicit pick retires the legacy setup-wizard default.
    if (store.globalDefault) store.setGlobalDefault(null);
  };

  return {
    agent,
    agents,
    model,
    modelKey: model ? { providerID: model.providerID, modelID: model.modelID } : null,
    variant,
    variants,
    setAgent: setPickedAgent,
    setModel,
    setVariant: (v) => {
      if (variantKey) store.setVariant(variantKey, v);
    },
  };
}
