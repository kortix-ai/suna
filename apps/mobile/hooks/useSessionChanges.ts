/**
 * useSessionChanges — the open thread's changed files, for the session actions
 * sheet's View changes row (COR-148).
 *
 * Mirrors web's `useSessionChanges` (`features/session/session-changes-shared`):
 * the runtime's branch diff (`useRuntimeVcsDiff('branch')`) — the working tree
 * plus every commit this session's branch carries over its base. A
 * working-tree-only read drops to zero the moment the agent commits, while the
 * work is still not in the base version. The SDK re-reads it when the live
 * stream reports an edit.
 */
import { useMemo } from 'react';
import { useRuntimeVcsDiff } from '@kortix/sdk/react';

import { summarizeSessionChanges } from '@/lib/session/session-actions';

export function useSessionChanges(enabled: boolean) {
  const query = useRuntimeVcsDiff('branch', { enabled });
  const data = useMemo(() => (query.data ? summarizeSessionChanges(query.data) : undefined), [query.data]);
  return { data, isPending: query.isPending, isError: query.isError, refetch: query.refetch };
}
