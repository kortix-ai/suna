'use client';

import Loading from '@/components/ui/loading';

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
import type { WorkspaceChangeRequest } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, GitMerge, GitPullRequest, Plus, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DiffStat, DiffView } from './diff-view';

const CR_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  open: 'default',
  merged: 'secondary',
  closed: 'outline',
};

export function ChangeRequestsView({
  workspaceId,
  sessionId,
}: {
  workspaceId: string;
  sessionId: string;
}) {
  const qc = useQueryClient();
  const [selectedCrId, setSelectedCrId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['change-requests', workspaceId],
    queryFn: () => kortix.workspace(workspaceId).changeRequests.list(),
  });

  const items: WorkspaceChangeRequest[] = list.data?.change_requests ?? [];

  if (selectedCrId) {
    return (
      <ChangeRequestDetail
        workspaceId={workspaceId}
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
          workspaceId={workspaceId}
          sessionId={sessionId}
          onOpened={() => {
            qc.invalidateQueries({ queryKey: ['change-requests', workspaceId] });
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
              <Button
                key={cr.cr_id}
                type="button"
                variant="outline"
                onClick={() => setSelectedCrId(cr.cr_id)}
                className="h-auto w-full items-start justify-start gap-2 whitespace-normal rounded-lg bg-card/50 px-2.5 py-2 text-left hover:bg-card"
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
              </Button>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/** A single change request: detail (`get`) + merge preview + diff + actions. */
function ChangeRequestDetail({
  workspaceId,
  crId,
  onBack,
}: {
  workspaceId: string;
  crId: string;
  onBack: () => void;
}) {
  const qc = useQueryClient();

  const detail = useQuery({
    queryKey: ['change-request', workspaceId, crId],
    queryFn: () => kortix.workspace(workspaceId).changeRequests.get(crId),
  });

  const diff = useQuery({
    queryKey: ['change-request-diff', workspaceId, crId],
    queryFn: () => kortix.workspace(workspaceId).changeRequests.diff(crId),
  });

  const mergePreview = useQuery({
    queryKey: ['change-request-merge-preview', workspaceId, crId],
    queryFn: () => kortix.workspace(workspaceId).changeRequests.mergePreview(crId),
  });

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['change-requests', workspaceId] });
    qc.invalidateQueries({ queryKey: ['change-request', workspaceId, crId] });
    qc.invalidateQueries({ queryKey: ['change-request-diff', workspaceId, crId] });
    qc.invalidateQueries({
      queryKey: ['change-request-merge-preview', workspaceId, crId],
    });
  }

  const merge = useMutation({
    mutationFn: () => kortix.workspace(workspaceId).changeRequests.merge(crId),
    onSuccess: () => {
      toast.success('Change request merged');
      invalidate();
    },
    onError: () => toast.error('Could not merge change request'),
  });

  const close = useMutation({
    mutationFn: () => kortix.workspace(workspaceId).changeRequests.close(crId),
    onSuccess: () => {
      toast.success('Change request closed');
      invalidate();
    },
    onError: () => toast.error('Could not close change request'),
  });

  const reopen = useMutation({
    mutationFn: () => kortix.workspace(workspaceId).changeRequests.reopen(crId),
    onSuccess: () => {
      toast.success('Change request reopened');
      invalidate();
    },
    onError: () => toast.error('Could not reopen change request'),
  });

  // changeRequests.get() returns { change_request: ChangeRequest } — unwrap it.
  const cr = detail.data?.change_request;
  const mp = mergePreview.data;
  const df = diff.data;
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
                    <Loading className="size-3.5" />
                  ) : (
                    <GitMerge className="size-3.5" />
                  )}
                  Merge
                </Button>
                <Button size="sm" variant="outline" onClick={() => close.mutate()} disabled={busy}>
                  {close.isPending ? <Loading className="size-3.5" /> : <X className="size-3.5" />}
                  Close
                </Button>
              </>
            )}
            {status === 'closed' && (
              <Button size="sm" variant="outline" onClick={() => reopen.mutate()} disabled={busy}>
                {reopen.isPending ? (
                  <Loading className="size-3.5" />
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
  workspaceId,
  sessionId,
  onOpened,
}: {
  workspaceId: string;
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
      kortix.workspace(workspaceId).changeRequests.open({
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
              <Loading className="size-3.5" />
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
