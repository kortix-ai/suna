'use client';

/**
 * Inline "agent needs your approval" prompt, pinned above the composer — the
 * in-session face of a connector action a policy gated as `require_approval`.
 * Mirrors opencode's native tool-permission prompt (tool-renderers
 * PermissionPromptInline) so it feels native: approve lets the paused run
 * proceed, deny refuses it and the agent continues.
 *
 * Self-contained: reads projectId + the (Kortix) session id from the route and
 * shares the session-audit query with the header nudge + Audit panel, so all
 * three stay in lockstep.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  isPendingAction,
  relativeTime,
  riskTone,
  useResolveApproval,
  useSessionAudit,
} from '@/features/session/session-audit-shared';
import { cn } from '@/lib/utils';
import { ShieldAlert } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';

export function SessionApprovalPrompt() {
  const { id: projectId, sessionId: projectSessionId } = useParams<{
    id: string;
    sessionId: string;
  }>();
  // Poll a touch faster than the panel/nudge — this is the blocking gate the
  // user is actively waiting on.
  const { data } = useSessionAudit(projectId, projectSessionId, { refetchInterval: 5_000 });
  const resolve = useResolveApproval(projectId, projectSessionId);
  const [busy, setBusy] = useState<Record<string, 'approve' | 'deny'>>({});

  const pending = (data?.actions ?? []).filter(isPendingAction);
  if (pending.length === 0) return null;

  const decide = (executionId: string, decision: 'approve' | 'deny') => {
    setBusy((b) => ({ ...b, [executionId]: decision }));
    resolve.mutate(
      { executionId, decision },
      {
        onSuccess: () =>
          successToast(decision === 'approve' ? 'Approved — the agent will continue' : 'Denied'),
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

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-amber-500/40 bg-amber-50/60 dark:bg-amber-950/20">
      <div className="flex items-center gap-2 border-amber-500/20 border-b px-3 py-1.5">
        <ShieldAlert className="size-3.5 text-amber-600 dark:text-amber-400" />
        <span className="text-foreground text-xs font-semibold tracking-tight">
          {pending.length === 1
            ? 'The agent needs your approval'
            : `${pending.length} actions need your approval`}
        </span>
        <span className="text-muted-foreground text-[11px]">— it's paused until you decide</span>
      </div>
      <ul className="divide-amber-500/15 divide-y">
        {pending.map((a) => {
          const b = busy[a.execution_id];
          return (
            <li key={a.execution_id} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground text-xs">Run</span>
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
                  Requested {relativeTime(a.at)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  size="xs"
                  variant="muted"
                  className={cn('hover:bg-destructive/10 hover:text-destructive')}
                  disabled={!!b}
                  onClick={() => decide(a.execution_id, 'deny')}
                >
                  {b === 'deny' ? <Loading className="size-3 animate-spin" /> : null}
                  Deny
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  disabled={!!b}
                  onClick={() => decide(a.execution_id, 'approve')}
                >
                  {b === 'approve' ? <Loading className="size-3 animate-spin" /> : null}
                  Approve
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
