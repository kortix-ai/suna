'use client';

import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { List } from '@/components/ui/list';
import { Skeleton } from '@/components/ui/skeleton';
import {
  listProjectSnapshots,
  type ProjectSandboxHealth,
  type ProjectSnapshot,
  type ProjectSnapshotStatus,
  type ProjectSnapshotsResponse,
  type SnapshotErrorCategory,
} from '@/lib/projects-client';
import { useSandboxRecovery } from '@/components/projects/sandbox-health-alert';
import { cn } from '@/lib/utils';

interface SandboxSnapshotCardProps {
  projectId: string;
  canManage: boolean;
}

const SNAPSHOTS_QUERY_KEY = (projectId: string) => ['project-snapshots', projectId];

const STATUS_STYLE: Record<ProjectSnapshotStatus, {
  label: string;
  badgeClass: string;
  icon: typeof CheckCircle2;
}> = {
  ready: {
    label: 'Ready',
    badgeClass: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20',
    icon: CheckCircle2,
  },
  building: {
    label: 'Building',
    badgeClass: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20',
    icon: Loader2,
  },
  queued: {
    label: 'Queued',
    badgeClass: 'bg-muted text-muted-foreground border border-border/60',
    icon: Clock,
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

function StatusPill({ status }: { status: ProjectSnapshotStatus }) {
  const style = STATUS_STYLE[status];
  const Icon = style.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', style.badgeClass)}>
      <Icon className={cn('h-3 w-3', status === 'building' && 'animate-spin')} />
      {style.label}
    </span>
  );
}

function shortSha(sha: string | null | undefined): string {
  if (!sha) return '—';
  return sha.slice(0, 7);
}

function formatRelative(input: string): string {
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

// ── Health banner ──────────────────────────────────────────────────────────
// One clear, color-coded line at the top of the panel that tells the user the
// single thing that matters: can sessions start, and if not, what to do.

type BannerTone = 'ok' | 'degraded' | 'critical' | 'building' | 'updating' | 'neutral';

const BANNER_TONE: Record<BannerTone, string> = {
  ok: 'border-emerald-500/20 bg-emerald-500/5',
  degraded: 'border-amber-500/30 bg-amber-500/5',
  critical: 'border-destructive/30 bg-destructive/5',
  building: 'border-blue-500/20 bg-blue-500/5',
  updating: 'border-blue-500/20 bg-blue-500/5',
  neutral: 'border-border/60 bg-muted/30',
};

function bannerToneOf(health: ProjectSandboxHealth | null): BannerTone {
  if (!health) return 'neutral';
  if (health.failure) return health.ready_count === 0 ? 'critical' : 'degraded';
  // A build in flight with healthy snapshots still retained = seamless update
  // (sessions keep booting the current image). Only "first build" has nothing.
  if (health.building) return health.first_build ? 'building' : 'updating';
  if (health.healthy) return 'ok';
  return 'neutral';
}

function HealthBanner({
  projectId,
  health,
  canManage,
}: {
  projectId: string;
  health: ProjectSandboxHealth | null;
  canManage: boolean;
}) {
  const { retry, fixWithAgent } = useSandboxRecovery(projectId);
  const tone = bannerToneOf(health);
  const failure = health?.failure ?? null;
  const canFixWithAgent = !!failure?.fixable_by_agent && (health?.ready_count ?? 0) > 0;

  const { Icon, iconClass, title, body } = useMemo(() => {
    switch (tone) {
      case 'critical':
        return {
          Icon: XCircle,
          iconClass: 'text-destructive',
          title: 'Sandbox build failed — sessions can’t start',
          body: 'No healthy snapshot remains. Fix the build to start new sessions again.',
        };
      case 'degraded':
        return {
          Icon: AlertTriangle,
          iconClass: 'text-amber-600 dark:text-amber-400',
          title: 'Latest build failed — running on an older snapshot',
          body: `Sessions still boot from the last healthy snapshot (${health?.ready_count} retained). New commits won’t apply until the build succeeds.`,
        };
      case 'building':
        return {
          Icon: Loader2,
          iconClass: 'text-blue-600 dark:text-blue-400 animate-spin',
          title: 'Building the first sandbox…',
          body: 'This one-time build runs the first time a project is created. Sessions can start as soon as it’s ready.',
        };
      case 'updating':
        return {
          Icon: Loader2,
          iconClass: 'text-blue-600 dark:text-blue-400 animate-spin',
          title: 'Updating sandbox…',
          body: `Rebuilding for the latest ${health?.runtime_outdated ? 'runtime' : 'commit'}. Sessions keep booting from the current snapshot (${health?.ready_count} retained) until it’s ready — nothing is lost.`,
        };
      case 'ok':
        return {
          Icon: CheckCircle2,
          iconClass: 'text-emerald-600 dark:text-emerald-400',
          title: 'Sandbox healthy',
          body: `${health?.ready_count} of ${health?.retention} snapshots retained as fallbacks${health && health.bootable_count < health.ready_count ? ` (${health.bootable_count} on the current runtime)` : ''}. Sessions boot from the latest.`,
        };
      default:
        return {
          Icon: Clock,
          iconClass: 'text-muted-foreground',
          title: 'No sandbox built yet',
          body: 'The first snapshot builds when a session starts or you trigger a build.',
        };
    }
  }, [tone, health]);

  return (
    <div className={cn('rounded-2xl border p-4', BANNER_TONE[tone])}>
      <div className="flex items-start gap-3">
        <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', iconClass)} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{body}</p>

          {failure && (
            <div className="mt-3">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-destructive/20 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                  {CATEGORY_LABEL[failure.category] ?? failure.category}
                </span>
                <code className="font-mono text-xs text-muted-foreground">
                  {shortSha(failure.commit_sha)}
                </code>
                <span className="text-xs text-muted-foreground">
                  {formatRelative(failure.failed_at)}
                </span>
              </div>
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/70 p-2.5 text-xs text-muted-foreground">
                {failure.error}
              </pre>
            </div>
          )}

          {canManage && (failure || tone === 'critical' || tone === 'degraded') && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={retry.isPending}
                onClick={() => retry.mutate()}
              >
                {retry.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Retry build
              </Button>
              {canFixWithAgent && (
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={fixWithAgent.isPending}
                  onClick={() => fixWithAgent.mutate()}
                >
                  {fixWithAgent.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  Fix with agent
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function SandboxSnapshotCard({ projectId, canManage }: SandboxSnapshotCardProps) {
  const snapshotsQuery = useQuery<ProjectSnapshotsResponse>({
    queryKey: SNAPSHOTS_QUERY_KEY(projectId),
    queryFn: () => listProjectSnapshots(projectId),
    staleTime: 10_000,
    // Auto-refresh while a build is in flight so the badge updates without a manual reload.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const inFlight = data.items.some((s) => s.status === 'building' || s.status === 'queued');
      return inFlight ? 5_000 : false;
    },
  });
  const { retry } = useSandboxRecovery(projectId);

  const data = snapshotsQuery.data;
  const health = data?.health ?? null;

  const latestReady = useMemo<ProjectSnapshot | null>(() => {
    if (!data) return null;
    const branch = data.default_branch;
    return data.items.find((s) => s.status === 'ready' && s.branch === branch) ?? null;
  }, [data]);

  const activeForBranch = useMemo<ProjectSnapshot | null>(() => {
    if (!data) return null;
    const branch = data.default_branch;
    return (
      data.items.find(
        (s) => s.branch === branch && (s.status === 'building' || s.status === 'queued'),
      ) ?? null
    );
  }, [data]);

  const headSha = data?.head_commit_sha ?? null;
  const branch = data?.default_branch ?? '';

  // "Needs rebuild" — branch tip moved past the latest ready snapshot's commit
  // and there isn't already a build in flight for a newer commit.
  const needsRebuild =
    headSha != null &&
    latestReady != null &&
    headSha !== latestReady.commit_sha &&
    activeForBranch?.commit_sha !== headSha;

  // ── Empty / loading / error UI ─────────────────────────────────────────
  if (snapshotsQuery.isLoading) {
    return <Skeleton className="h-72 rounded-2xl" />;
  }
  if (snapshotsQuery.isError) {
    return (
      <section className="rounded-2xl border border-destructive/30 bg-destructive/5">
        <header className="border-b border-destructive/20 px-6 py-4">
          <h2 className="text-base font-semibold text-destructive">Sandbox</h2>
        </header>
        <div className="px-6 py-5">
          <p className="text-sm text-destructive">
            Failed to load snapshot status: {(snapshotsQuery.error as Error).message}
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => snapshotsQuery.refetch()}>
            Retry
          </Button>
        </div>
      </section>
    );
  }
  if (!data) return null;

  return (
    <section className="rounded-2xl border border-border/70 bg-card">
      <header className="flex items-start justify-between gap-3 border-b border-border/60 px-6 py-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">Sandbox snapshots</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Every session boots from this project’s{' '}
            <code className="font-mono">.kortix/Dockerfile</code> at the latest commit on{' '}
            <code className="font-mono">{branch || 'main'}</code>. The {health?.retention ?? 5} most
            recent healthy snapshots are retained as fallbacks.
          </p>
        </div>
        {canManage && (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 gap-1.5"
            disabled={retry.isPending}
            onClick={() => retry.mutate()}
          >
            {retry.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Rebuild
          </Button>
        )}
      </header>

      <div className="space-y-5 px-6 py-5">
        {/* ── Health banner ─────────────────────────────────────────────── */}
        <HealthBanner projectId={projectId} health={health} canManage={canManage} />

        {/* ── Headline status row ───────────────────────────────────────── */}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
            <p className="text-xs text-muted-foreground">Branch HEAD</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="rounded bg-background px-1.5 py-0.5 font-mono text-xs">
                {shortSha(headSha)}
              </code>
              {data.head_resolve_error && (
                <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3 w-3" /> unresolved
                </span>
              )}
            </div>
          </div>
          <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
            <p className="text-xs text-muted-foreground">Latest ready</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="rounded bg-background px-1.5 py-0.5 font-mono text-xs">
                {shortSha(latestReady?.commit_sha)}
              </code>
              {latestReady ? (
                <span className="text-xs text-muted-foreground">
                  {formatRelative(latestReady.updated_at)}
                </span>
              ) : needsRebuild ? null : (
                <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3 w-3" /> none
                </span>
              )}
            </div>
          </div>
          <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
            <p className="text-xs text-muted-foreground">In progress</p>
            <div className="mt-1 flex items-center gap-2">
              {activeForBranch ? (
                <>
                  <code className="rounded bg-background px-1.5 py-0.5 font-mono text-xs">
                    {shortSha(activeForBranch.commit_sha)}
                  </code>
                  <StatusPill status={activeForBranch.status} />
                </>
              ) : needsRebuild ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-3 w-3" /> Needs rebuild
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}
            </div>
          </div>
        </div>

        {/* ── History list ────────────────────────────────────────────── */}
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recent builds
          </h3>
          {data.items.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
              No snapshot builds yet. The first build kicks off when a session starts or you click Rebuild.
            </p>
          ) : (
            <List className="rounded-2xl border border-border/60">
              {data.items.slice(0, 10).map((snap) => (
                <li key={snap.snapshot_row_id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                  <code className="font-mono text-xs">{shortSha(snap.commit_sha)}</code>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                    {snap.branch || '—'}
                  </span>
                  <StatusPill status={snap.status} />
                  {snap.status === 'failed' && snap.error_category && (
                    <span className="rounded-full border border-destructive/20 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                      {CATEGORY_LABEL[snap.error_category] ?? snap.error_category}
                    </span>
                  )}
                  {snap.metadata?.source ? (
                    <span className="text-xs text-muted-foreground">
                      via {String(snap.metadata.source)}
                    </span>
                  ) : null}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatRelative(snap.updated_at)}
                  </span>
                  {snap.status === 'failed' && snap.error && (
                    <pre className="basis-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-destructive/5 p-2 text-xs text-destructive">
                      {snap.error}
                    </pre>
                  )}
                </li>
              ))}
            </List>
          )}
        </div>
      </div>
    </section>
  );
}
