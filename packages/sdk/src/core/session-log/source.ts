/**
 * Where the v2 session log comes from, and when a client reads it.
 *
 * NEGOTIATION. A session reads `kortix.session/2` only when all three hold:
 *  - the runtime's `/kortix/health` lists `session.log.v2` (a daemon that serves the
 *    `log.*` frames). An absent or empty list is not support: `runtimeSupports` reads
 *    such a list as "every feature" (an old OpenCode daemon), negotiation does not;
 *  - the project flag `session_log` is exactly `true`. An API that predates the session
 *    log does not serve the flag, so an SDK newer than its API keeps v1;
 *  - this SDK has a page loader. An SDK published before the API route keeps v1.
 * Otherwise the session reads v1, exactly as before the session log existed.
 *
 * THE PAGE LOADER reads `GET /v1/projects/:p/sessions/:s/log?thread=&before_seq=&limit=`
 * (`@kortix/api-contract/session-log` `SessionLogPageSchema`). `SessionLogPage` is that
 * schema's type, written out because this package has no zod; `contract-drift.test.ts` holds
 * the two equal at typecheck. `SessionLogPage` and `SessionLogPageQuery` are public (the types of
 * `getSessionLogPage`); the loader is internal. A 404 (the session has no stored log, or no such
 * thread) reads as no page, and the session stays on v1.
 */
import { backendApi } from '../http/api-client';
import { isSessionLogPage } from './guard';
import type { SessionLogSessionRecord, SessionLogThreadHead } from './store';
import type { SessionLogMessage } from './types';

/** One page of one thread: the session record, every thread head, and the thread's messages by `seq`. */
export interface SessionLogPage {
  /** The session record without `threads`; a field the daemon has not journaled yet is absent. */
  session: Partial<SessionLogSessionRecord>;
  generation: number;
  threads: SessionLogThreadHead[];
  /** The paged thread: the one asked for, else the root thread; null when no thread is stored. */
  thread_id: string | null;
  /** That thread's newest messages before `before_seq`, ascending `seq`; tombstones excluded. */
  messages: SessionLogMessage[];
  /** Older messages exist: ask again with `before_seq` = the first message's `seq`. */
  has_more: boolean;
}

export interface SessionLogPageQuery {
  /** Default: the root thread. */
  thread?: string;
  before_seq?: number;
  limit?: number;
}

/** Fetches one page. The answer is validated by the caller, so it is `unknown` here. */
export type LoadSessionLogPage = (
  projectId: string,
  sessionId: string,
  query: SessionLogPageQuery,
  signal?: AbortSignal,
) => Promise<unknown>;

/** The route's answer as is; `fetchFirstSessionLogPage` validates it. Throws on a non-2xx. */
export const loadSessionLogPage: LoadSessionLogPage | null = async (projectId, sessionId, query, signal) => {
  const search = new URLSearchParams();
  if (query.thread !== undefined) search.set('thread', query.thread);
  if (query.before_seq !== undefined) search.set('before_seq', String(query.before_seq));
  if (query.limit !== undefined) search.set('limit', String(query.limit));
  const qs = search.toString();
  const response = await backendApi.get<unknown>(
    `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/log${qs ? `?${qs}` : ''}`,
    { showErrors: false, signal },
  );
  if (!response.success) throw response.error ?? new Error('Session log request failed');
  return response.data;
};

/** The first window, the same size as the v1 mirror's (`MIRROR_HYDRATE_LIMIT`). */
export const SESSION_LOG_FIRST_PAGE_LIMIT = 40;

export type SessionLogDialect = 'v1' | 'v2';

export function negotiateSessionLog(input: {
  capabilities: readonly string[] | null | undefined;
  flag: boolean | undefined;
  loader: LoadSessionLogPage | null;
}): SessionLogDialect {
  const served = Array.isArray(input.capabilities) && input.capabilities.includes('session.log.v2');
  return served && input.flag === true && input.loader !== null ? 'v2' : 'v1';
}

/** The newest page of the root thread, validated. Null on any failure; never throws. */
export async function fetchFirstSessionLogPage(
  load: LoadSessionLogPage,
  projectId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionLogPage | null> {
  try {
    const page = await load(projectId, sessionId, { limit: SESSION_LOG_FIRST_PAGE_LIMIT }, signal);
    return isSessionLogPage(page) ? page : null;
  } catch {
    return null;
  }
}
