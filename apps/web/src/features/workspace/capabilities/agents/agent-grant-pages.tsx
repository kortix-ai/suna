'use client';

import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
/**
 * The agent editor's Access pages — Skills, Connectors, Secrets — built from
 * the SAME cards and the SAME modals as the project-wide tabs of the same
 * name (Marko, 2026-09-03: "hardcore reuse same components as much as
 * possible & same modals/dialogues"). A card here is a `CatalogCard` in
 * select mode: its checkbox says whether the agent is granted the thing, its
 * body opens the thing itself — `EntityDetailModal` for a skill,
 * `ConnectorModal` for a connector, `ProjectSecretDialog` for a secret.
 *
 * The grant itself is still the All · Pick · None machine from
 * `grant-mode-field.tsx`; the catalog stays on screen in every mode so All
 * reads as "every card checked" and None as "every card unchecked".
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { connectorDisplayName } from '@/features/workspace/capabilities/connectors/connector-filter';
import {
  ConnectorAppIcon,
  ConnectorConnectedMark,
  ConnectorStatusBadge,
} from '@/features/workspace/capabilities/connectors/connector-identity';
import { ConnectorModal } from '@/features/workspace/capabilities/connectors/detail/connector-modal';
import { providerLabel } from '@/features/workspace/capabilities/connectors/provider-label';
import { CatalogCard } from '@/features/workspace/capabilities/shared/catalog/catalog-card';
import { CatalogGridSkeleton } from '@/features/workspace/capabilities/shared/catalog/catalog-grid';
import { detailSelection } from '@/features/workspace/capabilities/shared/detail-selection';
import { EntityDetailModal } from '@/features/workspace/capabilities/shared/entity/entity-modal';
import { connectorSetupStatus } from '@/features/workspace/customize/sections/connector-connection-form';
import type { AgentDraft } from '@/features/workspace/customize/sections/view/agent-editor';
import {
  GrantHeaderTrailing,
  RequiredConnectorToggle,
} from '@/features/workspace/customize/sections/view/agent-editor-access-fields';
import { EditorSection } from '@/features/workspace/customize/sections/view/agent-editor-primitives';
import { GrantModeField } from '@/features/workspace/customize/sections/view/grant-mode-field';
import {
  buildRows,
  ProjectSecretDialog,
  type SecretRow,
} from '@/features/workspace/customize/sections/view/secrets-view';
import { toArray } from '@/features/workspace/customize/shared/utils';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import {
  type AgentGrantSetV2,
  listConnectors,
  listProjectSecrets,
  type ProjectConfigSummary,
} from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { KeyIcon, PlusIcon, SparkleIcon } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';

// ─── The shared catalog ──────────────────────────────────────────────────

interface GrantCatalogItem {
  id: string;
  card: Omit<Parameters<typeof CatalogCard>[0], 'select' | 'onClick' | 'href'>;
  onOpen?: () => void;
}

/**
 * All · Pick · None over a grid of selectable cards. `items` is the project's
 * catalog; a granted id the catalog no longer has still renders, flagged, so
 * a stale grant is visible rather than silently dropped.
 */
function GrantCatalog({
  value,
  onChange,
  allLabel,
  items,
  isLoading,
  isError,
  onRetry,
  empty,
  trailingFor,
}: {
  value: AgentGrantSetV2 | undefined;
  onChange: (v: AgentGrantSetV2) => void;
  allLabel: string;
  items: GrantCatalogItem[];
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  empty: ReactNode;
  /** A control beside a GRANTED card in Pick mode — the connectors page's
   *  Required toggle. */
  trailingFor?: (id: string) => ReactNode;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <GrantModeField
      value={value}
      onChange={onChange}
      allLabel={allLabel}
      noneLabel={tI18nComplete.raw('text765b240c2900')}
      alwaysRender
    >
      {({ selected, toggle, mode }) => {
        if (isLoading) return <CatalogGridSkeleton />;
        if (isError) {
          return (
            <ErrorState
              size="sm"
              title={tI18nComplete.raw('text3f2d97c61a7e')}
              action={
                onRetry ? (
                  <Button variant="outline" size="sm" onClick={onRetry}>
                    {tI18nComplete.raw('text942087cc2d41')}
                  </Button>
                ) : undefined
              }
            />
          );
        }
        const known = new Set(items.map((i) => i.id));
        const orphans = [...selected].filter((id) => !known.has(id));
        if (items.length === 0 && orphans.length === 0) return <>{empty}</>;
        const checked = (id: string) => mode === 'all' || (mode === 'pick' && selected.has(id));
        return (
          <div className="grid gap-2">
            {items.map((item) => (
              <CatalogCard
                key={item.id}
                {...item.card}
                trailing={
                  <span className="flex items-center gap-1.5">
                    {item.card.trailing}
                    {mode === 'pick' && selected.has(item.id) ? trailingFor?.(item.id) : null}
                  </span>
                }
                onClick={item.onOpen}
                select={{
                  checked: checked(item.id),
                  onCheckedChange: () => toggle(item.id),
                  disabled: mode !== 'pick',
                  label: tI18nComplete('textd4170e74c3b0', { value0: item.id }),
                }}
              />
            ))}
            {orphans.map((id) => (
              <CatalogCard
                key={id}
                title={<span className="font-mono">{id}</span>}
                description={tI18nComplete.raw('textfecc36d012be')}
                badges={
                  <Badge variant="destructive" size="xs">
                    {tI18nComplete.raw('text6be36ca49ee8')}
                  </Badge>
                }
                select={{
                  checked: true,
                  onCheckedChange: () => toggle(id),
                  disabled: mode !== 'pick',
                  label: tI18nComplete('textd4170e74c3b0', { value0: id }),
                }}
              />
            ))}
          </div>
        );
      }}
    </GrantModeField>
  );
}

// ─── Skills ──────────────────────────────────────────────────────────────

export function SkillsGrantPage({
  projectId,
  config,
  editor,
}: {
  projectId: string;
  config: ProjectConfigSummary;
  editor: AgentDraft;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const skills = toArray(config.skills);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const detail = detailSelection({
    selection: selectedPath,
    record: skills.find((skill) => skill.path === selectedPath),
    isSuccess: true,
  });
  return (
    <>
      <EditorSection
        title={tI18nComplete.raw('text66d0f523a379')}
        description={tI18nComplete.raw('text836cd8e8a791')}
        trailing={
          <GrantHeaderTrailing
            value={editor.draft.skills}
            tab="skills"
            label={tI18nComplete.raw('text78abcbbfb830')}
          />
        }
      >
        <div className="py-4">
          <GrantCatalog
            value={editor.draft.skills}
            onChange={(v) => editor.set('skills', v)}
            allLabel={tI18nComplete.raw('textf059c2dbe260')}
            items={skills.map((skill) => ({
              id: skill.name,
              card: { title: skill.name, description: skill.description },
              onOpen: () => setSelectedPath(skill.path),
            }))}
            empty={
              <EmptyState
                icon={SparkleIcon}
                size="sm"
                title={tI18nComplete.raw('text32ae9b80f832')}
                description={tI18nComplete.raw('text62d220bbfcc8')}
              />
            }
          />
        </div>
      </EditorSection>
      <EntityDetailModal
        projectId={projectId}
        entity={detail.record}
        kind="skill"
        open={detail.open}
        isResolving={detail.isResolving}
        onOpenChange={(next) => {
          if (!next) setSelectedPath(null);
        }}
      />
    </>
  );
}

// ─── Connectors ──────────────────────────────────────────────────────────

export function ConnectorsGrantPage({
  projectId,
  editor,
}: {
  projectId: string;
  editor: AgentDraft;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const accountId = useProjectAccountId(projectId);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE, { accountId }).allowed ===
    true;
  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId),
    ...contract('config'),
  });
  const connectors = connectorsQuery.data?.connectors ?? [];
  const [detailSlug, setDetailSlug] = useState<string | null>(null);
  const detail = detailSelection({
    selection: detailSlug,
    record: connectors.find((c) => c.slug === detailSlug),
    isSuccess: connectorsQuery.isSuccess,
  });
  useEffect(() => {
    if (detail.isMissing) setDetailSlug(null);
  }, [detail.isMissing]);
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: qk.project.connectors(projectId) });

  const { draft, set } = editor;
  return (
    <>
      <EditorSection
        title={tI18nComplete.raw('textc3d2e79ebdd0')}
        description={tI18nComplete.raw('textc174fc077197')}
        trailing={
          <GrantHeaderTrailing
            value={draft.connectors}
            tab="connectors"
            label={tI18nComplete.raw('textd83250185d41')}
          />
        }
      >
        <div className="space-y-2 py-4">
          <GrantCatalog
            value={draft.connectors}
            onChange={(v) => {
              set('connectors', v);
              const required = draft.connectors_required ?? [];
              const kept =
                v === 'all' || v === 'none' || !Array.isArray(v)
                  ? []
                  : required.filter((slug) => v.includes(slug));
              if (kept.length !== required.length) {
                set('connectors_required', kept.length ? kept : undefined);
              }
            }}
            allLabel={tI18nComplete.raw('text35e54cea7f41')}
            isLoading={connectorsQuery.isLoading}
            isError={connectorsQuery.isError}
            onRetry={() => void connectorsQuery.refetch()}
            items={connectors.map((connector) => ({
              id: connector.slug,
              card: {
                leading: <ConnectorAppIcon connector={connector} size="lg" />,
                title: connectorDisplayName(connector),
                description: `${providerLabel(connector.provider)} · ${connector.actions.length} ${
                  connector.actions.length === 1 ? 'action' : 'actions'
                }`,
                badges: <ConnectorStatusBadge connector={connector} />,
                trailing:
                  connectorSetupStatus(connector) === 'connected' ? (
                    <ConnectorConnectedMark />
                  ) : undefined,
              },
              onOpen: () => setDetailSlug(connector.slug),
            }))}
            trailingFor={(slug) => (
              <RequiredConnectorToggle
                active={draft.connectors_required?.includes(slug) === true}
                onToggle={() => {
                  const current = draft.connectors_required ?? [];
                  const next = current.includes(slug)
                    ? current.filter((a) => a !== slug)
                    : [...current, slug];
                  set('connectors_required', next.length ? next : undefined);
                }}
              />
            )}
            empty={
              <EmptyState
                size="sm"
                title={tI18nComplete.raw('text51ae0a7e3783')}
                description={tI18nComplete.raw('text9bf8fe539046')}
              />
            }
          />
          {draft.connectors === 'all' && draft.connectors_required?.length ? (
            <p className="text-muted-foreground text-xs">
              {tI18nComplete.raw('textf39fe0fefce2')}{' '}
              <span className="font-mono">{draft.connectors_required.join(', ')}</span>
              {tI18nComplete.raw('text954401fb96d1')}
            </p>
          ) : null}
        </div>
      </EditorSection>
      <ConnectorModal
        projectId={projectId}
        connector={detail.record}
        canWrite={canWrite}
        open={detail.open}
        isResolving={detail.isResolving}
        onOpenChange={(open) => !open && setDetailSlug(null)}
        onChanged={invalidate}
        onRemoved={() => {
          invalidate();
          setDetailSlug(null);
        }}
      />
    </>
  );
}

// ─── Secrets ─────────────────────────────────────────────────────────────

export function SecretsGrantPage({ projectId, editor }: { projectId: string; editor: AgentDraft }) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const accountId = useProjectAccountId(projectId);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SECRET_WRITE, { accountId }).allowed === true;
  const secretsQuery = useQuery({
    queryKey: qk.project.secrets(projectId),
    queryFn: () => listProjectSecrets(projectId),
    ...contract('config'),
  });
  const rows = buildRows(secretsQuery.data);
  const [dialog, setDialog] = useState<{ open: boolean; row: SecretRow | null }>({
    open: false,
    row: null,
  });
  return (
    <>
      <EditorSection
        title={tI18nComplete.raw('textd8707d411d99')}
        description={tI18nComplete.raw('textbb74cc7dce98')}
        trailing={
          <span className="flex items-center gap-2">
            <GrantHeaderTrailing
              value={editor.draft.secrets}
              tab="secrets"
              label={tI18nComplete.raw('text0b38e3daeb93')}
            />
            {canWrite ? (
              <Button
                variant="secondary"
                size="sm"
                className="gap-1.5"
                onClick={() => setDialog({ open: true, row: null })}
              >
                <PlusIcon className="size-4" />
                {tI18nComplete.raw('text18fdd549b2ed')}
              </Button>
            ) : null}
          </span>
        }
      >
        <div className="py-4">
          <GrantCatalog
            value={editor.draft.secrets}
            onChange={(v) => editor.set('secrets', v)}
            allLabel={tI18nComplete.raw('text86fdc0c950d5')}
            isLoading={secretsQuery.isLoading}
            isError={secretsQuery.isError}
            onRetry={() => void secretsQuery.refetch()}
            items={rows.map((row) => ({
              id: row.identifier,
              card: {
                leading: (
                  <span className="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-md">
                    <KeyIcon className="size-4" />
                  </span>
                ),
                title: <span className="font-mono">{row.identifier}</span>,
                description:
                  row.purpose ?? (row.key !== row.identifier ? `Env var ${row.key}` : null),
                badges: (
                  <>
                    {!row.configured ? (
                      <Badge variant="destructive" size="xs">
                        {tI18nComplete.raw('text4fd0272a5628')}
                      </Badge>
                    ) : null}
                    {row.system ? (
                      <Badge variant="muted" size="xs">
                        {tI18nComplete.raw('text6725e7bbcd28')}
                      </Badge>
                    ) : null}
                  </>
                ),
              },
              onOpen: () => setDialog({ open: true, row }),
            }))}
            empty={
              <EmptyState
                icon={KeyIcon}
                size="sm"
                title={tI18nComplete.raw('text5aa40906d187')}
                description={tI18nComplete.raw('textfc7605717e58')}
                action={
                  canWrite ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setDialog({ open: true, row: null })}
                    >
                      <PlusIcon className="size-4" />
                      {tI18nComplete.raw('text98aa52b34c8f')}
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        </div>
      </EditorSection>
      <ProjectSecretDialog
        projectId={projectId}
        row={dialog.row}
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
      />
    </>
  );
}
