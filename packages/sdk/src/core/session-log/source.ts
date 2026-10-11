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
 * THE PAGE LOADER is `null` until `GET /v1/projects/:p/sessions/:s/log?thread=&before_seq=&limit=`
 * (P4.2) is served. `SessionLogPage` mirrors the shape that route answers. It is internal and
 * not exported: the api-contract owns the schema, and this file takes a byte-equal copy of
 * it, held by a drift test, when the route lands.
 */
import { isSessionLogPage } from './guard';
import type { SessionLogSessionRecord, SessionLogThreadHead } from './store';
import type { SessionLogMessage } from './types';

/** One page of one thread: the session record, every thread head, and the thread's messages by `seq`. */
export interface SessionLogPage {
  session: SessionLogSessionRecord;
  generation: number;
  threads: SessionLogThreadHead[];
  /** One thread's messages, ascending `seq`; tombstones excluded. */
  messages: SessionLogMessage[];
  /** Older messages of the thread exist (page with `before_seq`). */
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

/** `null` until the API serves the route (P4.2): negotiation then resolves to v1. */
export const loadSessionLogPage: LoadSessionLogPage | null = null;

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
