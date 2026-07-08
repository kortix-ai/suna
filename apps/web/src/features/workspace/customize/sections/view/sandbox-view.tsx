'use client';

import { SandboxTemplateForm } from '@/components/projects/sandbox-template-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Disclosure,
  DisclosureBody,
  DisclosureContent,
  DisclosureTrigger,
} from '@/components/ui/disclosure';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { Icon } from '@/features/icon/icon';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { useProjectManifestVersion } from '@/features/workspace/customize/migrate-to-v2/manifest-version';
import { useSandboxRecovery } from '@/features/workspace/project-sidebar/footer/project-sandbox-alert';
import {
  buildSandboxTemplate,
  deleteSandboxTemplate,
  getProject,
  listProjectSnapshots,
  type ProjectSnapshotBuild,
  type ProjectSnapshotStatus,
  type SandboxTemplate,
  type SnapshotErrorCategory,
} from '@kortix/sdk/projects-client';
import { cn } from '@/lib/utils';
import {
  AlarmClockSolid,
  CheckCircleSolid,
  SparklesSolid,
  XCircleSolid,
} from '@mynaui/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  Container,
  Edit3,
  FileCode,
  Package,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';

const SNAPSHOTS_QUERY_KEY = (projectId: string) => ['project-snapshots', projectId];

const CATEGORY_LABEL: Record<SnapshotErrorCategory, string> = {
  quota: 'Snapshot quota reached',
  dockerfile: 'Dockerfile build failed',
  git: 'Repository access failed',
  tunnel: 'Sandbox callback unreachable',
  provider: 'Sandbox provider error',
  timeout: 'Build timed out',
  runtime: 'Runtime artifact missing',
  unknown: 'Build failed',
};

const BUILD_SOURCE_LABEL: Record<NonNullable<ProjectSnapshotBuild['source']>, string> = {
  'session-start': 'Session start',
  'project-create': 'Project created',
  'cr-merge': 'Code review merge',
  manual: 'Manual rebuild',
  background: 'Background sync',
  startup: 'Startup',
};

const BUILD_STATUS_TILE: Record<
  ProjectSnapshotStatus,
  {
    label: string;
    badgeVariant: 'success' | 'warning' | 'destructive';
    tileBg: string;
    iconColor: string;
    Icon: typeof CheckCircleSolid;
  }
> = {
  ready: {
    label: 'ready',
    badgeVariant: 'success',
    tileBg: 'bg-kortix-green/15',
    iconColor: 'text-kortix-green',
    Icon: CheckCircleSolid,
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
    Icon: XCircleSolid,
  },
};

const DAYTONA_STATE_LABEL: Record<
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

const DAYTONA_TONE_BADGE = {
  ok: { variant: 'success' as const },
  busy: { variant: 'solid' as const, color: 'blue' as const },
  fail: { variant: 'destructive' as const },
  idle: { variant: 'muted' as const },
};

const DAYTONA_TONE_ICON_TILE: Record<'ok' | 'busy' | 'fail' | 'idle', string> = {
  ok: 'bg-kortix-green/10 text-kortix-green',
  busy: 'bg-kortix-yellow/10 text-kortix-yellow',
  fail: 'bg-kortix-red/10 text-kortix-red',
  idle: 'text-muted-foreground border-border',
};

function describeState(state: string): { label: string; tone: 'ok' | 'busy' | 'fail' | 'idle' } {
  return DAYTONA_STATE_LABEL[state] ?? { label: state || 'Unknown', tone: 'idle' };
}

// Human label for a sandbox provider id. Mirrors the capitalize-first convention
// used by the provider pin in Settings (see SandboxProviderRow), with a couple of
// tidy overrides so multi-word ids never render awkwardly.
const PROVIDER_LABEL: Record<string, string> = {
  local_docker: 'Local',
  justavps: 'JustAVPS',
};
function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

// Small, muted chip naming the sandbox provider a template/build belongs to.
// Omitted entirely when the provider is unknown — we never render "Unknown".
function ProviderBadge({ provider }: { provider: string | null | undefined }) {
  if (!provider) return null;
  return (
    <Badge variant="muted" size="sm">
      {providerLabel(provider)}
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

function BuildRow({ build, provider }: { build: ProjectSnapshotBuild; provider?: string }) {
  const status = BUILD_STATUS_TILE[build.status];
  const { Icon } = status;
  const duration = formatBuildDuration(build.started_at, build.finished_at);
  const sourceLabel = build.source ? BUILD_SOURCE_LABEL[build.source] : null;
  const timestamp = formatRelative(build.finished_at ?? build.started_at);
  const hasErrorDetails = build.status === 'failed' && !!build.error;

  const row = (
    <>
      <span
        className={cn('flex size-9 shrink-0 items-center justify-center rounded-sm', status.tileBg)}
      >
        <Icon className={cn('size-5 shrink-0', status.iconColor)} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground truncate text-sm font-medium">{build.slug}</span>
          <Badge variant={status.badgeVariant} size="xs">
            {status.label}
          </Badge>
          <ProviderBadge provider={provider} />
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

function LatestFailureBanner({
  failure,
  canManage,
  canFixWithAgent,
  isFixPending,
  onFix,
}: {
  failure: ProjectSnapshotBuild;
  canManage: boolean;
  canFixWithAgent: boolean;
  isFixPending: boolean;
  onFix: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const showFixAction = canManage && canFixWithAgent;

  return (
    <div className="border-border bg-popover rounded-md border">
      <div className="flex items-start gap-3 px-4 py-3">
        <span className="border-border bg-kortix-red/10 text-kortix-red inline-flex size-10 shrink-0 items-center justify-center self-start rounded-sm border">
          <XCircleSolid className="size-6 shrink-0" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="text-foreground text-sm font-medium text-balance">
                {tI18nHardcoded.raw(
                  'autoComponentsProjectsSandboxSnapshotCardJsxTextLatestBuildFailedf1dd9030',
                )}
              </p>
              <InlineMeta>
                <code className="bg-muted rounded-sm px-1.5 py-0.5 font-mono text-xs">
                  {failure.slug}
                </code>
                <span className="tabular-nums">
                  {formatRelative(failure.finished_at ?? failure.started_at)}
                </span>
              </InlineMeta>
            </div>
            {(failure.error_category || showFixAction) && (
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {failure.error_category ? (
                  <Badge size="sm" variant="warning">
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
              </div>
            )}
          </div>
          {failure.error ? (
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
  if (!input) return '—';
  const then = new Date(input).getTime();
  if (!Number.isFinite(then)) return input;
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(input).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function TemplateRow({
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
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const { version: manifestVersion } = useProjectManifestVersion(projectId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const buildMut = useMutation({
    mutationFn: () => buildSandboxTemplate(projectId, template.template_id!),
    onSuccess: () => {
      successToast(`Rebuild started for "${template.name}"`);
      queryClient.invalidateQueries({ queryKey: SNAPSHOTS_QUERY_KEY(projectId) });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to start build'),
  });
  const deleteMut = useMutation({
    mutationFn: () => deleteSandboxTemplate(projectId, template.template_id!),
    onSuccess: () => {
      successToast(`Deleted "${template.name}"`);
      queryClient.invalidateQueries({ queryKey: SNAPSHOTS_QUERY_KEY(projectId) });
      queryClient.invalidateQueries({ queryKey: ['project-sandboxes', projectId] });
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
  const stateInfo = describeState(template.daytona_state);
  const stateBadge = DAYTONA_TONE_BADGE[stateInfo.tone];
  const StateIcon =
    stateInfo.tone === 'busy'
      ? Loading
      : stateInfo.tone === 'ok'
        ? CheckCircleSolid
        : stateInfo.tone === 'fail'
          ? XCircleSolid
          : AlarmClockSolid;

  return (
    <>
      <li className="bg-popover flex flex-wrap items-center gap-4 overflow-hidden px-4 py-3 text-sm">
        <div
          className={cn(
            'inline-flex size-11 shrink-0 items-center justify-center rounded-sm border',
            DAYTONA_TONE_ICON_TILE[stateInfo.tone],
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
            <ProviderBadge provider={template.provider} />
          </div>
          <div className="text-muted-foreground truncate text-[13px]">
            {sub} &bull; {template.cpu}{' '}
            {tI18nHardcoded.raw('autoComponentsProjectsSandboxSnapshotCardJsxTextVCPU15535b27')}{' '}
            &bull; {template.memory_gb}{' '}
            {tI18nHardcoded.raw('autoComponentsProjectsSandboxSnapshotCardJsxTextGiB9d1e488f')}{' '}
            &bull; {template.disk_gb}{' '}
            {tI18nHardcoded.raw('autoComponentsProjectsSandboxSnapshotCardJsxTextGiBDiskd395296d')}{' '}
            &bull; {sourceTag}
          </div>
        </div>
        <Badge
          variant={stateBadge.variant}
          color={'color' in stateBadge ? stateBadge.color : undefined}
        >
          <StateIcon className="size-4 shrink-0" />
          {stateInfo.label}
        </Badge>
        {canManage && (
          <div className="flex items-center gap-1">
            {template.template_id && !template.is_default && (
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
            {template.template_id && (
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

export function SandboxView({ projectId }: { projectId: string }) {
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
    staleTime: 20_000,
  });
  const { version: manifestVersion } = useProjectManifestVersion(projectId);
  const canManage = projectQuery.data?.effective_project_role === 'manager';

  const tI18nHardcoded = useTranslations('hardcodedUi');
  const snapshotsQuery = useQuery({
    queryKey: SNAPSHOTS_QUERY_KEY(projectId),
    queryFn: () => listProjectSnapshots(projectId),
    staleTime: 10_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const builds = Array.isArray(data.builds) ? data.builds : [];
      const templates = Array.isArray(data.templates) ? data.templates : [];
      const anyBuilding =
        builds.some((b) => b.status === 'building') ||
        templates.some((t) =>
          ['pulling', 'building'].includes((t.daytona_state || '').toLowerCase()),
        );
      return anyBuilding ? 5_000 : false;
    },
  });
  const { fixWithAgent } = useSandboxRecovery(projectId);

  const [formOpen, setFormOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<SandboxTemplate | null>(null);

  const data = snapshotsQuery.data;
  const builds = Array.isArray(data?.builds) ? data.builds : [];
  const templates = Array.isArray(data?.templates) ? data.templates : [];
  const latestFailure = builds.find((b) => b.status === 'failed') ?? null;
  const latestReady = builds.find((b) => b.status === 'ready') ?? null;
  const canFixWithAgent = !!latestFailure && !!latestReady;
  const isFullyEmpty = templates.length === 0 && builds.length === 0;

  // Build-log rows carry no provider column of their own, so resolve it from the
  // template the build was for (`template_slug`). Unknown → the badge is omitted.
  const providerBySlug = new Map(templates.map((t) => [t.slug, t.provider]));

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
            <Icon.Plus className="size-4 shrink-0" />
            {tI18nHardcoded.raw(
              'autoComponentsProjectsSandboxSnapshotCardJsxTextNewTemplate62cccf85',
            )}
          </Button>
        )
      }
    >
      {snapshotsQuery.isLoading ? (
        <div className="space-y-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 rounded-md" />
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
                          projectId={projectId}
                          template={t}
                          canManage={canManage}
                          onEdit={openEditForm}
                        />
                      ))}
                    </ul>
                  </div>
                )}

                {latestFailure ? (
                  <LatestFailureBanner
                    failure={latestFailure}
                    canManage={canManage}
                    canFixWithAgent={canFixWithAgent}
                    isFixPending={fixWithAgent.isPending}
                    onFix={() => fixWithAgent.mutate()}
                  />
                ) : null}

                <div className="space-y-2">
                  <Label>
                    {tI18nHardcoded.raw(
                      'autoComponentsProjectsSandboxSnapshotCardJsxTextRecentBuildscde18d4a',
                    )}
                  </Label>

                  {builds.length === 0 ? (
                    <div className="border-border rounded-md border">
                      <InlinePanelEmpty
                        message={tI18nHardcoded.raw(
                          'autoComponentsProjectsSandboxSnapshotCardJsxTextNoBuildsRecordedfa95bbcb',
                        )}
                      />
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {builds.slice(0, 10).map((b) => (
                        <BuildRow
                          key={b.build_id}
                          build={b}
                          provider={providerBySlug.get(b.template_slug)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>

          <SandboxTemplateForm
            projectId={projectId}
            open={formOpen}
            onOpenChange={setFormOpen}
            template={editingTemplate}
          />
        </section>
      )}
    </CustomizeSectionWrapper>
  );
}
