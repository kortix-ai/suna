'use client';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { Badge } from '../../primitives/badge';
import Hint from '../../primitives/hint';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../primitives/select';
import { connectorDisplayName } from '../connectors/connector-filter';
import { ConnectorLogo } from '../../internal/connector-logo/connector-logo';
import { installedConnectorLogoSource } from '../../internal/connector-logo/connector-logo-source';
import type { AgentDraft } from '../sections/view/agent-editor';
import { EditorList, EditorSection } from '../sections/view/agent-editor-primitives';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { type AdminConnector, listConnectors } from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { type PolicySetOption, policySetRows, withPolicySet } from './agent-policy-sets';

/**
 * The agent's connector policy sets, shown on the agent-scoped Connectors
 * screen: one row per granted connector that defines sets, each with a picker
 * for which rule set this agent gets. Moved out of the deleted Connectors grant
 * page when the agent editor switched to the full Connectors screen.
 */
function usePolicySetData(projectId: string) {
  const accountId = useProjectAccountId(projectId);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE, { accountId }).allowed ===
    true;
  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId, { includeSchemas: false }),
    ...contract('config'),
  });
  return { canWrite, connectors: connectorsQuery.data?.connectors ?? [] };
}

/**
 * The policy-set picker of each granted connector, for the connector's own
 * row on the agent page (the rail layout): `control(slug)` is the picker, or
 * undefined for a connector that defines no sets.
 */
export function useAgentPolicySetControls(
  projectId: string,
  editor: AgentDraft,
  catalog: Record<string, PolicySetOption[]>,
): (slug: string) => ReactNode | undefined {
  const { canWrite, connectors } = usePolicySetData(projectId);
  const rows = policySetRows(
    editor.draft.connectors,
    catalog,
    editor.draft.policy_sets,
    connectors.map((connector) => connector.slug),
  );
  return function PolicySetControl(slug: string) {
    const row = rows.find((candidate) => candidate.slug === slug);
    if (!row) return undefined;
    const connector = connectors.find((candidate) => candidate.slug === slug);
    return (
      <PolicySetSelect
        row={row}
        name={connector ? connectorDisplayName(connector) : slug}
        editor={editor}
        canWrite={canWrite}
      />
    );
  };
}

export function AgentPolicySetsPanel({
  projectId,
  editor,
  catalog,
  unlistedOnly = false,
}: {
  projectId: string;
  editor: AgentDraft;
  catalog: Record<string, PolicySetOption[]>;
  /** Only the sets of granted connectors the project does not list: the rest sit in their rows. */
  unlistedOnly?: boolean;
}) {
  const { canWrite, connectors } = usePolicySetData(projectId);
  return (
    <AgentPolicySetsSection
      editor={editor}
      catalog={catalog}
      connectors={connectors}
      canWrite={canWrite}
      unlistedOnly={unlistedOnly}
    />
  );
}

const BASE_SET_VALUE = '__base';

/**
 * Which rule set the agent gets on each granted connector that defines sets
 * (`agents.<a>.policy_sets`). One list for Pick and All alike: under All the
 * catalog has no per-row controls, and a second rendering for that mode would
 * be two places to set one value. Choosing a set needs connector write as well
 * as agent write (the API checks both), so a viewer without it sees the
 * values but cannot change them.
 */
function AgentPolicySetsSection({
  editor,
  catalog,
  connectors,
  canWrite,
  unlistedOnly,
}: {
  editor: AgentDraft;
  catalog: Record<string, PolicySetOption[]>;
  connectors: AdminConnector[];
  canWrite: boolean;
  unlistedOnly: boolean;
}) {
  const t = useI18nTranslations('connectorPolicySets');
  const { draft } = editor;
  const rows = policySetRows(
    draft.connectors,
    catalog,
    draft.policy_sets,
    connectors.map((connector) => connector.slug),
  ).filter((row) => !unlistedOnly || !connectors.some((connector) => connector.slug === row.slug));
  if (rows.length === 0) return null;
  return (
    <EditorSection title={t('agentSection')} bare>
      <EditorList>
        {rows.map((row) => {
          const connector = connectors.find((candidate) => candidate.slug === row.slug);
          const name = connector ? connectorDisplayName(connector) : row.slug;
          return (
            <li key={row.slug} className="flex min-h-13 items-center gap-3 px-4 py-2">
              {connector ? (
                <ConnectorLogo source={installedConnectorLogoSource(connector)} size="sm" />
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="text-foreground block truncate text-sm font-medium">{name}</span>
                <span className="text-muted-foreground block truncate font-mono text-xs">
                  {row.slug}
                </span>
              </span>
              <PolicySetSelect row={row} name={name} editor={editor} canWrite={canWrite} />
            </li>
          );
        })}
      </EditorList>
    </EditorSection>
  );
}

type PolicySetRow = ReturnType<typeof policySetRows>[number];

/** Which rule set the agent gets on one connector, with the missing-set mark. */
function PolicySetSelect({
  row,
  name,
  editor,
  canWrite,
}: {
  row: PolicySetRow;
  name: string;
  editor: AgentDraft;
  canWrite: boolean;
}) {
  const t = useI18nTranslations('connectorPolicySets');
  const { draft, set } = editor;
  return (
    <span className="flex shrink-0 items-center gap-2">
      {row.missing && row.value ? (
        <Hint label={t('agentMissingHint', { name: row.value })}>
          <Badge variant="destructive" size="xs">
            {t('agentMissing')}
          </Badge>
        </Hint>
      ) : null}
      <Select
        value={row.value ?? BASE_SET_VALUE}
        disabled={!canWrite}
        onValueChange={(next) =>
          set('policy_sets', withPolicySet(draft.policy_sets, row.slug, next === BASE_SET_VALUE ? null : next))
        }
      >
        <SelectTrigger size="sm" className="w-40 shrink-0" aria-label={t('agentSelectLabel', { name })}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value={BASE_SET_VALUE}>{t('baseRules')}</SelectItem>
          {row.options.map((option) => (
            <SelectItem key={option.name} value={option.name} description={option.description}>
              <span className="font-mono">{option.name}</span>
            </SelectItem>
          ))}
          {row.missing && row.value ? (
            <SelectItem value={row.value}>
              <span className="font-mono">{row.value}</span>
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
    </span>
  );
}
