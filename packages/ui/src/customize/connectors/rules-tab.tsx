'use client';

import { listConnectors } from '@kortix/sdk';
import { contract, FRESHNESS, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

import { useTranslations } from '../../i18n';
import { ConnectorLogo } from '../../internal/connector-logo/connector-logo';
import { installedConnectorLogoSource } from '../../internal/connector-logo/connector-logo-source';
import { Skeleton } from '../../primitives/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../primitives/table';
import { UiLink as Link } from '../../providers/ui-provider';
import { PoliciesPanel } from '../../workspace/projects/policies-panel';

import { agentConnectorAccess } from './agent-access';
import { connectorDisplayName } from './connector-filter';
import { connectorHref } from './connector-routes';
import { policySetLabel } from './detail/connector-policy-sets';
import { useAgentAccess } from './use-agent-access';

/**
 * The Rules tab: everything that decides whether a tool call runs, in one
 * place. First the project's own rules (default mode + project rules, which
 * every connector obeys first), then who gets which rules: one row per
 * connector, one column per agent, each cell the agent's rule set on that
 * connector. A cell links to the connector's Agents tab, where it is edited.
 */
export function RulesTab({ projectId }: { projectId: string }) {
  const t = useTranslations('connectorPages');
  return (
    <div className="w-full max-w-5xl space-y-10">
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-foreground text-sm font-medium">{t('rulesProjectTitle')}</h2>
          <p className="text-muted-foreground text-xs text-pretty">{t('rulesProjectBody')}</p>
        </div>
        <PoliciesPanel projectId={projectId} />
      </section>
      <RulesMatrix projectId={projectId} />
    </div>
  );
}

function RulesMatrix({ projectId }: { projectId: string }) {
  const t = useTranslations('connectorPages');
  const tSets = useTranslations('connectorPolicySets');
  const access = useAgentAccess(projectId);
  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId, { includeSchemas: false }),
    ...contract(FRESHNESS.connectors),
  });
  // A channel or the computer reaches every agent: nothing to grant.
  const connectors = (connectorsQuery.data?.connectors ?? []).filter(
    (connector) => connector.provider !== 'channel' && connector.provider !== 'computer',
  );

  const heading = (
    <div className="space-y-1">
      <h2 className="text-foreground text-sm font-medium">{t('rulesMatrixTitle')}</h2>
      <p className="text-muted-foreground text-xs text-pretty">{t('rulesMatrixBody')}</p>
    </div>
  );

  if (access.isPending || connectorsQuery.isPending) {
    return (
      <section className="space-y-4">
        {heading}
        <Skeleton className="h-32 rounded-md" />
      </section>
    );
  }
  if (!access.supported || connectors.length === 0 || access.agents.length === 0) {
    return (
      <section className="space-y-4">
        {heading}
        <p className="text-muted-foreground text-sm text-pretty">
          {!access.supported ? t('agentsNeedsV2') : connectors.length === 0 ? t('rulesMatrixNoConnectors') : t('agentsEmpty')}
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      {heading}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="bg-accent sticky left-0 min-w-44">{t('rulesMatrixConnector')}</TableHead>
            {access.agents.map((agent) => (
              <TableHead key={agent} className="whitespace-nowrap">
                {agent}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {connectors.map((connector) => {
            const name = connectorDisplayName(connector);
            const href = connectorHref(projectId, connector.slug, { tab: 'agents' });
            return (
              <TableRow key={connector.slug}>
                <TableCell className="bg-popover sticky left-0">
                  <Link href={href} className="flex min-w-0 items-center gap-2 underline-offset-4 hover:underline">
                    <ConnectorLogo source={installedConnectorLogoSource(connector)} size="sm" />
                    <span className="text-foreground truncate font-medium">{name}</span>
                  </Link>
                </TableCell>
                {access.agents.map((agent) => {
                  const cell = agentConnectorAccess(access.grantsOf(agent), connector.slug);
                  const value = !cell.granted
                    ? t('rulesMatrixNoAccess')
                    : cell.policySet
                      ? policySetLabel(cell.policySet)
                      : tSets('baseRules');
                  return (
                    <TableCell key={agent} className="whitespace-nowrap">
                      <Link
                        href={href}
                        title={cell.policySet ?? undefined}
                        aria-label={t('rulesMatrixCell', { agent, name, value })}
                        className={
                          cell.granted
                            ? 'text-foreground underline-offset-4 hover:underline'
                            : 'text-muted-foreground underline-offset-4 hover:underline'
                        }
                      >
                        {value}
                      </Link>
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}
