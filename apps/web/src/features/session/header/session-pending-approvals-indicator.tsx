'use client';

/**
 * Header nudge for PER-SESSION pending approvals.
 *
 * Always mounted in the session header; renders nothing until this session has
 * an action awaiting a decision, then shows a count badge + popover so the
 * launcher notices even with the side panel closed. Resolve inline, or jump to
 * the full "Audit" tab. Shares its query with {@link SessionAuditPanel} (same
 * key) so the two never disagree.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  isPendingAction,
  relativeTime,
  riskTone,
  useResolveApproval,
  useSessionAudit,
} from '@/features/session/session-audit-shared';
import { cn } from '@/lib/utils';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useSessionBrowserStore } from '@/stores/session-browser-store';
import { Check, ShieldAlert, X } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';

export function SessionPendingApprovalsIndicator({ sessionId }: { sessionId: string }) {
  // Route params: `id` = projectId, `sessionId` = the Kortix (route) session id
  // the audit endpoint keys on — distinct from the Runtime `sessionId` prop we
  // use to drive the panel's tab store.
  const { id: projectId, sessionId: projectSessionId } = useParams<{
    id: string;
    sessionId: string;
  }>();

  const { data } = useSessionAudit(projectId, projectSessionId, { silent: true });
  const resolve = useResolveApproval(projectId, projectSessionId);
  const [busy, setBusy] = useState<Record<string, 'approve' | 'deny'>>({});
  const [open, setOpen] = useState(false);

  const pending = (data?.actions ?? []).filter(isPendingAction);
  if (pending.length === 0) return null;

  const decide = (executionId: string, decision: 'approve' | 'deny') => {
    setBusy((b) => ({ ...b, [executionId]: decision }));
    resolve.mutate(
      { executionId, decision },
      {
        onSuccess: () => successToast(decision === 'approve' ? 'Action approved' : 'Action denied'),
        onError: (e: unknown) =>
          errorToast(e instanceof Error ? e.message : 'Failed to resolve approval'),
        onSettled: () =>
          setBusy((b) => {
            const next = { ...b };
            delete next[executionId];
            return next;
          }),
      },
    );
  };

  const openAudit = () => {
    useSessionBrowserStore.getState().setView(sessionId, 'audit');
    useKortixComputerStore.getState().setIsSidePanelOpen(true);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${pending.length} action${pending.length === 1 ? '' : 's'} awaiting your approval`}
          className="relative"
        >
          <ShieldAlert className="size-4 text-amber-500" />
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-600 px-1 text-[10px] font-semibold leading-none text-white">
            {pending.length}
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={8} className="w-[340px] overflow-hidden p-0">
        <div className="border-border border-b px-4 pt-4 pb-3">
          <h3 className="text-foreground text-sm font-semibold tracking-tight">
            {pending.length} action{pending.length === 1 ? '' : 's'} awaiting approval
          </h3>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            The agent hit an action a policy gated for a human. Approve to let it proceed on the
            next attempt, or deny to refuse.
          </p>
        </div>

        <div className="max-h-64 divide-border divide-y overflow-auto">
          {pending.map((a) => {
            const b = busy[a.execution_id];
            return (
              <div key={a.execution_id} className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <code
                    title={a.action}
                    className="text-foreground truncate font-mono text-xs font-medium"
                  >
                    {a.action}
                  </code>
                  {a.risk ? (
                    <Badge variant={riskTone(a.risk)} size="xs" className="shrink-0 capitalize">
                      {a.risk}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-muted-foreground mt-0.5 text-[11px]">
                  {a.acted_by_email ?? 'agent'} · {relativeTime(a.at)}
                </p>
                <div className="mt-2 flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className={cn('h-7 gap-1 px-2 text-xs')}
                    disabled={!!b}
                    onClick={() => decide(a.execution_id, 'deny')}
                  >
                    {b === 'deny' ? (
                      <Loading className="size-3 animate-spin" />
                    ) : (
                      <X className="size-3" />
                    )}
                    Deny
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    disabled={!!b}
                    onClick={() => decide(a.execution_id, 'approve')}
                  >
                    {b === 'approve' ? (
                      <Loading className="size-3 animate-spin" />
                    ) : (
                      <Check className="size-3" />
                    )}
                    Approve
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="border-border flex items-center justify-end border-t px-3 py-2.5">
          <Button variant="ghost" size="sm" onClick={openAudit}>
            Open in Audit
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
