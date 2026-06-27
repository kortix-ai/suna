'use client';

/**
 * The git / changes view for the white-label workbench. A single panel with two
 * tabs — "Commits" (the project's git history + session commit + base compare)
 * and "Change requests" (Kortix's native PR layer). Everything routes through the
 * `@kortix/sdk` facade: `kortix.project(id).git.*`, `.changeRequests.*`, and the
 * session-scoped `kortix.session(id, sid).commit()`. No raw HTTP.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { kortix } from '@/lib/kortix';
import { cn, relativeTime } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Loader2,
  Plus,
  RotateCcw,
  Scale,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** Render a unified-diff patch as a colored monospace block. */
function DiffView({ patch }: { patch?: string | null }) {
  const text = (patch ?? '').toString();
  if (!text.trim()) {
    return (
      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
        No changes to show.
      </div>
    );
  }
  const lines = text.split('\n');
  return (
    <pre className="overflow-auto whitespace-pre rounded-md bg-muted/40 p-2 font-mono text-[0.7rem] leading-relaxed scrollbar-thin">
      {lines.map((line, i) => {
        const isMeta =
          line.startsWith('+++') ||
          line.startsWith('---') ||
          line.startsWith('diff ') ||
          line.startsWith('index ');
        const isHunk = line.startsWith('@@');
        const isAdd = !isMeta && line.startsWith('+');
        const isRemove = !isMeta && line.startsWith('-');
        return (
          <div
            key={i}
            className={cn(
              'px-1',
              isHunk && 'text-brand',
              isMeta && 'text-muted-foreground',
              isAdd && 'bg-emerald-500/10 text-emerald-500',
              isRemove && 'bg-destructive/10 text-destructive',
              !isHunk && !isMeta && !isAdd && !isRemove && 'text-foreground/80',
            )}
          >
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

/** +adds / -removes summary chips. */
function DiffStat({ additions, deletions }: { additions?: number; deletions?: number }) {
  return (
    <span className="flex items-center gap-1.5 font-mono text-[0.7rem]">
      <span className="text-emerald-500">+{additions ?? 0}</span>
      <span className="text-destructive">-{deletions ?? 0}</span>
    </span>
  );
}

const CR_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  open: 'default',
  merged: 'secondary',
  closed: 'outline',
};

// ---------------------------------------------------------------------------
// Commits tab
// ---------------------------------------------------------------------------

function CommitsTab({
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

// ---------------------------------------------------------------------------
// Change requests tab
// ---------------------------------------------------------------------------

function ChangeRequestsTab({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const qc = useQueryClient();
  const [selectedCrId, setSelectedCrId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['change-requests', projectId],
    queryFn: () => kortix.project(projectId).changeRequests.list(),
  });

  const items: any[] = (list.data as any)?.change_requests ?? [];

  if (selectedCrId) {
    return (
      <ChangeRequestDetail
        projectId={projectId}
        crId={selectedCrId}
        onBack={() => setSelectedCrId(null)}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <GitPullRequest className="size-3.5" />
          Change requests
        </div>
        <OpenChangeRequestDialog
          projectId={projectId}
          sessionId={sessionId}
          onOpened={() => {
            qc.invalidateQueries({ queryKey: ['change-requests', projectId] });
          }}
        />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 pr-2">
          {list.isLoading ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </>
          ) : items.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              No change requests.
            </div>
          ) : (
            items.map((cr) => (
              <button
                key={cr.cr_id}
                onClick={() => setSelectedCrId(cr.cr_id)}
                className="flex w-full items-start gap-2 rounded-lg border border-border bg-card/50 px-2.5 py-2 text-left transition-colors hover:bg-card"
              >
                <GitPullRequest className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">
                    <span className="text-muted-foreground">#{cr.number}</span>{' '}
                    {cr.title}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[0.7rem] text-muted-foreground">
                    <span>{cr.head_ref}</span>
                    <ArrowLeft className="size-3 rotate-180" />
                    <span>{cr.base_ref}</span>
                  </div>
                </div>
                <Badge
                  variant={CR_STATUS_VARIANT[cr.status] ?? 'outline'}
                  className="shrink-0"
                >
                  {cr.status}
                </Badge>
              </button>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/** A single change request: detail (`get`) + merge preview + diff + actions. */
function ChangeRequestDetail({
  projectId,
  crId,
  onBack,
}: {
  projectId: string;
  crId: string;
  onBack: () => void;
}) {
  const qc = useQueryClient();

  const detail = useQuery({
    queryKey: ['change-request', projectId, crId],
    queryFn: () => kortix.project(projectId).changeRequests.get(crId),
  });

  const diff = useQuery({
    queryKey: ['change-request-diff', projectId, crId],
    queryFn: () => kortix.project(projectId).changeRequests.diff(crId),
  });

  const mergePreview = useQuery({
    queryKey: ['change-request-merge-preview', projectId, crId],
    queryFn: () => kortix.project(projectId).changeRequests.mergePreview(crId),
  });

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['change-requests', projectId] });
    qc.invalidateQueries({ queryKey: ['change-request', projectId, crId] });
    qc.invalidateQueries({ queryKey: ['change-request-diff', projectId, crId] });
    qc.invalidateQueries({
      queryKey: ['change-request-merge-preview', projectId, crId],
    });
  }

  const merge = useMutation({
    mutationFn: () => kortix.project(projectId).changeRequests.merge(crId),
    onSuccess: () => {
      toast.success('Change request merged');
      invalidate();
    },
    onError: () => toast.error('Could not merge change request'),
  });

  const close = useMutation({
    mutationFn: () => kortix.project(projectId).changeRequests.close(crId),
    onSuccess: () => {
      toast.success('Change request closed');
      invalidate();
    },
    onError: () => toast.error('Could not close change request'),
  });

  const reopen = useMutation({
    mutationFn: () => kortix.project(projectId).changeRequests.reopen(crId),
    onSuccess: () => {
      toast.success('Change request reopened');
      invalidate();
    },
    onError: () => toast.error('Could not reopen change request'),
  });

  const cr = detail.data as any;
  const mp = mergePreview.data as any;
  const df = diff.data as any;
  const status: string = cr?.status ?? 'open';
  const busy = merge.isPending || close.isPending || reopen.isPending;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          {detail.isLoading ? (
            <Skeleton className="h-4 w-40" />
          ) : (
            <div className="truncate text-sm font-medium">
              <span className="text-muted-foreground">#{cr?.number}</span> {cr?.title}
            </div>
          )}
        </div>
        <Badge variant={CR_STATUS_VARIANT[status] ?? 'outline'}>{status}</Badge>
      </div>

      {cr?.description && (
        <p className="shrink-0 whitespace-pre-wrap text-xs text-muted-foreground">
          {cr.description}
        </p>
      )}

      {/* Merge preview + actions */}
      <Card className="shrink-0">
        <CardContent className="space-y-2 py-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {mergePreview.isLoading ? (
              <Skeleton className="h-4 w-32" />
            ) : mp ? (
              <>
                <Badge variant={mp.can_merge ? 'secondary' : 'destructive'}>
                  {mp.can_merge ? 'Can merge' : 'Conflicts'}
                </Badge>
                {mp.can_fast_forward && <Badge variant="outline">Fast-forward</Badge>}
                {mp.is_up_to_date && <Badge variant="outline">Up to date</Badge>}
                {Array.isArray(mp.conflicts) && mp.conflicts.length > 0 && (
                  <span className="font-mono text-destructive">
                    {mp.conflicts.length} conflicting file(s)
                  </span>
                )}
              </>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {status === 'open' && (
              <>
                <Button
                  size="sm"
                  onClick={() => merge.mutate()}
                  disabled={busy || (mp && !mp.can_merge)}
                >
                  {merge.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <GitMerge className="size-3.5" />
                  )}
                  Merge
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => close.mutate()}
                  disabled={busy}
                >
                  {close.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <X className="size-3.5" />
                  )}
                  Close
                </Button>
              </>
            )}
            {status === 'closed' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => reopen.mutate()}
                disabled={busy}
              >
                {reopen.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="size-3.5" />
                )}
                Reopen
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Diff */}
      <div className="flex shrink-0 items-center justify-between px-0.5 text-xs font-medium text-muted-foreground">
        <span>
          {df?.files_changed ?? df?.files?.length ?? 0} files changed
        </span>
        {df && <DiffStat additions={df.additions} deletions={df.deletions} />}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {diff.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <DiffView patch={df?.patch} />
        )}
      </ScrollArea>
    </div>
  );
}

/** The "Open change request" form (`changeRequests.open`) in a dialog. */
function OpenChangeRequestDialog({
  projectId,
  sessionId,
  onOpened,
}: {
  projectId: string;
  sessionId: string;
  onOpened: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [headRef, setHeadRef] = useState(sessionId);
  const [baseRef, setBaseRef] = useState('');

  const openCr = useMutation({
    mutationFn: () =>
      kortix.project(projectId).changeRequests.open({
        title: title.trim(),
        description: description.trim() || undefined,
        head_ref: headRef.trim(),
        base_ref: baseRef.trim() || undefined,
        session_id: sessionId,
      }),
    onSuccess: () => {
      toast.success('Change request opened');
      onOpened();
      setOpen(false);
      setTitle('');
      setDescription('');
      setHeadRef(sessionId);
      setBaseRef('');
    },
    onError: () => toast.error('Could not open change request'),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-3.5" />
          Open
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Open change request</DialogTitle>
          <DialogDescription>
            Propose merging the session branch back into the base.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={3}
            className="resize-none"
          />
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="px-0.5 text-[0.7rem] text-muted-foreground">
                Head ref
              </label>
              <Input
                value={headRef}
                onChange={(e) => setHeadRef(e.target.value)}
                placeholder="head branch"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <label className="px-0.5 text-[0.7rem] text-muted-foreground">
                Base ref
              </label>
              <Input
                value={baseRef}
                onChange={(e) => setBaseRef(e.target.value)}
                placeholder="default branch"
                className="font-mono text-xs"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => openCr.mutate()}
            disabled={!title.trim() || !headRef.trim() || openCr.isPending}
          >
            {openCr.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <GitPullRequest className="size-3.5" />
            )}
            Open change request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function ChangesPanel({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <Tabs defaultValue="commits" className="flex h-full min-h-0 flex-col">
        <TabsList className="mx-3 mt-3 shrink-0 self-start">
          <TabsTrigger value="commits">
            <GitCommitHorizontal className="size-3.5" />
            Commits
          </TabsTrigger>
          <TabsTrigger value="change-requests">
            <GitPullRequest className="size-3.5" />
            Change requests
          </TabsTrigger>
        </TabsList>
        <TabsContent
          value="commits"
          className="min-h-0 flex-1 overflow-hidden p-3 data-[state=inactive]:hidden"
        >
          <CommitsTab projectId={projectId} sessionId={sessionId} />
        </TabsContent>
        <TabsContent
          value="change-requests"
          className="min-h-0 flex-1 overflow-hidden p-3 data-[state=inactive]:hidden"
        >
          <ChangeRequestsTab projectId={projectId} sessionId={sessionId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
