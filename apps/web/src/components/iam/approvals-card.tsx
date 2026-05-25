'use client';

import { useTranslations } from 'next-intl';
// Approval workflow card on the Settings tab. Combines the on/off toggle
// (with the gated-actions list) and the pending-requests inbox so admins
// have one place to manage two-person rule operations.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CheckCircle2,
  Clock,
  Loader2,
  ShieldAlert,
  X,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  type ApprovalRequest,
  approveApprovalRequest,
  getApprovalsPolicy,
  listApprovalRequests,
  rejectApprovalRequest,
  setApprovalsPolicy,
} from '@/lib/iam-client';
import { listAccountMembers } from '@/lib/projects-client';

interface ApprovalsCardProps {
  accountId: string;
  currentUserId: string;
  canManage: boolean;
}

export function ApprovalsCard({ accountId, currentUserId, canManage }: ApprovalsCardProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [decision, setDecision] = useState<
    { kind: 'approve' | 'reject'; request: ApprovalRequest } | null
  >(null);

  const policyQuery = useQuery({
    queryKey: ['iam-approvals-policy', accountId],
    queryFn: () => getApprovalsPolicy(accountId),
    staleTime: 30_000,
  });

  const pendingQuery = useQuery({
    queryKey: ['iam-approvals', accountId, 'pending'],
    queryFn: () => listApprovalRequests(accountId, { status: 'pending' }),
    refetchInterval: 30_000,
  });

  const membersQuery = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId),
    staleTime: 60_000,
  });

  const emailByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersQuery.data ?? []) {
      if (m.email) map.set(m.user_id, m.email);
    }
    return map;
  }, [membersQuery.data]);

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => setApprovalsPolicy(accountId, enabled),
    onSuccess: (res) => {
      toast.success(
        res.enabled ? 'Approval workflow enabled' : 'Approval workflow disabled',
      );
      queryClient.invalidateQueries({ queryKey: ['iam-approvals-policy', accountId] });
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to update policy'),
  });

  const approveMutation = useMutation({
    mutationFn: (requestId: string) => approveApprovalRequest(accountId, requestId),
    onSuccess: () => {
      toast.success('Request approved — requester can now finalise the change');
      queryClient.invalidateQueries({ queryKey: ['iam-approvals', accountId] });
      setDecision(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to approve'),
  });

  const rejectMutation = useMutation({
    mutationFn: (requestId: string) => rejectApprovalRequest(accountId, requestId),
    onSuccess: () => {
      toast.success('Request rejected');
      queryClient.invalidateQueries({ queryKey: ['iam-approvals', accountId] });
      setDecision(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to reject'),
  });

  const enabled = policyQuery.data?.enabled ?? false;
  const gatedActions = policyQuery.data?.gated_actions ?? [];
  const pending = pendingQuery.data ?? [];

  return (
    <section className="rounded-xl border border-border/70 bg-card">
      <header className="border-b border-border/60 px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <ShieldAlert className="h-4 w-4 text-muted-foreground" />
              {tHardcodedUi.raw('componentsIamApprovalsCard.line114JsxTextTwoPersonRule')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {tHardcodedUi.raw('componentsIamApprovalsCard.line117JsxTextWhenOnTheCuratedSetOfHighBlast')}</p>
          </div>
          {policyQuery.isLoading ? (
            <Skeleton className="h-9 w-24 rounded-md" />
          ) : (
            <Button
              variant={enabled ? 'destructive' : 'default'}
              disabled={!canManage || toggleMutation.isPending}
              onClick={() => toggleMutation.mutate(!enabled)}
            >
              {toggleMutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {enabled ? 'Disable' : 'Enable'}
            </Button>
          )}
        </div>
      </header>

      {/* Policy details */}
      <div className="border-b border-border/60 px-6 py-4">
        <p className="mb-2 text-xs font-medium text-foreground">{tHardcodedUi.raw('componentsIamApprovalsCard.line139JsxTextGatedActions')}</p>
        <div className="flex flex-wrap gap-1.5">
          {gatedActions.length === 0 ? (
            <span className="text-xs text-muted-foreground">{tHardcodedUi.raw('componentsIamApprovalsCard.line142JsxTextNoActionsGated')}</span>
          ) : (
            gatedActions.map((a) => (
              <Badge key={a} variant="outline" size="sm" className="font-mono text-[11px]">
                {a}
              </Badge>
            ))
          )}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          {tHardcodedUi.raw('componentsIamApprovalsCard.line152JsxTextRequestsAutoExpireAfter24Hours')}</p>
      </div>

      {/* Pending requests */}
      <div className="px-6 py-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          {tHardcodedUi.raw('componentsIamApprovalsCard.line160JsxTextPendingRequests')}{pending.length})
        </h3>
        {pendingQuery.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : pending.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {tHardcodedUi.raw('componentsIamApprovalsCard.line166JsxTextNoPendingApprovalRequests')}</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((r) => {
              const isSelf = r.requested_by === currentUserId;
              const expired = new Date(r.expires_at) < new Date();
              return (
                <li
                  key={r.request_id}
                  className="rounded-md border border-border/60 px-3 py-2.5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge
                          variant="outline"
                          size="sm"
                          className="font-mono text-[10px]"
                        >
                          {r.action}
                        </Badge>
                        {expired && (
                          <Badge variant="outline" size="sm" className="text-muted-foreground">
                            expired
                          </Badge>
                        )}
                        {isSelf && (
                          <Badge variant="outline" size="sm">{tHardcodedUi.raw('componentsIamApprovalsCard.line194JsxTextYourRequest')}</Badge>
                        )}
                      </div>
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        {tHardcodedUi.raw('componentsIamApprovalsCard.line198JsxTextRequestedBy')}{' '}
                        <span className="text-foreground">
                          {emailByUserId.get(r.requested_by) ?? r.requested_by}
                        </span>
                        {' · '}
                        {formatRelative(r.requested_at)}
                      </p>
                      {r.requester_reason && (
                        <p className="mt-1 text-xs italic text-muted-foreground">
                          {tHardcodedUi.raw('componentsIamApprovalsCard.line207JsxTextText')}{r.requester_reason}{tHardcodedUi.raw('componentsIamApprovalsCard.line207JsxTextText')}</p>
                      )}
                    </div>
                    {canManage && !isSelf && !expired && (
                      <div className="flex shrink-0 gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setDecision({ kind: 'reject', request: r })}
                          className="gap-1.5 text-destructive hover:text-destructive"
                        >
                          <X className="h-3.5 w-3.5" />
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => setDecision({ kind: 'approve', request: r })}
                          className="gap-1.5"
                        >
                          <Check className="h-3.5 w-3.5" />
                          Approve
                        </Button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Confirm dialogs */}
      <ConfirmDialog
        open={decision?.kind === 'approve'}
        onOpenChange={(o) => {
          if (!o) setDecision(null);
        }}
        title={tHardcodedUi.raw('componentsIamApprovalsCard.line246JsxAttrTitleApproveThisRequest')}
        description={
          decision
            ? `Approving will let the requester finalise the change. The action ("${decision.request.action}") only runs when they re-submit with this approval id — you're not executing it yourself.`
            : ''
        }
        confirmLabel="Approve"
        confirmIcon={<CheckCircle2 className="h-4 w-4" />}
        isPending={approveMutation.isPending}
        onConfirm={() => {
          if (decision) approveMutation.mutate(decision.request.request_id);
        }}
      />

      <ConfirmDialog
        open={decision?.kind === 'reject'}
        onOpenChange={(o) => {
          if (!o) setDecision(null);
        }}
        title={tHardcodedUi.raw('componentsIamApprovalsCard.line265JsxAttrTitleRejectThisRequest')}
        description={
          decision
            ? `The requester won't be able to use this approval id. They'll need to re-request if they still want to ${decision.request.action}.`
            : ''
        }
        confirmLabel="Reject"
        confirmVariant="destructive"
        confirmIcon={<XCircle className="h-4 w-4" />}
        isPending={rejectMutation.isPending}
        onConfirm={() => {
          if (decision) rejectMutation.mutate(decision.request.request_id);
        }}
      />
    </section>
  );
}

function formatRelative(iso: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return date.toLocaleDateString();
}
