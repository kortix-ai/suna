import type { QueryClient } from '@tanstack/react-query';

import { qk } from './query-keys';

type SessionTitleQueryClient = Pick<QueryClient, 'getQueryData' | 'refetchQueries'>;

interface SessionTitleRefreshOptions {
  delaysMs?: number[];
  signal?: AbortSignal;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_TITLE_REFRESH_DELAYS_MS = [0, 5_000, 5_000, 10_000, 10_000, 15_000, 20_000];

function readRealTitle(value: unknown): string | null {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || /^new (?:session|agent)\b/i.test(title)) return null;
  return title;
}

function cachedSessionHasTitle(
  queryClient: Pick<QueryClient, 'getQueryData'>,
  workspaceId: string,
  sessionId: string,
): boolean {
  // Exact-match reads (`getQueryData`), so these have to be the REAL cache
  // entries the list/detail queries populate, not the broad `sessionsScope`
  // invalidation prefix used below — `getQueryData` never does prefix
  // matching. Default scope ('visible') matches `listProjectSessions`' own
  // default and what the sidebar/list surfaces actually read.
  const list = queryClient.getQueryData<unknown>(qk.workspace.sessions(workspaceId));
  const detail = queryClient.getQueryData<unknown>(qk.workspace.session(workspaceId, sessionId));
  const candidates = [...(Array.isArray(list) ? list : []), detail];
  return candidates.some((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const session = candidate as Record<string, unknown>;
    const candidateId =
      typeof session.session_id === 'string'
        ? session.session_id
        : typeof session.sessionId === 'string'
          ? session.sessionId
          : null;
    if (candidateId !== sessionId) return false;
    return Boolean(readRealTitle(session.custom_name) || readRealTitle(session.name));
  });
}

function refetchSessionTitleQueries(
  queryClient: Pick<QueryClient, 'refetchQueries'>,
  workspaceId: string,
  sessionId: string,
): Promise<unknown[]> {
  return Promise.all([
    // The broad sessions-family prefix, not just the default-scope list: it
    // reaches the list in EVERY scope plus every session/messages entry
    // beneath it, so a manager-only 'project'-scope reader picks up the
    // resolved title too, not only the default 'visible' one.
    queryClient.refetchQueries({
      queryKey: qk.workspace.sessionsScope(workspaceId),
      type: 'active',
    }),
    queryClient.refetchQueries({
      queryKey: qk.workspace.session(workspaceId, sessionId),
      type: 'active',
    }),
  ]);
}

function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Refetch the authoritative Kortix session until its generated title appears.
 *
 * OpenCode generates titles asynchronously. This bounded loop refreshes the
 * authoritative Kortix session without permanent sidebar polling.
 */
export async function refreshSessionTitleQueryUntilResolved(
  queryClient: SessionTitleQueryClient,
  workspaceId: string,
  sessionId: string,
  options: SessionTitleRefreshOptions = {},
): Promise<boolean> {
  const delays = options.delaysMs ?? DEFAULT_TITLE_REFRESH_DELAYS_MS;
  const wait = options.sleep ?? sleep;

  for (const delayMs of delays) {
    await wait(delayMs, options.signal);
    if (options.signal?.aborted) return false;
    if (cachedSessionHasTitle(queryClient, workspaceId, sessionId)) return true;
    await refetchSessionTitleQueries(queryClient, workspaceId, sessionId);
    if (cachedSessionHasTitle(queryClient, workspaceId, sessionId)) return true;
  }
  return false;
}

/**
 * Reconcile a server-generated title after the conversation hydrates.
 *
 * This also covers an existing session opened after the original post-send
 * refresh window ended. Empty conversations never poll.
 */
export async function reconcileHydratedSessionTitle(
  queryClient: SessionTitleQueryClient,
  workspaceId: string,
  sessionId: string,
  userMessageCount: number,
  options: SessionTitleRefreshOptions = {},
): Promise<boolean> {
  if (userMessageCount <= 0) return false;
  if (cachedSessionHasTitle(queryClient, workspaceId, sessionId)) return true;
  return refreshSessionTitleQueryUntilResolved(queryClient, workspaceId, sessionId, options);
}
