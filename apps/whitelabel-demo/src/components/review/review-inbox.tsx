'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { kortix } from '@/lib/kortix';
import { cn, relativeTime } from '@/lib/utils';
import type { ApiReviewItem, PendingApproval, ReviewSegment, ReviewVerdict } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, Inbox, Loader2, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

type ApprovalScope = 'once' | 'session' | 'session_all';
type FeedbackMode = 'changes' | 'reject';

const SEGMENTS: { value: ReviewSegment; label: string; empty: string }[] = [
  { value: 'needs_you', label: 'Needs you', empty: 'Nothing needs your review.' },
  { value: 'waiting', label: 'Waiting', empty: 'Nothing is waiting on others.' },
  { value: 'done', label: 'Done', empty: 'No reviewed items yet.' },
];

const VERDICT_TOAST: Partial<Record<ReviewVerdict, string>> = {
  approve: 'Approved',
  changes: 'Changes requested',
  reject: 'Rejected',
  dismiss: 'Dismissed',
};

function statusVariant(status: ApiReviewItem['status']): 'default' | 'secondary' | 'outline' {
  if (status === 'approved') return 'default';
  if (status === 'changes_requested') return 'outline';
  return 'secondary';
}

export function ReviewInbox({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const approvalsKey = ['approvals', projectId] as const;

  const approvals = useQuery({
    queryKey: approvalsKey,
    queryFn: () => kortix.project(projectId).approvals.list(),
    refetchInterval: 10_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['review', projectId] });
    qc.invalidateQueries({ queryKey: approvalsKey });
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      {approvals.isLoading && (
        <Card className="gap-0 p-4">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-3 h-8 w-full" />
        </Card>
      )}
      {approvals.isError && (
        <Card className="gap-0 border-destructive/30 p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">
              Could not load pending approvals.
            </span>
            <Button variant="outline" size="sm" onClick={() => approvals.refetch()}>
              Retry
            </Button>
          </div>
        </Card>
      )}
      {approvals.isSuccess && approvals.data.count > 0 && (
        <Card className="gap-0 border-amber-500/30 p-0">
          <div className="flex items-center gap-2 px-5 pt-5 text-sm font-medium">
            <ShieldAlert className="size-4 text-amber-500" /> Pending tool approvals
            <Badge variant="secondary">{approvals.data.count}</Badge>
          </div>
          <div className="mt-2 divide-y divide-border">
            {approvals.data.approvals.map((a) => (
              <ApprovalRow
                key={a.execution_id}
                projectId={projectId}
                approval={a}
                onResolved={invalidate}
              />
            ))}
          </div>
        </Card>
      )}

      <Tabs defaultValue="needs_you">
        <TabsList>
          {SEGMENTS.map((s) => (
            <TabsTrigger key={s.value} value={s.value}>
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {SEGMENTS.map((s) => (
          <TabsContent key={s.value} value={s.value}>
            <SegmentPanel
              projectId={projectId}
              segment={s.value}
              emptyLabel={s.empty}
              onChanged={invalidate}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function ApprovalRow({
  projectId,
  approval,
  onResolved,
}: {
  projectId: string;
  approval: PendingApproval;
  onResolved: () => void;
}) {
  const [scope, setScope] = useState<ApprovalScope>('once');

  const resolve = useMutation({
    mutationFn: (decision: 'approve' | 'deny') =>
      kortix.project(projectId).approvals.resolve(approval.execution_id, decision, scope),
    onSuccess: (_res, decision) => {
      onResolved();
      toast.success(decision === 'approve' ? 'Action approved' : 'Action denied');
    },
    onError: () => toast.error('Could not resolve approval'),
  });

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs">{approval.action}</span>
          {approval.risk && (
            <Badge
              variant={approval.risk === 'destructive' ? 'destructive' : 'secondary'}
              className="text-[10px]"
            >
              {approval.risk}
            </Badge>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {approval.requested_by_email && <span>{approval.requested_by_email}</span>}
          <span>{relativeTime(approval.requested_at)}</span>
          {approval.session_id && (
            <Link
              href={`/projects/${projectId}/sessions/${approval.session_id}`}
              className="inline-flex items-center gap-1 text-foreground hover:underline"
            >
              <ExternalLink className="size-3" /> Session
            </Link>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <Select value={scope} onValueChange={(v) => setScope(v as ApprovalScope)}>
          <SelectTrigger size="sm" className="w-44 text-xs" aria-label="Approval scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="once">Just once</SelectItem>
            <SelectItem value="session">Rest of session</SelectItem>
            <SelectItem value="session_all">All actions this session</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate('approve')}>
          {resolve.isPending && resolve.variables === 'approve' && (
            <Loader2 className="size-4 animate-spin" />
          )}
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-muted-foreground hover:text-destructive"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate('deny')}
        >
          {resolve.isPending && resolve.variables === 'deny' && (
            <Loader2 className="size-4 animate-spin" />
          )}
          Deny
        </Button>
      </div>
    </div>
  );
}

function SegmentPanel({
  projectId,
  segment,
  emptyLabel,
  onChanged,
}: {
  projectId: string;
  segment: ReviewSegment;
  emptyLabel: string;
  onChanged: () => void;
}) {
  const query = useQuery({
    queryKey: ['review', projectId, segment],
    queryFn: () => kortix.project(projectId).review.list({ segment }),
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [feedbackTarget, setFeedbackTarget] = useState<{
    mode: FeedbackMode;
    item: ApiReviewItem;
  } | null>(null);
  const [feedback, setFeedback] = useState('');

  const closeFeedback = () => {
    setFeedbackTarget(null);
    setFeedback('');
  };

  const act = useMutation({
    mutationFn: (v: { id: string; verdict: ReviewVerdict; feedback?: string }) =>
      kortix.project(projectId).review.act(v.id, {
        verdict: v.verdict,
        ...(v.feedback ? { feedback: v.feedback } : {}),
      }),
    onSuccess: (_item, v) => {
      closeFeedback();
      onChanged();
      toast.success(VERDICT_TOAST[v.verdict] ?? 'Updated');
    },
    onError: () => toast.error('Could not update item'),
  });

  const bulk = useMutation({
    mutationFn: (v: { ids: string[]; verdict: ReviewVerdict }) =>
      kortix.project(projectId).review.bulkAct(v),
    onSuccess: (res, v) => {
      setSelected(new Set());
      onChanged();
      toast.success(
        `${res.updated} item${res.updated === 1 ? '' : 's'} ${
          v.verdict === 'approve' ? 'approved' : 'dismissed'
        }`,
      );
    },
    onError: () => toast.error('Could not update items'),
  });

  if (query.isLoading) {
    return (
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <Card key={i} className="gap-0 p-4">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="mt-2 h-4 w-full" />
            <Skeleton className="mt-3 h-4 w-40" />
          </Card>
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <Card className="gap-0 p-6 text-center">
        <p className="text-sm text-muted-foreground">Could not load review items.</p>
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={() => query.refetch()}>
            Retry
          </Button>
        </div>
      </Card>
    );
  }

  const items = query.data?.review_items ?? [];

  if (items.length === 0) {
    return (
      <Card className="gap-0 p-8 text-center">
        <Inbox className="mx-auto size-5 text-muted-foreground" />
        <p className="mt-2 text-sm text-muted-foreground">{emptyLabel}</p>
      </Card>
    );
  }

  const selectable = segment === 'needs_you';
  const selectedIds = [...selected].filter((id) =>
    items.some((it) => it.review_item_id === id),
  );

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <ReviewItemCard
          key={item.review_item_id}
          projectId={projectId}
          item={item}
          segment={segment}
          selected={selected.has(item.review_item_id)}
          onToggle={selectable ? () => toggle(item.review_item_id) : undefined}
          onAct={
            selectable
              ? (verdict) => act.mutate({ id: item.review_item_id, verdict })
              : undefined
          }
          onOpenFeedback={
            selectable ? (mode) => setFeedbackTarget({ mode, item }) : undefined
          }
          acting={act.isPending}
        />
      ))}

      {selectable && selectedIds.length > 0 && (
        <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-2.5 shadow-lg">
          <span className="text-xs text-muted-foreground">{selectedIds.length} selected</span>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              disabled={bulk.isPending}
              onClick={() => bulk.mutate({ ids: selectedIds, verdict: 'approve' })}
            >
              {bulk.isPending && <Loader2 className="size-4 animate-spin" />}
              Approve all
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={bulk.isPending}
              onClick={() => bulk.mutate({ ids: selectedIds, verdict: 'dismiss' })}
            >
              Dismiss all
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={feedbackTarget !== null}
        onOpenChange={(open) => {
          if (!open) closeFeedback();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {feedbackTarget?.mode === 'changes' ? 'Request changes' : 'Reject item'}
            </DialogTitle>
            <DialogDescription>{feedbackTarget?.item.title}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="review-feedback" className="text-xs text-muted-foreground">
              Feedback{feedbackTarget?.mode === 'reject' ? ' (optional)' : ''}
            </Label>
            <Textarea
              id="review-feedback"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder={
                feedbackTarget?.mode === 'changes' ? 'What should change?' : 'Why reject this?'
              }
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={act.isPending} onClick={closeFeedback}>
              Cancel
            </Button>
            <Button
              variant={feedbackTarget?.mode === 'reject' ? 'destructive' : 'default'}
              disabled={
                act.isPending || (feedbackTarget?.mode === 'changes' && !feedback.trim())
              }
              onClick={() => {
                if (!feedbackTarget) return;
                act.mutate({
                  id: feedbackTarget.item.review_item_id,
                  verdict: feedbackTarget.mode === 'changes' ? 'changes' : 'reject',
                  ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
                });
              }}
            >
              {act.isPending && <Loader2 className="size-4 animate-spin" />}
              {feedbackTarget?.mode === 'changes' ? 'Request changes' : 'Reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReviewItemCard({
  projectId,
  item,
  segment,
  selected,
  onToggle,
  onAct,
  onOpenFeedback,
  acting,
}: {
  projectId: string;
  item: ApiReviewItem;
  segment: ReviewSegment;
  selected: boolean;
  onToggle?: () => void;
  onAct?: (verdict: 'approve' | 'dismiss') => void;
  onOpenFeedback?: (mode: FeedbackMode) => void;
  acting: boolean;
}) {
  return (
    <Card className={cn('gap-0 p-4', selected && 'border-primary/40')}>
      <div className="flex items-start gap-3">
        {onToggle && (
          <label className="relative grid size-6 shrink-0 cursor-pointer place-items-center rounded-md transition-colors hover:bg-accent">
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggle}
              aria-label={selected ? `Deselect ${item.title}` : `Select ${item.title}`}
              className="peer absolute inset-0 cursor-pointer appearance-none"
            />
            <span
              className={cn(
                'pointer-events-none flex size-4 items-center justify-center rounded-sm border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50',
                selected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input',
              )}
            >
              {selected && <Check className="size-3" />}
            </span>
          </label>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{item.title}</span>
            <Badge variant="outline" className="text-[10px] capitalize">
              {item.kind}
            </Badge>
            {item.risk !== 'none' && (
              <Badge
                variant={item.risk === 'high' ? 'destructive' : 'secondary'}
                className="text-[10px]"
              >
                {item.risk} risk
              </Badge>
            )}
            {segment === 'done' && (
              <Badge variant={statusVariant(item.status)} className="text-[10px]">
                {item.status.replace(/_/g, ' ')}
              </Badge>
            )}
          </div>
          {item.summary && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.summary}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{item.agent}</span>
            <span>·</span>
            <span>{relativeTime(item.created_at)}</span>
            {segment === 'done' && item.acted_by && (
              <>
                <span>·</span>
                <span>by {item.acted_by}</span>
              </>
            )}
            {segment === 'done' && item.acted_at && (
              <>
                <span>·</span>
                <span>{relativeTime(item.acted_at)}</span>
              </>
            )}
            {item.origin_session_id && (
              <Link
                href={`/projects/${projectId}/sessions/${item.origin_session_id}`}
                className="inline-flex items-center gap-1 text-foreground hover:underline"
              >
                <ExternalLink className="size-3" /> Session
              </Link>
            )}
          </div>
          {onAct && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <Button size="sm" disabled={acting} onClick={() => onAct('approve')}>
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={acting}
                onClick={() => onOpenFeedback?.('changes')}
              >
                Request changes
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-muted-foreground hover:text-destructive"
                disabled={acting}
                onClick={() => onOpenFeedback?.('reject')}
              >
                Reject
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                disabled={acting}
                onClick={() => onAct('dismiss')}
              >
                Dismiss
              </Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
