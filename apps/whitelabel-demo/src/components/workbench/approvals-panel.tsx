'use client';

/**
 * The approval gate, in the session it belongs to.
 *
 * A project policy can mark a connector action `require_approval`; the agent's
 * turn then ENDS on a pending gate and nothing else happens until a person
 * decides. Until this panel existed the wrapper's operator had no way to see
 * that from Lumen — the session simply looked idle, and the only way to clear
 * it was curl. So the pending set is polled per session and each row carries
 * the two decisions plus the standing one.
 *
 * Two buttons — Approve and Deny — and they decide exactly the call that asked.
 *
 * There used to be a third, "Always this session". The platform's `session` and
 * `session_all` scopes were REMOVED: a grant keyed on (session, connector,
 * action) ignores the ARGUMENTS, so approving a send to one recipient silently
 * pre-authorised a send to any other. A tool that should run unattended belongs
 * in an `always_run` policy rule, authored deliberately.
 */

import Loading from '@/components/ui/loading';

import { CallSnippet } from '@/components/dev/call-snippet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  approvalFailure,
  sessionApprovalsView,
  type ApprovalFailure,
} from '@/components/workbench/approvals-model';
import { kortix } from '@/lib/kortix';
import { cn, relativeTime } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ShieldCheck, ShieldQuestion, X } from 'lucide-react';
import { useState } from 'react';

/** Query key kept local: `lib/query-keys.ts` is shared by every panel and this
 *  is the only reader of the session audit. */
const auditKey = (projectId: string, sessionId: string) =>
  ['session-approvals', projectId, sessionId] as const;

const RISK_BADGE: Record<string, string> = {
  destructive: 'bg-destructive/15 text-destructive',
  write: 'bg-amber-500/15 text-amber-500',
  read: 'bg-muted text-muted-foreground',
};

export function SessionApprovals({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const qc = useQueryClient();
  const [failure, setFailure] = useState<ApprovalFailure | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);

  const audit = useQuery({
    queryKey: auditKey(projectId, sessionId),
    queryFn: () => kortix.session(projectId, sessionId).audit(50, { showErrors: false }),
    // A gate can appear at any point in a turn and the agent is blocked until
    // it clears, so this polls rather than waiting for a navigation.
    refetchInterval: 8_000,
    retry: false,
  });

  const resolve = useMutation({
    mutationFn: (input: { executionId: string; decision: 'approve' | 'deny' }) =>
      kortix.project(projectId).approvals.resolve(input.executionId, input.decision),
    onMutate: (input) => {
      setFailure(null);
      setDeciding(input.executionId);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: auditKey(projectId, sessionId) }),
    // A refused resolve is the interesting case, not an edge case: name it
    // instead of collapsing every 403/409 into "something went wrong".
    onError: (err) => setFailure(approvalFailure(err)),
    onSettled: () => setDeciding(null),
  });

  // A session whose audit can't be read must not render as "nothing pending" —
  // that is a claim about a gate, and a wrong one leaves the agent stuck with
  // no sign of why.
  if (audit.isError) {
    return (
      <Strip>
        <ShieldQuestion className="size-3.5 shrink-0" />
        Approvals could not be read for this session just now.
      </Strip>
    );
  }
  if (audit.isLoading) {
    return (
      <Strip>
        <Loading className="size-3.5" />
        Checking for anything waiting on a human…
      </Strip>
    );
  }

  const view = sessionApprovalsView(audit.data);

  if (view.pending.length === 0) {
    return (
      <Strip>
        <ShieldCheck className="size-3.5 shrink-0" />
        <span>
          Nothing is waiting on a human decision.
          {view.trailLimited
            ? ' The full action trail is an Enterprise feature, so only pending gates are shown here.'
            : view.recent.length > 0
              ? ` ${view.recent.length} governed action${view.recent.length === 1 ? '' : 's'} so far, most recently ${view.recent[0]!.action}.`
              : ''}
        </span>
      </Strip>
    );
  }

  return (
    <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/5 px-5 py-3">
      <div className="mx-auto max-w-3xl space-y-2">
        <div className="flex items-center gap-2 text-xs font-medium text-amber-500">
          <ShieldQuestion className="size-3.5 shrink-0" />
          {view.pending.length} action{view.pending.length === 1 ? '' : 's'} waiting on a human
          decision — the agent is blocked until you decide.
        </div>

        {view.pending.map((row) => {
          const busy = resolve.isPending && deciding === row.executionId;
          return (
            <div
              key={row.executionId}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs">{row.action}</span>
                <span className="block text-xs text-muted-foreground">
                  asked {relativeTime(row.requestedAt)}
                </span>
              </span>
              {row.risk && (
                <Badge
                  variant="secondary"
                  className={cn('capitalize', RISK_BADGE[row.risk] ?? 'bg-muted')}
                >
                  {row.risk}
                </Badge>
              )}
              <Button
                size="xs"
                disabled={busy}
                onClick={() =>
                  resolve.mutate({ executionId: row.executionId, decision: 'approve' })
                }
              >
                {busy ? <Loading className="size-3" /> : <Check className="size-3" />}
                Approve
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  resolve.mutate({ executionId: row.executionId, decision: 'deny' })
                }
              >
                <X className="size-3" />
                Deny
              </Button>
            </div>
          );
        })}

        {/* The decision these buttons send, on the execution id that is
            actually waiting. */}
        <CallSnippet
          id="approval.resolve"
          context={{ projectId, executionId: view.pending[0]?.executionId }}
        />

        {failure && (
          <div
            className={cn(
              'rounded-md border px-3 py-2',
              failure.kind === 'requires_human'
                ? 'border-brand/40 bg-brand/5'
                : 'border-destructive/40 bg-destructive/5',
            )}
          >
            <div className="text-sm font-medium">{failure.title}</div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {failure.detail}
              {failure.kind === 'requires_human' &&
                ' Retrying with the same credential cannot succeed — this decision has to come from a signed-in person.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** The quiet one-line state — present even when nothing is pending, so the
 *  gate is discoverable before it ever fires. */
function Strip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-1.5 text-xs text-muted-foreground">
      {children}
    </div>
  );
}
