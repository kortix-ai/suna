/**
 * useSessionChanges — the open thread's changed files, for the session actions
 * sheet's View changes row (COR-148).
 *
 * Mirrors web's `useSessionChanges` (`features/session/session-changes-shared`):
 * the runtime's `/vcs/diff` in `branch` mode — the working tree plus every
 * commit this session's branch carries over its base. A working-tree-only
 * read drops to zero the moment the agent commits, while the work is still
 * not in the base version.
 *
 * `session/:id/diff` (the old mobile sheet's source) answers a different
 * question: what one user message changed.
 */
import { useQuery } from '@tanstack/react-query';

import { opencodeFetch } from './use-opencode-data';
import { summarizeSessionChanges } from '@/lib/session/session-actions';

export const sessionChangesKey = (sandboxUrl: string) =>
  ['opencode', 'vcs-diff', 'branch', sandboxUrl] as const;

export function useSessionChanges(sandboxUrl: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: sessionChangesKey(sandboxUrl ?? ''),
    queryFn: () => opencodeFetch<unknown>(sandboxUrl!, '/vcs/diff?mode=branch'),
    select: summarizeSessionChanges,
    enabled: enabled && !!sandboxUrl,
    // Read fresh each time the sheet opens; the agent edits between opens.
    staleTime: 5_000,
    retry: 1,
  });
}
