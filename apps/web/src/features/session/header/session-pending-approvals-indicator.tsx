'use client';

/**
 * Header nudge for PER-SESSION pending approvals.
 *
 * Always mounted in the session header; renders nothing until this session has
 * an action awaiting a decision, then shows a count badge + popover so the
 * launcher notices even with the side panel closed. It links to the full
 * parameter review instead of exposing a parameter-blind decision shortcut.
 * It shares its query with {@link SessionAuditPanel} so the two never disagree.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { openSessionQuickView } from '@/features/session/open-session-quick-view';
import {
  isPendingAction,
  relativeTime,
  riskTone,
  useSessionAudit,
} from '@/features/session/session-audit-shared';
import { ArrowSquareOutIcon, ShieldWarningIcon } from '@phosphor-icons/react';
import { useParams } from 'next/navigation';
import { useState } from 'react';

export function SessionPendingApprovalsIndicator({ sessionId }: { sessionId: string }) {
  // Route params: `id` = projectId, `sessionId` = the Kortix (route) session id
  // the audit endpoint keys on — distinct from the OpenCode `sessionId` prop we
  // use to drive the panel's tab store.
  const { id: projectId, sessionId: projectSessionId } = useParams<{
    id: string;
    sessionId: string;
  }>();

  const { data } = useSessionAudit(projectId, projectSessionId, { silent: true });
  const [open, setOpen] = useState(false);

  const pending = (data?.actions ?? []).filter(isPendingAction);
  if (pending.length === 0) return null;

  const openAudit = () => {
    // Same Advanced-only `viewBySession` dead end as the other chips.
    openSessionQuickView('audit', 'chip');
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
          <ShieldWarningIcon className="text-kortix-orange size-4" />
          <Badge variant="warning" size="tabular" className="absolute -top-1 -right-1">
            {pending.length}
          </Badge>
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

        <div className="divide-border max-h-64 divide-y overflow-auto">
          {pending.map((a) => {
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
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {a.acted_by_email ?? 'agent'} · {relativeTime(a.at)}
                </p>
                <div className="mt-2 flex items-center gap-1.5">
                  {a.approval_url ? (
                    <Button size="sm" asChild>
                      <a href={a.approval_url}>
                        Review parameters
                        <ArrowSquareOutIcon className="size-3 shrink-0" />
                      </a>
                    </Button>
                  ) : (
                    <Button size="sm" onClick={openAudit}>
                      Review in Audit
                    </Button>
                  )}
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
