'use client';

/**
 * Changes — the Customize section for reviewing & landing work.
 *
 * Two thin surfaces behind one rail entry:
 *   • Change requests — the merge queue. Each open CR can be Merged or
 *     Rejected inline (one click, no leaving the overlay); the row opens the
 *     full diff dialog if you want to inspect before landing. This is the
 *     "keep growing main" loop.
 *   • Versions — the project's branches (each session runs on one), read-only.
 *
 * CR hooks read the project from <ProjectFilesProvider>, so we wrap the view
 * in it (same as the Files section).
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import {
  GitBranch,
  GitMerge,
  GitPullRequest,
  Loader2,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ProjectFilesProvider } from '@/features/project-files';
import { ChangeRequestDetailDialog } from '@/features/project-files/components/change-request-detail-dialog';
import {
  useChangeRequests,
  useCloseChangeRequest,
  useMergeChangeRequest,
  useReopenChangeRequest,
} from '@/features/project-files/hooks/use-change-requests';
import { getProject, listProjectBranches, type ChangeRequestStatus } from '@/lib/projects-client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import { CustomizeSectionHeader } from '../customize-section-header';

function rel(iso: string | null): string {
  if (!iso) return '';
  try {
    return formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
  } catch {
    return '';
  }
}

export function ChangesView({ projectId }: { projectId: string }) {
  const projectQuery = useQuery({
    queryKey: ['projects', projectId, 'meta'],
    queryFn: () => getProject(projectId),
    staleTime: 60_000,
  });
  const defaultBranch = projectQuery.data?.default_branch ?? '';

  return (
    <ProjectFilesProvider value={{ projectId, ref: defaultBranch, defaultBranch }}>
      <ChangesInner projectId={projectId} />
    </ProjectFilesProvider>
  );
}

function ChangesInner({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<'crs' | 'versions'>('crs');
  const [detailCrId, setDetailCrId] = useState<string | null>(null);

  const openCount =
    useChangeRequests('open', { refetchInterval: 8_000 }).data?.change_requests.length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <CustomizeSectionHeader
        icon={GitPullRequest}
        title="Changes"
        count={tab === 'crs' ? openCount : undefined}
      />

      {/* Tabs */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-2">
        <SegTab active={tab === 'crs'} onClick={() => setTab('crs')}>
          Change requests
        </SegTab>
        <SegTab active={tab === 'versions'} onClick={() => setTab('versions')}>
          Versions
        </SegTab>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
          {tab === 'crs' ? (
            <ChangeRequestsTab onOpenDetail={setDetailCrId} />
          ) : (
            <VersionsTab projectId={projectId} />
          )}
        </div>
      </div>

      <ChangeRequestDetailDialog crId={detailCrId} onClose={() => setDetailCrId(null)} />
    </div>
  );
}

function SegTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'bg-primary/10 text-foreground'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/* ─── Change requests ───────────────────────────────────────────────────── */

const STATUS_FILTERS: { value: ChangeRequestStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed' },
];

function ChangeRequestsTab({ onOpenDetail }: { onOpenDetail: (crId: string) => void }) {
  const [status, setStatus] = useState<ChangeRequestStatus>('open');
  const { data, isLoading } = useChangeRequests(status, { refetchInterval: 8_000 });
  const crs = useMemo(() => data?.change_requests ?? [], [data]);

  const merge = useMergeChangeRequest();
  const close = useCloseChangeRequest();
  const reopen = useReopenChangeRequest();

  const onMerge = (crId: string) =>
    merge.mutate(crId, {
      onSuccess: (res) =>
        toast.success(
          res.merge.fast_forward
            ? 'Merged (fast-forward)'
            : `Merged ${res.merge.merge_commit_sha.slice(0, 7)}`,
        ),
      onError: (err) => toast.error(err.message),
    });
  const onClose = (crId: string) =>
    close.mutate(crId, {
      onSuccess: () => toast.success('Change request rejected'),
      onError: (err) => toast.error(err.message),
    });
  const onReopen = (crId: string) =>
    reopen.mutate(crId, {
      onSuccess: () => toast.success('Change request reopened'),
      onError: (err) => toast.error(err.message),
    });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setStatus(f.value)}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
              status === f.value
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : crs.length === 0 ? (
        <EmptyState
          icon={GitPullRequest}
          size="sm"
          title={`No ${status} change requests`}
          description={
            status === 'open'
              ? 'When a session proposes changes, they show up here to review and merge into main.'
              : `Nothing ${status} yet.`
          }
        />
      ) : (
        <ul className="space-y-2">
          {crs.map((cr) => {
            const busy =
              (merge.isPending && merge.variables === cr.cr_id) ||
              (close.isPending && close.variables === cr.cr_id) ||
              (reopen.isPending && reopen.variables === cr.cr_id);
            return (
              <li
                key={cr.cr_id}
                className="group flex items-center gap-3 rounded-2xl border border-border/60 bg-card px-3.5 py-3 transition-colors hover:border-foreground/20"
              >
                <CrStatusIcon status={cr.status} />
                <button
                  type="button"
                  onClick={() => onOpenDetail(cr.cr_id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs text-muted-foreground">#{cr.number}</span>
                    <span className="truncate text-sm font-medium text-foreground">{cr.title}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <GitBranch className="h-3 w-3 shrink-0" />
                    <span className="max-w-[140px] truncate font-mono">{cr.head_ref}</span>
                    <span className="text-muted-foreground/40">→</span>
                    <span className="max-w-[100px] truncate font-mono">{cr.base_ref}</span>
                    <span className="text-muted-foreground/40">·</span>
                    <span className="shrink-0">
                      {cr.status === 'merged' && cr.merged_at
                        ? `merged ${rel(cr.merged_at)}`
                        : cr.status === 'closed' && cr.closed_at
                          ? `closed ${rel(cr.closed_at)}`
                          : `opened ${rel(cr.created_at)}`}
                    </span>
                  </div>
                </button>

                {cr.status === 'open' && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => onClose(cr.cr_id)}
                      disabled={busy}
                    >
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 gap-1.5 px-2.5 text-xs"
                      onClick={() => onMerge(cr.cr_id)}
                      disabled={busy}
                    >
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <GitMerge className="h-3.5 w-3.5" />
                      )}
                      Merge
                    </Button>
                  </div>
                )}
                {cr.status === 'closed' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 px-2.5 text-xs"
                    onClick={() => onReopen(cr.cr_id)}
                    disabled={busy}
                  >
                    Reopen
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CrStatusIcon({ status }: { status: ChangeRequestStatus }) {
  const cls = 'h-4 w-4 shrink-0';
  if (status === 'merged') return <GitMerge className={cn(cls, 'text-primary')} />;
  if (status === 'closed') return <XCircle className={cn(cls, 'text-muted-foreground')} />;
  return <GitPullRequest className={cn(cls, 'text-foreground')} />;
}

/* ─── Versions (branches) ───────────────────────────────────────────────── */

function VersionsTab({ projectId }: { projectId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['project-files', 'branches', projectId],
    queryFn: () => listProjectBranches(projectId),
    staleTime: 10_000,
  });
  const branches = data?.branches ?? [];

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (branches.length === 0) {
    return (
      <EmptyState
        icon={GitBranch}
        size="sm"
        title="No versions"
        description="Branches show up here as sessions create them."
      />
    );
  }

  return (
    <ul className="space-y-2">
      {branches.map((b) => (
        <li
          key={b.name}
          className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card px-3.5 py-3"
        >
          <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-sm font-medium text-foreground">{b.name}</span>
              {b.is_default && (
                <Badge variant="secondary" size="sm">
                  default
                </Badge>
              )}
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {b.subject || '(no commits)'}
              {b.committed_at && <span className="text-muted-foreground/60"> · {rel(b.committed_at)}</span>}
            </div>
          </div>
          {!b.is_default && (b.ahead != null || b.behind != null) && (
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/70">
              {b.ahead != null && `↑${b.ahead}`} {b.behind != null && `↓${b.behind}`}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
