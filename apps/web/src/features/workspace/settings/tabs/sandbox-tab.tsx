'use client';

/**
 * The Sandbox tab — sandbox template CRUD (list, create, edit, delete,
 * rebuild). **No build log.** Split off `sandbox-view.tsx`'s `SandboxView`,
 * which used to render this content AND the snapshot build log together on
 * one 858-line page (Task 20's brief). The build log, status banner, error
 * categories, and the `isProjectAcceleratorBuild` filter move to
 * `snapshots-tab.tsx` instead — see that file's header comment.
 * `settings-panel.tsx:1127` used to mount the unsplit `SandboxView` on
 * `case 'sandbox'` alone, with `snapshots` stuck on a placeholder
 * (`settings-panel.tsx:997-1003` explains why: mounting `SandboxView` on
 * both tabs would have rendered the build log twice). Both cases are now
 * wired to their own tab; `SandboxView`/`sandbox-view.tsx` is deleted.
 *
 * **What moved here, verbatim, from `sandbox-view.tsx`:** `TemplateRow`
 * (the template list row — build/delete mutations, edit/rebuild actions),
 * `describeState`/`TEMPLATE_STATE_LABEL`/`TEMPLATE_TONE_ICON_TILE` (template
 * status-tile presentation), `TEMPLATE_SKELETON_ROWS`, and the
 * `SandboxTemplateForm` create/edit modal mount.
 * `SandboxTemplateProviderCoverage`/`SandboxTemplateProviderModeBadge`
 * (from `../../customize/sections/view/sandbox-provider-coverage.tsx`) are
 * Sandbox-half symbols per JAY-508 — that module is used only by
 * `TemplateRow`, so it stays in place (not part of the 858-line file being
 * split) and is imported here exactly as `sandbox-view.tsx` imported it.
 *
 * **Gate — preserved exactly.** `canManage` is
 * `projectQuery.data?.effective_project_role === 'manager'`, byte-identical
 * to `sandbox-view.tsx`'s own computation — not re-derived from
 * `useProjectCan` or any other permission source in scope. It gates the
 * header "New template" button, the empty-state action, and every
 * `TemplateRow` edit/delete/rebuild control, matching the original exactly.
 *
 * **`useTranslations('hardcodedUi')` removed.** `sandbox-view.tsx` routed
 * its static English copy through `next-intl`'s `useTranslations` with
 * auto-generated keys (e.g. `...JsxTextNewTemplate62cccf85`) that resolve to
 * plain literals in `translations/en.json` — no other tab in this directory
 * does this (`general-tab.tsx`/`api-keys-tab.tsx` write literals directly),
 * and `useTranslations` needs a `NextIntlClientProvider` ancestor that
 * `renderToStaticMarkup` doesn't provide. That is exactly why nothing in
 * `sandbox-view.tsx` that called it was ever covered by
 * `sandbox-view.test.tsx` — only the translation-free `BuildRow` and
 * `isProjectAcceleratorBuild` were testable. Copy here is the literal text
 * those keys resolved to (checked against `translations/en.json`), inlined
 * directly — matching the house pattern and making `SandboxTabView`
 * testable.
 *
 * **`listProjectSnapshots` — shared endpoint, split rendering.** Both this
 * tab and `snapshots-tab.tsx` call the identical
 * `useQuery({ queryKey: qk.project.snapshots(projectId), queryFn: () =>
 * listProjectSnapshots(projectId) })` — the backend has one endpoint
 * returning `{ templates, builds, status, provider_mode, selected_provider,
 * templates_error }` together; this tab reads only the templates-shaped
 * fields, `snapshots-tab.tsx` only the builds-shaped ones. React Query
 * dedupes by cache key, and `SettingsTabPane` mounts only the active tab's
 * container (`if (!active) return null`), so only one network request
 * happens at a time — same as `sandbox-view.tsx` before the split. Each
 * tab's `refetchInterval` polls only for ITS OWN "still building" signal
 * (this tab: `provider_state`/`provider_coverage` on templates;
 * `snapshots-tab.tsx`: `status` on builds) — a split of the original
 * combined boolean, not a re-derived gate.
 *
 * **The combined "fully empty" empty state is gone by construction.**
 * `sandbox-view.tsx` showed one big `EmptyState` only when BOTH `templates`
 * and `builds` were empty (`isFullyEmpty`), falling back to a plain
 * `InlinePanelEmpty` box when only templates were empty but builds existed.
 * Split across two tabs, "fully empty" can only mean "empty for THIS tab's
 * own domain" — so this tab shows `EmptyState` whenever `templates.length
 * === 0`, independent of whatever `snapshots-tab.tsx` has to show.
 *
 * `SandboxTabView` is the pure, props-only half — `templatesSlot` is a slot
 * because each `TemplateRow` owns its own `useMutation`/`useQueryClient`
 * (build, delete) and can't render under `renderToStaticMarkup` with no
 * `QueryClientProvider`, same reasoning as `general-tab.tsx`'s
 * `generalFieldsSlot`. `SandboxTemplateForm` (create/edit dialog) is NOT
 * rendered inside the pure view either — it owns its own
 * `useMutation`/`useQueryClient` too — it mounts as a sibling in `SandboxTab`
 * instead. `SandboxTab` is the container: every hook only runs once this tab
 * is actually mounted, which `SettingsTabPane` in `settings-panel.tsx`
 * guarantees.
 */

import { type ReactNode, useState } from 'react';

import { SandboxTemplateForm } from '@/components/projects/sandbox-template-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoBanner } from '@/components/ui/info-banner';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { Skeleton } from '@/components/ui/skeleton';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { Plus as PlusIcon } from '@/features/icon/icons/plus';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useProjectManifestVersion } from '@/features/workspace/customize/migrate-to-v2/manifest-version';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';
import {
  type SandboxTemplate,
  buildSandboxTemplate,
  deleteSandboxTemplate,
  getProject,
  listProjectSnapshots,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  ShippingContainerIcon as Container,
  PencilSimpleIcon as Edit3,
  FileCodeIcon as FileCode,
  PackageIcon as Package,
  PlusIcon as Plus,
  ArrowClockwiseIcon as RefreshCw,
  TrashIcon as Trash2,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type SandboxProvider,
  type SandboxProviderMode,
  SandboxTemplateProviderCoverage,
  SandboxTemplateProviderModeBadge,
} from '../../customize/sections/view/sandbox-provider-coverage';

const TEMPLATE_SKELETON_ROWS = [
  'sandbox-template-skeleton-1',
  'sandbox-template-skeleton-2',
  'sandbox-template-skeleton-3',
  'sandbox-template-skeleton-4',
  'sandbox-template-skeleton-5',
] as const;

const TEMPLATE_STATE_LABEL: Record<
  string,
  { label: string; tone: 'ok' | 'busy' | 'fail' | 'idle' }
> = {
  active: { label: 'Ready', tone: 'ok' },
  pulling: { label: 'Pulling', tone: 'busy' },
  building: { label: 'Building', tone: 'busy' },
  removing: { label: 'Removing', tone: 'busy' },
  error: { label: 'Error', tone: 'fail' },
  build_failed: { label: 'Build failed', tone: 'fail' },
  missing: { label: 'Not built yet', tone: 'idle' },
};

const TEMPLATE_TONE_ICON_TILE: Record<'ok' | 'busy' | 'fail' | 'idle', string> = {
  ok: 'bg-kortix-green/10 text-kortix-green',
  busy: 'bg-kortix-yellow/10 text-kortix-yellow',
  fail: 'bg-kortix-red/10 text-kortix-red',
  idle: 'text-muted-foreground border-border',
};

function describeState(state: string): { label: string; tone: 'ok' | 'busy' | 'fail' | 'idle' } {
  return TEMPLATE_STATE_LABEL[state] ?? { label: state || 'Unknown', tone: 'idle' };
}

/** Matches `snapshots-tab.tsx`'s own `formatRelative` (both wrap
 *  `relativeTime`) — needed here for `SandboxTemplateProviderCoverage`'s
 *  `formatObservedAt`, which this tab uses independently of anything build-
 *  or snapshot-log related. */
function formatRelative(input: string | null | undefined): string {
  return relativeTime(input) || '—';
}

function TemplateRow({
  projectId,
  template,
  canManage,
  onEdit,
  providerMode,
  selectedProvider,
}: {
  projectId: string;
  template: SandboxTemplate;
  canManage: boolean;
  onEdit: (tpl: SandboxTemplate) => void;
  providerMode: SandboxProviderMode;
  selectedProvider: SandboxProvider | null;
}) {
  const queryClient = useQueryClient();
  const { version: manifestVersion } = useProjectManifestVersion(projectId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const templateId = template.template_id ?? null;
  const requireTemplateId = () => {
    if (!templateId) throw new Error('Sandbox template id is missing');
    return templateId;
  };
  const buildMut = useMutation({
    mutationFn: () => buildSandboxTemplate(projectId, requireTemplateId()),
    onSuccess: () => {
      successToast(`Rebuild started for "${template.name}"`);
      queryClient.invalidateQueries({ queryKey: qk.project.snapshots(projectId) });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to start build'),
  });
  const deleteMut = useMutation({
    mutationFn: () => deleteSandboxTemplate(projectId, requireTemplateId()),
    onSuccess: () => {
      successToast(`Deleted "${template.name}"`);
      queryClient.invalidateQueries({ queryKey: qk.project.snapshots(projectId) });
      queryClient.invalidateQueries({ queryKey: qk.project.sandboxes(projectId) });
      setConfirmDelete(false);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to delete template'),
  });

  const Icon = template.is_default ? Container : template.has_image ? Package : FileCode;
  const sub = template.is_default
    ? 'Platform default · shared by every project'
    : template.has_image
      ? `Image: ${template.image}`
      : `Dockerfile: ${template.dockerfile_path}`;
  const sourceTag =
    template.source === 'platform'
      ? 'platform'
      : template.source === 'ui'
        ? 'UI'
        : manifestVersion === 2
          ? 'kortix.yaml'
          : 'kortix.toml';
  const stateInfo = describeState(template.provider_state || template.daytona_state);

  return (
    <>
      <li className="bg-popover flex flex-wrap items-center gap-4 overflow-hidden px-4 py-3 text-sm">
        <div
          className={cn(
            'inline-flex size-11 shrink-0 items-center justify-center rounded-sm border',
            TEMPLATE_TONE_ICON_TILE[stateInfo.tone],
          )}
        >
          <Icon className="size-6 shrink-0" />
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{template.name}</span>
            <Badge variant="secondary" size="sm">
              {template.slug}
            </Badge>
          </div>
          {/* `tabular-nums`: vCPU / GiB / GiB-disk are three numbers repeated down
              every template row, so proportional digits make the columns wander
              between rows. Matches `snapshots-tab.tsx`, the other half of this
              split, which already pins its timestamps the same way. */}
          <div className="text-muted-foreground truncate text-xs tabular-nums">
            {sub} &bull; {template.cpu} vCPU &bull; {template.memory_gb} GiB &bull;{' '}
            {template.disk_gb} GiB disk &bull; {sourceTag}
          </div>
          <SandboxTemplateProviderCoverage
            providerMode={providerMode}
            coverage={template.provider_coverage}
            selectedProvider={selectedProvider}
            formatObservedAt={formatRelative}
          />
        </div>
        <SandboxTemplateProviderModeBadge
          providerMode={providerMode}
          coverage={template.provider_coverage}
          selectedProvider={selectedProvider}
        />
        {canManage && (
          <div className="flex items-center gap-1">
            {templateId && !template.is_default && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="size-7 p-0"
                  onClick={() => onEdit(template)}
                  aria-label="Edit template"
                >
                  <Edit3 className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive size-7 p-0"
                  disabled={deleteMut.isPending}
                  onClick={() => setConfirmDelete(true)}
                  aria-label="Delete template"
                >
                  {deleteMut.isPending ? (
                    <Loading className="size-3.5 shrink-0" />
                  ) : (
                    <Trash2 className="size-3.5 shrink-0" />
                  )}
                </Button>
              </>
            )}
            {templateId && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={buildMut.isPending}
                onClick={() => buildMut.mutate()}
              >
                {buildMut.isPending ? (
                  <Loading className="size-3.5 shrink-0" />
                ) : (
                  <RefreshCw className="size-3.5 shrink-0" />
                )}
                Rebuild
              </Button>
            )}
          </div>
        )}
      </li>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete sandbox template "${template.name}"?`}
        description="This removes the template from the project. Sessions already using it are unaffected."
        confirmLabel="Delete"
        confirmVariant="destructive"
        isPending={deleteMut.isPending}
        onConfirm={() => deleteMut.mutate()}
      />
    </>
  );
}

export interface SandboxTabViewProps {
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  /** "New template" button next to the section header — manager-only, built
   *  by the container from the same `canManage` gate as everything else in
   *  this tab. `undefined` (not rendered) for a non-manager. */
  headerAction?: ReactNode;
  /** `1 | 2 | null` — drives whether the manifest hint below reads
   *  `kortix.toml` or `kortix.yaml`. `null`/anything else falls back to
   *  `kortix.toml`, matching `sandbox-view.tsx`'s own ternary default. */
  manifestVersion?: number | null;
  /** `data.templates_error` from `listProjectSnapshots` — a partial-read
   *  warning, not a hard error (the hard-error path is `isError` above). */
  templatesError?: string | null;
  /** `templates.length === 0` — this tab's own empty state, scoped to its
   *  own domain now that the split removed the old combined
   *  "templates AND builds both empty" check. See this file's header
   *  comment. */
  isEmpty?: boolean;
  emptyAction?: ReactNode;
  /** The `<ul>` of `TemplateRow`s, built by the container — see this file's
   *  header comment for why it's a slot. */
  templatesSlot?: ReactNode;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `SandboxTab` so this renders under
 *  `renderToStaticMarkup` with no `QueryClientProvider` — see
 *  `GeneralTabView` for the same split. */
export function SandboxTabView({
  isLoading = false,
  isError = false,
  errorMessage = '',
  onRetry = () => {},
  headerAction,
  manifestVersion = null,
  templatesError = null,
  isEmpty = true,
  emptyAction,
  templatesSlot,
}: SandboxTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <div className="space-y-8">
        <SettingsSectionHeader
          title="Sandbox templates"
          description="Manage sandbox templates and image builds."
          action={headerAction}
        />
        {isLoading ? (
          <div className="space-y-1">
            {TEMPLATE_SKELETON_ROWS.map((row) => (
              <Skeleton key={row} className="h-10 rounded-md" />
            ))}
          </div>
        ) : isError ? (
          <ErrorState
            size="sm"
            title="Failed to load sandbox templates:"
            description={errorMessage}
            action={
              <Button variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            }
          />
        ) : (
          <>
            <p className="text-muted-foreground text-sm text-balance">
              Sessions boot from a sandbox template. The platform default is shared by every
              project and clones your repo into <code className="font-mono">/workspace</code> at
              boot. Add your own templates here or via{' '}
              {manifestVersion === 2 ? (
                <>
                  <code className="font-mono">sandbox.templates</code> in{' '}
                  <code className="font-mono">kortix.yaml</code>
                </>
              ) : (
                <>
                  <code className="font-mono">[[sandbox.templates]]</code> in{' '}
                  <code className="font-mono">kortix.toml</code>
                </>
              )}
              .
            </p>

            {templatesError ? (
              <InfoBanner tone="warning">
                Couldn’t read project sandbox config: {templatesError}
              </InfoBanner>
            ) : null}

            {isEmpty ? (
              <EmptyState
                icon={Container}
                size="sm"
                title="No templates resolved yet."
                description="Create one, or add it to your project's manifest."
                action={emptyAction}
              />
            ) : (
              <div className="border-border divide-border divide-y overflow-hidden rounded-md border">
                {templatesSlot}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Container: owns every hook (project + snapshots queries, the template
 *  form's open/edit state) and renders `SandboxTabView` with real data +
 *  the templates slot, plus `SandboxTemplateForm` as a sibling (it owns its
 *  own mutations — see this file's header comment). Only ever mounted while
 *  this tab is active (`SettingsTabPane` in `settings-panel.tsx` returns
 *  `null` otherwise), so nothing here fetches on panel open. */
export function SandboxTab({ projectId }: { projectId: string }) {
  const projectQuery = useQuery({
    queryKey: qk.project.summary(projectId),
    queryFn: () => getProject(projectId),
    ...contract('config'),
  });
  // Byte-identical to `sandbox-view.tsx`'s own gate — see this file's header
  // comment, "Gate — preserved exactly".
  const canManage = projectQuery.data?.effective_project_role === 'manager';
  const { version: manifestVersion } = useProjectManifestVersion(projectId);

  const snapshotsQuery = useQuery({
    queryKey: qk.project.snapshots(projectId),
    queryFn: () => listProjectSnapshots(projectId),
    ...contract('config'),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const templates = Array.isArray(data.templates) ? data.templates : [];
      const anyBuilding =
        templates.some((t) => t.provider_state === 'building') ||
        templates.some((t) =>
          t.provider_coverage?.some((provider) => provider.status === 'building'),
        );
      return anyBuilding ? 5_000 : false;
    },
  });

  const [formOpen, setFormOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<SandboxTemplate | null>(null);

  const data = snapshotsQuery.data;
  const templates = Array.isArray(data?.templates) ? data.templates : [];
  const providerMode: SandboxProviderMode =
    data?.provider_mode === 'pinned' ? 'pinned' : 'automatic';
  const selectedProvider = data?.selected_provider ?? null;

  const openNewForm = () => {
    setEditingTemplate(null);
    setFormOpen(true);
  };
  const openEditForm = (tpl: SandboxTemplate) => {
    setEditingTemplate(tpl);
    setFormOpen(true);
  };

  // Same quirk as `sandbox-view.tsx`: this button does NOT reset
  // `editingTemplate` (only `openNewForm`, used by the header action, does)
  // — preserved as-is, not in scope to fix.
  const newTemplateAction = canManage ? (
    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setFormOpen(true)}>
      <Plus className="size-3.5 shrink-0" />
      New template
    </Button>
  ) : undefined;

  return (
    <>
      <SandboxTabView
        isLoading={snapshotsQuery.isLoading}
        isError={snapshotsQuery.isError}
        errorMessage={(snapshotsQuery.error as Error)?.message ?? ''}
        onRetry={() => snapshotsQuery.refetch()}
        headerAction={
          canManage ? (
            <Button size="sm" variant="secondary" className="gap-1.5" onClick={openNewForm}>
              <PlusIcon className="size-4 shrink-0" />
              New template
            </Button>
          ) : undefined
        }
        manifestVersion={manifestVersion}
        templatesError={data?.templates_error ?? null}
        isEmpty={templates.length === 0}
        emptyAction={newTemplateAction}
        templatesSlot={
          templates.length === 0 ? undefined : (
            <ul>
              {templates.map((t) => (
                <TemplateRow
                  key={t.template_id ?? `tpl-${t.slug}`}
                  projectId={projectId}
                  template={t}
                  canManage={canManage}
                  onEdit={openEditForm}
                  providerMode={providerMode}
                  selectedProvider={selectedProvider}
                />
              ))}
            </ul>
          )
        }
      />
      <SandboxTemplateForm
        projectId={projectId}
        open={formOpen}
        onOpenChange={setFormOpen}
        template={editingTemplate}
      />
    </>
  );
}
