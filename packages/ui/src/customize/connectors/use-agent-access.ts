'use client';

import { getProjectDetail, setAgentScope } from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { errorToast } from '../../primitives/toast';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCans } from '../../internal/lib/use-project-can';

import { manifestAgentGrants, withConnectorGrant, type AgentGrants } from './agent-access';

const ACTIONS = [PROJECT_ACTIONS.PROJECT_AGENT_WRITE, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE] as const;

/**
 * The project's agents and their connector grants and rule sets, plus the two
 * writes: give or take a connector, and pick an agent's rule set on it. Both
 * commit kortix.yaml through `PUT …/agents/{name}/scope`.
 *
 * `supported` is false on a v1 manifest: its agents are a TOML overlay this
 * reader does not parse, and rule sets need v2.
 */
export function useAgentAccess(projectId: string) {
  const queryClient = useQueryClient();
  const accountId = useProjectAccountId(projectId);
  const cans = useProjectCans(projectId, ACTIONS, { accountId });
  const canEdit =
    cans[PROJECT_ACTIONS.PROJECT_AGENT_WRITE]?.allowed === true &&
    cans[PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE]?.allowed === true;

  const projectQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const config = projectQuery.data?.config;
  const grants = useMemo(() => manifestAgentGrants(config?.manifest_raw), [config?.manifest_raw]);
  const agents = useMemo(() => {
    const names = new Set(Object.keys(grants ?? {}));
    for (const agent of config?.agents ?? []) if (!agent.hidden) names.add(agent.name);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [grants, config?.agents]);

  const write = useMutation({
    mutationFn: (input: { agent: string; scope: Parameters<typeof setAgentScope>[2] }) =>
      setAgentScope(projectId, input.agent, input.scope),
    onError: (error: Error) => errorToast(error.message),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.project.detail(projectId) });
      void queryClient.invalidateQueries({ queryKey: ['connector-policy-sets', projectId] });
    },
  });

  const grantsOf = (agent: string): AgentGrants | undefined => grants?.[agent];

  return {
    isPending: projectQuery.isPending,
    isError: projectQuery.isError,
    error: projectQuery.error,
    refetch: projectQuery.refetch,
    supported: grants !== null,
    canEdit,
    agents,
    grantsOf,
    pending: write.isPending ? write.variables?.agent ?? null : null,
    /** Give (`on`) or take one connector. `allSlugs` are the project's connectors. */
    setGrant: (agent: string, slug: string, on: boolean, allSlugs: readonly string[]) =>
      write.mutateAsync({
        agent,
        scope: { connectors: withConnectorGrant(grantsOf(agent), slug, on, allSlugs) },
      }),
    /** Pick the agent's rule set on a connector; null is the base rules. Grants the connector too. */
    setPolicySet: (agent: string, slug: string, set: string | null, allSlugs: readonly string[]) =>
      write.mutateAsync({
        agent,
        scope: {
          ...(set ? { connectors: withConnectorGrant(grantsOf(agent), slug, true, allSlugs) } : {}),
          policy_sets: { [slug]: set },
        },
      }),
  };
}
