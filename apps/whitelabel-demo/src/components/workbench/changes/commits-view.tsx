'use client';

/**
 * The "Commits" tab of the workbench changes panel: the "Commit session changes"
 * box (`session.commit`), branches (`git.branches`), the commit list
 * (`git.commits`) with a detail dialog (`git.commit`, `git.commitDiff`), and the
 * compare-to-base summary (`git.versionDiff`). Everything routes through the
 * `@kortix/sdk` facade — no raw HTTP.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { kortix } from '@/lib/kortix';
import { relativeTime } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Scale,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DiffStat, DiffView } from './diff-view';

export function CommitsView({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const qc = useQueryClient();
  const [message, setMessage] = useState('');
  const [openSha, setOpenSha] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);

  const branches = useQuery({
    queryKey: ['project-branches', projectId],
    queryFn: () => kortix.project(projectId).git.branches(),
  });

  const commits = useQuery({
    queryKey: ['project-commits', projectId],
    queryFn: () => kortix.project(projectId).git.commits(),
  });

  const defaultBranch = (branches.data as any)?.default_branch as string | undefined;

  // "Compare to base": summarize the session branch against the default branch.
  const versionDiff = useQuery({
    queryKey: ['project-version-diff', projectId, defaultBranch, sessionId],
    enabled: comparing && !!defaultBranch,
    queryFn: () =>
      kortix.project(projectId).git.versionDiff({
        from: defaultBranch as string,
        into: sessionId,
      }),
  });

  const commitSession = useMutation({
    mutationFn: () =>
      kortix.session(projectId, sessionId).commit(
        message.trim() ? { message: message.trim() } : undefined,
      ),
    onSuccess: (res) => {
      const r = res as any;
      if (r?.nothing_to_do) {
        toast.info('Nothing to commit');
      } else {
        toast.success(
          r?.pushed ? 'Committed and pushed session changes' : 'Committed session changes',
        );
      }
      setMessage('');
      qc.invalidateQueries({ queryKey: ['project-commits', projectId] });
      qc.invalidateQueries({ queryKey: ['project-branches', projectId] });
    },
    onError: () => toast.error('Could not commit session changes'),
  });

  const branchItems: any[] = (branches.data as any)?.branches ?? [];
  const commitItems: any[] = (commits.data as any)?.commits ?? [];
  const vd = versionDiff.data as any;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Commit session changes */}
      <Card className="shrink-0">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <GitCommitHorizontal className="size-4 text-muted-foreground" />
            Commit session changes
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Commit message (optional)"
            rows={2}
            className="resize-none font-mono text-xs"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[0.7rem] text-muted-foreground">
              {sessionId}
            </span>
            <Button
              size="sm"
              onClick={() => commitSession.mutate()}
              disabled={commitSession.isPending}
            >
              {commitSession.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
              Commit
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Compare to base */}
      <Card className="shrink-0">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2">
              <Scale className="size-4 text-muted-foreground" />
              Compare to base
            </span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => setComparing(true)}
              disabled={!defaultBranch || versionDiff.isFetching}
            >
              {versionDiff.isFetching ? (
                <Loader2 className="size-3 animate-spin" />
              ) : null}
              Compare
            </Button>
          </CardTitle>
        </CardHeader>
        {comparing && (
          <CardContent className="text-xs text-muted-foreground">
            {versionDiff.isLoading ? (
              <Skeleton className="h-4 w-40" />
            ) : vd ? (
              vd.is_same_ref ? (
                <span>Session is on the base branch.</span>
              ) : vd.is_up_to_date ? (
                <span>Up to date with base.</span>
              ) : (
                <span className="flex items-center gap-2">
                  <span className="font-mono text-foreground/80">
                    {vd.from} → {vd.into}
                  </span>
                  <span>{vd.files_changed} files</span>
                  <DiffStat additions={vd.additions} deletions={vd.deletions} />
                </span>
              )
            ) : (
              <span>No diff available.</span>
            )}
          </CardContent>
        )}
      </Card>

      {/* Branches */}
      <div className="shrink-0">
        <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-xs font-medium text-muted-foreground">
          <GitBranch className="size-3.5" />
          Branches
        </div>
        {branches.isLoading ? (
          <Skeleton className="h-8 w-full" />
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {branchItems.map((b) => (
              <Badge
                key={b.name}
                variant={b.is_default ? 'default' : 'outline'}
                className="gap-1 font-mono"
                title={`${b.subject ?? ''} · ${b.committer_name ?? ''}`}
              >
                <GitBranch className="size-3" />
                {b.name}
                {b.is_default && <span className="opacity-70">(default)</span>}
              </Badge>
            ))}
            {branchItems.length === 0 && (
              <span className="text-xs text-muted-foreground">No branches.</span>
            )}
          </div>
        )}
      </div>

      <Separator />

      {/* Commit list */}
      <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-xs font-medium text-muted-foreground">
        <GitCommitHorizontal className="size-3.5" />
        Commits
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 pr-2">
          {commits.isLoading ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </>
          ) : commitItems.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              No commits yet.
            </div>
          ) : (
            commitItems.map((c) => (
              <button
                key={c.hash}
                onClick={() => setOpenSha(c.hash)}
                className="flex w-full items-start gap-2 rounded-lg border border-border bg-card/50 px-2.5 py-2 text-left transition-colors hover:bg-card"
              >
                <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">
                    {c.subject || '(no message)'}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[0.7rem] text-muted-foreground">
                    <span className="font-mono">{c.short_hash}</span>
                    <span>{c.author_name}</span>
                    <span>{relativeTime(c.committed_at ?? c.authored_at)}</span>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </ScrollArea>

      <CommitDetailDialog
        projectId={projectId}
        sha={openSha}
        onClose={() => setOpenSha(null)}
      />
    </div>
  );
}

/** A commit's metadata (`git.commit`) + patch (`git.commitDiff`) in a dialog. */
function CommitDetailDialog({
  projectId,
  sha,
  onClose,
}: {
  projectId: string;
  sha: string | null;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: ['project-commit', projectId, sha],
    enabled: !!sha,
    queryFn: () => kortix.project(projectId).git.commit(sha as string),
  });

  const diff = useQuery({
    queryKey: ['project-commit-diff', projectId, sha],
    enabled: !!sha,
    queryFn: () => kortix.project(projectId).git.commitDiff(sha as string),
  });

  const d = detail.data as any;
  const files: any[] = d?.files ?? [];

  return (
    <Dialog open={!!sha} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col">
        <DialogHeader>
          <DialogTitle className="truncate">
            {d?.subject ?? 'Commit'}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2 font-mono text-xs">
            <span>{d?.short_hash ?? sha?.slice(0, 7)}</span>
            {d?.author_name && <span>· {d.author_name}</span>}
            {d?.committed_at && <span>· {relativeTime(d.committed_at)}</span>}
          </DialogDescription>
        </DialogHeader>

        {d?.body && (
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">{d.body}</p>
        )}

        {files.length > 0 && (
          <div className="space-y-0.5 rounded-md border border-border p-2">
            {files.map((f, i) => (
              <div
                key={`${f.path}-${i}`}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span className="truncate font-mono text-foreground/80">
                  <span className="mr-1.5 text-muted-foreground">[{f.status}]</span>
                  {f.path}
                </span>
                <DiffStat additions={f.additions} deletions={f.deletions} />
              </div>
            ))}
          </div>
        )}

        <ScrollArea className="min-h-0 flex-1">
          {diff.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <DiffView patch={(diff.data as any)?.patch} />
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
