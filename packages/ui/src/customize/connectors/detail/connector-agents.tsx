'use client';

import { listConnectorPolicySets, listConnectors, type AdminConnector } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { RobotIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';

import { useTranslations } from '../../../i18n';
import { Button } from '../../../primitives/button';
import { EmptyState } from '../../../primitives/empty-state';
import { ErrorState } from '../../../primitives/error-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../primitives/select';
import { Skeleton } from '../../../primitives/skeleton';
import { Switch } from '../../../primitives/switch';
import { agentHref } from '../../../internal/lib/capability-tab-routes';
import { UiLink as Link } from '../../../providers/ui-provider';

import { agentConnectorAccess } from '../agent-access';
import { humanizeToolName as policySetLabel } from '../tools/tool-groups';
import { connectorPolicySetsKey, supportsPolicySets } from '../tools/policy-sets';
import { useAgentAccess } from '../use-agent-access';

const BASE_VALUE = '__base';

/**
 * Agents — which agents can use this connector, and with which rule set. One
 * row per agent: a switch gives or takes the connector, and a picker chooses
 * the rule set (Base rules or one of the connector's sets). Each change
 * commits kortix.yaml (`PUT …/agents/{name}/scope`).
 *
 * Read-only for a caller without both `project.agent.write` and
 * `project.connector.write`: the rows still say who has access.
 */
export function ConnectorAgents({ projectId, connector }: { projectId: string; connector: AdminConnector }) {
  const t = useTranslations('connectorPages');
  const tSets = useTranslations('connectorPolicySets');
  const access = useAgentAccess(projectId);
  const slug = connector.slug;
  const showSets = supportsPolicySets(connector.provider);
  const setsQuery = useQuery({
    queryKey: connectorPolicySetsKey(projectId, slug),
    queryFn: () => listConnectorPolicySets(projectId, slug),
    enabled: showSets && access.canEdit,
  });
  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId, { includeSchemas: false }),
    ...contract('config'),
  });
  const allSlugs = (connectorsQuery.data?.connectors ?? []).map((item) => item.slug);
  const sets = setsQuery.data?.sets ?? [];

  if (access.isPending) {
    return (
      <div className="space-y-2">
        {[0, 1].map((row) => (
          <Skeleton key={row} className="h-13 rounded-md" />
        ))}
      </div>
    );
  }
  if (access.isError) {
    return (
      <ErrorState
        size="sm"
        title={t('agentsLoadFailed')}
        description={access.error instanceof Error ? access.error.message : undefined}
        action={
          <Button variant="outline" size="sm" onClick={() => void access.refetch()}>
            {tSets('retry')}
          </Button>
        }
      />
    );
  }
  if (!access.supported) {
    return <p className="text-muted-foreground text-sm text-pretty">{t('agentsNeedsV2')}</p>;
  }
  if (access.agents.length === 0) {
    return <EmptyState icon={RobotIcon} size="sm" title={t('agentsEmpty')} />;
  }

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm text-pretty">
        {access.canEdit ? t('agentsIntro') : t('agentsReadOnly')}
      </p>
      <ul className="bg-popover divide-y overflow-hidden rounded-md border">
        {access.agents.map((agent) => {
          const row = agentConnectorAccess(access.grantsOf(agent), slug);
          const busy = access.pending === agent;
          // Also covers a reader, who cannot list the sets: the value still shows.
          const missing = row.policySet !== null && !sets.some((set) => set.name === row.policySet);
          return (
            <li key={agent} className="flex min-h-13 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
              <Link
                href={`${agentHref(projectId, agent)}?section=connectors`}
                className="text-foreground min-w-0 flex-1 truncate text-sm font-medium underline-offset-4 hover:underline"
              >
                {agent}
              </Link>
              {/* Every agent that can use the connector picks its rules here:
                  Base rules or one of the connector's sets. */}
              {showSets && row.granted ? (
                <Select
                  value={row.policySet ?? BASE_VALUE}
                  disabled={!access.canEdit || busy}
                  onValueChange={(next) =>
                    void access
                      .setPolicySet(agent, slug, next === BASE_VALUE ? null : next, allSlugs)
                      .catch(() => undefined)
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="w-40 shrink-0"
                    aria-label={tSets('agentSelectLabel', { name: agent })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem value={BASE_VALUE}>{tSets('baseRules')}</SelectItem>
                    {sets.map((set) => (
                      <SelectItem key={set.name} value={set.name} description={set.description ?? undefined}>
                        {policySetLabel(set.name)}
                      </SelectItem>
                    ))}
                    {missing && row.policySet ? (
                      <SelectItem value={row.policySet}>{policySetLabel(row.policySet)}</SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
              ) : null}
              <Switch
                label={t('agentsCanUse')}
                aria-label={t('agentsCanUseNamed', { name: agent })}
                checked={row.granted}
                disabled={!access.canEdit || busy}
                onCheckedChange={(on) => void access.setGrant(agent, slug, on, allSlugs).catch(() => undefined)}
                className="shrink-0 px-0 py-0"
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
