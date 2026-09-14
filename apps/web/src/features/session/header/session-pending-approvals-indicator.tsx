'use client';

import { useTranslations } from '@/i18n/use-translations';
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
          aria-label={tI18nComplete('text33dd5a127fb6', {
            value0: pending.length,
            value1: pending.length === 1 ? '' : 's',
          })}
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
            {pending.length} {tI18nComplete.raw('textbd938c688f49')}
            {pending.length === 1 ? '' : 's'} {tI18nComplete.raw('text84e3eb92c7a8')}
          </h3>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            {tI18nComplete.raw('text48edc0b5c137')}
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
                      {/* A new tab, as the ArrowSquareOut icon promises. In the same
                          tab this is a document load that tears down the live
                          session — SSE stream, transcript and sandbox panel. */}
                      <a href={a.approval_url} target="_blank" rel="noopener noreferrer">
                        {tI18nComplete.raw('textecdcf83028e7')}
                        <ArrowSquareOutIcon className="size-3 shrink-0" />
                      </a>
                    </Button>
                  ) : (
                    <Button size="sm" onClick={openAudit}>
                      {tI18nComplete.raw('textf517096df65f')}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="border-border flex items-center justify-end border-t px-3 py-2.5">
          <Button variant="ghost" size="sm" onClick={openAudit}>
            {tI18nComplete.raw('text8b2e3db6128a')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
