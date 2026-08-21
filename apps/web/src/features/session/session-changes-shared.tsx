'use client';

/**
 * Shared primitives for surfacing a session's uncommitted changes — used by
 * both the in-panel <SessionVersionHeader> and the header
 * <SessionChangesIndicator>. Keeping the prompt wording, the base-ref lookup,
 * and the status badges in one place means the two surfaces never drift.
 */

import { useCallback, useMemo, useState } from 'react';

import { STATUS_TEXT } from '@/components/ui/status';
import { errorToast, successToast } from '@/components/ui/toast';
import { useChatSendStore } from '@/stores/chat-send-store';
import {
  useProjectSession,
  useRuntimeProjectInfo,
  useRuntimeReady,
  useRuntimeVcsDiff,
  type VcsFileDiff,
} from '@kortix/sdk/react';

/** diff status → single-letter badge, using the canonical status tones. */
export const CHANGE_STATUS_BADGE: Record<string, { letter: string; cls: string; label: string }> = {
  added: { letter: 'A', cls: STATUS_TEXT.success, label: 'Added' },
  modified: { letter: 'M', cls: STATUS_TEXT.warning, label: 'Modified' },
  deleted: { letter: 'D', cls: STATUS_TEXT.destructive, label: 'Deleted' },
};

/**
 * THE session's changes — one query, one array, read by every Changes surface.
 *
 * The tab badge (`SessionVersionHeader`), the header chip
 * (`SessionChangesIndicator`) and the diff panel (`SessionDiffViewer`) all call
 * this hook. React Query dedupes by key, so the three cannot disagree: "Changes
 * 32" above "No changes yet" is unreachable once they share a cache entry.
 *
 * Mode is `branch`, deliberately. The surface's own copy promises "what this
 * session changed … these edits stay here and don't affect <base> until you
 * propose the changes", and "Propose changes" runs `kortix cr open`, which
 * COMMITS the working tree. So the set that matters is version-vs-base — every
 * commit on this branch plus the dirty tree — not the working tree alone. A
 * working-tree-only read drops to zero the moment the agent commits, and the
 * badge and the CTA vanish while the work is still not in the base version.
 */
export interface SessionChanges {
  /** Every file this version changed against its base. Never undefined. */
  files: VcsFileDiff[];
  count: number;
  /**
   * True while the answer is genuinely unknown — the runtime is still booting,
   * or the first read has not landed. A disabled query is NOT an empty result,
   * so a caller must render a loading state here, never "no changes yet".
   */
  isPending: boolean;
  /** False when the project has no git, so there is nothing to compare. */
  isTracked: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useSessionChanges(): SessionChanges {
  // Shares `runtimeKeys.currentProject()` with every other project-info reader.
  const projectQuery = useRuntimeProjectInfo();
  const runtimeReady = useRuntimeReady();

  const trackingKnown = projectQuery.data !== undefined || projectQuery.isError;
  const isTracked = projectQuery.data?.vcs === 'git';

  const diffQuery = useRuntimeVcsDiff('branch', { enabled: isTracked });
  const error = (diffQuery.error ?? projectQuery.error ?? null) as Error | null;

  const files = diffQuery.data;
  // `isPending` from react-query stays true forever on a DISABLED query, which
  // is why the panel used to assert "no changes" during boot without ever
  // having asked. Ask the three real questions instead.
  const isPending =
    !error && (!runtimeReady || !trackingKnown || (isTracked && files === undefined));

  const { refetch } = diffQuery;
  return useMemo<SessionChanges>(
    () => ({
      files: files ?? [],
      count: files?.length ?? 0,
      isPending,
      isTracked,
      error,
      refetch: () => void refetch(),
    }),
    [files, isPending, isTracked, error, refetch],
  );
}

/** The base branch this session forks from (e.g. `main`). Defaults to `main`. */
export function useSessionBaseRef(
  projectId: string | undefined,
  gitSessionId: string | undefined,
): string {
  // `useProjectSession` owns the key, the freshness contract and the fetcher
  // for this entry — see its doc comment for why all three readers must agree.
  const sessionQuery = useProjectSession(projectId, gitSessionId);
  return sessionQuery.data?.base_ref ?? 'main';
}

/**
 * Ask the agent to commit this session's work and open a change request — it
 * runs `kortix cr open` for the user to review & merge. When there's no live
 * chat session to message, the prompt is copied to the clipboard instead.
 */
export function useOpenChangeRequest(chatSessionId: string | undefined, baseRef: string) {
  const sendToSession = useChatSendStore((s) => s.sendToSession);
  const [asking, setAsking] = useState(false);

  const openChangeRequest = useCallback(async () => {
    if (asking) return;
    const prompt = `Load the kortix-system skill and read about Versions & Change Requests. Then review the changes in this session, commit them, and open a change request to merge into \`${baseRef}\`. Give it a clear title and a description of what changed and why.`;

    if (!chatSessionId) {
      try {
        await navigator.clipboard.writeText(prompt);
        successToast('Prompt copied — paste it into the chat to ask your agent.');
      } catch {
        errorToast('Could not copy to clipboard.');
      }
      return;
    }

    setAsking(true);
    try {
      await sendToSession(chatSessionId, prompt);
      successToast('Asked your agent to propose these changes for review.');
    } catch (err) {
      errorToast(
        err instanceof Error ? err.message : 'Could not reach the agent. Please try again.',
      );
    } finally {
      setAsking(false);
    }
  }, [asking, baseRef, chatSessionId, sendToSession]);

  return { asking, openChangeRequest };
}
