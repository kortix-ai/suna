'use client';

import { agentDisplayLabel } from '@/features/session/composer/agent-selector';
import {
  composerSelectableAgents,
  resolveComposerAgent,
} from '@/features/session/composer/composer-agent-access';
import type { ModelKey } from '@kortix/sdk';
import {
  useProjectConfig,
  useRuntimeAgents,
  useRuntimeConfig,
  useRuntimeProviders,
  useSessionModelSelection,
} from '@kortix/sdk/react';
import { type MutableRefObject, useEffect, useMemo } from 'react';

/**
 * A new session's agent for the desktop Quick Entry bar, resolved exactly as
 * the project-home composer resolves it, plus the model and effort that agent
 * sends with there. The bar shows only the agent.
 */
export interface QuickEntryComposerSnapshot {
  projectId: string;
  agents: { id: string; label: string }[];
  agent: string | null;
  /** The current model's catalog says whether it reads images; null = it does not say. */
  vision: boolean | null;
  /** The send's overrides for this selection. */
  overrides: { agent: string | null; model: ModelKey | null; variant: string | null };
}

export type QuickEntrySelect = (kind: string, value: string | null) => void;

/**
 * Headless twin of `ComposerChatInput`'s selection (composer-chat-input.tsx):
 * the same hooks, the same resolution. Mount inside `KortixProjectProvider`.
 *
 * An agent picked in the bar goes through the composer's own setter, so the
 * model and effort follow that agent exactly as they do in the composer.
 */
export function QuickEntryComposer({
  projectId,
  onChange,
  selectRef,
}: {
  projectId: string;
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

  const currentKey = local.model.currentKey ?? null;
  const variant = local.model.variant.current ?? null;
  const vision =
    local.model.list.find(
      (model) => model.providerID === currentKey?.providerID && model.modelID === currentKey?.modelID,
    )?.capabilities?.vision ?? null;

  const snapshot = useMemo<QuickEntryComposerSnapshot | null>(() => {
    if (!agents) return null;
    return {
      projectId,
      agents: composerSelectableAgents(agents).map((item) => ({
        id: item.name,
        label: agentDisplayLabel(agents, item.name),
      })),
      agent,
      vision,
      overrides: { agent, model: currentKey, variant },
    };
  }, [agents, agent, vision, currentKey, variant, projectId]);

  useEffect(() => onChange(snapshot), [onChange, snapshot]);
  useEffect(() => () => onChange(null), [onChange]);

  const setAgent = local.agent.set;
  useEffect(() => {
    selectRef.current = (kind, value) => {
      if (kind === 'agent' && snapshot?.agents.some((item) => item.id === value)) setAgent(value ?? undefined);
    };
    return () => {
      selectRef.current = null;
    };
  }, [snapshot, selectRef, setAgent]);

  return null;
}
