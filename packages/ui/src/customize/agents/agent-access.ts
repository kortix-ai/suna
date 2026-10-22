import type { ProjectConfigSummary } from '@kortix/sdk';

type AgentScope = NonNullable<ProjectConfigSummary['agents'][number]['scope']>;

/** One grant on the card: everything (`'all'`) or how many are listed. */
export interface AgentAccessPart {
  kind: 'connectors' | 'secrets' | 'actions';
  value: 'all' | number;
}

/**
 * What an agent's configuration grants, for its card. The card used to show
 * only the agent's own description, and the starter's says "full tool access"
 * whatever the configuration grants (KRTX-3025). Null for an agent that
 * kortix.yaml does not govern: there is nothing to summarize.
 */
export function agentAccess(
  scope: AgentScope | undefined,
): { kind: 'full' } | { kind: 'scoped'; parts: AgentAccessPart[] } | null {
  if (!scope) return null;
  const grant = (value: string[] | 'all' | undefined): 'all' | number =>
    value === 'all' ? 'all' : (value?.length ?? 0);
  const parts: AgentAccessPart[] = [
    { kind: 'connectors', value: grant(scope.connectors) },
    { kind: 'secrets', value: grant(scope.env) },
    { kind: 'actions', value: grant(scope.kortix_permissions ?? scope.kortix_cli) },
  ];
  return parts.every((part) => part.value === 'all') ? { kind: 'full' } : { kind: 'scoped', parts };
}
