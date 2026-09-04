'use client';

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
  return (
    <GrantModeField
      value={value}
      onChange={onChange}
      allLabel={allLabel}
      noneLabel="Deny — nothing granted."
      alwaysRender
    >
      {({ selected, toggle, mode }) => {
        if (isLoading) return <CatalogGridSkeleton />;
        if (isError) {
          return (
            <ErrorState
              size="sm"
              title="Couldn’t load the catalog"
              action={
                onRetry ? (
                  <Button variant="outline" size="sm" onClick={onRetry}>
                    Retry
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
                  label: `Grant ${item.id}`,
                }}
              />
            ))}
            {orphans.map((id) => (
              <CatalogCard
                key={id}
                title={<span className="font-mono">{id}</span>}
                description="Granted in kortix.yaml, but this project no longer declares it."
                badges={
                  <Badge variant="destructive" size="xs">
                    Missing
                  </Badge>
                }
                select={{
                  checked: true,
                  onCheckedChange: () => toggle(id),
                  disabled: mode !== 'pick',
                  label: `Grant ${id}`,
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
        title="Skills"
        description="Instructions and scripts this agent can load into a session. Click a skill to read it."
        trailing={
          <GrantHeaderTrailing value={editor.draft.skills} tab="skills" label="All skills" />
        }
      >
        <div className="py-4">
          <GrantCatalog
            value={editor.draft.skills}
            onChange={(v) => editor.set('skills', v)}
            allLabel="Every skill in this project, including ones added later."
            items={skills.map((skill) => ({
              id: skill.name,
              card: { title: skill.name, description: skill.description },
              onOpen: () => setSelectedPath(skill.path),
            }))}
            empty={
              <EmptyState
                icon={SparkleIcon}
                size="sm"
                title="No skills yet"
                description="Skills declared in this project appear here for the agent to pick from."
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
        title="Connectors"
        description="Outside services this agent can call. Click one to connect it or manage its accounts; mark one Required and a session will not start until it resolves."
        trailing={
          <GrantHeaderTrailing value={draft.connectors} tab="connectors" label="All connectors" />
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
            allLabel="Every connector in this project, including ones added later."
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
                title="No connectors yet"
                description="Connectors added to this project appear here for the agent to pick from."
              />
            }
          />
          {draft.connectors === 'all' && draft.connectors_required?.length ? (
            <p className="text-muted-foreground text-xs">
              Required before session start:{' '}
              <span className="font-mono">{draft.connectors_required.join(', ')}</span>. Switch to
              Pick to change it.
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
        title="Secrets"
        description="Project secrets handed to this agent's sessions as environment variables. Click one to edit it."
        trailing={
          <span className="flex items-center gap-2">
            <GrantHeaderTrailing value={editor.draft.secrets} tab="secrets" label="All secrets" />
            {canWrite ? (
              <Button
                variant="secondary"
                size="sm"
                className="gap-1.5"
                onClick={() => setDialog({ open: true, row: null })}
              >
                <PlusIcon className="size-4" />
                New
              </Button>
            ) : null}
          </span>
        }
      >
        <div className="py-4">
          <GrantCatalog
            value={editor.draft.secrets}
            onChange={(v) => editor.set('secrets', v)}
            allLabel="Every secret in this project, including ones added later."
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
                        No value
                      </Badge>
                    ) : null}
                    {row.system ? (
                      <Badge variant="muted" size="xs">
                        System
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
                title="No secrets yet"
                description="Secrets added to this project appear here for the agent to pick from."
                action={
                  canWrite ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setDialog({ open: true, row: null })}
                    >
                      <PlusIcon className="size-4" />
                      Add a secret
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
