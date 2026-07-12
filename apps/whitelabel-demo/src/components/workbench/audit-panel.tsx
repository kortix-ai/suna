'use client';

/**
 * The session's action audit: every executor-gated action the agent took
 * (`session.audit`) plus the live approve/deny inbox for actions a policy
 * gated as require-approval (`project.approvals`). Approvals resolved here
 * unblock the agent's retry; the trail below is the permanent record.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { cn, relativeTime } from '@/lib/utils';
import type { PendingApproval, SessionAuditAction } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

const STATUS_BADGE: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  ok: 'secondary',
  error: 'destructive',
  denied: 'destructive',
  pending_approval: 'outline',
};

type ApprovalScope = 'once' | 'session' | 'session_all';

export function AuditPanel({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const qc = useQueryClient();

  const audit = useQuery({
    queryKey: ['session-audit', projectId, sessionId],
    queryFn: () => kortix.session(projectId, sessionId).audit(100, { showErrors: false }),
    refetchInterval: 10_000,
    retry: false,
  });
  const approvals = useQuery({
    queryKey: ['approvals', projectId],
    queryFn: () => kortix.project(projectId).approvals.list({ showErrors: false }),
    refetchInterval: 10_000,
    retry: false,
  });

  const pendingHere = (approvals.data?.approvals ?? []).filter((a) => a.session_id === sessionId);

  const resolve = useMutation({
    mutationFn: ({
      executionId,
      decision,
      scope,
    }: {
      executionId: string;
      decision: 'approve' | 'deny';
      scope: ApprovalScope;
    }) => kortix.project(projectId).approvals.resolve(executionId, decision, scope),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['approvals', projectId] });
      qc.invalidateQueries({ queryKey: ['approvals-needs-input', projectId] });
      qc.invalidateQueries({ queryKey: ['session-audit', projectId, sessionId] });
      toast.success(vars.decision === 'approve' ? 'Action approved' : 'Action denied');
    },
    onError: () => toast.error('Could not resolve the approval'),
  });

  if (audit.isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-3">
        {['s1', 's2', 's3', 's4'].map((id) => (
          <Skeleton key={id} className="h-14 rounded-xl" />
        ))}
      </div>
    );
  }

  const actions = audit.data?.actions ?? [];
  const restricted = audit.data?.audit_access === false;

  return (
    <div className="mx-auto h-full max-w-3xl space-y-4 overflow-y-auto scrollbar-thin">
      {pendingHere.length > 0 && (
        <Card className="border-amber-500/30 p-0">
          <div className="flex items-center gap-2 border-b border-amber-500/20 px-4 py-2.5 text-sm font-medium">
            <ShieldAlert className="size-4 text-amber-500" />
            Waiting on your approval
            <Badge variant="secondary" className="ml-auto tabular-nums">
              {pendingHere.length}
            </Badge>
          </div>
          <ul className="divide-y divide-border">
            {pendingHere.map((a) => (
              <ApprovalRow
                key={a.execution_id}
                approval={a}
                busy={resolve.isPending}
                onResolve={(decision, scope) =>
                  resolve.mutate({ executionId: a.execution_id, decision, scope })
                }
              />
            ))}
          </ul>
        </Card>
      )}

      <div>
        <div className="mb-2 flex items-center gap-2">
          <ShieldCheck className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Action trail</span>
          {audit.data && (
            <Badge variant="outline" className="tabular-nums">
              {audit.data.count}
            </Badge>
          )}
        </div>
        {restricted && (
          <p className="mb-3 text-xs text-muted-foreground">
            The full historical trail requires the Enterprise audit entitlement; showing pending
            approvals only.
          </p>
        )}
        {audit.isError ? (
          <Card className="p-4 text-sm text-muted-foreground">
            The audit trail isn&apos;t available for this session.
          </Card>
        ) : actions.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            No gated actions yet. When the agent uses connector tools, every action lands here with
            its policy verdict.
          </Card>
        ) : (
          <Card className="p-0">
            <ul className="divide-y divide-border">
              {actions.map((a) => (
                <AuditRow key={a.execution_id} action={a} />
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

function ApprovalRow({
  approval,
  busy,
  onResolve,
}: {
  approval: PendingApproval;
  busy: boolean;
  onResolve: (decision: 'approve' | 'deny', scope: ApprovalScope) => void;
}) {
  const [scope, setScope] = useState<ApprovalScope>('once');
  return (
    <li className="flex flex-wrap items-center gap-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-xs">{approval.action}</span>
          {approval.risk && (
            <Badge
              variant={approval.risk === 'destructive' ? 'destructive' : 'secondary'}
              className="px-1.5 py-0 text-[0.65rem]"
            >
              {approval.risk}
            </Badge>
          )}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {approval.requested_by_email ?? 'the agent'} · {relativeTime(approval.requested_at)}
        </div>
      </div>
      <Select value={scope} onValueChange={(v) => setScope(v as ApprovalScope)}>
        <SelectTrigger className="h-7 w-[150px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="once" className="text-xs">
            Just once
          </SelectItem>
          <SelectItem value="session" className="text-xs">
            Rest of session
          </SelectItem>
          <SelectItem value="session_all" className="text-xs">
            All actions this session
          </SelectItem>
        </SelectContent>
      </Select>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          className="h-7 gap-1"
          disabled={busy}
          onClick={() => onResolve('approve', scope)}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1"
          disabled={busy}
          onClick={() => onResolve('deny', 'once')}
        >
          <X className="size-3.5" /> Deny
        </Button>
      </div>
    </li>
  );
}

function AuditRow({ action }: { action: SessionAuditAction }) {
  const pending = action.status === 'pending_approval';
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{action.action}</span>
        {action.risk && action.risk !== 'read' && (
          <Badge
            variant={action.risk === 'destructive' ? 'destructive' : 'secondary'}
            className="px-1.5 py-0 text-[0.65rem]"
          >
            {action.risk}
          </Badge>
        )}
        <Badge
          variant={STATUS_BADGE[action.status] ?? 'outline'}
          className={cn(
            'px-1.5 py-0 text-[0.65rem]',
            pending && 'border-amber-500/50 text-amber-500',
          )}
        >
          {pending ? 'awaiting approval' : action.status}
        </Badge>
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
        <span>{relativeTime(action.at)}</span>
        {action.resolved_by_email && (
          <span className="truncate">
            resolved by {action.resolved_by_email}
            {action.resolved_at ? ` ${relativeTime(action.resolved_at)}` : ''}
          </span>
        )}
      </div>
    </li>
  );
}
