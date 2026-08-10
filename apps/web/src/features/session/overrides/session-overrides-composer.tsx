'use client';

import { useMemo } from 'react';

import { AgentSelector } from '@/features/session/composer/agent-selector';
import type { FlatModel } from '@/features/session/model-flatten';
import { ModelSelector } from '@/features/session/model-selector';
import {
  ReasoningEffortSelector,
  useReasoningEffortControl,
} from '@/features/session/reasoning-effort-selector';
import type { SessionScopeCommit } from '@/features/session/scope/session-scope-model';
import type { Agent, ProviderListResponse } from '@kortix/sdk/react';
import { useWorkspaceSession } from '@kortix/sdk/react';

import { SessionOverridesToolbar } from './session-overrides-toolbar';

export interface SessionOverridesComposerProps {
  workspaceId: string;
  sessionId?: string;
  onCommittedDraft?: (commit: SessionScopeCommit | undefined) => void;

  agents: Agent[];
  selectedAgent: string | null;
  onAgentChange?: (agentName: string | null) => void;
  agentLocked?: boolean;
  /** The workspace's configured default agent — what "no override" resolves to. */
  defaultAgentName?: string | null;

  models: FlatModel[];
  modelsLoading?: boolean;
  selectedModel: { providerID: string; modelID: string } | null;
  onModelChange?: (model: { providerID: string; modelID: string } | null) => void;
  providers?: ProviderListResponse;
  /**
   * What the model resolves to with no session pick (agent → workspace → account
   * → platform). The composer always HAS a selected model — it is seeded from
   * this — so only a difference from it is an override worth badging.
   */
  defaultModel?: { providerID: string; modelID: string } | null;
}

/**
 * The composer's overrides control, wired to the SAME agent/model/effort
 * controls the toolbar row renders.
 *
 * It exists so the two composers (the workspace-home one in
 * `composer-chat-input.tsx` and the in-session one in `session-chat.tsx`) build
 * the panel from one place. Each already owns this state for its toolbar; this
 * only re-uses it.
 */
export function SessionOverridesComposer({
  workspaceId,
  sessionId,
  onCommittedDraft,
  agents,
  selectedAgent,
  onAgentChange,
  agentLocked = false,
  defaultAgentName,
  models,
  modelsLoading,
  selectedModel,
  onModelChange,
  providers,
  defaultModel,
}: SessionOverridesComposerProps) {
  const sessionRow = useWorkspaceSession(workspaceId, sessionId, { enabled: Boolean(sessionId) });
  const effort = useReasoningEffortControl(selectedModel, workspaceId);
  const effortCurrent = effort.current;
  const effortVisible = effort.visible;
  const currentModel = models.find(
    (candidate) =>
      candidate.providerID === selectedModel?.providerID &&
      candidate.modelID === selectedModel?.modelID,
  );

  const agentSlot = useMemo(
    () => ({
      summary: selectedAgent ?? 'Workspace default',
      // The workspace's own default agent is not an override, even though it is
      // the selected one.
      overridden: Boolean(selectedAgent) && selectedAgent !== defaultAgentName,
      description: agentLocked
        ? 'This session is bound to its agent, so it cannot be changed here. The agent also sets the ceiling for every other axis: a session never reaches past what its agent is granted.'
        : 'The agent that answers your next prompt. It also sets the ceiling for every other axis — a session never reaches past what its agent is granted.',
      control: (
        <AgentSelector
          agents={agents}
          selectedAgent={selectedAgent}
          onSelect={onAgentChange ?? (() => {})}
          disabled={agentLocked}
        />
      ),
    }),
    [agentLocked, agents, defaultAgentName, onAgentChange, selectedAgent],
  );

  const modelSlot = useMemo(
    () => ({
      summary: currentModel?.modelName ?? 'Workspace default',
      overridden:
        Boolean(selectedModel) &&
        Boolean(defaultModel) &&
        (selectedModel?.providerID !== defaultModel?.providerID ||
          selectedModel?.modelID !== defaultModel?.modelID),
      control: (
        <ModelSelector
          models={models}
          modelsLoading={modelsLoading}
          selectedModel={selectedModel}
          onSelect={onModelChange ?? (() => {})}
          providers={providers}
          unsetLabel="Workspace default"
          disabled={!onModelChange}
        />
      ),
    }),
    [
      currentModel?.modelName,
      defaultModel,
      models,
      modelsLoading,
      onModelChange,
      providers,
      selectedModel,
    ],
  );

  const effortSlot = useMemo(
    () =>
      effortVisible
        ? {
            summary: effortCurrent ?? 'Model default',
            overridden: Boolean(effortCurrent),
            control: <ReasoningEffortSelector model={selectedModel} workspaceId={workspaceId} />,
          }
        : undefined,
    [effortCurrent, effortVisible, workspaceId, selectedModel],
  );

  const sandbox = useMemo(
    () => ({
      slug: (sessionRow.data?.metadata?.sandbox_slug as string | undefined) ?? null,
      provider: sessionRow.data?.sandbox_provider ?? null,
    }),
    [sessionRow.data?.metadata, sessionRow.data?.sandbox_provider],
  );

  return (
    <SessionOverridesToolbar
      workspaceId={workspaceId}
      sessionId={sessionId}
      agentName={selectedAgent ?? undefined}
      onCommittedDraft={onCommittedDraft}
      agent={agentSlot}
      model={modelSlot}
      reasoningEffort={effortSlot}
      sandbox={sandbox}
    />
  );
}
