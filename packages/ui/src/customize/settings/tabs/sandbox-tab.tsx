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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../primitives/select';
import { SettingsRow, SettingsRowGroup } from '../../../primitives/settings-row';
import { SettingsSubsectionHeader } from '../../../primitives/settings-subsection-header';
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
  type KortixProject,
  type SandboxProviderName,
  type SandboxTemplate,
  buildSandboxTemplate,
  deleteSandboxTemplate,
  getProject,
  listProjectSnapshots,
  updateProjectSandboxProvider,
} from '@kortix/sdk';
import { contract, invalidateProject, qk } from '@kortix/sdk/react';
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
  PushPinIcon,
  ShippingContainerIcon,
  ShuffleIcon,
  SquaresFourIcon,
  TrashIcon,
  XCircleIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type SandboxProvider,
  SandboxProviderBadge,
  SandboxProviderLabel,
  type SandboxProviderMode,
  availableProviderCoverage,
  describeProviderMode,
  latestObservedAt,
} from '../../sections/view/sandbox-provider-coverage';
import {
  applySandboxProviderResult,
  pollSandboxProviderTransition,
} from '../../sections/view/sandbox-provider-result';
import {
  formatSandboxProvider,
  isLegacySandboxProvider,
  sortSandboxProviders,
} from '../../../internal/lib/sandbox-providers';
import { SettingsTabHeader } from '../settings-tab-header';
import { snapshotsQueryRetry } from './snapshots-query';

/** One batched probe for the two leaves this tab gates on. */
const SANDBOX_TAB_ACTIONS = [
  PROJECT_ACTIONS.PROJECT_SANDBOX_WRITE,
  PROJECT_ACTIONS.PROJECT_WRITE,
] as const;

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

/** Where sessions built from this template actually run. Static configuration,
 *  not live status — which is why it belongs in the spec grid next to CPU and
 *  memory, and NOT in the runtime footer where a bare `Automatic` badge used
 *  to float with no label attached to it. */
export function describeRouting(
  providerMode: SandboxProviderMode,
  selectedProvider: SandboxProvider | null,
  tI18nComplete: UiTranslator,
  labels: {
    automatic?: string;
    pinned?: string;
    pinnedWithProvider?: (provider: string) => string;
  } = {},
): { label: string; icon: PhosphorIcon } {
  const mode = describeProviderMode(providerMode, selectedProvider, tI18nComplete);
  if (providerMode === 'automatic')
    return { label: labels.automatic ?? 'Automatic', icon: ShuffleIcon };
  return {
    label: mode.selectedProvider
      ? (labels.pinnedWithProvider?.(mode.selectedProvider) ?? `Pinned · ${mode.selectedProvider}`)
      : (labels.pinned ?? 'Pinned'),
    icon: PushPinIcon,
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
  providerMode,
  selectedProvider,
  formatObservedAt,
  runtimeLabel,
  checkedLabel,
  badgeCopy,
}: {
  coverage: SandboxTemplate['provider_coverage'] | null | undefined;
  providerMode: SandboxProviderMode;
  selectedProvider: SandboxProvider | null;
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
          <SandboxProviderBadge
            key={item.provider}
            item={item}
            selected={providerMode === 'pinned' && item.provider === selectedProvider}
            copy={badgeCopy}
          />
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
  const routing = describeRouting(providerMode, selectedProvider, tI18nComplete, {
    automatic: t('routing.automatic'),
    pinned: t('routing.pinned'),
    pinnedWithProvider: (provider) => t('routing.pinnedWithProvider', { provider }),
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

        {/* SIX cells, every one exactly one track wide — the grid fills two
            complete rows of three with no holes and no spans. The base-image
            cell used to take `col-span-2`, which left row 1 as three equal
            cells and row 2 as one narrow beside one double-wide: a uniform
            track carrying ragged content. Long image refs now truncate inside
            their own cell (full string on the native `title`) instead of
            widening it.

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
          <FactCell icon={routing.icon} label={t('routing.title')} value={routing.label} />
        </dl>

        <TemplateRuntimeFooter
          coverage={template.provider_coverage}
          providerMode={providerMode}
          selectedProvider={selectedProvider}
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
            selected: t('coverage.selected'),
            selectedAria: t('coverage.selectedAria'),
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

const AUTO_PROVIDER = '__auto__';
function SandboxProviderRow({
  project,
  canManage,
}: {
  project: KortixProject;
  canManage: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('settings.sandbox');
  const queryClient = useQueryClient();
  const available = sortSandboxProviders(project.available_sandbox_providers ?? []);
  const current = project.default_sandbox_provider ?? null;

  const mutation = useMutation({
    mutationFn: (next: SandboxProviderName | null) =>
      updateProjectSandboxProvider(project.project_id, next),
    onSuccess: (result, next) => {
      // FIX-L: the PATCH returns EITHER the updated project (immediate) OR a
      // preparation object (the prepare branch — a switch to a different enabled
      // provider). Write the project cache ONLY for the immediate result; a
      // preparation is a transition, not a project, and must not clobber the
      // cached project shape.
      const kind = applySandboxProviderResult(queryClient, project.project_id, result);
      if (kind === 'preparation') {
        successToast(
          tI18nComplete('text32f14aa9ea33', {
            provider: next ? formatSandboxProvider(next) : tI18nComplete('text22412aa281cb'),
          }),
        );
        // Poll the durable transition (bounded, backoff, terminal-stop, 404 = done)
        // and refresh the project once it settles so the now-active provider shows.
        void pollSandboxProviderTransition(project.project_id, {
          onSettled: (state) => {
            // invalidateProject() reaches qk.project.scope(project.project_id),
            // which qk.project.summary(project.project_id) nests under — so it
            // already covers the bare-project row too; no separate summary
            // invalidation needed here.
            void invalidateProject(queryClient, project.project_id);
            // qk.projects.scope(): restores the reach the old bare
            // projects-literal prefix match had. A sandbox-provider switch
            // is rare — over-invalidating a few extra account lists costs
            // nothing measurable.
            queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
            const status = state?.latest?.status;
            if (status === 'activated') {
              successToast(
                tI18nComplete('text1c145081eddd', {
                  provider: formatSandboxProvider(state?.latest?.target_provider ?? ''),
                }),
              );
            } else if (status === 'failed') {
              errorToast(state?.latest?.label || tI18nComplete('texte9ca8360a34d'));
            }
          },
        });
      }
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete('text914be6d9bb89')),
  });

  if (available.length === 0) return null;

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader title={t('routing.title')} />
      <SettingsRowGroup>
        <SettingsRow
          label={
            <>
              {t('provider.label')}
              <Badge variant="highlight" size="sm">
                {t('provider.experimental')}
              </Badge>
            </>
          }
          description={
            available.some(isLegacySandboxProvider)
              ? `${t('provider.description')} ${t('provider.legacyNote')}`
              : t('provider.description')
          }
        >
          <Select
            value={current ?? AUTO_PROVIDER}
            onValueChange={(v) =>
              mutation.mutate(
                v === AUTO_PROVIDER ? null : (available.find((provider) => provider === v) ?? null),
              )
            }
            disabled={!canManage || mutation.isPending}
          >
            <SelectTrigger aria-label={t('provider.label')} className="h-8 w-48 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value={AUTO_PROVIDER}>{t('routing.automatic')}</SelectItem>
              {available.map((p) => (
                <SelectItem key={p} value={p}>
                  <SandboxProviderLabel provider={p} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsRowGroup>
    </section>
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
  /** `SandboxProviderRow` — the per-project provider pin, moved here from
   *  `general-tab.tsx`. A slot for the same reason `templatesSlot` is one: it
   *  owns a `useMutation`/`useQueryClient` and cannot render under
   *  `renderToStaticMarkup` with no `QueryClientProvider`.
   *
   *  Rendered ABOVE the loading/error branch on purpose. It is fed by the
   *  PROJECT query, not the snapshots query, so a slow or failed template read
   *  must not hide a control that has nothing to do with it. */
  sandboxProviderSlot?: ReactNode;
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
  sandboxProviderSlot,
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
        {sandboxProviderSlot}
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
  const projectQuery = useQuery({
    queryKey: qk.project.summary(projectId),
    queryFn: () => getProject(projectId),
    ...contract('config'),
  });
  // Two different leaves, one batched probe. Template CRUD asserts
  // `project.sandbox.write`; the provider row asserts `project.write`. They
  // are deliberately NOT merged — a role may hold one without the other.
  const caps = useProjectCans(projectId, SANDBOX_TAB_ACTIONS);
  const canManage = caps[PROJECT_ACTIONS.PROJECT_SANDBOX_WRITE]?.allowed === true;
  const canEditProvider = caps[PROJECT_ACTIONS.PROJECT_WRITE]?.allowed === true;
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

  const pinnedProvider: SandboxProvider | null = projectQuery.data
    ? (projectQuery.data.default_sandbox_provider ?? null)
    : (data?.selected_provider ?? null);
  const providerMode: SandboxProviderMode = pinnedProvider ? 'pinned' : 'automatic';
  const selectedProvider = pinnedProvider;

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
        sandboxProviderSlot={
          projectQuery.data ? (
            <SandboxProviderRow project={projectQuery.data} canManage={canEditProvider} />
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
