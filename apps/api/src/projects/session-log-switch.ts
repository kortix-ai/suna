/**
 * The switch preflight (P7.1): `POST .../log/switch-preflight`. Read only: no lock, no claim, no write.
 *
 * The route is callable by every session reader (the session's own sandbox token too), so the read is
 * bounded: one read-only snapshot, and Postgres projects each block to the few fields
 * `switchPreflight` (`@kortix/api-contract/session-log`, `capabilities.ts`) reads. Text, tool input
 * and output and attachment bytes never leave the database; a reasoning text leaves as `x` or `''`
 * (the rule needs only "not blank", any whitespace, as JS `trim`); no blob is read, only the blob
 * sizes for the restore cap (`sessionLogRestoreFits`). The projection is cast to
 * `SessionLog`: only the fields `switchPreflight` reads are real.
 */
import {
  SESSION_LOG_SCHEMA,
  switchPreflight,
  type SessionLog,
  type SessionLogHarness,
  type SessionLogMessage,
  type SessionLogSwitchPreflight,
} from '@kortix/api-contract/session-log';
import { sessionLogMessages, sessionLogs, sessionLogThreads } from '@kortix/db';
import { asc, eq, sql } from 'drizzle-orm';
import { qualifiedColumn } from '../shared/sql-qualified-column';
import { config } from '../config';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { projectLlmGatewayEnabled } from '../llm-gateway/enablement';
import { db } from '../shared/db';
import { sessionLogRestoreFits } from './session-log-restore';

type Thread = SessionLog['threads'][number];

/** Each block as `switchPreflight` reads it; a tool result keeps only the types of its items. */
const SLIM_BLOCKS = sql<unknown[]>`COALESCE((
  SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'type', b->'type', 'mime', b->'mime', 'kind', b->'kind', 'name', b->'name', 'input_format', b->'input_format',
    'opaque', b->'opaque', 'layout', b->'layout', 'trigger', b->'trigger',
    'text', CASE WHEN b->>'type' = 'reasoning' THEN to_jsonb(CASE WHEN (b->>'text') ~ '[^[:space:]]' THEN 'x' ELSE '' END) END,
    'result', CASE WHEN b->>'type' = 'tool_call' AND b->'result' IS NOT NULL THEN jsonb_build_object(
      'is_error', b#>'{result,is_error}',
      'content', (SELECT COALESCE(jsonb_agg(jsonb_build_object('type', c->'type')), '[]'::jsonb)
        FROM jsonb_array_elements(COALESCE(b#>'{result,content}', '[]'::jsonb) || COALESCE(b#>'{result,model_content}', '[]'::jsonb)) c)
    ) END
  ))) FROM jsonb_array_elements(${qualifiedColumn(sessionLogMessages.record)}->'blocks') b
), '[]'::jsonb)`;

export async function sessionLogSwitchPreflight(input: {
  sessionId: string;
  projectMetadata: unknown;
  to: SessionLogHarness;
}): Promise<SessionLogSwitchPreflight | null> {
  return db.transaction(
    async (tx) => {
      const [log] = await tx
        .select({
          createdAt: sessionLogs.createdAt,
          harnessCurrent: sessionLogs.harnessCurrent,
          harness: sql<SessionLog['harness'] | null>`${sessionLogs.record}->'harness'`,
          selection: sql<SessionLog['selection'] | null>`${sessionLogs.record}->'selection'`,
          todos: sql<SessionLog['todos'] | null>`${sessionLogs.record}->'todos'`,
        })
        .from(sessionLogs)
        .where(eq(sessionLogs.sessionId, input.sessionId));
      if (!log) return null;
      const threads = await tx
        .select({
          threadId: sessionLogThreads.threadId,
          parentThreadId: sessionLogThreads.parentThreadId,
          interactions: sql<unknown[] | null>`${sessionLogThreads.record}->'interactions'`,
        })
        .from(sessionLogThreads)
        .where(eq(sessionLogThreads.sessionId, input.sessionId));
      const messages = await tx
        .select({
          threadId: sessionLogMessages.threadId,
          role: sessionLogMessages.role,
          deleted: sql<boolean>`${sessionLogMessages.deletedAt} IS NOT NULL`,
          slim: sql<Partial<SessionLogMessage>>`jsonb_strip_nulls(jsonb_build_object(
            'in_context', ${qualifiedColumn(sessionLogMessages.record)}->'in_context', 'hidden_reason', ${qualifiedColumn(sessionLogMessages.record)}->'hidden_reason',
            'origin', ${qualifiedColumn(sessionLogMessages.record)}->'origin', 'model', ${qualifiedColumn(sessionLogMessages.record)}->'model', 'blocks', ${SLIM_BLOCKS}))`,
        })
        .from(sessionLogMessages)
        .where(eq(sessionLogMessages.sessionId, input.sessionId))
        .orderBy(asc(sessionLogMessages.seq));

      const byThread = new Map<string, Thread>();
      const thread = (threadId: string, parent: string | null = null, interactions?: unknown[] | null) => {
        let t = byThread.get(threadId);
        if (!t) {
          t = { thread_id: threadId, parent_thread_id: parent, ...(interactions?.length && { interactions }), messages: [] } as unknown as Thread;
          byThread.set(threadId, t);
        }
        return t;
      };
      for (const t of threads) thread(t.threadId, t.parentThreadId, t.interactions);
      let deleted = 0;
      for (const m of messages) {
        if (m.deleted) deleted++;
        else thread(m.threadId).messages.push({ role: m.role, blocks: [], ...m.slim } as SessionLogMessage);
      }
      const slim = {
        schema: SESSION_LOG_SCHEMA,
        session_id: input.sessionId,
        created_at: log.createdAt.toISOString(),
        harness: log.harness ?? { current: log.harnessCurrent, history: [] },
        selection: log.selection ?? { agent: null, model: null },
        todos: log.todos ?? [],
        threads: [...byThread.values()],
      } as unknown as SessionLog;
      return switchPreflight(slim, input.to, {
        llmGateway: projectLlmGatewayEnabled(input.projectMetadata),
        // Over the restore cap the new box gets the note alone (413): the history does not restore.
        restore:
          config.SESSION_LOG_RESTORE_ENABLED &&
          resolveFeatureFlag(input.projectMetadata, 'session_log_restore') &&
          (await sessionLogRestoreFits(tx, input.sessionId)),
        deletedMessages: deleted,
      });
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
