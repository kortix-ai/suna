'use client';

import { useTranslations } from 'next-intl';

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
import { toast } from '@/lib/toast';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { InfoBanner } from '@/components/ui/info-banner';
import { UnifiedMarkdown } from '@/components/markdown';
import { DiffRenderer } from './diff-renderer';
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
  const map: Record<
    ChangeRequestStatus,
    { icon: React.ReactNode; label: string; variant: React.ComponentProps<typeof Badge>['variant'] }
  > = {
    open: {
      icon: <GitPullRequest className="h-3 w-3" />,
      label: 'Open',
      variant: 'success',
    },
    merged: {
      icon: <GitMerge className="h-3 w-3" />,
      label: 'Merged',
      variant: 'info',
    },
    closed: {
      icon: <GitPullRequestClosed className="h-3 w-3" />,
      label: 'Closed',
      variant: 'secondary',
    },
  };
  const m = map[status];
  return (
    <Badge variant={m.variant} size="sm">
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

/**
 * Split a unified diff that touches multiple files into one chunk per file.
 * Pierre's `PatchDiff` (and our `DiffRenderer` wrapper) only renders a single
 * file per call, so a multi-file CR has to be sliced before rendering.
 */
function splitUnifiedPatch(patch: string): Array<{ path: string; body: string }> {
  if (!patch || !patch.trim()) return [];
  // Each file diff in `git diff` output begins with `diff --git a/<src> b/<dst>`.
  // Split before each such header so the resulting array contains
  // self-contained per-file patches.
  const chunks = patch.split(/^(?=diff --git )/m).filter((c) => c.trim().length > 0);
  return chunks.map((body) => {
    // The destination path (post-rename) is what the file list shows.
    const match = body.match(/^diff --git a\/(?:.*?) b\/(.+?)$/m);
    const path = match ? match[1] : '';
    return { path, body };
  });
}

interface ChangeRequestDetailDialogProps {
  crId: string | null;
  onClose: () => void;
}

export function ChangeRequestDetailDialog({ crId, onClose }: ChangeRequestDetailDialogProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
      <DialogContent
        hideCloseButton
        className="max-w-4xl p-0 gap-0 overflow-hidden max-h-[88vh] flex flex-col"
      >
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
                  <h2 className="text-sm font-medium leading-tight">{cr.title}</h2>
                  <StatusBadge status={cr.status} />
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground flex-wrap">
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

        {/* Native overflow scrolling — Radix ScrollArea's viewport doesn't
            reliably bound its height inside this flex dialog, so the body
            wouldn't scroll. A plain min-h-0 + overflow-y-auto flex child does. */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          <div className="px-5 py-4 space-y-3">
            {/* Description — authored by the agent as markdown (headings,
                lists, code, links), so render it as such rather than raw text. */}
            {cr?.description && (
              <div className="text-sm text-muted-foreground">
                <UnifiedMarkdown content={cr.description} />
              </div>
            )}

            {/* Merge state banner */}
            {cr?.status === 'open' && preview && (
              preview.is_up_to_date ? (
                <InfoBanner tone="neutral" icon={RefreshCcw} className="px-3 py-2">{tHardcodedUi.raw('featuresProjectFilesComponentsChangeRequestDetailDialog.line269JsxTextThisVersionIsAlreadyAtTheBaseNothing')}</InfoBanner>
              ) : preview.can_merge ? (
                <InfoBanner tone="success" icon={Check} className="px-3 py-2">{tHardcodedUi.raw('featuresProjectFilesComponentsChangeRequestDetailDialog.line273JsxTextMergeableCleanly')}{' '}{preview.can_fast_forward ? ' (fast-forward)' : ' (3-way merge)'}.
                </InfoBanner>
              ) : (
                <InfoBanner
                  tone="warning"
                  icon={AlertTriangle}
                  className="px-3 py-2"
                  title={
                    <>{tHardcodedUi.raw('featuresProjectFilesComponentsChangeRequestDetailDialog.line283JsxTextConflictsIn')}{' '}{preview.conflicts.length} file
                      {preview.conflicts.length === 1 ? '' : 's'}
                    </>
                  }
                >
                  <ul className="mt-1 list-disc pl-5 font-mono">
                    {preview.conflicts.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </InfoBanner>
              )
            )}

            {cr?.status === 'merged' && (
              <InfoBanner tone="neutral" icon={GitMerge} className="items-center px-3 py-2">
                Merged
                {cr.merge_commit_sha && (
                  <>
                    {' as '}
                    <span className="font-mono">{cr.merge_commit_sha.slice(0, 7)}</span>
                  </>
                )}
                {cr.merged_at && <> · {relativeTime(cr.merged_at)}</>}
              </InfoBanner>
            )}

            {/* Files changed list + unified diff */}
            {diffQuery.isLoading ? (
              <Skeleton className="h-32 w-full rounded-2xl" />
            ) : diff && diff.files.length > 0 ? (
              <div className="rounded-2xl border border-border/60 bg-card overflow-hidden">
                <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
                  <h3 className="text-xs font-medium text-foreground">
                    {diff.files.length} file{diff.files.length === 1 ? '' : 's'} changed
                  </h3>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    <span className="text-emerald-600">+{totalLines.adds}</span>{' '}
                    <span className="text-red-600">-{totalLines.dels}</span>
                  </span>
                </div>
                <div className="divide-y divide-border/40">
                  {diff.files.map((f) => (
                    <div key={f.path} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                      <FileStatusIcon status={f.status} />
                      <span className="font-mono text-foreground truncate">{f.path}</span>
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                        <span className="text-emerald-600">+{f.additions}</span>{' '}
                        <span className="text-red-600">-{f.deletions}</span>
                      </span>
                    </div>
                  ))}
                </div>
                {diff.patch && (
                  <div className="border-t border-border/60">
                    {splitUnifiedPatch(diff.patch).map((chunk, i) => (
                      <div
                        key={chunk.path || i}
                        className="border-b border-border/40 last:border-b-0"
                      >
                        {chunk.path && (
                          <div className="flex items-center gap-2 bg-muted/30 px-3 py-1.5 text-xs font-mono text-muted-foreground border-b border-border/40">
                            {chunk.path}
                          </div>
                        )}
                        <DiffRenderer patch={chunk.body} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="rounded-2xl border border-dashed border-border/60 p-5 text-center text-xs text-muted-foreground">{tHardcodedUi.raw('featuresProjectFilesComponentsChangeRequestDetailDialog.line356JsxTextNoChangesDetected')}</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
