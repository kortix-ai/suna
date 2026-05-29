'use client';

/**
 * Shared primitives for surfacing a session's uncommitted changes — used by
 * both the in-panel <SessionVersionHeader> and the header
 * <SessionChangesIndicator>. Keeping the prompt wording, the base-ref lookup,
 * and the status badges in one place means the two surfaces never drift.
 */

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { getProjectSession } from '@/lib/projects-client';
import { useChatSendStore } from '@/stores/chat-send-store';
import { STATUS_TEXT } from '@/components/ui/status';
import { toast } from '@/lib/toast';

/** git-status status → single-letter badge, using the canonical status tones. */
export const CHANGE_STATUS_BADGE: Record<
  string,
  { letter: string; cls: string; label: string }
> = {
  added: { letter: 'A', cls: STATUS_TEXT.success, label: 'Added' },
  modified: { letter: 'M', cls: STATUS_TEXT.warning, label: 'Modified' },
  deleted: { letter: 'D', cls: STATUS_TEXT.destructive, label: 'Deleted' },
};

/** The base branch this session forks from (e.g. `main`). Defaults to `main`. */
export function useSessionBaseRef(
  projectId: string | undefined,
  gitSessionId: string | undefined,
): string {
  const sessionQuery = useQuery({
    queryKey: ['project', 'session', projectId, gitSessionId],
    queryFn: () => getProjectSession(projectId!, gitSessionId!),
    enabled: !!projectId && !!gitSessionId,
    staleTime: 60_000,
  });
  return sessionQuery.data?.base_ref ?? 'main';
}

/**
 * Ask the agent to commit this session's work and open a change request — it
 * runs `kortix cr open` for the user to review & merge. When there's no live
 * chat session to message, the prompt is copied to the clipboard instead.
 */
export function useOpenChangeRequest(
  chatSessionId: string | undefined,
  baseRef: string,
) {
  const sendToSession = useChatSendStore((s) => s.sendToSession);
  const [asking, setAsking] = useState(false);

  const openChangeRequest = useCallback(async () => {
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
  }, [asking, baseRef, chatSessionId, sendToSession]);

  return { asking, openChangeRequest };
}
