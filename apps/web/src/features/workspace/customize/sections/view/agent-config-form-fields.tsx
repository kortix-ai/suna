'use client';

import {
  type AgentConfigBlock,
  listConnectors,
  listProjectSandboxTemplates,
  listProjectSecrets,
  type RuntimeAgentConfig,
} from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { CpuIcon as Cpu, StackIcon as Layers } from '@phosphor-icons/react';

import { LayerHeader } from './agent-editor-primitives';
import { KortixLayerFields } from './kortix-layer-fields';
import { RuntimeLayerFields } from './runtime-layer-fields';

type Option = { id: string; label: string };

export function useAgentConfigFormOptions(
  projectId: string,
  initialSandbox?: string,
): {
  secretOptions: Option[];
  connectorOptions: Option[];
  sandboxOptions: Option[];
} {
  const secretsQuery = useQuery({
    queryKey: ['project-secrets', projectId],
    queryFn: () => listProjectSecrets(projectId),
    staleTime: 30_000,
  });
  const connectorsQuery = useQuery({
    queryKey: ['project-connectors', projectId],
    queryFn: () => listConnectors(projectId),
    staleTime: 30_000,
  });
  const sandboxesQuery = useQuery({
    queryKey: ['project-sandbox-templates', projectId],
    queryFn: () => listProjectSandboxTemplates(projectId),
    staleTime: 30_000,
  });

  const secretOptions = useMemo(
    () =>
      [...new Set((secretsQuery.data?.items ?? []).map((s) => s.identifier))]
        .sort()
        .map((identifier) => ({ id: identifier, label: identifier })),
    [secretsQuery.data],
  );

  const connectorOptions = useMemo(
    () =>
      (connectorsQuery.data?.connectors ?? [])
        .map((c) => ({ id: c.slug, label: c.name || c.slug }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [connectorsQuery.data],
  );

  const sandboxOptions = useMemo(() => {
    const options = new Map<string, string>([['default', 'Platform default']]);
    for (const template of sandboxesQuery.data?.items ?? []) {
      options.set(template.slug, template.is_default ? 'Platform default' : template.name);
    }
    if (initialSandbox && !options.has(initialSandbox)) {
      options.set(initialSandbox, initialSandbox);
    }
    return [...options].map(([id, label]) => ({ id, label }));
  }, [initialSandbox, sandboxesQuery.data]);

  return { secretOptions, connectorOptions, sandboxOptions };
}

export function AgentConfigFormFields({
  agentName,
  draft,
  set,
  setOc,
  skillsOptions,
  connectorOptions,
  secretOptions,
  sandboxOptions,
}: {
  agentName: string;
  draft: AgentConfigBlock;
  set: <K extends keyof AgentConfigBlock>(key: K, value: AgentConfigBlock[K]) => void;
  setOc: <K extends keyof RuntimeAgentConfig>(key: K, value: RuntimeAgentConfig[K]) => void;
  skillsOptions: Option[];
  connectorOptions: Option[];
  secretOptions: Option[];
  sandboxOptions: Option[];
}) {
  return (
    <>
      <div className="space-y-6">
        <LayerHeader
          icon={Layers}
          label="Kortix"
          tone="kortix"
          description="Identity, model, and platform-enforced governance."
        />
        <KortixLayerFields
          draft={draft}
          set={set}
          skillsOptions={skillsOptions}
          connectorOptions={connectorOptions}
          secretOptions={secretOptions}
          sandboxOptions={sandboxOptions}
        />
      </div>

      <div className="space-y-6">
        <LayerHeader
          icon={Cpu}
          label="OpenCode"
          tone="outline"
          description="Behavior this agent runtime executes."
        />
        <RuntimeLayerFields agentName={agentName} oc={draft.opencode ?? {}} setOc={setOc} />
      </div>
    </>
  );
}
