import type { ProjectConfigSummary } from '@kortix/sdk';
export function agentStatus(
  agent: ProjectConfigSummary['agents'][number],
  config: ProjectConfigSummary | null,
) {
  const mode = agent.mode?.toLowerCase();
  return {
    mode,
    showMode: !!mode && mode !== 'primary',
    isDefault: (config?.default_agent ?? config?.open_code_default_agent) === agent.name,
    disabled: agent.enabled === false,
  };
}
