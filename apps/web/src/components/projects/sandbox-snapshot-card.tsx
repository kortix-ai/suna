'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { useMemo } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  listProjectSnapshots,
  rebuildProjectSnapshot,
  type ProjectSnapshot,
  type ProjectSnapshotStatus,
  type ProjectSnapshotsResponse,
  type RebuildSnapshotResponse,
} from '@/lib/projects-client';
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

function StatusPill({ status }: { status: ProjectSnapshotStatus }) {
  const style = STATUS_STYLE[status];
  const Icon = style.icon;
  const spin = status === 'building' || status === 'queued';
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', style.badgeClass)}>
      <Icon className={cn('h-3 w-3', spin && status === 'building' && 'animate-spin')} />
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

export function SandboxSnapshotCard({ projectId, canManage }: SandboxSnapshotCardProps) {
  const queryClient = useQueryClient();

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

  const rebuildMutation = useMutation<RebuildSnapshotResponse>({
    mutationFn: () => rebuildProjectSnapshot(projectId),
    onSuccess: (result) => {
      const labels: Record<RebuildSnapshotResponse['status'], string> = {
        'started': 'Snapshot build started',
        'already-building': 'A build for this commit is already in progress',
        'already-ready': 'Latest commit is already built',
        'failed-to-start': 'Could not start build',
      };
      toast.success(labels[result.status]);
      queryClient.invalidateQueries({ queryKey: SNAPSHOTS_QUERY_KEY(projectId) });
    },
    onError: (error: Error) => toast.error(error.message || 'Failed to rebuild snapshot'),
  });

  const data = snapshotsQuery.data;
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

  // "Needs rebuild" is true when the branch tip has moved past the latest
  // ready snapshot's commit AND there isn't already a build in flight for
  // a newer commit.
  const needsRebuild =
    headSha != null &&
    latestReady != null &&
    headSha !== latestReady.commit_sha &&
    activeForBranch?.commit_sha !== headSha;

  // ── Empty / loading / error UI ─────────────────────────────────────────
  if (snapshotsQuery.isLoading) {
    return <Skeleton className="h-56 rounded-xl" />;
  }
  if (snapshotsQuery.isError) {
    return (
      <section className="rounded-xl border border-destructive/30 bg-destructive/5">
        <header className="border-b border-destructive/20 px-6 py-4">
          <h2 className="text-base font-semibold text-destructive">Sandbox snapshot</h2>
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
    <section className="rounded-xl border border-border/70 bg-card">
      <header className="border-b border-border/60 px-6 py-4">
        <h2 className="text-base font-semibold text-foreground">Sandbox snapshot</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Every session boots from this project&apos;s own Daytona snapshot, built from{' '}
          <code className="font-mono">.kortix/Dockerfile</code> at the latest commit on{' '}
          <code className="font-mono">{branch || 'main'}</code>. The {Math.min(data.items.length, 5)} most recent ready snapshots are retained.
        </p>
      </header>

      <div className="space-y-5 px-6 py-5">
        {/* ── Headline status row ─────────────────────────────────────── */}
        <div className="rounded-lg border border-border/60 bg-muted/30 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Branch HEAD</span>
                <code className="rounded bg-background px-1.5 py-0.5 font-mono text-xs">
                  {shortSha(headSha)}
                </code>
                {data.head_resolve_error && (
                  <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3 w-3" />
                    Could not resolve HEAD
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Latest ready</span>
                <code className="rounded bg-background px-1.5 py-0.5 font-mono text-xs">
                  {shortSha(latestReady?.commit_sha)}
                </code>
                {latestReady && (
                  <span className="text-xs text-muted-foreground">
                    · built {formatRelative(latestReady.updated_at)}
                  </span>
                )}
              </div>
              {activeForBranch && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">In progress</span>
                  <code className="rounded bg-background px-1.5 py-0.5 font-mono text-xs">
                    {shortSha(activeForBranch.commit_sha)}
                  </code>
                  <StatusPill status={activeForBranch.status} />
                </div>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {needsRebuild ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-3 w-3" />
                  Needs rebuild
                </span>
              ) : latestReady ? (
                <StatusPill status="ready" />
              ) : activeForBranch ? (
                <StatusPill status={activeForBranch.status} />
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  Not built yet
                </span>
              )}
              {canManage && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={rebuildMutation.isPending}
                  onClick={() => rebuildMutation.mutate()}
                >
                  {rebuildMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  Rebuild
                </Button>
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
            <p className="rounded-lg border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
              No snapshot builds yet. The first build kicks off automatically when the project is created;
              it typically completes within a few minutes.
            </p>
          ) : (
            <ul className="divide-y divide-border/50 rounded-lg border border-border/60">
              {data.items.slice(0, 10).map((snap) => (
                <li key={snap.snapshot_row_id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                  <code className="font-mono text-xs">{shortSha(snap.commit_sha)}</code>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {snap.branch || '—'}
                  </span>
                  <StatusPill status={snap.status} />
                  {snap.metadata?.source ? (
                    <span className="text-xs text-muted-foreground">
                      via {String(snap.metadata.source)}
                    </span>
                  ) : null}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatRelative(snap.updated_at)}
                  </span>
                  {snap.status === 'failed' && snap.error && (
                    <p className="basis-full text-xs text-destructive">
                      {snap.error}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
