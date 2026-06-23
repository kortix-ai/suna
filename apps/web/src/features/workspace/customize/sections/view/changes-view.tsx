'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsListCompact,
  TabsTrigger,
  TabsTriggerCompact,
} from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ProjectFilesProvider } from '@/features/project-files';
import { ChangeRequestDetailDialog } from '@/features/project-files/components/change-request-detail-dialog';
import {
  useChangeRequests,
  useCloseChangeRequest,
  useMergeChangeRequest,
  useReopenChangeRequest,
} from '@/features/project-files/hooks/use-change-requests';
import { getProject, listProjectBranches, type ChangeRequestStatus } from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import {
  GitBranch,
  GitMerge,
  GitMergeSolid,
  GitPullRequest,
  XCircleSolid,
} from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import CustomizeSectionWrapper from '../component/section-wrapper';

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
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [tab, setTab] = useState<'crs' | 'versions'>('crs');
  const [detailCrId, setDetailCrId] = useState<string | null>(null);

  const openCount =
    useChangeRequests('open', { refetchInterval: 8_000 }).data?.change_requests.length ?? 0;

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <CustomizeSectionWrapper title="Changes" description="Review and merge change requests">
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as 'crs' | 'versions')}
          className="space-y-6"
        >
          <TabsList type="underline" className="flex w-full items-center justify-start">
            <TabsTrigger value="crs" className="w-fit flex-none">
              Change Requests
            </TabsTrigger>
            <TabsTrigger value="versions" className="w-fit flex-none">
              Versions
            </TabsTrigger>
          </TabsList>

          <TabsContent value="crs">
            <ChangeRequestsTab onOpenDetail={setDetailCrId} />
          </TabsContent>

          <TabsContent value="versions">
            <VersionsTab projectId={projectId} />
          </TabsContent>
        </Tabs>

        <ChangeRequestDetailDialog crId={detailCrId} onClose={() => setDetailCrId(null)} />
      </CustomizeSectionWrapper>
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
        successToast(
          res.merge.fast_forward
            ? 'Merged (fast-forward)'
            : `Merged ${res.merge.merge_commit_sha.slice(0, 7)}`,
        ),
      onError: (err) => errorToast(err.message),
    });
  const onClose = (crId: string) =>
    close.mutate(crId, {
      onSuccess: () => successToast('Change request rejected'),
      onError: (err) => errorToast(err.message),
    });
  const onReopen = (crId: string) =>
    reopen.mutate(crId, {
      onSuccess: () => successToast('Change request reopened'),
      onError: (err) => errorToast(err.message),
    });

  return (
    <Tabs
      value={status}
      onValueChange={(value) => setStatus(value as ChangeRequestStatus)}
      className="space-y-4"
    >
      <TabsListCompact>
        {STATUS_FILTERS.map((f) => (
          <TabsTriggerCompact key={f.value} value={f.value}>
            {f.label}
          </TabsTriggerCompact>
        ))}
      </TabsListCompact>

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
                className="group bg-popover flex items-center gap-3 rounded-md border px-4 py-2 transition-colors"
              >
                <span
                  className={cn(
                    'flex size-9 items-center justify-center rounded-sm',
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
                <button
                  type="button"
                  onClick={() => onOpenDetail(cr.cr_id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground text-sm">#{cr.number}</span>
                    <span className="text-foreground truncate text-sm font-medium">{cr.title}</span>
                  </div>
                  <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
                    <span className="max-w-[140px] truncate font-mono">{cr.head_ref}</span>
                    <span className="text-muted-foreground/40">&rarr;</span>
                    <Badge variant="kortix" size="xs">
                      {cr.base_ref}
                    </Badge>
                    <span className="text-muted-foreground/40">&bull;</span>
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
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onClose(cr.cr_id)}
                      disabled={busy}
                    >
                      Reject
                    </Button>
                    <Button size="sm" onClick={() => onMerge(cr.cr_id)} disabled={busy}>
                      {busy ? (
                        <Loading className="size-3.5 animate-spin" />
                      ) : (
                        <GitMerge className="size-3.5" />
                      )}
                      Merge
                    </Button>
                  </div>
                )}
                {cr.status === 'closed' && (
                  <Button
                    variant="secondary"
                    size="sm"
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
    </Tabs>
  );
}

function VersionsTab({ projectId }: { projectId: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
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
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (branches.length === 0) {
    return (
      <EmptyState
        icon={GitBranch}
        size="sm"
        title={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsChangesViewJsxAttrTitleNoc31e05e1',
        )}
        description={tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsChangesViewJsxAttrDescriptionBranches801ec5e2',
        )}
      />
    );
  }

  return (
    <ul className="space-y-2">
      {branches.map((b) => (
        <li
          key={b.name}
          className="group bg-popover flex items-center gap-3 rounded-md border px-4 py-2 transition-colors"
        >
          <span
            className={cn(
              'flex size-9 items-center justify-center rounded-sm',
              b.is_default ? 'bg-kortix-green/15' : 'bg-kortix-base/15',
            )}
          >
            <GitBranch
              className={cn('size-5', b.is_default ? 'text-kortix-green' : 'text-kortix-base')}
            />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-foreground truncate text-sm font-medium">
                {b.subject || '(no commits)'}
              </span>
              {b.is_default && (
                <Badge variant="kortix" size="xs">
                  default
                </Badge>
              )}
            </div>
            <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
              <span className="truncate">{b.name}</span>
              {b.committed_at && (
                <>
                  <span className="text-muted-foreground/40">&bull;</span>
                  <span className="shrink-0">{rel(b.committed_at)}</span>
                </>
              )}
            </div>
          </div>
          {!b.is_default && (b.ahead != null || b.behind != null) && (
            <span className="text-muted-foreground/70 shrink-0 font-mono text-xs tabular-nums">
              {b.ahead != null && `↑${b.ahead}`} {b.behind != null && `↓${b.behind}`}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
