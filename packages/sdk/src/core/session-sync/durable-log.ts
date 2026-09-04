/**
 * The durable per-session event log.
 *
 * OpenCode's runtime keeps an ordered, replayable log per session, and exposes
 * it on two routes that our sandboxes already serve (verified live through the
 * Kortix proxy, dev, 2026-08-24):
 *
 *   GET /api/session/{id}/history?limit&after -> { data: SessionDurableEvent[], hasMore }
 *   GET /api/session/{id}/event?after=<seq>   -> SSE: replay, then tail
 *
 * The SDK's own words for the second one: "Replay durable events after an
 * aggregate sequence, then continue with new durable events."
 *
 * Why this matters more than any repair we have written:
 *
 * Every transcript bug this file's neighbours exist to fix comes from the same
 * shape — the browser holds a COPY assembled from a lossy stream, and has no
 * way to ask "what did I miss?". So we invented answers: re-read the tail on a
 * gap, on turn end, on tab return, on eviction; poll every 10s while working;
 * infer "is it working" from six stamped observations. Each is a guess about
 * loss we could not measure.
 *
 * A sequence cursor replaces all of it with a question the server can answer
 * exactly: everything after `seq`. Missed nothing -> zero events. Missed a
 * turn -> exactly that turn. Cost is proportional to what was MISSED rather
 * than to the size of the transcript, which is the whole reason a 78 MB tail
 * read could never be the right repair.
 *
 * Framework-free on purpose: no DOM, no React, no store. Callers own the cursor.
 */

/** One page of durable events. `limit` is per request, not a total. */
export const DURABLE_HISTORY_PAGE_SIZE = 200;

/** A durable event carries an aggregate sequence; a delta frame does not. */
export interface DurableEventLike {
  durable?: { aggregateID?: string; seq?: number; version?: number };
}

export interface DurableHistoryPage {
  events: unknown[];
  hasMore: boolean;
  /**
   * The cursor to pass as `after` next time. Never lower than the cursor this
   * read was given — a rewind would replay events already applied.
   */
  lastSeq: number | null;
}

export interface DurableLogClient {
  v2?: {
    session: {
      history: (request: {
        sessionID: string;
        limit?: number;
        after?: number;
      }) => Promise<{ data?: { data?: unknown[]; hasMore?: boolean } }>;
    };
  };
}

/**
 * The aggregate sequence of an event, or null if it carries none.
 *
 * Only durable events advance the cursor. The runtime also emits pure deltas
 * (text, reasoning, tool input, compaction) that exist to make typing look
 * live; they are disposable by design and must never move a cursor, or a
 * reconnect would skip the durable event they were painting over.
 */
export function durableSeqOf(event: unknown): number | null {
  if (!event || typeof event !== 'object') return null;
  const durable = (event as DurableEventLike).durable;
  if (!durable || typeof durable.seq !== 'number' || !Number.isFinite(durable.seq)) return null;
  return durable.seq;
}

/**
 * Read one page of the log after `after` (exclusive).
 *
 * The runtime's own note on this route: "Newly committed events may appear on
 * later pages" — so `hasMore: false` means "caught up as of now", not "the log
 * is finished". The caller keeps the cursor and asks again.
 */
export async function readSessionDurableHistory(
  client: DurableLogClient,
  sessionId: string,
  cursor: { after?: number; limit?: number },
): Promise<DurableHistoryPage> {
  const history = client.v2?.session.history;
  if (!history) throw new Error('durable log unavailable: client exposes no v2 session namespace');

  const result = await history({
    sessionID: sessionId,
    limit: cursor.limit ?? DURABLE_HISTORY_PAGE_SIZE,
    ...(cursor.after === undefined ? {} : { after: cursor.after }),
  });

  const events = result.data?.data ?? [];
  // The HIGHEST sequence in the page, not the last element's. A page is not
  // promised in sequence order, and it may carry frames with no sequence at
  // all; taking the tail element would rewind the cursor on either.
  let lastSeq = cursor.after ?? null;
  for (const event of events) {
    const seq = durableSeqOf(event);
    if (seq === null) continue;
    if (lastSeq === null || seq > lastSeq) lastSeq = seq;
  }

  return { events, hasMore: result.data?.hasMore === true, lastSeq };
}

/**
 * Does this failure mean "this runtime has no durable log" rather than "the
 * read failed"?
 *
 * Self-hosted installs run older sandbox images. A 404 is a capability answer
 * and must fall back to the message read. Everything else is a real failure and
 * must reach the caller's retry — swallowing a 503 as "unsupported" would
 * permanently downgrade a runtime that was merely asleep.
 */
export function isDurableLogUnsupported(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status =
    (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  return status === 404;
}
