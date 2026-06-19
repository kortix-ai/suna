'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Clock,
  Container,
  Edit3,
  FileCode,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';

import { SandboxTemplateForm } from '@/components/projects/sandbox-template-form';
import { Button } from '@/components/ui/button';
import { List } from '@/components/ui/list';
import { Skeleton } from '@/components/ui/skeleton';
import { useSandboxRecovery } from '@/features/co-worker/project-sidebar/footer/project-sandbox-alert';
import {
  buildSandboxTemplate,
  deleteSandboxTemplate,
  listProjectSnapshots,
  type ProjectSnapshotBuild,
  type ProjectSnapshotStatus,
  type SandboxTemplate,
  type SnapshotErrorCategory,
} from '@/lib/projects-client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface SandboxSnapshotCardProps {
  projectId: string;
  canManage: boolean;
}

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

function StateBadge({ state }: { state: string }) {
  const info = describeState(state);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        info.tone === 'ok' &&
          'border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        info.tone === 'busy' &&
          'border border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-400',
        info.tone === 'fail' && 'bg-destructive/10 text-destructive border-destructive/20 border',
        info.tone === 'idle' && 'bg-muted text-muted-foreground border-border/60 border',
      )}
    >
      {info.tone === 'busy' ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : info.tone === 'ok' ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : info.tone === 'fail' ? (
        <XCircle className="h-3 w-3" />
      ) : (
        <Clock className="h-3 w-3" />
      )}
      {info.label}
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

  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-3 text-sm">
      <Icon className="text-muted-foreground size-4" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{template.name}</span>
          <code className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-xs">
            {template.slug}
          </code>
          <span className="text-muted-foreground/70 text-[10px] tracking-wide uppercase">
            {sourceTag}
          </span>
        </div>
        <div className="text-muted-foreground mt-0.5 truncate text-xs">
          {sub} · {template.cpu} vCPU · {template.memory_gb} GiB · {template.disk_gb} GiB disk
        </div>
      </div>
      <StateBadge state={template.daytona_state} />
      {canManage && (
        <div className="flex items-center gap-1">
          {template.template_id && !template.is_default && (
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
                onClick={() => {
                  if (window.confirm(`Delete sandbox template "${template.name}"?`)) {
                    deleteMut.mutate();
                  }
                }}
                aria-label="Delete template"
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
    </li>
  );
}

export function SandboxSnapshotCard({ projectId, canManage }: SandboxSnapshotCardProps) {
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

  if (snapshotsQuery.isLoading) {
    return <Skeleton className="h-64 rounded-2xl" />;
  }
  if (snapshotsQuery.isError) {
    return (
      <section className="border-destructive/30 bg-destructive/5 rounded-2xl border">
        <header className="border-destructive/20 border-b px-6 py-4">
          <h2 className="text-destructive text-base font-semibold">Sandbox</h2>
        </header>
        <div className="px-6 py-5">
          <p className="text-destructive text-sm">
            Failed to load sandbox templates: {(snapshotsQuery.error as Error).message}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => snapshotsQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      </section>
    );
  }
  const data = snapshotsQuery.data;
  if (!data) return null;

  const builds = Array.isArray(data.builds) ? data.builds : [];
  const templates = Array.isArray(data.templates) ? data.templates : [];
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
    <section className="border-border/70 bg-card rounded-2xl border">
      <header className="border-border/60 flex items-start justify-between gap-3 border-b px-6 py-4">
        <div>
          <h2 className="text-foreground text-base font-semibold">Sandbox templates</h2>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Sessions boot from a sandbox template. The platform default is shared by every project
            and clones your repo into <code className="font-mono">/workspace</code> at boot. Add
            your own templates here or via <code className="font-mono">[[sandbox.templates]]</code>{' '}
            in <code className="font-mono">kortix.toml</code>.
          </p>
          {data.templates_error && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              Couldn’t read project sandbox config: {data.templates_error}
            </p>
          )}
        </div>
        {canManage && (
          <Button size="sm" className="gap-1.5" onClick={openNewForm}>
            <Plus className="size-3.5" />
            New template
          </Button>
        )}
      </header>

      <div className="space-y-5 px-6 py-5">
        {templates.length === 0 ? (
          <p className="border-border/60 text-muted-foreground rounded-2xl border border-dashed px-4 py-6 text-center text-sm">
            No templates resolved yet.
          </p>
        ) : (
          <List className="border-border/60 rounded-2xl border">
            {templates.map((t) => (
              <TemplateRow
                key={t.template_id ?? `tpl-${t.slug}`}
                projectId={projectId}
                template={t}
                canManage={canManage}
                onEdit={openEditForm}
              />
            ))}
          </List>
        )}

        {latestFailure && (
          <div className="border-destructive/30 bg-destructive/5 rounded-2xl border p-4">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <XCircle className="text-destructive h-4 w-4" />
              <span className="text-destructive text-sm font-semibold">Latest build failed</span>
              {latestFailure.error_category && (
                <span className="border-destructive/20 bg-destructive/10 text-destructive rounded-full border px-2 py-0.5 text-xs font-medium">
                  {CATEGORY_LABEL[latestFailure.error_category] ?? latestFailure.error_category}
                </span>
              )}
              <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                {latestFailure.slug}
              </code>
              <span className="text-muted-foreground text-xs">
                {formatRelative(latestFailure.finished_at ?? latestFailure.started_at)}
              </span>
            </div>
            {latestFailure.error && (
              <pre className="bg-background/70 text-muted-foreground max-h-36 overflow-auto rounded-lg p-2.5 text-xs break-words whitespace-pre-wrap">
                {latestFailure.error}
              </pre>
            )}
            {canManage && canFixWithAgent && (
              <Button
                size="sm"
                className="mt-3 gap-1.5"
                disabled={fixWithAgent.isPending}
                onClick={() => fixWithAgent.mutate()}
              >
                {fixWithAgent.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                Fix with agent
              </Button>
            )}
          </div>
        )}

        <div>
          <h3 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
            Recent builds
          </h3>
          {builds.length === 0 ? (
            <p className="border-border/60 text-muted-foreground rounded-2xl border border-dashed px-4 py-6 text-center text-sm">
              No builds recorded yet. The platform default builds once globally; custom templates
              build on first use.
            </p>
          ) : (
            <List className="border-border/60 rounded-2xl border">
              {builds.slice(0, 10).map((b: ProjectSnapshotBuild) => (
                <li
                  key={b.build_id}
                  className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm"
                >
                  <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{b.slug}</code>
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
            </List>
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
  );
}
