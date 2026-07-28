'use client';

/**
 * Which model this agent runs on. Sets the per-agent gateway default (scope=agent,
 * DB-backed, instant — no git commit). When unset, the agent falls back to the
 * project → account → platform default. Manager-gated; everyone else sees the
 * read-only resolved model.
 *
 * Lives OUTSIDE the detail pane's "Advanced" disclosure on purpose: picking a
 * model is the single most common thing anyone does to an agent, so it stays
 * visible. Assignments and manifest scope are the advanced pair.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { successToast } from '@/components/ui/toast';
import { ModelSelector } from '@/features/session/model-selector';
import { flattenModels } from '@/features/session/session-chat-input';
import { listProjectAccess } from '@kortix/sdk';
import { useModelDefaults, useRuntimeProviders } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useMemo } from 'react';

export function AgentModel({ projectId, agentName }: { projectId: string; agentName: string }) {
  const accessQuery = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => listProjectAccess(projectId),
    staleTime: 20_000,
  });
  const canManage = Boolean(accessQuery.data?.can_manage);
  const { data: providers } = useRuntimeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);
  const defaults = useModelDefaults(projectId);
  const explicit = defaults.agentDefaults[agentName] ?? null;
  const resolved = defaults.resolveDefaultFor(agentName) ?? null;

  const nameOf = (m: { providerID: string; modelID: string } | null) =>
    m
      ? (models.find((x) => x.providerID === m.providerID && x.modelID === m.modelID)?.modelName ??
        `${m.providerID}/${m.modelID}`)
      : null;

  return (
    <div className="border-border/60 bg-muted/20 space-y-2.5 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="text-muted-foreground/70 size-3.5 shrink-0" />
        <span className="text-foreground/80 text-xs font-medium">Model</span>
        {explicit ? (
          <Badge variant="muted" size="xs">
            Pinned
          </Badge>
        ) : null}
      </div>

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <ModelSelector
            models={models}
            providers={providers}
            selectedModel={explicit}
            onSelect={(m) => {
              if (m) {
                void defaults.setAgentDefault(agentName, m);
                successToast(`${agentName} → ${nameOf(m)}`);
              } else {
                void defaults.clearAgentDefault(agentName);
              }
            }}
          />
          {explicit ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                void defaults.clearAgentDefault(agentName);
                successToast(`${agentName} follows the default model again`);
              }}
            >
              Reset to default
            </Button>
          ) : null}
        </div>
      ) : (
        <Badge variant="outline" size="sm" className="font-mono">
          {nameOf(resolved) ?? 'No model configured'}
        </Badge>
      )}

      <p className="text-muted-foreground/50 text-[11px] leading-relaxed">
        {explicit ? (
          <>
            Every session run by <span className="font-medium">{agentName}</span> uses{' '}
            <span className="font-medium">{nameOf(explicit)}</span>.
          </>
        ) : (
          <>
            Follows the project / account default
            {resolved ? (
              <>
                {' '}
                (<span className="font-medium">{nameOf(resolved)}</span>)
              </>
            ) : null}
            . Pick a model to pin this agent to it.
          </>
        )}
      </p>
    </div>
  );
}

export default AgentModel;
