'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { UserAvatar } from '@/components/ui/user-avatar';
import { Icon } from '@/features/icon/icon';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { ProjectFilesProvider } from '@/features/project-files';
import type { ChangeRequest } from '@/features/project-files/api/change-requests';
import { ChangeRequestDetailDialog } from '@/features/project-files/components/change-request-detail-dialog';
import { CheckpointDetailDialog } from '@/features/project-files/components/checkpoint-detail-dialog';
import {
  useChangeRequests,
  useCloseChangeRequest,
  useMergeChangeRequest,
  useReopenChangeRequest,
} from '@/features/project-files/hooks/use-change-requests';
import { useCommits } from '@/features/project-files/hooks/use-commits';
import { getProject, type ProjectCommit } from '@kortix/sdk/projects-client';
import { cn } from '@/lib/utils';
import {
  ChevronRight,
  GitMerge,
  GitMergeSolid,
  GitPullRequest,
  Refresh,
  XCircleSolid,
} from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { useMemo, useState } from 'react';
import CustomizeSectionWrapper from '../component/section-wrapper';
import {
  buildTimeline,
  commitTime,
  groupTimeline,
  isKortixAgent,
  type TimelineItem,
} from './changes-timeline';

const LIST_CLASS = 'bg-popover overflow-hidden divide-y divide-border rounded-md border';

function relCommit(c: ProjectCommit): string {
  try {
    return formatDistanceToNowStrict(new Date(commitTime(c)), { addSuffix: true });
  } catch {
    return '';
  }
}

function relIso(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
  } catch {
    return '';
  }
}

function crStatusLabel(cr: ChangeRequest): string {
  if (cr.status === 'merged' && cr.merged_at) return `merged ${relIso(cr.merged_at)}`;
  if (cr.status === 'closed' && cr.closed_at) return `closed ${relIso(cr.closed_at)}`;
  return `opened ${relIso(cr.created_at)}`;
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

function CheckpointRow({
  commit,
  index,
  onOpen,
}: {
  commit: ProjectCommit;
  index: number;
  onOpen: (sha: string) => void;
}) {
  const byAgent = isKortixAgent(commit);
  return (
    <li
      className="animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both"
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
    >
      <button
        type="button"
        onClick={() => onOpen(commit.hash)}
        className="group hover:bg-muted/40 active:bg-muted/50 flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors"
      >
        <span className="bg-kortix-blue/15 flex size-9 shrink-0 items-center justify-center rounded-sm">
          <GitPullRequest className="text-kortix-blue size-5" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="text-foreground block truncate text-sm font-medium">
            {commit.subject || '(no message)'}
          </span>
          <span className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
            {byAgent ? (
              <span className="bg-foreground flex size-5 shrink-0 items-center justify-center rounded-sm border">
                <Icon.Kortix className="text-background size-3" />
              </span>
            ) : (
              <UserAvatar
                email={commit.author_email}
                name={commit.author_name}
                size="xs"
                className="shrink-0"
              />
            )}
            <span className="truncate" title={commit.author_email}>
              {commit.author_name}
            </span>
            <span className="text-muted-foreground/40">&bull;</span>
            <span className="shrink-0">{relCommit(commit)}</span>
            <span className="text-muted-foreground/40">&bull;</span>
            <span className="shrink-0 font-mono tabular-nums">{commit.short_hash}</span>
          </span>
        </span>

        <ChevronRight className="text-muted-foreground/40 group-hover:text-muted-foreground size-4 shrink-0 transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
      </button>
    </li>
  );
}

function ChangeRequestRow({ cr, onOpen }: { cr: ChangeRequest; onOpen: (crId: string) => void }) {
  const merge = useMergeChangeRequest();
  const close = useCloseChangeRequest();
  const reopen = useReopenChangeRequest();

  const busy =
    (merge.isPending && merge.variables === cr.cr_id) ||
    (close.isPending && close.variables === cr.cr_id) ||
    (reopen.isPending && reopen.variables === cr.cr_id);

  const onMerge = () =>
    merge.mutate(cr.cr_id, {
      onSuccess: (res) =>
        successToast(
          res.merge.fast_forward
            ? 'Merged (fast-forward)'
            : `Merged ${res.merge.merge_commit_sha.slice(0, 7)}`,
        ),
      onError: (err) => errorToast(err.message),
    });
  const onClose = () =>
    close.mutate(cr.cr_id, {
      onSuccess: () => successToast('Change request rejected'),
      onError: (err) => errorToast(err.message),
    });
  const onReopen = () =>
    reopen.mutate(cr.cr_id, {
      onSuccess: () => successToast('Change request reopened'),
      onError: (err) => errorToast(err.message),
    });

  return (
    <li className="group hover:bg-muted/40 flex items-center gap-3 px-4 py-2.5 transition-colors">
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-sm',
          cr.status === 'merged'
            ? 'bg-kortix-green/15'
            : cr.status === 'closed'
              ? 'bg-kortix-red/15'
              : 'bg-kortix-blue/15',
        )}
      >
        {cr.status === 'merged' ? (
          <GitMergeSolid className="text-kortix-green size-5" />
        ) : cr.status === 'closed' ? (
          <XCircleSolid className="text-kortix-red size-5" />
        ) : (
          <GitPullRequest className="text-kortix-blue size-5" />
        )}
      </span>

      <button type="button" onClick={() => onOpen(cr.cr_id)} className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-sm">#{cr.number}</span>
          <span className="text-foreground truncate text-sm font-medium">{cr.title}</span>
        </span>
        <span className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
          <span className="max-w-[140px] truncate">{cr.head_ref}</span>
          <span className="text-muted-foreground/40">&rarr;</span>
          <Badge variant="kortix" size="xs">
            {cr.base_ref}
          </Badge>
          <span className="text-muted-foreground/40">&bull;</span>
          <span className="shrink-0">{crStatusLabel(cr)}</span>
        </span>
      </button>

      {cr.status === 'open' && (
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Reject
          </Button>
          <Button size="sm" onClick={onMerge} disabled={busy}>
            {busy ? <Loading className="size-3.5 shrink-0" /> : <GitMerge className="size-3.5" />}
            Merge
          </Button>
        </div>
      )}
      {cr.status === 'closed' && (
        <Button variant="secondary" size="sm" onClick={onReopen} disabled={busy}>
          Reopen
        </Button>
      )}
    </li>
  );
}

function TimelineRow({
  item,
  index,
  onOpenCheckpoint,
  onOpenCr,
}: {
  item: TimelineItem;
  index: number;
  onOpenCheckpoint: (sha: string) => void;
  onOpenCr: (crId: string) => void;
}) {
  if (item.kind === 'checkpoint') {
    return <CheckpointRow commit={item.commit} index={index} onOpen={onOpenCheckpoint} />;
  }
  return <ChangeRequestRow cr={item.cr} onOpen={onOpenCr} />;
}

function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul className={LIST_CLASS}>
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 px-4 py-2.5">
          <Skeleton className="size-9 shrink-0 rounded-sm" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/3 rounded-sm" />
            <Skeleton className="h-3 w-1/3 rounded-sm" />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// section
// ---------------------------------------------------------------------------

export function ChangesView({ projectId }: { projectId: string }) {
  const projectQuery = useQuery({
    queryKey: ['projects', projectId, 'meta'],
    queryFn: () => getProject(projectId),
    staleTime: 60_000,
  });
  const defaultBranch = projectQuery.data?.default_branch ?? '';

  return (
    <ProjectFilesProvider value={{ projectId, ref: defaultBranch, defaultBranch }}>
      <ChangesTimeline defaultBranch={defaultBranch} projectLoading={projectQuery.isLoading} />
    </ProjectFilesProvider>
  );
}

function ChangesTimeline({
  defaultBranch,
  projectLoading,
}: {
  defaultBranch: string;
  projectLoading: boolean;
}) {
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [detailCrId, setDetailCrId] = useState<string | null>(null);

  const commitsQuery = useCommits({ limit: 50, enabled: Boolean(defaultBranch) });
  const crsQuery = useChangeRequests('all', { refetchInterval: 8_000 });

  const commits = useMemo(() => commitsQuery.data?.commits ?? [], [commitsQuery.data]);
  const crs = useMemo(() => crsQuery.data?.change_requests ?? [], [crsQuery.data]);
  const timeline = useMemo(() => buildTimeline(commits, crs), [commits, crs]);
  const groups = useMemo(() => groupTimeline(timeline), [timeline]);
  const shaList = useMemo(() => commits.map((c) => c.hash), [commits]);

  const loading =
    projectLoading || crsQuery.isLoading || (Boolean(defaultBranch) && commitsQuery.isLoading);
  const isFetching = commitsQuery.isFetching || crsQuery.isFetching;

  const refresh = (
    <Hint label="Refresh changes" side="bottom">
      <Button
        variant="outline"
        size="icon"
        onClick={() => {
          void commitsQuery.refetch();
          void crsQuery.refetch();
        }}
        disabled={isFetching || !defaultBranch}
      >
        {isFetching ? <Loading className="size-4 shrink-0" /> : <Refresh className="size-4" />}
      </Button>
    </Hint>
  );

  const hasContent = timeline.length > 0;
  const commitsFailed = commitsQuery.isError;
  const crsFailed = crsQuery.isError;

  return (
    <CustomizeSectionWrapper
      title="Checkpoint"
      description="Review open change requests and browse every checkpoint your agents saved."
      action={hasContent ? refresh : undefined}
    >
      {loading ? (
        <div className="space-y-6">
          <div className="flex items-center gap-1.5 px-1">
            <Skeleton className="h-3 w-12 rounded-sm" />
          </div>
          <ListSkeleton rows={6} />
        </div>
      ) : commitsFailed && crsFailed ? (
        <ErrorState
          size="sm"
          title="Couldn't load changes"
          description={
            commitsQuery.error instanceof Error ? commitsQuery.error.message : 'Please try again.'
          }
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void commitsQuery.refetch();
                void crsQuery.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      ) : !hasContent ? (
        <EmptyState
          icon={GitPullRequest}
          size="sm"
          title="No changes yet"
          description="When a session opens a change request or your agents save work, it shows up here."
        />
      ) : (
        <div className="space-y-6">
          {(commitsFailed || crsFailed) && (
            <ErrorState
              size="sm"
              title={commitsFailed ? "Couldn't load checkpoints" : "Couldn't load change requests"}
              description="Showing what loaded — retry to refresh."
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (commitsFailed) void commitsQuery.refetch();
                    if (crsFailed) void crsQuery.refetch();
                  }}
                >
                  Retry
                </Button>
              }
            />
          )}
          {groups.map((group) => (
            <section key={group.label} className="space-y-2">
              <div className="flex items-center gap-1.5 px-1">
                <h3 className="text-muted-foreground text-xs font-medium">{group.label}</h3>
                <span className="text-muted-foreground/40 text-xs tabular-nums">
                  {group.items.length}
                </span>
              </div>
              <ul className={LIST_CLASS}>
                {group.items.map((item, i) => (
                  <TimelineRow
                    key={item.key}
                    item={item}
                    index={i}
                    onOpenCheckpoint={setSelectedSha}
                    onOpenCr={setDetailCrId}
                  />
                ))}
              </ul>
            </section>
          ))}
          {commitsQuery.data?.hasMore && (
            <p className="text-muted-foreground/60 px-1 text-xs">
              Showing the {commits.length} most recent checkpoints.
            </p>
          )}
        </div>
      )}

      <CheckpointDetailDialog
        sha={selectedSha}
        shaList={shaList}
        onSelectSha={setSelectedSha}
        onClose={() => setSelectedSha(null)}
      />
      <ChangeRequestDetailDialog crId={detailCrId} onClose={() => setDetailCrId(null)} />
    </CustomizeSectionWrapper>
  );
}
