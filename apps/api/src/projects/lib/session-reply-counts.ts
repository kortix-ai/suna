/**
 * `reply_count` on a channel or DM thread list: how many messages follow the
 * thread's first prompt in its root conversation.
 *
 *   replies = (person messages - 1) + agent answers
 *
 * An agent answer is every assistant step that answers the same person
 * message, counted once (OpenCode and pi write one assistant message per step).
 * Sub-agent conversations are not replies.
 *
 * Read from the session log (`session_log_messages`), never from the box: the
 * root thread's `turn` messages, not tombstoned, not hidden; person messages of
 * origin prompt, steer or command; answers by `reply_to`. An aggregate on an
 * index that leads with `session_id`. It reads three keys of each matching
 * row's `record` jsonb (`origin`, `reply_to`, `hidden_reason`), so it detoasts
 * every message record of the listed root threads: its cost grows with
 * transcript size (a stored count or role-specific columns would remove the
 * read). A session with no log answers 0.
 */
import type { Database } from '@kortix/db';
import { sql } from 'drizzle-orm';

import { db } from '../../shared/db';

/** The rule above, on the two counts. */
export function replyCount(personMessages: number, agentAnswers: number): number {
  return Math.max(personMessages - 1, 0) + agentAnswers;
}

type CountRow = { session_id: string; person: number | string; answers: number | string };

function rowsOf(result: unknown): CountRow[] {
  if (Array.isArray(result)) return result as CountRow[];
  return ((result as { rows?: CountRow[] } | null)?.rows ?? []) as CountRow[];
}

/** `reply_count` per session id. Call only for sessions the viewer may read. */
async function countSessionReplies(database: Database, sessionIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>(sessionIds.map((id) => [id, 0]));
  if (sessionIds.length === 0) return counts;
  const ids = sql.join(sessionIds.map((id) => sql`${id}`), sql`, `);

  const rows = rowsOf(
    await database.execute(sql`
      SELECT m.session_id,
             count(*) FILTER (WHERE m.role = 'user'
               AND coalesce(m.record->>'origin', 'prompt') IN ('prompt', 'steer', 'command')) AS person,
             count(DISTINCT m.record->>'reply_to') FILTER (WHERE m.role = 'assistant') AS answers
        FROM kortix.session_log_messages m
        JOIN kortix.session_log_threads t
          ON t.session_id = m.session_id AND t.thread_id = m.thread_id AND t.parent_thread_id IS NULL
       WHERE m.session_id IN (${ids})
         AND m.kind = 'turn'
         AND m.deleted_at IS NULL
         AND m.record->>'hidden_reason' IS NULL
       GROUP BY m.session_id`),
  );
  for (const row of rows) counts.set(row.session_id, replyCount(Number(row.person), Number(row.answers)));
  return counts;
}

export function readSessionReplyCounts(sessionIds: string[]): Promise<Map<string, number>> {
  return countSessionReplies(db, sessionIds);
}
