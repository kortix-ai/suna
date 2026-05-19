'use client';

import { useMemo } from 'react';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import {
  AlertTriangle,
  Check,
  FileEdit,
  FilePlus2,
  FileX2,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Loader2,
  RefreshCcw,
  RotateCcw,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { DiffRenderer } from './diff-renderer';
import { cn } from '@/lib/utils';
import {
  useChangeRequest,
  useChangeRequestDiff,
  useChangeRequestMergePreview,
  useCloseChangeRequest,
  useMergeChangeRequest,
  useReopenChangeRequest,
} from '../hooks/use-change-requests';
import type { ChangeRequestStatus } from '../api/change-requests';

function relativeTime(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function StatusBadge({ status }: { status: ChangeRequestStatus }) {
  const map: Record<ChangeRequestStatus, { icon: React.ReactNode; label: string; className: string }> = {
    open: {
      icon: <GitPullRequest className="h-3 w-3" />,
      label: 'Open',
      className: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
    },
    merged: {
      icon: <GitMerge className="h-3 w-3" />,
      label: 'Merged',
      className: 'bg-violet-500/10 text-violet-600 border-violet-500/20',
    },
    closed: {
      icon: <GitPullRequestClosed className="h-3 w-3" />,
      label: 'Closed',
      className: 'bg-muted text-muted-foreground border-border',
    },
  };
  const m = map[status];
  return (
    <Badge
      variant="outline"
      className={cn('gap-1 rounded-md px-1.5 py-0 text-[10px] font-medium', m.className)}
    >
      {m.icon}
      {m.label}
    </Badge>
  );
}

function FileStatusIcon({ status }: { status: string }) {
  if (status === 'added') return <FilePlus2 className="h-3.5 w-3.5 text-emerald-500" />;
  if (status === 'deleted') return <FileX2 className="h-3.5 w-3.5 text-red-500" />;
  return <FileEdit className="h-3.5 w-3.5 text-blue-500" />;
}

interface ChangeRequestDetailDialogProps {
  crId: string | null;
  onClose: () => void;
}

export function ChangeRequestDetailDialog({ crId, onClose }: ChangeRequestDetailDialogProps) {
  const open = crId !== null;
  const detailQuery = useChangeRequest(crId);
  const diffQuery = useChangeRequestDiff(crId);
  const previewQuery = useChangeRequestMergePreview(
    crId,
    detailQuery.data?.change_request.status === 'open',
  );

  const mergeMutation = useMergeChangeRequest();
  const closeMutation = useCloseChangeRequest();
  const reopenMutation = useReopenChangeRequest();

  const cr = detailQuery.data?.change_request;
  const diff = diffQuery.data;
  const preview = previewQuery.data;

  const totalLines = useMemo(() => {
    if (!diff) return { adds: 0, dels: 0 };
    return { adds: diff.additions, dels: diff.deletions };
  }, [diff]);

  const handleMerge = () => {
    if (!crId) return;
    mergeMutation.mutate(crId, {
      onSuccess: (res) => {
        toast.success(
          res.merge.fast_forward
            ? 'Merged (fast-forward)'
            : `Merged ${res.merge.merge_commit_sha.slice(0, 7)}`,
        );
      },
      onError: (err) => toast.error(err.message),
    });
  };

  const handleClose = () => {
    if (!crId) return;
    closeMutation.mutate(crId, {
      onSuccess: () => toast.success('Change request closed'),
      onError: (err) => toast.error(err.message),
    });
  };

  const handleReopen = () => {
    if (!crId) return;
    reopenMutation.mutate(crId, {
      onSuccess: () => toast.success('Change request reopened'),
      onError: (err) => toast.error(err.message),
    });
  };

  const dialogTitle = cr ? `#${cr.number} ${cr.title}` : 'Change request';

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl p-0 gap-0 overflow-hidden max-h-[88vh] flex flex-col">
        {/* Always render a DialogTitle for a11y; visually hidden when we have
            our custom header layout to avoid double-rendering. */}
        <VisuallyHidden>
          <DialogTitle>{dialogTitle}</DialogTitle>
        </VisuallyHidden>

        <DialogHeader className="flex flex-row items-center gap-3 border-b border-border/40 px-5 py-3 space-y-0">
          <div className="flex-1 min-w-0">
            {!cr ? (
              <div className="space-y-1.5">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    #{cr.number}
                  </span>
                  <h2 className="text-[15px] font-medium leading-tight">{cr.title}</h2>
                  <StatusBadge status={cr.status} />
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground flex-wrap">
                  <GitBranch className="h-3 w-3" />
                  <span className="font-mono">{cr.head_ref}</span>
                  <span className="text-muted-foreground/60">→</span>
                  <span className="font-mono">{cr.base_ref}</span>
                  <span className="text-muted-foreground/40">·</span>
                  <span>opened {relativeTime(cr.created_at)}</span>
                  {cr.head_commit_sha && (
                    <>
                      <span className="text-muted-foreground/40">·</span>
                      <span className="font-mono">{cr.head_commit_sha.slice(0, 7)}</span>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
          {/* Action buttons */}
          <div className="flex items-center gap-1.5 shrink-0">
            {cr?.status === 'open' && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleClose}
                  disabled={closeMutation.isPending}
                  className="text-muted-foreground h-8"
                >
                  <X className="mr-1 h-3.5 w-3.5" />
                  Close
                </Button>
                <Button
                  size="sm"
                  disabled={mergeMutation.isPending || preview?.can_merge === false}
                  onClick={handleMerge}
                  className="h-8"
                >
                  {mergeMutation.isPending ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <GitMerge className="mr-1 h-3.5 w-3.5" />
                  )}
                  Merge
                </Button>
              </>
            )}
            {cr?.status === 'closed' && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleReopen}
                disabled={reopenMutation.isPending}
                className="h-8"
              >
                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                Reopen
              </Button>
            )}
          </div>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-5 py-4 space-y-3">
            {/* Description */}
            {cr?.description && (
              <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
                {cr.description}
              </p>
            )}

            {/* Merge state banner */}
            {cr?.status === 'open' && preview && (
              <div
                className={cn(
                  'rounded-md border px-3 py-2 text-xs flex items-start gap-2',
                  preview.is_up_to_date
                    ? 'border-border bg-muted/40 text-muted-foreground'
                    : preview.can_merge
                      ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400'
                      : 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400',
                )}
              >
                {preview.is_up_to_date ? (
                  <>
                    <RefreshCcw className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>This version is already at the base — nothing to merge.</span>
                  </>
                ) : preview.can_merge ? (
                  <>
                    <Check className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>
                      Mergeable cleanly
                      {preview.can_fast_forward ? ' (fast-forward)' : ' (3-way merge)'}.
                    </span>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <div className="font-medium">
                        Conflicts in {preview.conflicts.length} file
                        {preview.conflicts.length === 1 ? '' : 's'}
                      </div>
                      <ul className="mt-1 list-disc pl-5 font-mono">
                        {preview.conflicts.map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                    </div>
                  </>
                )}
              </div>
            )}

            {cr?.status === 'merged' && (
              <div className="rounded-md border border-violet-500/30 bg-violet-500/5 px-3 py-2 text-xs text-violet-700 dark:text-violet-400 flex items-center gap-2">
                <GitMerge className="h-3.5 w-3.5" />
                <span>
                  Merged
                  {cr.merge_commit_sha && (
                    <>
                      {' as '}
                      <span className="font-mono">{cr.merge_commit_sha.slice(0, 7)}</span>
                    </>
                  )}
                  {cr.merged_at && <> · {relativeTime(cr.merged_at)}</>}
                </span>
              </div>
            )}

            {/* Files changed list + unified diff */}
            {diffQuery.isLoading ? (
              <Skeleton className="h-32 w-full rounded-md" />
            ) : diff && diff.files.length > 0 ? (
              <div className="rounded-md border border-border/60 bg-card overflow-hidden">
                <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
                  <h3 className="text-xs font-medium text-foreground">
                    {diff.files.length} file{diff.files.length === 1 ? '' : 's'} changed
                  </h3>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    <span className="text-emerald-600">+{totalLines.adds}</span>{' '}
                    <span className="text-red-600">-{totalLines.dels}</span>
                  </span>
                </div>
                <div className="divide-y divide-border/40">
                  {diff.files.map((f) => (
                    <div key={f.path} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                      <FileStatusIcon status={f.status} />
                      <span className="font-mono text-foreground truncate">{f.path}</span>
                      <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                        <span className="text-emerald-600">+{f.additions}</span>{' '}
                        <span className="text-red-600">-{f.deletions}</span>
                      </span>
                    </div>
                  ))}
                </div>
                {diff.patch && (
                  <div className="border-t border-border/60">
                    <DiffRenderer patch={diff.patch} />
                  </div>
                )}
              </div>
            ) : (
              <p className="rounded-md border border-dashed border-border/60 p-5 text-center text-xs text-muted-foreground">
                No changes detected.
              </p>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
