import type { QueryClient } from '@tanstack/react-query';

import { sessionStartKey } from '../core/rest/projects-client';
import { qk } from './query-keys';

type SessionTitleQueryClient = Pick<QueryClient, 'getQueryData' | 'refetchQueries'> & {
  /** Optional so lean test fakes (and older callers) keep working; a real
   *  QueryClient always has it. */
  getQueryState?: QueryClient['getQueryState'];
};

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
  projectId: string,
  sessionId: string,
): boolean {
  // Exact-match reads (`getQueryData`), so these have to be the REAL cache
  // entries the list/detail queries populate, not the broad `sessionsScope`
  // invalidation prefix used below — `getQueryData` never does prefix
  // matching. Default scope ('visible') matches `listProjectSessions`' own
  // default and what the sidebar/list surfaces actually read.
  const list = queryClient.getQueryData<unknown>(qk.project.sessions(projectId));
  const detail = queryClient.getQueryData<unknown>(qk.project.session(projectId, sessionId));
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
  queryClient: SessionTitleQueryClient,
  projectId: string,
  sessionId: string,
): Promise<unknown[]> {
  // An adopted warm session is revealed by /start dropping `metadata.warm`.
  // While THIS session's /start is still in flight, a sessions-list refetch
  // can beat it, observe the row still hidden, and overwrite the adopting
  // tab's optimistic seed (warm-session-seed.ts in apps/web) — so the list
  // half waits for the next ladder pass. The detail refetch stays: the
  // session route serves the owner regardless of the marker.
  const startFetching =
    queryClient.getQueryState?.(sessionStartKey(projectId, sessionId))?.fetchStatus === 'fetching';
  return Promise.all([
    // The LIST family — `[...sessionsScope, 'list']` — so a manager-only
    // 'project'-scope reader picks up the resolved title too, not only the
    // default 'visible' one.
    //
    // NOT the whole `sessionsScope` prefix, which this used to be. That prefix
    // also covers `sessionTurn`, `sessionPrompts` and `messages` (see
    // `query-keys.ts`), so ONE title pass re-issued four endpoints — and the
    // ladder runs up to seven passes over ~65 s. Measured on a real
    // deployment: 5.8 `GET /sessions` and 6 `GET .../turn` per session open,
    // the single largest cumulative cost on the open path. A title ladder
    // refetches titles.
    ...(startFetching
      ? []
      : [
          queryClient.refetchQueries({
            queryKey: [...qk.project.sessionsScope(projectId), 'list'],
            type: 'active',
          }),
        ]),
    queryClient.refetchQueries({
      // EXACT: `qk.project.session(...)` is the PARENT of `prompts` and `turn`,
      // so a prefix refetch here is the same accident in miniature.
      queryKey: qk.project.session(projectId, sessionId),
      exact: true,
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
  projectId: string,
  sessionId: string,
  options: SessionTitleRefreshOptions = {},
): Promise<boolean> {
  const delays = options.delaysMs ?? DEFAULT_TITLE_REFRESH_DELAYS_MS;
  const wait = options.sleep ?? sleep;

  for (const delayMs of delays) {
    await wait(delayMs, options.signal);
    if (options.signal?.aborted) return false;
    if (cachedSessionHasTitle(queryClient, projectId, sessionId)) return true;
    await refetchSessionTitleQueries(queryClient, projectId, sessionId);
    if (cachedSessionHasTitle(queryClient, projectId, sessionId)) return true;
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
  projectId: string,
  sessionId: string,
  userMessageCount: number,
  options: SessionTitleRefreshOptions = {},
): Promise<boolean> {
  if (userMessageCount <= 0) return false;
  if (cachedSessionHasTitle(queryClient, projectId, sessionId)) return true;
  return refreshSessionTitleQueryUntilResolved(queryClient, projectId, sessionId, options);
}
