'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { List, ListRow } from '@/components/ui/list';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { listPendingApprovals, resolveApproval, type PendingApproval } from '@kortix/sdk/projects-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';

function riskTone(risk: string | null): 'destructive' | 'warning' | 'muted' {
  if (risk === 'destructive') return 'destructive';
  if (risk === 'write') return 'warning';
  return 'muted';
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function ApprovalsView({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ['project-approvals', projectId];
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => listPendingApprovals(projectId),
    staleTime: 10_000,
    refetchInterval: 20_000, // an inbox — keep it fresh while it's open
  });

  // Track which row is mid-resolve so its buttons show a spinner + disable.
  const [pending, setPending] = useState<Record<string, 'approve' | 'deny'>>({});

  const resolve = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approve' | 'deny' }) =>
      resolveApproval(projectId, id, decision),
    onMutate: ({ id, decision }) => setPending((p) => ({ ...p, [id]: decision })),
    onSuccess: (_r, { decision }) => {
      successToast(decision === 'approve' ? 'Action approved' : 'Action denied');
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (e: Error) => errorToast(e.message || 'Failed to resolve approval'),
    onSettled: (_r, _e, { id }) =>
      setPending((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      }),
  });

  const approvals = data?.approvals ?? [];

  return (
    <CustomizeSectionWrapper
      title="Approvals"
      description="Actions an agent tried to run that a policy gated for human approval. Approve to let them proceed on the next attempt, or deny to refuse. You see these as a project manager or the person who started the session."
    >
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loading className="animate-spin" />
        </div>
      ) : isError ? (
        <ErrorState
          title="Couldn't load approvals"
          description="The approval inbox failed to load."
          action={
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              Retry
            </Button>
          }
        />
      ) : approvals.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="Nothing waiting on you"
          description="When an agent hits an action a policy marks for approval, it shows up here for you to approve or deny."
        />
      ) : (
        <List>
          {approvals.map((a: PendingApproval) => {
            const busy = pending[a.execution_id];
            return (
              <ListRow
                key={a.execution_id}
                title={<code className="font-mono text-sm">{a.action}</code>}
                badges={
                  <>
                    {a.risk ? (
                      <Badge variant={riskTone(a.risk)} size="xs" className="capitalize">
                        {a.risk}
                      </Badge>
                    ) : null}
                    <Badge variant="muted" size="xs">
                      Awaiting approval
                    </Badge>
                  </>
                }
                subtitle={
                  <span className="text-muted-foreground text-xs">
                    Requested by {a.requested_by_email ?? 'an agent'} · {relativeTime(a.requested_at)}
                  </span>
                }
                trailing={
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1"
                      disabled={!!busy}
                      onClick={() => resolve.mutate({ id: a.execution_id, decision: 'deny' })}
                    >
                      {busy === 'deny' ? <Loading className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
                      Deny
                    </Button>
                    <Button
                      size="sm"
                      className="gap-1"
                      disabled={!!busy}
                      onClick={() => resolve.mutate({ id: a.execution_id, decision: 'approve' })}
                    >
                      {busy === 'approve' ? <Loading className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                      Approve
                    </Button>
                  </div>
                }
              />
            );
          })}
        </List>
      )}
    </CustomizeSectionWrapper>
  );
}
