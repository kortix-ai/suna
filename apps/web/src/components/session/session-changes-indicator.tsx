'use client';

/**
 * SessionChangesIndicator — a small, colored header chip that lights up when
 * this thread has uncommitted changes (the same diff the "Alternate version of
 * main · N changes" banner tracks). It's the at-a-glance signal: "huh, there
 * are unsynced changes here." Clicking opens a popover that explains the
 * situation in plain language and offers the two next steps — open a change
 * request, or jump to the full Changes view.
 *
 * It hides itself entirely when the thread is in sync, so a clean session
 * carries no extra chrome.
 */

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { GitPullRequestArrow, Loader2 } from 'lucide-react';

import { useGitStatus } from '@/features/files/hooks/use-git-status';
import { useSessionBrowserStore } from '@/stores/session-browser-store';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { STATUS_BG, STATUS_DOT, STATUS_TEXT } from '@/components/ui/status';
import {
  CHANGE_STATUS_BADGE,
  useOpenChangeRequest,
  useSessionBaseRef,
} from '@/components/session/session-changes-shared';

export function SessionChangesIndicator({
  /** OpenCode chat session id — the agent we message to open the change request,
   *  and the key the right-side panel view is stored under. */
  sessionId,
}: {
  sessionId: string;
}) {
  // The git branch == the ROUTE session id; the chat session id is `sessionId`.
  const { id: projectId, sessionId: gitSessionId } = useParams<{
    id: string;
    sessionId: string;
  }>();

  const statusQuery = useGitStatus();
  const changedFiles = statusQuery.data ?? [];
  const changedCount = changedFiles.length;
  const baseRef = useSessionBaseRef(projectId, gitSessionId);
  const { asking, openChangeRequest } = useOpenChangeRequest(sessionId, baseRef);

  const [open, setOpen] = useState(false);

  // Nothing to surface until there's a diff. (Loading / clean → no chrome.)
  if (changedCount === 0) return null;

  // Open the panel straight on the Changes diff view. The Files surface reads
  // the `files` panel-view value as "Changes" (vs `explorer` = All files).
  const viewChanges = () => {
    useSessionBrowserStore.getState().setView(sessionId, 'files');
    useKortixComputerStore.getState().setIsSidePanelOpen(true);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${changedCount} change${changedCount === 1 ? '' : 's'} in this version, not in ${baseRef} yet`}
          className="relative h-8 w-8 cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
        >
          <GitPullRequestArrow className="h-4 w-4" />
          {/* A single delicate amber dot — enough to say "there's a diff here"
              without shouting. The count lives in the popover. */}
          <span className="absolute right-1.5 top-1.5 flex size-1.5">
            <span
              className={cn(
                'absolute inline-flex size-full animate-ping rounded-full opacity-60',
                STATUS_DOT.warning,
              )}
            />
            <span
              className={cn(
                'relative inline-flex size-1.5 rounded-full ring-2 ring-background',
                STATUS_DOT.warning,
              )}
            />
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={8} className="w-[320px] overflow-hidden rounded-2xl p-0">
        <div className="border-b border-border/60 px-4 pt-4 pb-3">
          <div className="flex items-center gap-2.5">
            <span className={cn('grid size-7 shrink-0 place-items-center rounded-full', STATUS_BG.warning, STATUS_TEXT.warning)}>
              <GitPullRequestArrow className="size-3.5" />
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold tracking-tight text-foreground">
                {changedCount} change{changedCount === 1 ? '' : 's'} in this version
              </h3>
              <p className="truncate text-xs text-muted-foreground">
                Not in your <span className="font-mono">{baseRef}</span> version yet
              </p>
            </div>
          </div>
          <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
            This session is a separate version of{' '}
            <span className="font-mono text-foreground/80">{baseRef}</span>. These
            changes only exist here — they&apos;re not in your{' '}
            <span className="font-mono text-foreground/80">{baseRef}</span> version
            yet. Open a change request to merge them in.
          </p>
        </div>

        {/* Compact, read-only file list — the "what changed" at a glance. */}
        <div className="max-h-40 overflow-auto px-1.5 py-1.5">
          {changedFiles.map((file) => {
            const badge = CHANGE_STATUS_BADGE[file.status] ?? CHANGE_STATUS_BADGE.modified;
            const name = file.path.split('/').pop() || file.path;
            const dir = file.path.slice(0, file.path.length - name.length);
            return (
              <div
                key={file.path}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-xs"
              >
                <span
                  className={cn('w-3 shrink-0 text-center font-mono font-semibold', badge.cls)}
                  title={badge.label}
                >
                  {badge.letter}
                </span>
                <span className="truncate font-medium text-foreground/90">{name}</span>
                {dir && (
                  <span className="truncate font-mono text-[10px] text-muted-foreground/50">
                    {dir.replace(/\/$/, '')}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2.5">
          <Button
            size="sm"
            className="h-8 flex-1 gap-1.5 text-xs"
            onClick={openChangeRequest}
            disabled={asking}
          >
            {asking ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <GitPullRequestArrow className="size-3.5" />
            )}
            Open change request
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs text-muted-foreground hover:text-foreground"
            onClick={viewChanges}
          >
            View changes
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
