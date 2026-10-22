'use client';

import { LONG_AGO, relativeTime } from '../../../internal/lib/relative-time';
import { FactCell } from './fact-cell';

import { type ReactNode, useState } from 'react';

import { SandboxTemplateForm } from './sandbox-template-form';
import { Badge } from '../../../primitives/badge';
import { Button } from '../../../primitives/button';
import { ConfirmDialog } from '../../../primitives/confirm-dialog';
import Hint from '../../../primitives/hint';
import { InfoBanner } from '../../../primitives/info-banner';
import Loading from '../../../primitives/loading';
import { Skeleton } from '../../../primitives/skeleton';
import { errorToast, successToast } from '../../../primitives/toast';
import { EmptyState } from '../../../primitives/empty-state';
import { ErrorState } from '../../../primitives/error-state';
import {
  manifestFilename,
  useProjectManifestVersion,
} from '../../../internal/lib/manifest-version';
import type { UiTranslator } from '../../../i18n';
import { useLocale, useTranslations } from '../../../i18n';
import { PROJECT_ACTIONS } from '../../../internal/lib/project-actions';
import { useProjectCans } from '../../../internal/lib/use-project-can';
import { cn } from '../../../internal/lib/utils';
import {
  type SandboxTemplate,
  buildSandboxTemplate,
  deleteSandboxTemplate,
  listProjectSnapshots,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  CpuIcon,
  CubeIcon,
  FileCodeIcon,
  HardDrivesIcon,
  MemoryIcon,
  PackageIcon,
  PencilSimpleIcon,
  type Icon as PhosphorIcon,
  PlusIcon,
  ShippingContainerIcon,
  SquaresFourIcon,
  TrashIcon,
  XCircleIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  SandboxProviderBadge,
  availableProviderCoverage,
  latestObservedAt,
} from '../../sections/view/sandbox-provider-coverage';
import { SettingsTabHeader } from '../settings-tab-header';
import { snapshotsQueryRetry } from './snapshots-query';

/** The one leaf this tab gates on: template create, edit, delete and rebuild. */
const SANDBOX_TAB_ACTIONS = [PROJECT_ACTIONS.PROJECT_SANDBOX_WRITE] as const;

/** Three, not five: each skeleton is now a full card, so five of them
 *  overflowed the panel and read as a wall of grey. */
const TEMPLATE_SKELETON_ROWS = [
  'sandbox-template-skeleton-1',
  'sandbox-template-skeleton-2',
  'sandbox-template-skeleton-3',
] as const;

type TemplateTone = 'ok' | 'busy' | 'fail' | 'idle';

const TEMPLATE_STATE_LABEL: Record<string, { label: string; tone: TemplateTone }> = {
  active: { label: 'Ready', tone: 'ok' },
  pulling: { label: 'Pulling', tone: 'busy' },
  building: { label: 'Building', tone: 'busy' },
  removing: { label: 'Removing', tone: 'busy' },
  error: { label: 'Error', tone: 'fail' },
  build_failed: { label: 'Build failed', tone: 'fail' },
  missing: { label: 'Not built yet', tone: 'idle' },
};

const TEMPLATE_TONE_TEXT: Record<TemplateTone, string> = {
  ok: 'text-kortix-green',
  busy: 'text-kortix-yellow',
  fail: 'text-kortix-red',
  idle: 'text-muted-foreground',
};

/** Exported for test only — `TemplateCard` itself owns mutations and cannot
 *  render under `renderToStaticMarkup`, so the presentation decisions are
 *  pulled out as pure functions that can be asserted directly. */
export function describeState(
  state: string,
  labels: Partial<Record<string, string>> = {},
): { label: string; tone: TemplateTone } {
  const fallback = TEMPLATE_STATE_LABEL[state] ?? { label: state || 'Unknown', tone: 'idle' };
  return {
    ...fallback,
    label: labels[state] ?? (state ? fallback.label : (labels.unknown ?? 'Unknown')),
  };
}

/** Where the template is declared, in words a reader who has never opened the
 *  repo can act on. Replaces the raw `platform` / `UI` / `kortix.yaml` tag
 *  that used to sit last in the bullet-separated meta line. */
export function describeSource(
  template: SandboxTemplate,
  manifestVersion: number | null,
  labels: { platform?: string; dashboard?: string } = {},
): { label: string; icon: PhosphorIcon; mono: boolean } {
  if (template.source === 'platform')
    return {
      label: labels.platform ?? 'Kortix platform',
      icon: ShippingContainerIcon,
      mono: false,
    };
  if (template.source === 'ui')
    return { label: labels.dashboard ?? 'This dashboard', icon: SquaresFourIcon, mono: false };
  return {
    label: manifestFilename(manifestVersion),
    icon: FileCodeIcon,
    mono: true,
  };
}

/** What the sandbox is built from. The old row folded this into a `sub` string
 *  whose `is_default` branch hid the image entirely; the default's "shared by
 *  every project" note is now a `Default` badge in the card header instead, so
 *  this cell can always state the real base. */
export function describeBase(
  template: SandboxTemplate,
  labels: { baseImage?: string; builtFrom?: string; kortixDefault?: string } = {},
): {
  label: string;
  value: string;
  icon: PhosphorIcon;
  mono: boolean;
} {
  if (template.has_image && template.image)
    return {
      label: labels.baseImage ?? 'Base image',
      value: template.image,
      icon: PackageIcon,
      mono: true,
    };
  if (template.has_dockerfile && template.dockerfile_path)
    return {
      label: labels.builtFrom ?? 'Built from',
      value: template.dockerfile_path,
      icon: FileCodeIcon,
      mono: true,
    };
  return {
    label: labels.baseImage ?? 'Base image',
    value: labels.kortixDefault ?? 'Kortix default',
    icon: CubeIcon,
    mono: false,
  };
}

/** Locale-aware age for the runtime footer's "Checked …" stamp. */

export function TemplateStateLine({ tone, label }: { tone: TemplateTone; label: string }) {
  const toneClass = TEMPLATE_TONE_TEXT[tone];

  return (
    <span className={cn('flex items-center gap-1.5 text-xs font-medium', toneClass)}>
      {tone === 'busy' ? (
        <Loading variant="spokes" className={cn('size-3.5 shrink-0', toneClass)} />
      ) : tone === 'ok' ? (
        <CheckCircleIcon weight="fill" className="size-3.5 shrink-0" />
      ) : tone === 'fail' ? (
        <XCircleIcon weight="fill" className="size-3.5 shrink-0" />
      ) : (
        <CircleDashedIcon className="size-3.5 shrink-0" />
      )}
      {label}
    </span>
  );
}

export function TemplateRuntimeFooter({
  coverage,
  formatObservedAt,
  runtimeLabel,
  checkedLabel,
  badgeCopy,
}: {
  coverage: SandboxTemplate['provider_coverage'] | null | undefined;
  formatObservedAt: (observedAt: string) => string;
  runtimeLabel: string;
  checkedLabel: (value: string) => string;
  badgeCopy?: import('../../sections/view/sandbox-provider-coverage').SandboxProviderBadgeCopy;
}) {
  const available = availableProviderCoverage(coverage);
  if (available.length === 0) return null;

  const observedAt = latestObservedAt(coverage);

  return (
    <div className="border-border/60 bg-muted/25 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t px-4 py-2.5">
      <span className="text-muted-foreground shrink-0 text-xs">{runtimeLabel}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {available.map((item) => (
          <SandboxProviderBadge key={item.provider} item={item} copy={badgeCopy} />
        ))}
      </div>
      {observedAt ? (
        <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
          {checkedLabel(formatObservedAt(observedAt))}
        </span>
      ) : null}
    </div>
  );
}

function TemplateCard({
  projectId,
  template,
  canManage,
  onEdit,
}: {
  projectId: string;
  template: SandboxTemplate;
  canManage: boolean;
  onEdit: (tpl: SandboxTemplate) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('settings.sandbox');
  const locale = useLocale();
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
      successToast(tI18nComplete('texte3f97a8573b6', { name: template.name }));
      queryClient.invalidateQueries({ queryKey: qk.project.snapshots(projectId) });
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete('text527ee9c936d3')),
  });
  const deleteMut = useMutation({
    mutationFn: () => deleteSandboxTemplate(projectId, requireTemplateId()),
    onSuccess: () => {
      successToast(tI18nComplete('texta963ed79b37d', { name: template.name }));
      queryClient.invalidateQueries({ queryKey: qk.project.snapshots(projectId) });
      queryClient.invalidateQueries({ queryKey: qk.project.sandboxes(projectId) });
      setConfirmDelete(false);
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete('texta422c2e168e4')),
  });

  const stateInfo = describeState(template.provider_state || template.daytona_state, {
    active: t('states.ready'),
    pulling: t('states.pulling'),
    building: t('states.building'),
    removing: t('states.removing'),
    error: t('states.error'),
    build_failed: t('states.buildFailed'),
    missing: t('states.notBuilt'),
    unknown: t('states.unknown'),
  });
  const source = describeSource(template, manifestVersion, {
    platform: t('sources.platform'),
    dashboard: t('sources.dashboard'),
  });
  const base = describeBase(template, {
    baseImage: t('facts.baseImage'),
    builtFrom: t('facts.builtFrom'),
    kortixDefault: t('facts.kortixDefault'),
  });

  return (
    <>
      <li className="bg-popover overflow-hidden rounded-md border">
        {/* One left edge for the whole card. The header used to lead with a
            `size-9` tile, which pushed the name and status to x=64px while the
            spec grid below started at x=16px — two competing left edges inside
            one card. The status glyph in `TemplateStateLine` carries the tone
            colour the tile used to, so nothing is lost by dropping it, and the
            template kind is stated far more precisely by the "Base image" /
            "Built from" cell than by a decorative glyph. */}
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 pb-3.5">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-foreground truncate text-sm font-medium">{template.name}</span>
              <Badge variant="secondary" size="sm">
                {template.slug}
              </Badge>
              {template.is_default ? (
                <Badge variant="muted" size="sm">
                  {t('defaultBadge')}
                </Badge>
              ) : null}
            </div>
            <TemplateStateLine tone={stateInfo.tone} label={stateInfo.label} />
          </div>
          {canManage && (
            <div className="flex items-center gap-1">
              {templateId && !template.is_default && (
                <>
                  <Hint label={t('actions.edit')} side="top">
                    <Button
                      size="icon-base"
                      variant="ghost"
                      className="transition-transform active:scale-[0.96]"
                      onClick={() => onEdit(template)}
                      aria-label={t('actions.edit')}
                    >
                      <PencilSimpleIcon className="size-3.5 shrink-0" />
                    </Button>
                  </Hint>
                  <Hint label={t('actions.delete')} side="top">
                    <Button
                      size="icon-base"
                      variant="ghost"
                      className="text-destructive hover:text-destructive transition-transform active:scale-[0.96]"
                      disabled={deleteMut.isPending}
                      onClick={() => setConfirmDelete(true)}
                      aria-label={t('actions.delete')}
                    >
                      {deleteMut.isPending ? (
                        <Loading className="size-3.5 shrink-0" />
                      ) : (
                        <TrashIcon className="size-3.5 shrink-0" />
                      )}
                    </Button>
                  </Hint>
                </>
              )}
              {templateId && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 transition-transform active:scale-[0.96]"
                  disabled={buildMut.isPending}
                  onClick={() => buildMut.mutate()}
                >
                  {buildMut.isPending ? (
                    <Loading className="size-3.5 shrink-0" />
                  ) : (
                    <ArrowClockwiseIcon className="size-3.5 shrink-0" />
                  )}
                  {t('actions.rebuild')}
                </Button>
              )}
            </div>
          )}
        </div>

        {/* FIVE cells, every one exactly one track wide and no spans: the
            machine size on row 1, where the image comes from on row 2. The
            sixth "Routing" cell left with the provider pin: every sandbox runs
            on Platinum. The base-image cell used to take `col-span-2`, which
            left row 2 as one narrow beside one double-wide: a uniform track
            carrying ragged content. Long image refs truncate inside their own
            cell (full string on the native `title`) instead of widening it.

            `tabular-nums` on the whole list: vCPU / GiB / GiB-disk are the same
            three numbers repeated down every card, so proportional digits make
            the columns wander between cards. Matches `snapshots-tab.tsx`, the
            other half of this split, which pins its timestamps the same way. */}
        <dl className="border-border/60 grid grid-cols-2 gap-x-4 gap-y-4 border-t px-4 py-4 tabular-nums sm:grid-cols-3">
          <FactCell icon={CpuIcon} label={t('facts.processor')} value={`${template.cpu} vCPU`} />
          <FactCell
            icon={MemoryIcon}
            label={t('facts.memory')}
            value={`${template.memory_gb} GiB`}
          />
          <FactCell
            icon={HardDrivesIcon}
            label={t('facts.storage')}
            value={`${template.disk_gb} GiB`}
          />
          <FactCell icon={base.icon} label={base.label} value={base.value} mono={base.mono} />
          <FactCell
            icon={source.icon}
            label={t('facts.definedIn')}
            value={source.label}
            mono={source.mono}
          />
        </dl>

        <TemplateRuntimeFooter
          coverage={template.provider_coverage}
          runtimeLabel={t('runtime')}
          checkedLabel={(value) => t('checked', { value })}
          formatObservedAt={(observedAt) => relativeTime(observedAt, locale, Date.now(), LONG_AGO)}
          badgeCopy={{
            states: {
              ready: t('coverage.ready'),
              building: t('coverage.building'),
              failed: t('coverage.failed'),
              not_built: t('coverage.notReady'),
              unavailable: t('coverage.unavailable'),
              unknown: t('states.unknown'),
            },
          }}
        />
      </li>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('deleteDialog.title', { name: template.name })}
        description={t('deleteDialog.description')}
        confirmLabel={t('deleteDialog.confirm')}
        confirmVariant="destructive"
        isPending={deleteMut.isPending}
        onConfirm={() => deleteMut.mutate()}
      />
    </>
  );
}

const TEMPLATE_SKELETON_HEIGHT = 'h-60';

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
  /** The `<ul>` of `TemplateCard`s, built by the container — see this file's
   *  header comment for why it's a slot. */
  templatesSlot?: ReactNode;
  copy?: {
    loadFailed: string;
    retry: string;
    descriptionStart: string;
    descriptionEnd: string;
    configReadFailed: string;
    emptyTitle: string;
    emptyDescription: string;
  };
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
  copy: copyOverride,
}: SandboxTabViewProps) {
  const t = useTranslations('settings.sandbox');
  const copy = copyOverride ?? {
    loadFailed: t('loadFailed'),
    retry: t('retry'),
    descriptionStart: t('descriptionStart'),
    descriptionEnd: t('descriptionEnd'),
    configReadFailed: t('configReadFailed'),
    emptyTitle: t('emptyTitle'),
    emptyDescription: t('emptyDescription'),
  };
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <div className="space-y-8">
        <SettingsTabHeader tab="sandbox" action={headerAction} />
        {isLoading ? (
          <div className="space-y-2">
            {TEMPLATE_SKELETON_ROWS.map((row) => (
              <Skeleton key={row} className={cn(TEMPLATE_SKELETON_HEIGHT, 'rounded-md')} />
            ))}
          </div>
        ) : isError ? (
          <ErrorState
            size="sm"
            title={copy.loadFailed}
            description={errorMessage}
            action={
              <Button variant="outline" size="sm" onClick={onRetry}>
                {copy.retry}
              </Button>
            }
          />
        ) : (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm text-pretty">
              {copy.descriptionStart} <code className="font-mono">/workspace</code>.{' '}
              {copy.descriptionEnd}{' '}
              {manifestFilename(manifestVersion) === 'kortix.yaml' ? (
                <>
                  <code className="font-mono">sandbox.templates</code>{' '}
                  {tI18nComplete.raw('text582967534d0f')}{' '}
                  <code className="font-mono">kortix.yaml</code>
                </>
              ) : (
                <>
                  <code className="font-mono">[[sandbox.templates]]</code>{' '}
                  {tI18nComplete.raw('text582967534d0f')}{' '}
                  <code className="font-mono">kortix.toml</code>
                </>
              )}
              .
            </p>

            {templatesError ? (
              <InfoBanner tone="warning">
                {copy.configReadFailed} {templatesError}
              </InfoBanner>
            ) : null}

            {isEmpty ? (
              <EmptyState
                icon={ShippingContainerIcon}
                size="sm"
                title={copy.emptyTitle}
                description={copy.emptyDescription}
                action={emptyAction}
              />
            ) : (
              templatesSlot
            )}
          </div>
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
  const t = useTranslations('settings.sandbox');
  const caps = useProjectCans(projectId, SANDBOX_TAB_ACTIONS);
  const canManage = caps[PROJECT_ACTIONS.PROJECT_SANDBOX_WRITE]?.allowed === true;
  const { version: manifestVersion } = useProjectManifestVersion(projectId);

  const snapshotsQuery = useQuery({
    queryKey: qk.project.snapshots(projectId),
    queryFn: () => listProjectSnapshots(projectId),
    ...contract('config'),
    retry: snapshotsQueryRetry,
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

  const openNewForm = () => {
    setEditingTemplate(null);
    setFormOpen(true);
  };
  const openEditForm = (tpl: SandboxTemplate) => {
    setEditingTemplate(tpl);
    setFormOpen(true);
  };

  const newTemplateAction = canManage ? (
    <Button
      size="sm"
      variant="outline"
      className="gap-1.5 transition-transform active:scale-[0.96]"
      onClick={openNewForm}
    >
      <PlusIcon className="size-3.5 shrink-0" />
      {t('actions.new')}
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
            <Button
              size="sm"
              variant="secondary"
              className="gap-1.5 transition-transform active:scale-[0.96]"
              onClick={openNewForm}
            >
              <PlusIcon className="size-4 shrink-0" />
              {t('actions.new')}
            </Button>
          ) : undefined
        }
        manifestVersion={manifestVersion}
        templatesError={data?.templates_error ?? null}
        isEmpty={templates.length === 0}
        emptyAction={newTemplateAction}
        templatesSlot={
          templates.length === 0 ? undefined : (
            <ul className="space-y-2">
              {templates.map((t) => (
                <TemplateCard
                  key={t.template_id ?? `tpl-${t.slug}`}
                  projectId={projectId}
                  template={t}
                  canManage={canManage}
                  onEdit={openEditForm}
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
