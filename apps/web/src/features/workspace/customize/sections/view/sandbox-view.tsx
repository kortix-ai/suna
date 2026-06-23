'use client';

import { SandboxTemplateForm } from '@/components/projects/sandbox-template-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Item, ItemContent, ItemFooter, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Icon } from '@/features/icon/icon';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { useSandboxRecovery } from '@/features/workspace/project-sidebar/footer/project-sandbox-alert';
import {
  buildSandboxTemplate,
  deleteSandboxTemplate,
  getProject,
  listProjectSnapshots,
  updateTemplateWarmPool,
  type ProjectSnapshotBuild,
  type ProjectSnapshotStatus,
  type SandboxTemplate,
  type SnapshotErrorCategory,
} from '@/lib/projects-client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { AlarmClockSolid, CheckCircleSolid, XCircleSolid } from '@mynaui/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Container,
  Edit3,
  FileCode,
  Loader2,
  Minus,
  Package,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

const MAX_WARM_SIZE = 25;

const SNAPSHOTS_QUERY_KEY = (projectId: string) => ['project-snapshots', projectId];

const STATUS_STYLE: Record<
  ProjectSnapshotStatus,
  {
    label: string;
    badgeClass: string;
    icon: typeof CheckCircle2;
  }
> = {
  ready: {
    label: 'Ready',
    badgeClass:
      'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20',
    icon: CheckCircle2,
  },
  building: {
    label: 'Building',
    badgeClass: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20',
    icon: Loader2,
  },
  failed: {
    label: 'Failed',
    badgeClass: 'bg-destructive/10 text-destructive border border-destructive/20',
    icon: XCircle,
  },
};

const CATEGORY_LABEL: Record<SnapshotErrorCategory, string> = {
  dockerfile: 'Dockerfile build failed',
  git: 'Repository access failed',
  tunnel: 'Sandbox callback unreachable',
  provider: 'Sandbox provider error',
  timeout: 'Build timed out',
  runtime: 'Runtime artifact missing',
  unknown: 'Build failed',
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

function StatusPill({ status }: { status: ProjectSnapshotStatus }) {
  const style = STATUS_STYLE[status];
  const Icon = style.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        style.badgeClass,
      )}
    >
      <Icon className={cn('h-3 w-3', status === 'building' && 'animate-spin')} />
      {style.label}
    </span>
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

function TemplateWarmControl({
  projectId,
  template,
  canManage,
}: {
  projectId: string;
  template: SandboxTemplate;
  canManage: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const warm = template.warm_pool;
  const serverEnabled = warm?.enabled ?? false;
  const serverSize = warm?.size ?? 1;

  const [enabled, setEnabled] = useState(serverEnabled);
  const [size, setSize] = useState(serverSize);
  useEffect(() => {
    setEnabled(serverEnabled);
  }, [serverEnabled]);
  useEffect(() => {
    setSize(serverSize);
  }, [serverSize]);

  const save = useMutation({
    mutationFn: (input: { enabled?: boolean; size?: number }) =>
      updateTemplateWarmPool(projectId, { slug: template.slug, ...input }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SNAPSHOTS_QUERY_KEY(projectId) });
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Failed to update warm pool');
      setEnabled(serverEnabled);
      setSize(serverSize);
    },
  });

  const commit = (next: { enabled?: boolean; size?: number }) => {
    if (!canManage) return;
    save.mutate(next);
  };
  const setSizeClamped = (n: number) => {
    const clamped = Math.max(0, Math.min(MAX_WARM_SIZE, n));
    setSize(clamped);
    commit({ size: clamped });
  };

  return (
    <div className="border-border/50 mt-1 flex basis-full flex-wrap items-center gap-x-3 gap-y-2 border-t pt-2.5">
      <Zap className="text-muted-foreground size-3.5" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium">
          {tI18nHardcoded.raw('autoComponentsProjectsSandboxSnapshotCardJsxTextKeepWarm55c849e1')}
        </div>
        <div className="text-muted-foreground text-[11px]">
          {tI18nHardcoded.raw(
            'autoComponentsProjectsSandboxSnapshotCardJsxTextPreBootSandboxes7405a223',
          )}
        </div>
        {enabled && warm && (
          <div className="mt-1 flex items-center gap-3 text-[11px]">
            <span className="inline-flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-500">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              {warm.ready} ready
            </span>
            {warm.warming > 0 && (
              <span className="text-muted-foreground inline-flex items-center gap-1.5">
                <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
                {warm.warming}{' '}
                {tI18nHardcoded.raw(
                  'autoComponentsProjectsSandboxSnapshotCardJsxTextWarmingfab1d732',
                )}
              </span>
            )}
          </div>
        )}
      </div>
      {enabled && (
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="icon"
            className="size-7"
            disabled={!canManage || save.isPending || size <= 0}
            onClick={() => setSizeClamped(size - 1)}
            aria-label={tI18nHardcoded.raw(
              'autoComponentsProjectsSandboxSnapshotCardJsxAttrAriaLabelDecreased514ed20',
            )}
          >
            <Minus className="size-3.5" />
          </Button>
          <span className="w-5 text-center text-xs font-medium tabular-nums">{size}</span>
          <Button
            variant="outline"
            size="icon"
            className="size-7"
            disabled={!canManage || save.isPending || size >= MAX_WARM_SIZE}
            onClick={() => setSizeClamped(size + 1)}
            aria-label={tI18nHardcoded.raw(
              'autoComponentsProjectsSandboxSnapshotCardJsxAttrAriaLabelIncrease82989967',
            )}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      )}
      <Switch
        checked={enabled}
        disabled={!canManage || save.isPending}
        onCheckedChange={(v) => {
          setEnabled(v);
          commit({ enabled: v });
        }}
        aria-label={tI18nHardcoded.raw(
          'autoComponentsProjectsSandboxSnapshotCardJsxAttrAriaLabelKeepb2a43916',
        )}
      />
    </div>
  );
}

function TemplateRow({
  projectId,
  template,
  canManage,
  warmAvailable,
  onEdit,
}: {
  projectId: string;
  template: SandboxTemplate;
  canManage: boolean;
  warmAvailable: boolean;
  onEdit: (tpl: SandboxTemplate) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const buildMut = useMutation({
    mutationFn: () => buildSandboxTemplate(projectId, template.template_id!),
    onSuccess: () => {
      toast.success(`Rebuild started for "${template.name}"`);
      queryClient.invalidateQueries({ queryKey: SNAPSHOTS_QUERY_KEY(projectId) });
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to start build'),
  });
  const deleteMut = useMutation({
    mutationFn: () => deleteSandboxTemplate(projectId, template.template_id!),
    onSuccess: () => {
      toast.success(`Deleted "${template.name}"`);
      queryClient.invalidateQueries({ queryKey: SNAPSHOTS_QUERY_KEY(projectId) });
      queryClient.invalidateQueries({ queryKey: ['project-sandboxes', projectId] });
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to delete template'),
  });

  const Icon = template.is_default ? Container : template.has_image ? Package : FileCode;
  const sub = template.is_default
    ? 'Platform default · shared by every project'
    : template.has_image
      ? `Image: ${template.image}`
      : `Dockerfile: ${template.dockerfile_path}`;
  const sourceTag =
    template.source === 'platform' ? 'platform' : template.source === 'ui' ? 'UI' : 'kortix.toml';
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
    <li className="flex flex-wrap items-center gap-4 px-4 py-3 text-sm">
      <div
        className={cn(
          'inline-flex size-11 shrink-0 items-center justify-center rounded-sm border',
          DAYTONA_TONE_ICON_TILE[stateInfo.tone],
        )}
      >
        <Icon className="size-6 shrink-0" />
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium">{template.name}</span>
          <Badge variant="secondary" size="sm">
            {template.slug}
          </Badge>
          <span className="text-muted-foreground/70 text-[10px] tracking-wide uppercase">
            {sourceTag}
          </span>
        </div>
        <div className="text-muted-foreground gap-1 truncate text-[13px]">
          {sub} &bull; {template.cpu} &bull;{' '}
          {tI18nHardcoded.raw('autoComponentsProjectsSandboxSnapshotCardJsxTextVCPU15535b27')}
          &bull; {template.memory_gb}{' '}
          {tI18nHardcoded.raw('autoComponentsProjectsSandboxSnapshotCardJsxTextGiB9d1e488f')}
          &bull; {template.disk_gb}{' '}
          {tI18nHardcoded.raw('autoComponentsProjectsSandboxSnapshotCardJsxTextGiBDiskd395296d')}
        </div>
      </div>
      <Badge
        variant={stateBadge.variant}
        color={'color' in stateBadge ? stateBadge.color : undefined}
      >
        <StateIcon className={cn(stateInfo.tone === 'busy' && 'animate-spin', 'size-4')} />
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
                onClick={() => {
                  if (window.confirm(`Delete sandbox template "${template.name}"?`)) {
                    deleteMut.mutate();
                  }
                }}
                aria-label={tI18nHardcoded.raw(
                  'autoComponentsProjectsSandboxSnapshotCardJsxAttrAriaLabelDeleteda0507cf',
                )}
              >
                {deleteMut.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
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
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Rebuild
            </Button>
          )}
        </div>
      )}
      {warmAvailable && template.warm_pool && (
        <TemplateWarmControl projectId={projectId} template={template} canManage={canManage} />
      )}
    </li>
  );
}

export function SandboxView({ projectId }: { projectId: string }) {
  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
    staleTime: 20_000,
  });
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
      const anyWarm = templates.some((t) => t.warm_pool?.enabled);
      if (anyWarm) return 4_000;
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
      title="Sandbox"
      description="Explore and manage per-commit runtime snapshots, image health, and recovery."
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
          <div className="space-y-5">
            {templates.length === 0 ? (
              <EmptyState
                icon={Container}
                size="sm"
                title={tI18nHardcoded.raw(
                  'autoComponentsProjectsSandboxSnapshotCardJsxTextNoTemplatesResolved1e5654c6',
                )}
                action={
                  canManage ? (
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={openNewForm}>
                      <Plus className="size-3.5" />
                      {tI18nHardcoded.raw(
                        'autoComponentsProjectsSandboxSnapshotCardJsxTextNewTemplate62cccf85',
                      )}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="border-border bg-popover rounded-md border">
                {templates.map((t) => (
                  <TemplateRow
                    key={t.template_id ?? `tpl-${t.slug}`}
                    projectId={projectId}
                    template={t}
                    canManage={canManage}
                    warmAvailable={data.warm_pool_available ?? false}
                    onEdit={openEditForm}
                  />
                ))}
              </div>
            )}

            {latestFailure && (
              <Item
                variant="outline"
                size="sm"
                className="border-kortix-red/30 bg-kortix-red/5 items-start"
              >
                <ItemMedia
                  variant="icon"
                  className="border-border bg-kortix-red/10 text-kortix-red [&_svg:not([class*='size-'])]:size-5"
                >
                  <XCircleSolid />
                </ItemMedia>
                <ItemContent className="min-w-0 gap-2">
                  <ItemTitle className="flex-wrap">
                    {tI18nHardcoded.raw(
                      'autoComponentsProjectsSandboxSnapshotCardJsxTextLatestBuildFailedf1dd9030',
                    )}
                    {latestFailure.error_category && (
                      <Badge size="sm" variant="warning">
                        {CATEGORY_LABEL[latestFailure.error_category] ??
                          latestFailure.error_category}
                      </Badge>
                    )}
                  </ItemTitle>
                  <InlineMeta>
                    <code className="bg-muted rounded-sm px-1.5 py-0.5 font-mono">
                      {latestFailure.slug}
                    </code>
                    {formatRelative(latestFailure.finished_at ?? latestFailure.started_at)}
                  </InlineMeta>
                  {latestFailure.error && (
                    <pre className="bg-muted/50 text-muted-foreground max-h-36 overflow-auto rounded-sm p-2.5 text-xs break-words whitespace-pre-wrap">
                      {latestFailure.error}
                    </pre>
                  )}
                </ItemContent>
                {canManage && canFixWithAgent && (
                  <ItemFooter>
                    <Button
                      size="sm"
                      className="gap-1.5"
                      disabled={fixWithAgent.isPending}
                      onClick={() => fixWithAgent.mutate()}
                    >
                      {fixWithAgent.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      {tI18nHardcoded.raw(
                        'autoComponentsProjectsSandboxSnapshotCardJsxTextFixWithAgent918e1083',
                      )}
                    </Button>
                  </ItemFooter>
                )}
              </Item>
            )}

            <div className="space-y-3">
              <Label>
                {tI18nHardcoded.raw(
                  'autoComponentsProjectsSandboxSnapshotCardJsxTextRecentBuildscde18d4a',
                )}
              </Label>
              {builds.length === 0 ? (
                <EmptyState
                  icon={Package}
                  size="sm"
                  title={tI18nHardcoded.raw(
                    'autoComponentsProjectsSandboxSnapshotCardJsxTextNoBuildsRecordedfa95bbcb',
                  )}
                />
              ) : (
                <div className="border-border divide-y rounded-md border">
                  {builds.slice(0, 10).map((b: ProjectSnapshotBuild) => (
                    <li
                      key={b.build_id}
                      className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm"
                    >
                      <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                        {b.slug}
                      </code>
                      <StatusPill status={b.status} />
                      {b.source && (
                        <span className="text-muted-foreground text-xs">via {b.source}</span>
                      )}
                      <span className="text-muted-foreground ml-auto text-xs">
                        {formatRelative(b.finished_at ?? b.started_at)}
                      </span>
                      {b.status === 'failed' && b.error && (
                        <pre className="bg-destructive/5 text-destructive basis-full overflow-auto rounded-lg p-2 text-xs break-words whitespace-pre-wrap">
                          {b.error}
                        </pre>
                      )}
                    </li>
                  ))}
                </div>
              )}
            </div>
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
