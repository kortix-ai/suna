'use client';

/**
 * A box that serves its log (`runtime.log.v1`): the session list and session records come from
 * the session log the client already holds (its thread heads), never from the box's OpenCode
 * routes. The rows keep the compatibility `Session` shape the session hooks have always answered.
 */
import type { UseQueryResult } from '@tanstack/react-query';
import { useSandboxConnectionStore } from '../../browser/stores/sandbox-connection-store';
import type { Session } from '../../core/runtime/runtime-types';
import { RUNTIME_LOG_CAPABILITY } from '../../core/session/runtime-actions';
import type { SessionLogState } from '../../core/session-log/store';

/** The active runtime lists `runtime.log.v1`. */
export function useRuntimeServesLog(): boolean {
  return useSandboxConnectionStore((state) => state.runtimeCapabilities?.includes(RUNTIME_LOG_CAPABILITY) === true);
}

const time = (iso: string | null | undefined): number => {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
};

/** Every thread the held logs name, as `Session` rows, newest activity first. */
export function logSessionRows(logs: Readonly<Record<string, SessionLogState | undefined>>): Session[] {
  const rows: Session[] = [];
  for (const log of Object.values(logs)) {
    if (!log) continue;
    for (const head of Object.values(log.threads)) {
      const last = log.messages[head.thread_id]?.at(-1);
      const created = time(head.created_at);
      const root = head.parent_thread_id === null;
      rows.push({
        id: head.thread_id,
        slug: head.thread_id,
        projectID: '',
        directory: '',
        version: '',
        title: head.title ?? (root ? (log.session.title ?? '') : ''),
        ...(root ? {} : { parentID: head.parent_thread_id! }),
        ...(head.agent ? { agent: head.agent } : {}),
        time: { created, updated: Math.max(created, time(last?.completed_at ?? last?.created_at)) },
      });
    }
  }
  return rows.sort((a, b) => b.time.updated - a.time.updated);
}

/** A query result that answers `data` as a settled success: the log is already in the client. */
export function settledFromLog<T>(query: UseQueryResult<T>, data: T): UseQueryResult<T> {
  return {
    ...query,
    data,
    error: null,
    status: 'success',
    fetchStatus: 'idle',
    isSuccess: true,
    isError: false,
    isPending: false,
    isLoading: false,
    isLoadingError: false,
    isRefetchError: false,
    isFetched: true,
    isFetchedAfterMount: true,
    isFetching: false,
    isRefetching: false,
    isPlaceholderData: false,
  } as UseQueryResult<T>;
}
