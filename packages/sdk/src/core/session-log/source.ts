/**
 * Where the v2 session log comes from, and when a client reads it.
 *
 * NEGOTIATION. A session reads `kortix.session/2` first, always: the first read of an open is
 * `GET …/log`. The project flag `session_log` is not read (the API deletes it). A 404 or an
 * invalid page (an API that predates the session log, or a session with no stored log yet)
 * falls back to v1, exactly as before the session log existed. The runtime is not asked: the stored log is the API's (a stopped box reads it too), and the session
 * stream serves `schema=v2` for every daemon (it converts the v1 frames of a daemon that
 * does not list `session.log.v2`).
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

/** An older page: the reader scrolls on purpose, so fewer round trips win (the v1 older page is 100 too). */
export const SESSION_LOG_OLDER_PAGE_LIMIT = 100;

export type SessionLogDialect = 'v1' | 'v2';

/** One page, validated. Null on any failure; never throws. */
export async function fetchSessionLogPage(
  load: LoadSessionLogPage,
  projectId: string,
  sessionId: string,
  query: SessionLogPageQuery,
  signal?: AbortSignal,
): Promise<SessionLogPage | null> {
  try {
    const page = await load(projectId, sessionId, query, signal);
    return isSessionLogPage(page) ? page : null;
  } catch {
    return null;
  }
}

/** The newest page of the root thread, validated. Null on any failure; never throws. */
export function fetchFirstSessionLogPage(
  load: LoadSessionLogPage,
  projectId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionLogPage | null> {
  return fetchSessionLogPage(load, projectId, sessionId, { limit: SESSION_LOG_FIRST_PAGE_LIMIT }, signal);
}
