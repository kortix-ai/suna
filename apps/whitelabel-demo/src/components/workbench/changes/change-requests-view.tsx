'use client';

/**
 * The "Change requests" tab of the workbench changes panel — Kortix's native PR
 * layer: the list (`changeRequests.list`), a single change request's detail
 * (`get` / `diff` / `mergePreview`) with its actions (`open` / `merge` / `close`
 * / `reopen`), and the "Open change request" form. Everything routes through the
 * `@kortix/sdk` facade — no raw HTTP.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { kortix } from '@/lib/kortix';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, GitMerge, GitPullRequest, Loader2, Plus, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DiffStat, DiffView } from './diff-view';

const CR_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  open: 'default',
  merged: 'secondary',
  closed: 'outline',
};

export function ChangeRequestsView({
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
                    <span className="text-muted-foreground">#{cr.number}</span> {cr.title}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[0.7rem] text-muted-foreground">
                    <span>{cr.head_ref}</span>
                    <ArrowLeft className="size-3 rotate-180" />
                    <span>{cr.base_ref}</span>
                  </div>
                </div>
                <Badge variant={CR_STATUS_VARIANT[cr.status] ?? 'outline'} className="shrink-0">
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
                <Button size="sm" variant="outline" onClick={() => close.mutate()} disabled={busy}>
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
              <Button size="sm" variant="outline" onClick={() => reopen.mutate()} disabled={busy}>
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
        <span>{df?.files_changed ?? df?.files?.length ?? 0} files changed</span>
        {df && <DiffStat additions={df.additions} deletions={df.deletions} />}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {diff.isLoading ? <Skeleton className="h-40 w-full" /> : <DiffView patch={df?.patch} />}
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
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={3}
            className="resize-none"
          />
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="px-0.5 text-[0.7rem] text-muted-foreground">Head ref</label>
              <Input
                value={headRef}
                onChange={(e) => setHeadRef(e.target.value)}
                placeholder="head branch"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <label className="px-0.5 text-[0.7rem] text-muted-foreground">Base ref</label>
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
