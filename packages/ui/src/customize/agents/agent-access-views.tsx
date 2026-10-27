'use client';

/**
 * Access → Connectors, Secrets and Apps in the one Access look
 * (`agent-access-list.tsx`): the lead line and Manage, the All · Specific ·
 * None row, the project's items with a switch each. The project-wide pages
 * (install, set a value, deploy) stay one Manage click away; this view only
 * decides what THIS agent may use.
 */

import type { AgentGrantSetV2, ProjectSecret } from '@kortix/sdk';
import { useProjectApps } from '@kortix/sdk/react';
import { AppWindowIcon, KeyIcon, PlugsConnectedIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { ConnectorLogo } from '../../internal/connector-logo/connector-logo';
import { installedConnectorLogoSource } from '../../internal/connector-logo/connector-logo-source';
import { uiRoutes } from '../../lib/routes';
import { Badge } from '../../primitives/badge';
import { Button } from '../../primitives/button';
import { EmptyArt } from '../../primitives/empty-art';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { Skeleton } from '../../primitives/skeleton';
import { connectorDisplayName } from '../connectors/connector-filter';
import { useAgentGrant, GrantModeTabs } from '../shared/agent-resource-scope';
import { type AgentDraft, agentEditorOptionQueries } from '../sections/view/agent-editor';
import { ManageButton } from '../sections/view/agent-editor-access-fields';
import { EditorList } from '../sections/view/agent-editor-primitives';
import { AccessGroup, type AccessItem, AccessLead, AccessList, BuiltinGroup, plainGrantSwitch } from './agent-access-list';
import { appGrantRows } from './agent-apps-grant';
import { pruneRequiredConnectors } from './connectors-required';

/** The shape every list view shares: lead, mode row, then its body. */
function AccessView({
  testId,
  title,
  lead,
  action,
  mode,
  children,
}: {
  testId: string;
  title: string;
  lead: ReactNode;
  action?: ReactNode;
  mode?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-6" data-testid={testId}>
      <h2 className="sr-only">{title}</h2>
      <AccessLead description={lead} action={action} />
      {mode}
      {children}
    </section>
  );
}

function LoadState({ isError, onRetry }: { isError: boolean; onRetry: () => void }) {
  const t = useI18nTranslations('agentCapabilities');
  if (isError) {
    return (
      <ErrorState
        size="sm"
        title={t('loadErrorList')}
        action={
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t('retry')}
          </Button>
        }
      />
    );
  }
  return (
    <EditorList>
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex min-h-12 items-center gap-3 px-4 py-2">
          <Skeleton className="h-4 w-40 rounded-sm" />
        </li>
      ))}
    </EditorList>
  );
}

/** A granted id the project no longer has: listed so it can be turned off. */
function orphanItems(value: AgentGrantSetV2 | undefined, known: readonly string[], missing: string, toggle: ReturnType<typeof plainGrantSwitch>): AccessItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((id) => !known.includes(id))
    .map((id) => ({ id, status: <Badge variant="muted" size="xs">{missing}</Badge>, ...toggle(id) }));
}

export function AgentConnectorsAccess({
  projectId,
  agentName,
  editor,
  policySets,
}: {
  projectId: string;
  agentName: string;
  editor: AgentDraft;
  /** The agent's connector rule sets, under the list (`AgentPolicySetsPanel`). */
  policySets?: ReactNode;
}) {
  const t = useI18nTranslations('agentScope');
  const query = useQuery(agentEditorOptionQueries(projectId).connectors);
  const connectors = [...(query.data?.connectors ?? [])].sort((a, b) =>
    connectorDisplayName(a).localeCompare(connectorDisplayName(b)),
  );
  const value = editor.draft.connectors;
  // `connectors_required` is no longer enforced: keep it inside the grant.
  const write = (next: AgentGrantSetV2) => {
    editor.set('connectors', next);
    const kept = pruneRequiredConnectors(editor.draft.connectors_required, next);
    if (kept !== editor.draft.connectors_required) editor.set('connectors_required', kept);
  };
  const grant = useAgentGrant(value, write);
  const ids = connectors.map((c) => c.slug);
  const toggle = plainGrantSwitch(value, ids, write);
  const items: AccessItem[] = [
    ...connectors.map((c) => ({
      id: c.slug,
      title: connectorDisplayName(c),
      leading: <ConnectorLogo source={installedConnectorLogoSource(c)} size="sm" />,
      description: c.slug,
      status:
        c.status === 'needs_auth' || c.status === 'error' ? (
          <Badge variant="warning" size="xs">
            {c.status === 'error' ? t('connectorError') : t('connectorNeedsAuth')}
          </Badge>
        ) : undefined,
      ...toggle(c.slug),
    })),
    ...orphanItems(value, ids, t('missing'), toggle),
  ];
  return (
    <AccessView
      testId="agent-access-connectors"
      title={t('connectorsAccess')}
      lead={t('connectorsDescription')}
      action={<ManageButton tab="connectors" />}
      mode={items.length > 0 ? <GrantModeTabs grant={grant} label={t('connectorsAccess')} agentName={agentName} /> : null}
    >
      {query.data ? (
        items.length > 0 ? (
          <AccessList items={items} />
        ) : (
          <EmptyState
            media={<EmptyArt icon={PlugsConnectedIcon} />}
            title={t('connectorsEmptyTitle')}
            description={t('connectorsEmptyDescription')}
          />
        )
      ) : (
        <LoadState isError={query.isError} onRetry={() => void query.refetch()} />
      )}
      {policySets}
    </AccessView>
  );
}

/** One row per identifier: a secret with a shared value and a personal one lists twice. */
function uniqueSecrets(items: readonly ProjectSecret[]): ProjectSecret[] {
  const seen = new Map<string, ProjectSecret>();
  for (const s of items) if (!seen.has(s.identifier)) seen.set(s.identifier, s);
  return [...seen.values()].sort((a, b) => a.identifier.localeCompare(b.identifier));
}

export function AgentSecretsAccess({
  projectId,
  agentName,
  editor,
}: {
  projectId: string;
  agentName: string;
  editor: AgentDraft;
}) {
  const t = useI18nTranslations('agentScope');
  const query = useQuery(agentEditorOptionQueries(projectId).secrets);
  const secrets = uniqueSecrets(query.data?.items ?? []);
  const value = editor.draft.secrets;
  const write = (next: AgentGrantSetV2) => editor.set('secrets', next);
  const grant = useAgentGrant(value, write);
  const ids = secrets.map((s) => s.identifier);
  const toggle = plainGrantSwitch(value, ids, write);
  const item = (s: ProjectSecret): AccessItem => ({
    id: s.identifier,
    description: s.purpose || (s.name !== s.identifier ? s.name : undefined),
    status: s.configured ? undefined : (
      <Badge variant="muted" size="xs">
        {t('secretNotSet')}
      </Badge>
    ),
    ...toggle(s.identifier),
  });
  const project = [...secrets.filter((s) => !s.system).map(item), ...orphanItems(value, ids, t('missing'), toggle)];
  const builtin = secrets.filter((s) => s.system).map(item);
  return (
    <AccessView
      testId="agent-access-secrets"
      title={t('secretsAccess')}
      lead={t('secretsDescription')}
      action={<ManageButton tab="secrets" />}
      mode={secrets.length > 0 ? <GrantModeTabs grant={grant} label={t('secretsAccess')} agentName={agentName} /> : null}
    >
      {query.data ? (
        secrets.length > 0 ? (
          <>
            <AccessGroup title={t('projectGroup')} items={project} empty={t('secretsEmptyProject')} />
            <BuiltinGroup items={builtin} defaultOpen={project.length === 0} />
          </>
        ) : (
          <EmptyState
            media={<EmptyArt icon={KeyIcon} />}
            title={t('secretsEmptyTitle')}
            description={t('secretsEmptyDescription')}
          />
        )
      ) : (
        <LoadState isError={query.isError} onRetry={() => void query.refetch()} />
      )}
    </AccessView>
  );
}

export function AgentAppsAccess({
  projectId,
  agentName,
  editor,
}: {
  projectId: string;
  agentName: string;
  editor: AgentDraft;
}) {
  const t = useI18nTranslations('agentApps');
  const tScope = useI18nTranslations('agentScope');
  const query = useProjectApps(projectId);
  const rows = appGrantRows(query.data);
  const value = editor.draft.apps;
  const write = (next: AgentGrantSetV2) => editor.set('apps', next);
  const grant = useAgentGrant(value, write);
  const ids = rows.map((row) => row.id);
  const toggle = plainGrantSwitch(value, ids, write);
  const items: AccessItem[] = [
    ...rows.map((row) => ({
      id: row.id,
      description: row.name === row.id ? undefined : row.name,
      // The grant decides admission for a restricted or private App, the
      // normal case. Only an App that admits agents without it is marked.
      status: row.needsGrant ? undefined : (
        <Badge variant="muted" size="xs">
          {t('openWithoutGrant')}
        </Badge>
      ),
      ...toggle(row.id),
    })),
    ...orphanItems(value, ids, tScope('missing'), toggle),
  ];
  return (
    <AccessView
      testId="agent-apps-grant"
      title={tScope('appsAccess')}
      lead={t('description')}
      action={<ManageButton href={(id) => uiRoutes().apps(id)} />}
      mode={items.length > 0 ? <GrantModeTabs grant={grant} label={tScope('appsAccess')} agentName={agentName} /> : null}
    >
      {query.data ? (
        items.length > 0 ? (
          <div className="space-y-3">
            <AccessList items={items} />
            <p className="text-muted-foreground text-xs text-pretty">{t('grantNote')}</p>
          </div>
        ) : (
          <EmptyState media={<EmptyArt icon={AppWindowIcon} />} title={t('emptyTitle')} description={t('emptyDescription')} />
        )
      ) : (
        <LoadState isError={query.isError} onRetry={() => void query.refetch()} />
      )}
    </AccessView>
  );
}
