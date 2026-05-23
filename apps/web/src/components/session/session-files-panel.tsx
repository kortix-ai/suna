'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { GitPullRequestArrow, Loader2, Sparkles } from 'lucide-react';

import { getProjectSession } from '@/lib/projects-client';
import { useGitStatus } from '@/features/files/hooks/use-git-status';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

import { Button } from '@/components/ui/button';
import { STATUS_TEXT } from '@/components/ui/status';

// Status → single-letter badge, using the canonical status-text tones.
const STATUS_BADGE: Record<string, { letter: string; cls: string; label: string }> = {
  added: { letter: 'A', cls: STATUS_TEXT.success, label: 'Added' },
  modified: { letter: 'M', cls: STATUS_TEXT.warning, label: 'Modified' },
  deleted: { letter: 'D', cls: STATUS_TEXT.destructive, label: 'Deleted' },
};

/**
 * Side-panel "Changes" view.
 *
 * Each session runs on its own standalone version of the project (a branch
 * forked from `base_ref`), so work here never touches the main version until
 * it's explicitly merged. This panel is intentionally NOT a file browser — the
 * full explorer lives in the main Files tab + Customize. Here we only surface:
 *
 *   1. what changed in this session (git status), and
 *   2. the one way to persist it: ask the agent to open a change request, which
 *      it commits + opens via `kortix cr open` for the user to review & merge.
 */
export function SessionFilesPanel() {
  // The git branch == the ROUTE session id; SessionLayout's `sessionId` prop is
  // the OpenCode chat session id (used to message the agent).
  const { id: projectId, sessionId: gitSessionId } = useParams<{
    id: string;
    sessionId: string;
  }>();

  const statusQuery = useGitStatus();
  const changedFiles = statusQuery.data ?? [];
  const changedCount = changedFiles.length;
  // Show a loader until the first git-status result lands (or while refetching
  // with nothing yet) instead of flashing the empty state prematurely.
  const isLoadingChanges =
    !statusQuery.data && (statusQuery.isLoading || statusQuery.isFetching);

  const sessionQuery = useQuery({
    queryKey: ['project', 'session', projectId, gitSessionId],
    queryFn: () => getProjectSession(projectId!, gitSessionId!),
    enabled: !!projectId && !!gitSessionId,
    staleTime: 60_000,
  });
  const baseRef = sessionQuery.data?.base_ref ?? 'main';

  const { openPreview } = useFilePreviewStore();

  // Copy a ready-to-send prompt to the clipboard so the user can paste it into
  // the chat — the agent then commits and runs `kortix cr open`. (We copy
  // rather than auto-send because programmatic enqueue isn't reliable here.)
  const copyChangeRequestPrompt = async () => {
    const prompt = `Load the kortix-system skill and read about Versions & Change Requests. Then review the changes in this session, commit them, and open a change request to merge into \`${baseRef}\`. Give it a clear title and a description of what changed and why.`;
    try {
      await navigator.clipboard.writeText(prompt);
      toast.success('Prompt copied — paste it into the chat to ask your agent.');
    } catch {
      toast.error('Could not copy to clipboard.');
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* What this is + the one action. */}
      <div className="flex-shrink-0 space-y-3 border-b border-border/40 p-4">
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium text-foreground">
            This session is its own version
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Changes here live on a standalone version of your project — separate
            from{' '}
            <span className="font-mono text-foreground/80">{baseRef}</span>, so
            you can work in parallel without affecting it. To make any of them
            part of your main Kortix version, ask your agent to open a{' '}
            <span className="font-medium text-foreground/80">change request</span>
            ; you can review and merge it into{' '}
            <span className="font-mono text-foreground/80">{baseRef}</span>{' '}
            whenever you&apos;re ready.
          </p>
        </div>
        <Button size="sm" className="w-full" onClick={copyChangeRequestPrompt}>
          <Sparkles className="size-3.5" />
          Ask agent to open a change request
        </Button>
      </div>

      {/* The currently-changed files (git status). */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground/60">
          <GitPullRequestArrow className="size-3.5" />
          Changes
          {changedCount > 0 && (
            <span className="text-muted-foreground/40">· {changedCount}</span>
          )}
        </div>

        {isLoadingChanges ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground/50">
            <Loader2 className="size-4 animate-spin" />
            Loading changes…
          </div>
        ) : changedCount > 0 ? (
          <div className="space-y-0.5">
            {changedFiles.map((file) => {
              const badge = STATUS_BADGE[file.status] ?? STATUS_BADGE.modified;
              const name = file.path.split('/').pop() || file.path;
              const dir = file.path.slice(0, file.path.length - name.length);
              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => openPreview(file.path)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
                >
                  <span
                    className={cn(
                      'w-3 flex-shrink-0 text-center font-mono font-semibold',
                      badge.cls,
                    )}
                    title={badge.label}
                  >
                    {badge.letter}
                  </span>
                  <span className="truncate font-medium text-foreground/90">
                    {name}
                  </span>
                  {dir && (
                    <span className="truncate font-mono text-[10px] text-muted-foreground/50">
                      {dir.replace(/\/$/, '')}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="px-1 py-8 text-center text-xs text-muted-foreground/60">
            No changes yet. Files the agent creates or edits in this session will
            show up here.
          </div>
        )}
      </div>
    </div>
  );
}
