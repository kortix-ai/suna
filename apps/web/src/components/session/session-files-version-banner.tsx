'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  GitBranch,
  GitPullRequestArrow,
  Loader2,
  Sparkles,
} from 'lucide-react';

import { getProjectSession } from '@/lib/projects-client';
import { useGitStatus } from '@/features/files/hooks/use-git-status';
import { useFilesStore } from '@/features/files';
import { useChatSendStore } from '@/stores/chat-send-store';
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

/** git-status paths are repo-relative; the explorer/preview use /workspace-absolute. */
function toAbsolute(p: string): string {
  return p.startsWith('/workspace/') ? p : `/workspace/${p}`;
}

/**
 * Version banner that sits at the very top of the session Files screen — above
 * the explorer toolbar.
 *
 * It frames the whole screen for what it is: a **standalone, parallel version of
 * the project's main branch**. The agent works here without touching the live
 * version, so when there are changes we surface (1) a clear "this is an alternate
 * version of `<base>`" message, (2) the diff (the files that differ), and (3) the
 * one way to persist them: open a change request to merge into `<base>`.
 *
 * Rendered INSIDE the Files screen's FilesStoreProvider, so clicking a changed
 * file opens it in the same preview modal the explorer uses.
 */
export function SessionFilesVersionBanner({
  /** OpenCode chat session id — the agent we message to open the change request. */
  chatSessionId,
}: {
  chatSessionId?: string;
}) {
  // The git branch == the ROUTE session id; the chat session id is passed in.
  const { id: projectId, sessionId: gitSessionId } = useParams<{
    id: string;
    sessionId: string;
  }>();

  const statusQuery = useGitStatus();
  const changedFiles = statusQuery.data ?? [];
  const changedCount = changedFiles.length;
  const isLoading =
    !statusQuery.data && (statusQuery.isLoading || statusQuery.isFetching);

  const sessionQuery = useQuery({
    queryKey: ['project', 'session', projectId, gitSessionId],
    queryFn: () => getProjectSession(projectId!, gitSessionId!),
    enabled: !!projectId && !!gitSessionId,
    staleTime: 60_000,
  });
  const baseRef = sessionQuery.data?.base_ref ?? 'main';

  const openFileWithList = useFilesStore((s) => s.openFileWithList);
  const sendToSession = useChatSendStore((s) => s.sendToSession);
  const [asking, setAsking] = useState(false);

  // Expansion defaults to "open when there's a diff to show", but the user's
  // explicit toggle wins once they touch it.
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const expanded = userToggled ?? changedCount > 0;

  const absPaths = useMemo(
    () => changedFiles.map((f) => toAbsolute(f.path)),
    [changedFiles],
  );

  const openChange = (filePath: string) => {
    const abs = toAbsolute(filePath);
    openFileWithList(abs, absPaths, Math.max(0, absPaths.indexOf(abs)));
  };

  // Ask the agent to commit this version's work and open a change request — it
  // runs `kortix cr open` for the user to review & merge. Same path as the old
  // Changes tab, sent straight through the chat send pipe.
  const openChangeRequest = async () => {
    if (asking) return;
    const prompt = `Load the kortix-system skill and read about Versions & Change Requests. Then review the changes in this session, commit them, and open a change request to merge into \`${baseRef}\`. Give it a clear title and a description of what changed and why.`;

    if (!chatSessionId) {
      try {
        await navigator.clipboard.writeText(prompt);
        toast.success('Prompt copied — paste it into the chat to ask your agent.');
      } catch {
        toast.error('Could not copy to clipboard.');
      }
      return;
    }

    setAsking(true);
    try {
      await sendToSession(chatSessionId, prompt);
      toast.success('Asked your agent to commit and open a change request.');
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not reach the agent. Please try again.',
      );
    } finally {
      setAsking(false);
    }
  };

  const hasChanges = changedCount > 0;

  return (
    <div className="flex-shrink-0 border-b border-border/40 bg-muted/20">
      {/* Summary row — always visible. */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setUserToggled(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground/70" />
          <span className="min-w-0 truncate text-xs">
            <span className="font-medium text-foreground">Alternate version</span>
            <span className="text-muted-foreground"> of </span>
            <span className="font-mono text-foreground/80">{baseRef}</span>
          </span>
          {isLoading ? (
            <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground/40" />
          ) : hasChanges ? (
            <span className={cn('shrink-0 text-xs font-medium', STATUS_TEXT.warning)}>
              · {changedCount} change{changedCount === 1 ? '' : 's'}
            </span>
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground/50">· no changes</span>
          )}
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground/40 transition-transform',
              expanded ? 'rotate-0' : '-rotate-90',
            )}
          />
        </button>

        {hasChanges && (
          <Button
            size="sm"
            className="h-7 shrink-0 gap-1.5 text-xs"
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
        )}
      </div>

      {/* Expanded: explanation + the diff. */}
      {expanded && (
        <div className="space-y-2 px-3 pb-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            This is a standalone copy of{' '}
            <span className="font-mono text-foreground/80">{baseRef}</span> — the
            agent works here in parallel without affecting the live version. To
            persist {hasChanges ? 'these changes' : 'any changes'}, open a change
            request and review &amp; merge it into{' '}
            <span className="font-mono text-foreground/80">{baseRef}</span> when
            you&apos;re ready.
          </p>

          {hasChanges && (
            <div className="max-h-48 space-y-0.5 overflow-auto rounded-lg border border-border/40 bg-background/50 p-1">
              {changedFiles.map((file) => {
                const badge = STATUS_BADGE[file.status] ?? STATUS_BADGE.modified;
                const name = file.path.split('/').pop() || file.path;
                const dir = file.path.slice(0, file.path.length - name.length);
                return (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => openChange(file.path)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-muted/60"
                  >
                    <span
                      className={cn(
                        'w-3 shrink-0 text-center font-mono font-semibold',
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
          )}
        </div>
      )}
    </div>
  );
}
