'use client';

import { SandboxTemplateForm } from '@/components/workspaces/sandbox-template-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Disclosure,
  DisclosureBody,
  DisclosureContent,
  DisclosureTrigger,
} from '@/components/ui/disclosure';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { Plus as PlusIcon } from '@/features/icon/icons/plus';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useWorkspaceManifestVersion } from '@/features/workspace/customize/migrate-to-v2/manifest-version';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { useSandboxRecovery } from '@/features/workspace/workspace-sidebar/footer/workspace-sandbox-alert';
import {
  type FailedBuildRelevance,
  describeFailedBuild,
  formatSandboxProviders,
} from '@/features/workspace/workspace-sidebar/footer/sandbox-alert-state';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';
import {
  type WorkspaceSnapshotBuild,
  type WorkspaceSnapshotStatus,
  type SandboxRuntimeStatus,
  type SandboxTemplate,
  type SnapshotErrorCategory,
  buildSandboxTemplate,
  deleteSandboxTemplate,
  getWorkspace,
  listWorkspaceSnapshots,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  CheckCircleIcon as CheckCircleSolid,
  CaretDownIcon as ChevronDown,
  ShippingContainerIcon as Container,
  WarningIcon as DangerTriangleSolid,
  PencilSimpleIcon as Edit3,
  FileCodeIcon as FileCode,
  PackageIcon as Package,
  PlusIcon as Plus,
  ArrowClockwiseIcon as RefreshCw,
  SparkleIcon as SparklesSolid,
  TrashIcon as Trash2,
  XCircleIcon as XCircleSolid,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { type ComponentType, type ReactNode, useState } from 'react';
import {
  type SandboxProvider,
  type SandboxProviderMode,
  SandboxTemplateProviderCoverage,
  SandboxTemplateProviderModeBadge,
} from './sandbox-provider-coverage';

const TEMPLATE_SKELETON_ROWS = [
  'sandbox-template-skeleton-1',
  'sandbox-template-skeleton-2',
  'sandbox-template-skeleton-3',
  'sandbox-template-skeleton-4',
  'sandbox-template-skeleton-5',
] as const;

/** Build-status tile icons render solid/fill — a filled status glyph inside
 *  the colored tile, distinct from the app's default outline weight. */
const CheckCircleFilled = ({ className }: { className?: string }) => (
  <CheckCircleSolid className={className} weight="fill" />
);
const XCircleFilled = ({ className }: { className?: string }) => (
  <XCircleSolid className={className} weight="fill" />
);

const CATEGORY_LABEL: Record<SnapshotErrorCategory, string> = {
  quota: 'Snapshot quota reached',
  dockerfile: 'Dockerfile build failed',
  layer: 'Kortix runtime layer failed',
  git: 'Repository access failed',
  tunnel: 'Sandbox callback unreachable',
  provider: 'Sandbox provider error',
  timeout: 'Build timed out',
  runtime: 'Runtime artifact missing',
  unknown: 'Build failed',
};

const BUILD_SOURCE_LABEL: Record<NonNullable<WorkspaceSnapshotBuild['source']>, string> = {
  'session-start': 'Session start',
  'workspace-create': 'Workspace created',
  'cr-merge': 'Code review merge',
  manual: 'Manual rebuild',
  background: 'Background sync',
  startup: 'Startup',
};

const BUILD_STATUS_TILE: Record<
  WorkspaceSnapshotStatus,
  {
    label: string;
    badgeVariant: 'success' | 'warning' | 'destructive';
    tileBg: string;
    iconColor: string;
    Icon: ComponentType<{ className?: string }>;
  }
> = {
  ready: {
    label: 'ready',
    badgeVariant: 'success',
    tileBg: 'bg-kortix-green/15',
    iconColor: 'text-kortix-green',
    Icon: CheckCircleFilled,
  },
  building: {
    label: 'building',
    badgeVariant: 'warning',
    tileBg: 'bg-kortix-yellow/15',
    iconColor: 'text-kortix-yellow',
    Icon: Loading,
  },
  failed: {
    label: 'failed',
    badgeVariant: 'destructive',
    tileBg: 'bg-kortix-red/15',
    iconColor: 'text-kortix-red',
    Icon: XCircleFilled,
  },
};

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

function ProviderBadge({ provider }: { provider: string | null | undefined }) {
  if (!provider) return null;
  return (
    <Badge variant="muted" size="sm">
      {provider === 'e2b' ? 'E2B' : provider.charAt(0).toUpperCase() + provider.slice(1)}
    </Badge>
  );
}

function formatBuildDuration(startedAt: string, finishedAt: string | null): string | null {
  if (!finishedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const minutes = Math.round((end - start) / 60_000);
  if (minutes < 1) return 'under 1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

export function isWorkspaceAcceleratorBuild(build: WorkspaceSnapshotBuild): boolean {
  return build.snapshot_name.startsWith('kortix-ppwarm-');
}

/**
 * A failed build that no longer describes anything bootable is history, and must
 * not keep shouting in red — that is exactly how an 11-day-old error passed for
 * a live outage. Only a failure that still blocks a session keeps the red tile.
 */
const STALE_FAILURE_LABEL: Record<Exclude<FailedBuildRelevance, 'blocking'>, string> = {
  superseded: 'superseded',
  recovered: 'resolved',
  retrying: 'retrying',
};

const STALE_FAILURE_HINT: Record<Exclude<FailedBuildRelevance, 'blocking'>, string> = {
  superseded: 'Built an older definition of this template. The current image has moved on.',
  recovered: 'This image is available now — nothing to fix.',
  retrying: 'A newer build of this same image is running.',
};

export function BuildRow({
  build,
  providerMode,
  relevance,
}: {
  build: WorkspaceSnapshotBuild;
  /** Only reveal the resolved provider when the workspace has explicitly pinned one. */
  providerMode: SandboxProviderMode;
  /** How this build relates to the image the workspace boots today. */
  relevance?: FailedBuildRelevance | null;
}) {
  const status = BUILD_STATUS_TILE[build.status];
  const { Icon } = status;
  const stale = relevance && relevance !== 'blocking' ? relevance : null;
  const duration = formatBuildDuration(build.started_at, build.finished_at);
  const sourceLabel = build.source ? BUILD_SOURCE_LABEL[build.source] : null;
  const timestamp = formatRelative(build.finished_at ?? build.started_at);
  const hasErrorDetails = build.status === 'failed' && !!build.error;
  const accelerator = isWorkspaceAcceleratorBuild(build);

  const row = (
    <>
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-sm',
          stale ? 'border-border text-muted-foreground border' : status.tileBg,
        )}
      >
        <Icon className={cn('size-5 shrink-0', stale ? undefined : status.iconColor)} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'truncate text-sm font-medium',
              stale ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {accelerator ? 'Repository accelerator' : build.slug}
          </span>
          <Badge variant={stale ? 'muted' : status.badgeVariant} size="xs">
            {status.label}
          </Badge>
          {stale ? (
            <Hint label={STALE_FAILURE_HINT[stale]}>
              <Badge variant="muted" size="xs">
                {STALE_FAILURE_LABEL[stale]}
              </Badge>
            </Hint>
          ) : null}
          {providerMode === 'pinned' ? <ProviderBadge provider={build.provider} /> : null}
        </div>
        <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
          <span className="truncate font-mono">{build.snapshot_name}</span>
          {sourceLabel ? (
            <>
              <span className="text-muted-foreground/40">&bull;</span>
              <span className="shrink-0">{sourceLabel}</span>
            </>
          ) : null}
          {timestamp ? (
            <>
              <span className="text-muted-foreground/40">&bull;</span>
              <span className="shrink-0 tabular-nums">{timestamp}</span>
            </>
          ) : null}
        </div>
      </div>
      {build.status === 'building' ? null : duration ? (
        <span className="text-muted-foreground/70 shrink-0 font-mono text-xs tabular-nums">
          {duration}
        </span>
      ) : null}
      {hasErrorDetails ? (
        <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform duration-150 ease-out group-data-[state=open]/build:rotate-180" />
      ) : null}
    </>
  );

  if (hasErrorDetails) {
    return (
      <li className="overflow-hidden transition-colors">
        <Disclosure
          className="group/build bg-popover overflow-hidden"
          variant="outline"
          transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
        >
          <DisclosureTrigger>
            <div className="flex w-full items-center gap-3 px-4 py-2">{row}</div>
          </DisclosureTrigger>
          <DisclosureContent className="overflow-hidden">
            <DisclosureBody className="bg-secondary space-y-2 rounded-t-lg px-4 py-3">
              {build.error_category ? (
                <Label className="text-foreground">{CATEGORY_LABEL[build.error_category]}</Label>
              ) : null}
              <pre className="bg-muted/50 text-muted-foreground max-h-28 overflow-auto rounded-sm text-xs wrap-break-word whitespace-pre-wrap">
                {build.error}
              </pre>
            </DisclosureBody>
          </DisclosureContent>
        </Disclosure>
      </li>
    );
  }

  return (
    <li className="group bg-popover rounded-md border transition-colors">
      <div className="flex items-center gap-3 px-4 py-2">{row}</div>
    </li>
  );
}

function InlinePanelEmpty({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
      <p className="text-muted-foreground text-sm text-balance">{message}</p>
      {action}
    </div>
  );
}

/**
 * Shown only when a failure still bites — i.e. the API's derived state is
 * `blocked` (nothing bootable anywhere this workspace routes) or `degraded` (some
 * routable providers are fine, others aren't).
 *
 * It deliberately never renders the newest failed row on its own. A build row is
 * a record of one past attempt against one image identity; presenting it as the
 * present tense is what showed "Latest build failed" for eleven days while a
 * ready image was serving every session.
 */
function SandboxStatusBanner({
  status,
  canManage,
  isFixPending,
  isRetryPending,
  onFix,
  onRetry,
}: {
  status: SandboxRuntimeStatus;
  canManage: boolean;
  isFixPending: boolean;
  isRetryPending: boolean;
  onFix: () => void;
  onRetry: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const failure = status.current_failure;
  const blocked = status.state === 'blocked';
  const showFixAction = canManage && status.fix_with_agent_available;
  const failedAt = failure ? formatRelative(failure.finished_at ?? failure.started_at) : null;

  return (
    <div className="border-border bg-popover rounded-md border">
      <div className="flex items-start gap-3 px-4 py-3">
        <span
          className={cn(
            'border-border inline-flex size-10 shrink-0 items-center justify-center self-start rounded-sm border',
            blocked ? 'bg-kortix-red/10 text-kortix-red' : 'bg-kortix-orange/10 text-kortix-orange',
          )}
        >
          {blocked ? (
            <XCircleSolid weight="fill" className="size-6 shrink-0" />
          ) : (
            <DangerTriangleSolid weight="fill" className="size-6 shrink-0" />
          )}
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="text-foreground text-sm font-medium text-balance">
                {blocked ? 'Sessions can’t start' : 'Some sessions won’t start'}
              </p>
              <p className="text-muted-foreground text-sm text-balance">
                {blocked
                  ? 'The image this workspace boots from failed to build, and no working copy is available. Every new session retries it and hits the same error.'
                  : `The image is ready on ${formatSandboxProviders(status.ready_providers)} but failing on ${formatSandboxProviders(status.failed_providers)}. Sessions routed there won’t start.`}
              </p>
              {failure ? (
                <InlineMeta>
                  <code className="bg-muted rounded-sm px-1.5 py-0.5 font-mono text-xs">
                    {failure.slug}
                  </code>
                  <span className="tabular-nums">{failedAt}</span>
                </InlineMeta>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {failure?.error_category ? (
                <Badge size="sm" variant={blocked ? 'destructive' : 'warning'}>
                  {CATEGORY_LABEL[failure.error_category] ?? failure.error_category}
                </Badge>
              ) : null}
              {showFixAction ? (
                <Button
                  size="sm"
                  className="gap-1.5 transition-transform active:scale-[0.96]"
                  disabled={isFixPending}
                  onClick={onFix}
                >
                  {isFixPending ? (
                    <Loading className="size-3.5 shrink-0" />
                  ) : (
                    <SparklesSolid className="size-3.5 shrink-0" />
                  )}
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsSandboxSnapshotCardJsxTextFixWithAgent918e1083',
                  )}
                </Button>
              ) : null}
              {canManage ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={isRetryPending}
                  onClick={onRetry}
                >
                  {isRetryPending ? (
                    <Loading className="size-3.5 shrink-0" />
                  ) : (
                    <RefreshCw className="size-3.5 shrink-0" />
                  )}
                  Rebuild
                </Button>
              ) : null}
            </div>
          </div>
          {failure?.error ? (
            <pre className="bg-muted/50 text-muted-foreground max-h-36 overflow-auto rounded-sm p-2.5 text-xs wrap-break-word whitespace-pre-wrap">
              {failure.error}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function formatRelative(input: string | null | undefined): string {
  return relativeTime(input) || '—';
}

function TemplateRow({
  workspaceId,
  template,
  canManage,
  onEdit,
  providerMode,
  selectedProvider,
}: {
  workspaceId: string;
  template: SandboxTemplate;
  canManage: boolean;
  onEdit: (tpl: SandboxTemplate) => void;
  providerMode: SandboxProviderMode;
  selectedProvider: SandboxProvider | null;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const { version: manifestVersion } = useWorkspaceManifestVersion(workspaceId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const templateId = template.template_id ?? null;
  const requireTemplateId = () => {
    if (!templateId) throw new Error('Sandbox template id is missing');
    return templateId;
  };
  const buildMut = useMutation({
    mutationFn: () => buildSandboxTemplate(workspaceId, requireTemplateId()),
    onSuccess: () => {
      successToast(`Rebuild started for "${template.name}"`);
      queryClient.invalidateQueries({ queryKey: qk.workspace.snapshots(workspaceId) });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to start build'),
  });
  const deleteMut = useMutation({
    mutationFn: () => deleteSandboxTemplate(workspaceId, requireTemplateId()),
    onSuccess: () => {
      successToast(`Deleted "${template.name}"`);
      queryClient.invalidateQueries({ queryKey: qk.workspace.snapshots(workspaceId) });
      queryClient.invalidateQueries({ queryKey: qk.workspace.sandboxes(workspaceId) });
      setConfirmDelete(false);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to delete template'),
  });

  const Icon = template.is_default ? Container : template.has_image ? Package : FileCode;
  const sub = template.is_default
    ? 'Platform default · shared by every workspace'
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
          <div className="text-muted-foreground truncate text-xs">
            {sub} &bull; {template.cpu}{' '}
            {tI18nHardcoded.raw('autoComponentsProjectsSandboxSnapshotCardJsxTextVCPU15535b27')}{' '}
            &bull; {template.memory_gb}{' '}
            {tI18nHardcoded.raw('autoComponentsProjectsSandboxSnapshotCardJsxTextGiB9d1e488f')}{' '}
            &bull; {template.disk_gb}{' '}
            {tI18nHardcoded.raw('autoComponentsProjectsSandboxSnapshotCardJsxTextGiBDiskd395296d')}{' '}
            &bull; {sourceTag}
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
                  aria-label={tI18nHardcoded.raw(
                    'autoComponentsProjectsSandboxSnapshotCardJsxAttrAriaLabelEditdc9d24c2',
                  )}
                >
                  <Edit3 className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive size-7 p-0"
                  disabled={deleteMut.isPending}
                  onClick={() => setConfirmDelete(true)}
                  aria-label={tI18nHardcoded.raw(
                    'autoComponentsProjectsSandboxSnapshotCardJsxAttrAriaLabelDeleteda0507cf',
                  )}
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
        description="This removes the template from the workspace. Sessions already using it are unaffected."
        confirmLabel="Delete"
        confirmVariant="destructive"
        isPending={deleteMut.isPending}
        onConfirm={() => deleteMut.mutate()}
      />
    </>
  );
}

export function SandboxView({ workspaceId }: { workspaceId: string }) {
  const workspaceQuery = useQuery({
    queryKey: qk.workspace.summary(workspaceId),
    queryFn: () => getWorkspace(workspaceId),
    ...contract('config'),
  });
  const { version: manifestVersion } = useWorkspaceManifestVersion(workspaceId);
  const canManage = workspaceQuery.data?.effective_workspace_role === 'manager';

  const tI18nHardcoded = useTranslations('hardcodedUi');
  const snapshotsQuery = useQuery({
    queryKey: qk.workspace.snapshots(workspaceId),
    queryFn: () => listWorkspaceSnapshots(workspaceId),
    ...contract('config'),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const builds = Array.isArray(data.builds) ? data.builds : [];
      const templates = Array.isArray(data.templates) ? data.templates : [];
      const anyBuilding =
        builds.some((b) => b.status === 'building') ||
        templates.some((t) => t.provider_state === 'building') ||
        templates.some((t) =>
          t.provider_coverage?.some((provider) => provider.status === 'building'),
        );
      return anyBuilding ? 5_000 : false;
    },
  });
  const { fixWithAgent, retry } = useSandboxRecovery(workspaceId);

  const [formOpen, setFormOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<SandboxTemplate | null>(null);

  const data = snapshotsQuery.data;
  const builds = Array.isArray(data?.builds) ? data.builds : [];
  const templates = Array.isArray(data?.templates) ? data.templates : [];
  const providerMode: SandboxProviderMode =
    data?.provider_mode === 'pinned' ? 'pinned' : 'automatic';
  const selectedProvider = data?.selected_provider ?? null;
  const templateBuilds = builds.filter((build) => !isWorkspaceAcceleratorBuild(build));
  const acceleratorBuilds = builds.filter(isWorkspaceAcceleratorBuild);
  const status = data?.status ?? null;
  // Only these two states mean a user is actually affected right now. Everything
  // else — including a failed build whose image the provider has since brought
  // up — belongs in the log below, not in a banner.
  const showStatusBanner = status?.state === 'blocked' || status?.state === 'degraded';
  const isFullyEmpty = templates.length === 0 && builds.length === 0;

  const newTemplateAction = canManage ? (
    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setFormOpen(true)}>
      <Plus className="size-3.5 shrink-0" />
      {tI18nHardcoded.raw('autoComponentsProjectsSandboxSnapshotCardJsxTextNewTemplate62cccf85')}
    </Button>
  ) : undefined;

  const openNewForm = () => {
    setEditingTemplate(null);
    setFormOpen(true);
  };
  const openEditForm = (tpl: SandboxTemplate) => {
    setEditingTemplate(tpl);
    setFormOpen(true);
  };

  return (
    <CustomizeSectionWrapper
      title={tI18nHardcoded.raw(
        'autoComponentsProjectsSandboxSnapshotCardJsxTextSandboxTemplatesc053b378',
      )}
      description="Manage sandbox templates, image builds, and failure recovery."
      action={
        canManage && (
          <Button size="sm" variant="secondary" className="gap-1.5" onClick={openNewForm}>
            <PlusIcon className="size-4 shrink-0" />
            {tI18nHardcoded.raw(
              'autoComponentsProjectsSandboxSnapshotCardJsxTextNewTemplate62cccf85',
            )}
          </Button>
        )
      }
    >
      {snapshotsQuery.isLoading ? (
        <div className="space-y-1">
          {TEMPLATE_SKELETON_ROWS.map((row) => (
            <Skeleton key={row} className="h-10 rounded-md" />
          ))}
        </div>
      ) : snapshotsQuery.isError ? (
        <ErrorState
          size="sm"
          title={tI18nHardcoded.raw(
            'autoComponentsProjectsSandboxSnapshotCardJsxTextFailedToLoad51fc2341',
          )}
          description={(snapshotsQuery.error as Error).message}
          action={
            <Button variant="outline" size="sm" onClick={() => snapshotsQuery.refetch()}>
              Retry
            </Button>
          }
        />
      ) : !data ? null : (
        <section>
          <div className="space-y-10">
            <p className="text-muted-foreground text-sm text-balance">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsSandboxSnapshotCardJsxTextSessionsBootFrom7b80534b',
              )}{' '}
              <code className="font-mono">/workspace</code>{' '}
              {tI18nHardcoded.raw(
                'autoComponentsProjectsSandboxSnapshotCardJsxTextAtBootAdd8305ffcd',
              )}{' '}
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

            {data.templates_error ? (
              <InfoBanner tone="warning">
                {tI18nHardcoded.raw(
                  'autoComponentsProjectsSandboxSnapshotCardJsxTextCouldnTReadf6f1bc48',
                )}{' '}
                {data.templates_error}
              </InfoBanner>
            ) : null}

            {isFullyEmpty ? (
              <EmptyState
                icon={Container}
                size="sm"
                title={tI18nHardcoded.raw(
                  'autoComponentsProjectsSandboxSnapshotCardJsxTextNoTemplatesResolved1e5654c6',
                )}
                description={tI18nHardcoded.raw(
                  'autoComponentsProjectsSandboxSnapshotCardJsxTextNoBuildsRecordedfa95bbcb',
                )}
                action={newTemplateAction}
              />
            ) : (
              <>
                {templates.length === 0 ? (
                  <div className="border-border rounded-md border">
                    <InlinePanelEmpty
                      message={tI18nHardcoded.raw(
                        'autoComponentsProjectsSandboxSnapshotCardJsxTextNoTemplatesResolved1e5654c6',
                      )}
                      action={newTemplateAction}
                    />
                  </div>
                ) : (
                  <div className="border-border divide-border divide-y overflow-hidden rounded-md border">
                    <ul>
                      {templates.map((t) => (
                        <TemplateRow
                          key={t.template_id ?? `tpl-${t.slug}`}
                          workspaceId={workspaceId}
                          template={t}
                          canManage={canManage}
                          onEdit={openEditForm}
                          providerMode={providerMode}
                          selectedProvider={selectedProvider}
                        />
                      ))}
                    </ul>
                  </div>
                )}

                {showStatusBanner && status ? (
                  <SandboxStatusBanner
                    status={status}
                    canManage={canManage}
                    isFixPending={fixWithAgent.isPending}
                    isRetryPending={retry.isPending}
                    onFix={() => fixWithAgent.mutate()}
                    onRetry={() => retry.mutate(status.current_failure?.template_slug)}
                  />
                ) : null}

                <div className="space-y-2">
                  <Label>Session template builds</Label>

                  {templateBuilds.length === 0 ? (
                    <div className="border-border rounded-md border">
                      <InlinePanelEmpty
                        message={tI18nHardcoded.raw(
                          'autoComponentsProjectsSandboxSnapshotCardJsxTextNoBuildsRecordedfa95bbcb',
                        )}
                      />
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {templateBuilds.slice(0, 10).map((b) => (
                        <BuildRow
                          key={b.build_id}
                          build={b}
                          providerMode={providerMode}
                          relevance={describeFailedBuild(b, status)}
                        />
                      ))}
                    </ul>
                  )}
                </div>

                {acceleratorBuilds.length > 0 ? (
                  <div className="space-y-2">
                    <Label>Workspace accelerator</Label>
                    <InfoBanner
                      tone="neutral"
                      icon={SparklesSolid}
                      title="Optional repository acceleration"
                    >
                      A workspace accelerator preloads this repository for a later session. A missing
                      or failed accelerator never blocks a session. Kortix uses the shared session
                      runtime and clones the repository into{' '}
                      <code className="font-mono">/workspace</code>.
                    </InfoBanner>
                    <ul className="space-y-2">
                      {acceleratorBuilds.slice(0, 5).map((b) => (
                        <BuildRow key={b.build_id} build={b} providerMode={providerMode} />
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </div>

          <SandboxTemplateForm
            workspaceId={workspaceId}
            open={formOpen}
            onOpenChange={setFormOpen}
            template={editingTemplate}
          />
        </section>
      )}
    </CustomizeSectionWrapper>
  );
}
