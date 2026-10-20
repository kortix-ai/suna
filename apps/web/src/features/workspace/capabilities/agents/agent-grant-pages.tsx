'use client';

import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
/**
 * The agent editor's Access pages — Skills, Connectors, Secrets, Apps. Each
 * opens the SAME modal as the project-wide tab of the same name:
 * `EntityDetailModal` for a skill, `ConnectorModal` for a connector,
 * `ProjectSecretDialog` for a secret.
 *
 * Layout is the Settings page's: the pane title, one All · Pick · None row
 * (`grant-mode-field.tsx`), then the catalog as one bordered list. The list
 * stays on screen in every mode, so a person can still open any entry.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { connectorDisplayName } from '@/features/workspace/capabilities/connectors/connector-filter';
import {
  ConnectorAppIcon,
  ConnectorStatusBadge,
} from '@/features/workspace/capabilities/connectors/connector-identity';
import { ConnectorModal } from '@/features/workspace/capabilities/connectors/detail/connector-modal';
import { providerLabel } from '@/features/workspace/capabilities/connectors/provider-label';
import { detailSelection } from '@/features/workspace/capabilities/shared/detail-selection';
import { EntityDetailModal } from '@/features/workspace/capabilities/shared/entity/entity-modal';
import type { AgentDraft } from '@/features/workspace/customize/sections/view/agent-editor';
import {
  ManageButton,
  RequiredConnectorToggle,
} from '@/features/workspace/customize/sections/view/agent-editor-access-fields';
import {
  EditorList,
  EditorSection,
} from '@/features/workspace/customize/sections/view/agent-editor-primitives';
import {
  type GrantMode,
  GrantModeField,
} from '@/features/workspace/customize/sections/view/grant-mode-field';
import {
  buildRows,
  ProjectSecretDialog,
  type SecretRow,
} from '@/features/workspace/customize/sections/view/secrets-view';
import { toArray } from '@/features/workspace/customize/shared/utils';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { cn } from '@/lib/utils';
import { useProjectCan } from '@/lib/use-project-can';
import {
  type AgentGrantSetV2,
  listConnectors,
  listProjectSecrets,
  type ProjectConfigSummary,
} from '@kortix/sdk';
import {
  contract,
  qk,
  useProjectAccountId,
  useProjectApps,
} from '@kortix/sdk/react';
import { PlusIcon } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { appGrantRows } from './agent-apps-grant';

// ─── The shared catalog ──────────────────────────────────────────────────

interface GrantCatalogItem {
  id: string;
  /** A real logo only (a connector's app icon). A glyph that repeats on every
   *  row names nothing, so skills, secrets and Apps pass none. */
  leading?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Exceptions only, as `Badge`s at the row's right edge: Needs setup, Not
   *  set. The normal state carries no mark. */
  status?: ReactNode;
  onOpen?: () => void;
}

/**
 * All · Pick · None over the project's catalog, as one bordered list. The
 * checkbox exists only in Pick mode, where it is the control; in All and
 * None the mode row above already answers for every row. A granted id the
 * catalog no longer has still renders, flagged, so a stale grant is visible
 * rather than silently dropped.
 */
function GrantCatalog({
  value,
  onChange,
  items,
  isLoading,
  isError,
  onRetry,
  empty,
  trailingFor,
}: {
  value: AgentGrantSetV2 | undefined;
  onChange: (v: AgentGrantSetV2) => void;
  items: GrantCatalogItem[];
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  empty: ReactNode;
  /** A control beside a GRANTED row in Pick mode — the connectors page's
   *  Required toggle. */
  trailingFor?: (id: string) => ReactNode;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <GrantModeField
      value={value}
      onChange={onChange}
      alwaysRender
    >
      {({ selected, toggle, mode }) => {
        if (isLoading) {
          return (
            <EditorList>
              {[0, 1, 2].map((i) => (
                <li key={i} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton className="h-4 w-40 rounded-sm" />
                </li>
              ))}
            </EditorList>
          );
        }
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
        const orphans: GrantCatalogItem[] = [...selected]
          .filter((id) => !known.has(id))
          .map((id) => ({
            id,
            title: <span className="font-mono">{id}</span>,
            description: tI18nComplete.raw('textfecc36d012be'),
            status: (
              <Badge variant="destructive" size="xs">
                {tI18nComplete.raw('text6be36ca49ee8')}
              </Badge>
            ),
          }));
        if (items.length === 0 && orphans.length === 0) return <>{empty}</>;
        return (
          <EditorList>
            {[...items, ...orphans].map((item) => (
              <GrantRow
                key={item.id}
                item={item}
                mode={mode}
                checked={selected.has(item.id)}
                onToggle={() => toggle(item.id)}
                checkLabel={tI18nComplete('textd4170e74c3b0', { value0: item.id })}
                trailing={mode === 'pick' && selected.has(item.id) ? trailingFor?.(item.id) : null}
              />
            ))}
          </EditorList>
        );
      }}
    </GrantModeField>
  );
}

/**
 * One catalog row. The checkbox and the body are two sibling controls, never
 * one nested in the other: the checkbox grants, the body opens the entity.
 */
function GrantRow({
  item,
  mode,
  checked,
  onToggle,
  checkLabel,
  trailing,
}: {
  item: GrantCatalogItem;
  mode: GrantMode;
  checked: boolean;
  onToggle: () => void;
  checkLabel: string;
  trailing?: ReactNode;
}) {
  const body = (
    <>
      {item.leading}
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium">{item.title}</span>
        {item.description ? (
          <span className="text-muted-foreground block truncate text-xs">{item.description}</span>
        ) : null}
      </span>
    </>
  );
  return (
    <li
      className={cn(
        'flex min-h-13 items-center gap-3 px-4 py-2 transition-colors duration-fast',
        item.onOpen && 'hover:bg-hover',
        mode === 'none' && 'opacity-60',
      )}
    >
      {mode === 'pick' ? (
        <Checkbox variant="black" checked={checked} onCheckedChange={onToggle} aria-label={checkLabel} />
      ) : null}
      {item.onOpen ? (
        <button
          type="button"
          onClick={item.onOpen}
          className="focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none"
        >
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-3">{body}</span>
      )}
      {item.status || trailing ? (
        <span className="flex shrink-0 items-center gap-2">
          {item.status}
          {trailing}
        </span>
      ) : null}
    </li>
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
        trailing={<ManageButton tab="skills" />}
        lead
        bare
      >
          <GrantCatalog
            value={editor.draft.skills}
            onChange={(v) => editor.set('skills', v)}
            items={skills.map((skill) => ({
              id: skill.name,
              title: skill.name,
              description: skill.description,
              onOpen: () => setSelectedPath(skill.path),
            }))}
            empty={
              <EmptyState
                size="sm"
                title={tI18nComplete.raw('text32ae9b80f832')}
                description={tI18nComplete.raw('text62d220bbfcc8')}
              />
            }
          />
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
    queryFn: () => listConnectors(projectId, { includeSchemas: false }),
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
        trailing={<ManageButton tab="connectors" />}
        lead
        bare
      >
        <div className="space-y-3">
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
            isLoading={connectorsQuery.isLoading}
            isError={connectorsQuery.isError}
            onRetry={() => void connectorsQuery.refetch()}
            items={connectors.map((connector) => ({
              id: connector.slug,
              leading: <ConnectorAppIcon connector={connector} size="sm" />,
              title: connectorDisplayName(connector),
              description: `${providerLabel(connector.provider)} · ${connector.actions.length} ${
                connector.actions.length === 1 ? 'action' : 'actions'
              }`,
              status: <ConnectorStatusBadge connector={connector} />,
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
          canWrite ? (
            <Button
              variant="secondary"
              size="sm"
              className="gap-1.5"
              onClick={() => setDialog({ open: true, row: null })}
            >
              <PlusIcon className="size-4" />
              {tI18nComplete.raw('text18fdd549b2ed')}
            </Button>
          ) : undefined
        }
        lead
        bare
      >
          <GrantCatalog
            value={editor.draft.secrets}
            onChange={(v) => editor.set('secrets', v)}
            isLoading={secretsQuery.isLoading}
            isError={secretsQuery.isError}
            onRetry={() => void secretsQuery.refetch()}
            items={rows.map((row) => ({
              id: row.identifier,
              title: <span className="font-mono">{row.identifier}</span>,
              description:
                row.purpose ?? (row.key !== row.identifier ? `Env var ${row.key}` : null),
              status:
                !row.configured || row.system ? (
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
                ) : undefined,
              onOpen: () => setDialog({ open: true, row }),
            }))}
            empty={
              <EmptyState
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

// ─── Apps ────────────────────────────────────────────────────────────────

/**
 * Which Kortix Apps this agent may open — `agents.<name>.apps` in
 * kortix.yaml, the same All · Pick · None machine as Connectors and the same
 * cards.
 *
 * The grant decides admission for a `restricted` or `private` App only. A
 * `project` App admits any agent that holds `project.app.read`, a `public` App
 * admits everyone, and a `password` App admits no agent at all — so a row for
 * one of those is still grantable (its mode can change) but is flagged as not
 * currently load-bearing.
 *
 * Enforcement is the App gate (`agentAppAccessDecision`, apps/api/src/apps/
 * access.ts).
 */
export function AppsGrantPage({ projectId, editor }: { projectId: string; editor: AgentDraft }) {
  const t = useI18nTranslations('agentApps');
  const appsQuery = useProjectApps(projectId);
  const rows = appGrantRows(appsQuery.data);
  return (
    <EditorSection
      title={t('title')}
      description={t('description')}
      trailing={<ManageButton href={(id) => `/projects/${id}/apps`} />}
      lead
      bare
    >
      <div className="space-y-3" data-testid="agent-apps-grant">
        <GrantCatalog
          value={editor.draft.apps}
          onChange={(v) => editor.set('apps', v)}
          isLoading={appsQuery.isLoading}
          isError={appsQuery.isError}
          onRetry={() => void appsQuery.refetch()}
          items={rows.map((row) => ({
            id: row.id,
            title: <span className="font-mono">{row.id}</span>,
            description: row.name === row.id ? null : row.name,
            // The grant decides admission for a restricted or private App, the
            // normal case. Only an App that admits agents without it is flagged.
            status: row.needsGrant ? undefined : (
              <Badge variant="muted" size="xs">
                {t('openWithoutGrant')}
              </Badge>
            ),
          }))}
          empty={
            <EmptyState
              size="sm"
              title={t('emptyTitle')}
              description={t('emptyDescription')}
            />
          }
        />
      </div>
    </EditorSection>
  );
}
