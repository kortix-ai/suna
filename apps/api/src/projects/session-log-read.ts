/**
 * Reads over the session log (P4.2). Postgres only: nothing here reaches a box.
 *
 * `readSessionLogPage` serves `GET .../log` (`SessionLogPage`, `@kortix/api-contract/session-log`).
 *
 * `readStoredTranscriptWindow` is the stored transcript every v1 read serves (`transcript?shape=sync`,
 * the `shape=compact` fallback, the open bundle, the public share, and MCP `read_session` through
 * the transcript route). With the project flag `session_log` on it serves `toV1` of the log in the
 * mirror's window shape (`MirrorSnapshot`); otherwise, or when the log cannot answer, the mirror.
 * The log cannot answer when the session has no log, no stored message in the read thread, or a
 * thread `fromV1` did not build (no `kortix.transcript.v1` ext: the pi adapter writes its records
 * natively, without the v1 residuals, so `toV1` of them is not the mirror).
 *
 * The v1 window over the log equals the mirror's window, with three named differences:
 * - `captured_at` is the log's last write (`session_logs.updated_at`), not the capture time.
 * - `head_complete` is true: the journal holds the whole session.
 * - an attachment the API's capture uploaded keeps the `kortix-attachment://` url the mirror row
 *   has only when the journal sent it; the daemon never sees that url.
 * Paging assumes `seq` order is the mirror order (`created`, then id): the OpenCode adapter issues
 * seqs in `fromV1`'s order, which is that order.
 */
import {
  toV1,
  type SessionLog,
  type SessionLogMessage,
  type SessionLogPage,
  type V1Row,
} from '@kortix/api-contract/session-log';
import { KORTIX_TRANSCRIPT_SCHEMA } from '@kortix/api-contract/transcript';
import { projects, sessionLogMessages, sessionLogs, sessionLogThreads } from '@kortix/db';
import { and, asc, desc, eq, isNull, lt, lte, sql, type SQL } from 'drizzle-orm';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { db } from '../shared/db';
import {
  readSessionTranscriptMirror,
  restoreStrippedToolParts,
  UnknownTranscriptCursorError,
  type MirrorSnapshot,
} from './lib/session-transcript-mirror';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type J = Record<string, unknown>;
type ThreadRow = { threadId: string; parentThreadId: string | null; record: J };

const READ_ONLY = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;
/** Where `fromV1` keeps a superseded row's runtime session id. */
const RUNTIME_PATH = `$.ext.* ? (@.version == "${KORTIX_TRANSCRIPT_SCHEMA}").data.runtime_session_id`;

const v1Ext = (record: J) =>
  Object.values((record.ext ?? {}) as Record<string, { version?: string; native_id?: string; data?: J }>).find(
    (e) => e?.version === KORTIX_TRANSCRIPT_SCHEMA,
  );
/** `toV1`'s runtime session id of a thread: the v1 ext's native id, else the thread id. */
const nativeOf = (t: ThreadRow) => {
  const e = v1Ext(t.record);
  return e ? (e.native_id ?? null) : t.threadId;
};
const rootOf = (threads: ThreadRow[]) => threads.find((t) => t.parentThreadId === null) ?? threads[0];

function readThreads(tx: Tx, sessionId: string): Promise<ThreadRow[]> {
  return tx
    .select({ threadId: sessionLogThreads.threadId, parentThreadId: sessionLogThreads.parentThreadId, record: sessionLogThreads.record })
    .from(sessionLogThreads)
    .where(eq(sessionLogThreads.sessionId, sessionId))
    .orderBy(asc(sessionLogThreads.createdAt), asc(sessionLogThreads.threadId));
}

// ─── GET .../log ─────────────────────────────────────────────────────────────

/** One page of one thread, or null when the session has no stored log. */
export async function readSessionLogPage(input: {
  sessionId: string;
  threadId: string | null;
  beforeSeq: number | null;
  limit: number;
}): Promise<SessionLogPage | null> {
  return db.transaction(async (tx) => {
    const [log] = await tx
      .select({ generation: sessionLogs.generation, record: sessionLogs.record })
      .from(sessionLogs)
      .where(eq(sessionLogs.sessionId, input.sessionId))
      .limit(1);
    if (!log) return null;
    const threads = await readThreads(tx, input.sessionId);
    let threadId = input.threadId ?? rootOf(threads)?.threadId ?? null;
    if (threadId === null) {
      // A journal batch may carry messages before their thread upsert.
      const [first] = await tx
        .select({ threadId: sessionLogMessages.threadId })
        .from(sessionLogMessages)
        .where(eq(sessionLogMessages.sessionId, input.sessionId))
        .orderBy(asc(sessionLogMessages.seq))
        .limit(1);
      threadId = first?.threadId ?? null;
    }
    const rows =
      threadId === null
        ? []
        : await tx
            .select({ record: sessionLogMessages.record })
            .from(sessionLogMessages)
            .where(
              and(
                eq(sessionLogMessages.sessionId, input.sessionId),
                eq(sessionLogMessages.threadId, threadId),
                isNull(sessionLogMessages.deletedAt),
                input.beforeSeq === null ? undefined : lt(sessionLogMessages.seq, input.beforeSeq),
              ),
            )
            .orderBy(desc(sessionLogMessages.seq))
            .limit(input.limit + 1);
    return {
      session: log.record as SessionLogPage['session'],
      generation: log.generation,
      threads: threads.map((t) => t.record as SessionLogPage['threads'][number]),
      thread_id: threadId,
      messages: rows.slice(0, input.limit).reverse().map((r) => r.record as SessionLogMessage),
      has_more: rows.length > input.limit,
    };
  }, READ_ONLY);
}

// ─── v1 reads ────────────────────────────────────────────────────────────────

/** The stored transcript window: `toV1` of the log when the flag is on and the log can answer, else the mirror. */
export async function readStoredTranscriptWindow(input: {
  sessionId: string;
  limit: number;
  before?: string | null;
  /** A runtime session inside this session (a sub-agent); omitted: the root. */
  opencodeSessionId?: string | null;
}): Promise<MirrorSnapshot | null> {
  return (await readLogTranscriptWindow(input)) ?? readSessionTranscriptMirror(input);
}

/** The mirror order: `created` (missing first), then id. */
const created = (r: V1Row) => {
  const t = (r.info as { time?: { created?: unknown } })?.time?.created;
  return typeof t === 'number' && Number.isFinite(t) ? t : -Infinity;
};
const idOf = (r: V1Row) => String((r.info as { id?: unknown })?.id ?? '');
const keyCompare = (a: { at: number; id: string }, b: { at: number; id: string }) =>
  a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const keyOf = (r: V1Row) => ({ at: created(r), id: idOf(r) });

/** The window over the log, or null when the log cannot answer (see the module header). */
export async function readLogTranscriptWindow(input: {
  sessionId: string;
  limit: number;
  before?: string | null;
  opencodeSessionId?: string | null;
}): Promise<MirrorSnapshot | null> {
  const [log] = await db
    .select({ record: sessionLogs.record, updatedAt: sessionLogs.updatedAt, metadata: projects.metadata, accountId: projects.accountId })
    .from(sessionLogs)
    .innerJoin(projects, eq(projects.projectId, sessionLogs.projectId))
    .where(eq(sessionLogs.sessionId, input.sessionId))
    .limit(1);
  if (!log || !resolveFeatureFlag(log.metadata, 'session_log', log.accountId)) return null;

  return db.transaction(async (tx) => {
    const threads = await readThreads(tx, input.sessionId);
    const root = rootOf(threads);
    const stated = v1Ext(log.record)?.data;
    const rootId = stated && 'root_id' in stated ? ((stated.root_id as string | null) ?? null) : root ? nativeOf(root) : null;
    const target = input.opencodeSessionId || rootId;
    // A runtime session that is no thread of its own is an old root, merged into the root thread.
    const thread = threads.find((t) => nativeOf(t) === target) ?? root;
    if (!target || !thread || !v1Ext(thread.record)) return null;

    // The rows `toV1` gives runtime session `target`. Only a superseded (out-of-context) message
    // carries its own runtime id; every other message has its thread's.
    const nativeIsTarget = nativeOf(thread) === target;
    const scope = and(
      eq(sessionLogMessages.sessionId, input.sessionId),
      eq(sessionLogMessages.threadId, thread.threadId),
      isNull(sessionLogMessages.deletedAt),
      sql`CASE WHEN ${sessionLogMessages.inContext} THEN ${nativeIsTarget}::boolean
        WHEN jsonb_path_exists(${sessionLogMessages.record}, ${RUNTIME_PATH}::jsonpath)
          THEN jsonb_path_query_first(${sessionLogMessages.record}, ${RUNTIME_PATH}::jsonpath) #>> '{}' = ${target}
        ELSE ${nativeIsTarget}::boolean END`,
    ) as SQL;

    // A compaction with a summary is two v1 rows (the marker and the summary).
    const [totals] = await tx
      .select({
        total: sql<number>`(count(*) + count(*) FILTER (WHERE CASE WHEN ${sessionLogMessages.kind} = 'compaction'
          THEN coalesce(jsonb_typeof(jsonb_path_query_first(${sessionLogMessages.record}, '$.blocks[*] ? (@.type == "compaction")') -> 'summary') <> 'null', false)
          ELSE false END))::int`,
      })
      .from(sessionLogMessages)
      .where(scope);
    const total = totals?.total ?? 0;
    if (total === 0) return null;

    const toRows = (records: J[]) =>
      toV1({ ...(log.record as object), session_id: input.sessionId, threads: [{ ...thread.record, messages: records }] } as unknown as SessionLog)
        .rows.filter((r) => r.runtime_session_id === target);

    const anchor = input.before ? await anchorOf(tx, scope, input.before, toRows) : null;
    const window = await tx
      .select({ record: sessionLogMessages.record })
      .from(sessionLogMessages)
      .where(
        and(
          scope,
          anchor === null ? undefined : anchor.inclusive ? lte(sessionLogMessages.seq, anchor.seq) : lt(sessionLogMessages.seq, anchor.seq),
        ),
      )
      .orderBy(desc(sessionLogMessages.seq))
      // Every message is at least one row; an inclusive anchor drops its own summary row.
      .limit(input.limit + 1 + (anchor?.inclusive ? 1 : 0));

    const rows = toRows(window.map((w) => w.record).reverse())
      .filter((r) => anchor === null || keyCompare(keyOf(r), anchor.key) < 0)
      .sort((a, b) => keyCompare(keyOf(b), keyOf(a)));
    const kept = rows.slice(0, input.limit);
    return {
      opencode_session_id: target,
      root_opencode_session_id: rootId,
      captured_at: new Date(log.updatedAt).toISOString(),
      total,
      head_complete: true,
      next_cursor: rows.length > input.limit ? idOf(kept.at(-1)!) : null,
      messages: kept.reverse().map((r) => ({
        info: r.info as unknown as J,
        parts: restoreStrippedToolParts((Array.isArray(r.parts) ? r.parts : []) as unknown as J[]),
      })),
    };
  }, READ_ONLY);
}

type Anchor = { seq: number; inclusive: boolean; key: { at: number; id: string } };

/**
 * The cursor row: a message of the scope, or a compaction summary row (its marker's message,
 * inclusive: the marker row is older than the summary). Throws on any other id, as the mirror does.
 */
async function anchorOf(tx: Tx, scope: SQL, before: string, toRows: (records: J[]) => V1Row[]): Promise<Anchor> {
  const [own] = await tx
    .select({ seq: sessionLogMessages.seq, createdAt: sessionLogMessages.createdAt })
    .from(sessionLogMessages)
    .where(and(scope, eq(sessionLogMessages.messageId, before)))
    .limit(1);
  if (own) return { seq: own.seq, inclusive: false, key: { at: new Date(own.createdAt).getTime(), id: before } };
  const compactions = await tx
    .select({ seq: sessionLogMessages.seq, record: sessionLogMessages.record })
    .from(sessionLogMessages)
    .where(and(scope, eq(sessionLogMessages.kind, 'compaction')));
  for (const c of compactions) {
    const summary = toRows([c.record]).find((r) => idOf(r) === before);
    if (summary) return { seq: c.seq, inclusive: true, key: keyOf(summary) };
  }
  throw new UnknownTranscriptCursorError(before);
}
