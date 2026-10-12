'use client';

import { agentDisplayLabel } from '@/features/session/composer/agent-selector';
import {
  composerSelectableAgents,
  resolveComposerAgent,
} from '@/features/session/composer/composer-agent-access';
import { pickerGroupId, pickerGroupLabel } from '@/features/session/model-grouping';
import { reasoningEffortChoices } from '@/features/session/reasoning-effort-selector';
import { useModelConnectionGate } from '@/features/session/use-model-connection-gate';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import { modelInDefaultView, type KortixProject, type ModelKey } from '@kortix/sdk';
import {
  useModelStore,
  useProjectConfig,
  useRuntimeAgents,
  useRuntimeConfig,
  useRuntimeProviders,
  useSessionModelSelection,
} from '@kortix/sdk/react';
import { type MutableRefObject, useEffect, useMemo } from 'react';

/** A model's id on the wire to the desktop bar. `modelID` may itself hold a `/`. */
export const quickEntryModelId = (key: ModelKey) => `${key.providerID}:${key.modelID}`;

/**
 * A new session's agent, model and effort for the desktop Quick Entry bar,
 * resolved exactly as the project-home composer resolves them.
 */
export interface QuickEntryComposerSnapshot {
  projectId: string;
  agents: { id: string; label: string }[];
  agent: string | null;
  /** Menu order: by provider, then name. `vision: false` refuses images. */
  models: { id: string; label: string; group: string; variants: string[]; vision: boolean | null }[];
  model: string | null;
  /** null = Auto: the model decides. */
  variant: string | null;
  /** The send's overrides for this selection. */
  overrides: { agent: string | null; model: ModelKey | null; variant: string | null };
}

export type QuickEntrySelect = (kind: string, value: string | null) => void;

/**
 * Headless twin of `ComposerChatInput`'s selection (composer-chat-input.tsx)
 * and the model picker's list (model-selector.tsx): the same hooks, the same
 * resolution, the same filters. Mount inside `KortixProjectProvider`.
 *
 * A pick from the bar goes through the same setters the composer's own
 * controls call, so it persists the same way: the model per agent, the effort
 * per model.
 */
export function QuickEntryComposer({
  projectId,
  project,
  onChange,
  selectRef,
}: {
  projectId: string;
  project: KortixProject | undefined;
  onChange: (snapshot: QuickEntryComposerSnapshot | null) => void;
  selectRef: MutableRefObject<QuickEntrySelect | null>;
}) {
  const { data: agents } = useRuntimeAgents({ projectId });
  const { data: providers } = useRuntimeProviders();
  const { data: config } = useRuntimeConfig();
  const projectConfig = useProjectConfig(projectId);
  const defaultAgentName = projectConfig?.default_agent ?? projectConfig?.open_code_default_agent;
  const local = useSessionModelSelection({ agents, providers, config, defaultAgentName });
  const agent = resolveComposerAgent({
    agents,
    boundAgent: null,
    defaultAgent: defaultAgentName,
    selectedAgent: local.agent.current?.name ?? null,
  }).selected;

  const gateway = isLlmGatewayEnabled(project);
  const allModels = local.model.list;
  const baseModels = useMemo(
    () => (gateway ? allModels : allModels.filter((model) => model.providerID !== 'kortix')),
    [allModels, gateway],
  );
  const { isSelectableModel } = useModelConnectionGate(baseModels, { projectId });
  const store = useModelStore(baseModels);
  const currentKey = local.model.currentKey ?? null;
  const variant = local.model.variant.current ?? null;

  const snapshot = useMemo<QuickEntryComposerSnapshot | null>(() => {
    if (!agents || !baseModels.length) return null;
    const models = baseModels
      .filter(
        (model) =>
          model.enabled !== false &&
          isSelectableModel(model) &&
          modelInDefaultView(model, { search: '', isStoreVisible: store.isVisible, selected: currentKey }),
      )
      .map((model) => ({
        id: quickEntryModelId(model),
        label: model.modelName,
        group: pickerGroupLabel(pickerGroupId(model), model),
        variants: reasoningEffortChoices(Object.keys(model.variants ?? {}), true),
        vision: model.capabilities?.vision ?? null,
      }))
      .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
    return {
      projectId,
      agents: composerSelectableAgents(agents).map((item) => ({
        id: item.name,
        label: agentDisplayLabel(agents, item.name),
      })),
      agent,
      models,
      model: currentKey ? quickEntryModelId(currentKey) : null,
      variant,
      overrides: { agent, model: currentKey, variant },
    };
  }, [agents, agent, baseModels, isSelectableModel, store.isVisible, currentKey, variant, projectId]);

  useEffect(() => onChange(snapshot), [onChange, snapshot]);
  useEffect(() => () => onChange(null), [onChange]);

  const setAgent = local.agent.set;
  const setModel = local.model.set;
  const setVariant = local.model.variant.set;
  useEffect(() => {
    selectRef.current = (kind, value) => {
      if (!snapshot) return;
      if (kind === 'agent' && snapshot.agents.some((item) => item.id === value)) setAgent(value ?? undefined);
      if (kind === 'model') {
        const key = baseModels.find((model) => quickEntryModelId(model) === value);
        if (key) setModel({ providerID: key.providerID, modelID: key.modelID, provider: key.provider }, { recent: true });
      }
      if (kind === 'effort') {
        const variants = snapshot.models.find((model) => model.id === snapshot.model)?.variants ?? [];
        if (value === null || variants.includes(value)) setVariant(value ?? undefined);
      }
    };
    return () => {
      selectRef.current = null;
    };
  }, [snapshot, baseModels, selectRef, setAgent, setModel, setVariant]);

  return null;
}
