/**
 * Reads over the session log (P4.2). Postgres only: nothing here reaches a box.
 *
 * `readSessionLogPage` serves `GET .../log` (`SessionLogPage`, `@kortix/api-contract/session-log`).
 *
 * `readStoredTranscriptWindow` is the stored transcript every v1 read serves (`transcript?shape=sync`,
 * the `shape=compact` fallback, the open bundle, the public share, and MCP `read_session` through
 * the transcript route). With the project flag `session_log` on it serves `toV1` of the log in the
 * mirror's window shape (`MirrorSnapshot`) and never reads the mirror for a session that has a
 * log (P8): no stored message in the read thread answers null ("nothing saved"). A session with no
 * log at all is history from before the journal that the backfill has not converted yet: the
 * mirror answers it, so turning the flag on hides no saved transcript. With the flag off it serves
 * the mirror. Both kinds of thread answer: a `fromV1` one (OpenCode) and a native one
 * (pi, no `kortix.transcript.v1` ext), whose v1 rows are the ones the SDK renders through `toV1`.
 *
 * The v1 window over a `fromV1` thread equals the mirror's window (deep equality), with these named differences:
 * - `captured_at` is the log's last write (the read thread's newest message write, or the session
 *   record's), not the capture time.
 * - `head_complete` is true: the journal holds the whole session.
 * - an attachment the API's capture uploaded keeps the `kortix-attachment://` url the mirror row
 *   has only when the journal sent it; the daemon never sees that url.
 * - object key order: the log path builds its own; key order is not a wire contract.
 * - a text over 200,000 characters: the mirror cuts it (`MIRROR_MAX_PART_CHARS`); the log keeps
 *   the whole text. A text over 256 kB is a preview in the row (F3, `session-log-blobs.ts`):
 *   this read puts the whole text back from its object, after the transaction.
 * Paging assumes `seq` order is the mirror order (`created`, then id): the OpenCode adapter issues
 * seqs in `fromV1`'s order, which is that order; the pi adapter issues them in pi's append order,
 * which is its creation order. A cursor that names a message anchors on the
 * `created_at` column, while rows sort on `info.time.created` (`-Infinity` when absent; the column
 * then holds the ingest time). The two agree for every row with a creation time.
 *
 * `readSessionLogPage` answers `'unknown_thread'` for a `thread` the session does not have.
 */
import {
  toV1,
  ModelRefSchema,
  type SessionLog,
  type SessionLogBlock,
  type SessionLogMessage,
  type SessionLogPage,
  type V1Row,
} from '@kortix/api-contract/session-log';
import { KORTIX_TRANSCRIPT_SCHEMA } from '@kortix/api-contract/transcript';
import { projectSessions, projects, sessionLogMessages, sessionLogs, sessionLogThreads } from '@kortix/db';
import { and, asc, desc, eq, inArray, isNull, lt, lte, sql, type SQL } from 'drizzle-orm';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { db } from '../shared/db';
import { qualifiedColumn } from '../shared/sql-qualified-column';
import {
  readSessionTranscriptMirror,
  restoreStrippedToolParts,
  UnknownTranscriptCursorError,
  type MirrorSnapshot,
} from './lib/session-transcript-mirror';
import { rehydrateLargeTexts } from './session-log-blobs';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type J = Record<string, unknown>;
type ThreadRow = { threadId: string; parentThreadId: string | null; record: J };

const READ_ONLY = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;
/** `toV1` keeps a native thread's system and context messages only from this producer. */
const V1_IMPORT = 'kortix-v1-import';
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
}): Promise<SessionLogPage | 'unknown_thread' | null> {
  return db.transaction(async (tx) => {
    const [log] = await tx
      .select({ generation: sessionLogs.generation, record: sessionLogs.record })
      .from(sessionLogs)
      .where(eq(sessionLogs.sessionId, input.sessionId))
      .limit(1);
    if (!log) return null;
    const threads = await readThreads(tx, input.sessionId);
    if (input.threadId !== null && !threads.some((t) => t.threadId === input.threadId)) return 'unknown_thread' as const;
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
    const threadRecord = threads.find((t) => t.threadId === threadId)?.record;
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
      messages: rows
        .slice(0, input.limit)
        .reverse()
        .map((r) => withKeptToolInputs(log.record as J, threadRecord, r.record as SessionLogMessage)),
      has_more: rows.length > input.limit,
    };
  }, READ_ONLY);
}

type ToolCall = Extract<SessionLogBlock, { type: 'tool_call' }>;
const stripped = (b: SessionLogBlock): b is ToolCall =>
  b.type === 'tool_call' && (b.input === null || b.input === undefined) && (b.status === 'complete' || b.status === 'error');

/**
 * A tool call the old v1 mirror stripped (no input, no output: a row saved before 2026-09-28 and
 * backfilled into the log) is served with what it kept, as the v1 window serves it
 * (`restoreStrippedToolParts`). The block gets the proven input, and a command its output. Its v1
 * residual becomes the restored part, so `toV1` of the page (the SDK's v1 view) gives the row the
 * v1 window gives. Storage is unchanged. A message of a thread without the v1 ext passes as is.
 */
export function withKeptToolInputs(session: J, thread: J | undefined, message: SessionLogMessage): SessionLogMessage {
  if (!thread || !v1Ext(thread) || !message.blocks?.some(stripped)) return message;
  const parts = new Map(
    toV1({ ...session, threads: [{ ...thread, messages: [message] }] } as unknown as SessionLog)
      .rows.flatMap((row) => row.parts as unknown as J[])
      .map((part) => [part.id, part]),
  );
  return {
    ...message,
    blocks: message.blocks.map((b) => {
      const part = stripped(b) ? parts.get(b.id) : undefined;
      if (!part) return b;
      const [restored] = restoreStrippedToolParts([part]);
      if (restored === part) return b;
      const state = restored!.state as J;
      const call = b as ToolCall;
      const output = typeof state.output === 'string' && call.result && !call.result.content.some((c) => c.type === 'text') ? state.output : null;
      const key = Object.keys(call.ext ?? {}).find((k) => call.ext![k]!.version === KORTIX_TRANSCRIPT_SCHEMA);
      return {
        ...call,
        input: state.input,
        ...(output !== null && { result: { ...call.result!, content: [{ type: 'text' as const, text: output }, ...call.result!.content] } }),
        ...(key && { ext: { ...call.ext, [key]: { ...call.ext![key]!, data: { set: restored } } } }),
      };
    }),
  };
}

// ─── v1 reads ────────────────────────────────────────────────────────────────

/** The stored transcript window: `toV1` of the log when the flag is on, else the mirror. */
export async function readStoredTranscriptWindow(input: {
  sessionId: string;
  limit: number;
  before?: string | null;
  /** A runtime session inside this session (a sub-agent); omitted: the root. */
  opencodeSessionId?: string | null;
}): Promise<MirrorSnapshot | null> {
  const window = await readLogTranscriptWindow(input);
  return window === 'mirror' ? readSessionTranscriptMirror(input) : window;
}

/** The project flag `session_log` of the session's project. False for an unknown session. */
export async function sessionLogEnabled(sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ projectMetadata: projects.metadata })
    .from(projectSessions)
    .innerJoin(projects, eq(projects.projectId, projectSessions.projectId))
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return !!row && resolveFeatureFlag(row.projectMetadata, 'session_log');
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

/** The window over the log; null when the log has nothing to serve, `'mirror'` without the flag or without a log (see the module header). */
async function readLogTranscriptWindow(input: {
  sessionId: string;
  limit: number;
  before?: string | null;
  opencodeSessionId?: string | null;
}): Promise<MirrorSnapshot | null | 'mirror'> {
  // One round trip for the flag, the session record and the threads: the mirror read's state query costs one too.
  const [row] = await db
    .select({
      record: sessionLogs.record,
      updatedAt: sessionLogs.updatedAt,
      projectId: sessionLogs.projectId,
      metadata: projects.metadata,
      threads: sql<ThreadRow[] | null>`(SELECT json_agg(json_build_object('threadId', ${sessionLogThreads.threadId}, 'parentThreadId', ${sessionLogThreads.parentThreadId}, 'record', ${sessionLogThreads.record}) ORDER BY ${sessionLogThreads.createdAt}, ${sessionLogThreads.threadId}) FROM ${sessionLogThreads} WHERE ${sessionLogThreads.sessionId} = ${qualifiedColumn(projectSessions.sessionId)})`,
    })
    .from(projectSessions)
    .innerJoin(projects, eq(projects.projectId, projectSessions.projectId))
    .leftJoin(sessionLogs, eq(sessionLogs.sessionId, projectSessions.sessionId))
    .where(eq(projectSessions.sessionId, input.sessionId))
    .limit(1);
  if (!row || !resolveFeatureFlag(row.metadata, 'session_log')) return 'mirror';
  // No log yet: pre-journal history the backfill has not converted (until P8.2 drops the mirror).
  if (row.record === null || row.updatedAt === null || row.projectId === null) return 'mirror';
  const log = { record: row.record, updatedAt: row.updatedAt, projectId: row.projectId };
  const threads = row.threads ?? [];
  const root = rootOf(threads);
  const stated = v1Ext(log.record)?.data;
  const rootId = stated && 'root_id' in stated ? ((stated.root_id as string | null) ?? null) : root ? nativeOf(root) : null;
  const target = input.opencodeSessionId || rootId;
  // A runtime session that is no thread of its own is an old root, merged into the root thread.
  const thread = threads.find((t) => nativeOf(t) === target) ?? root;
  if (!target || !thread) return null;
  const v1Thread = !!v1Ext(thread.record);

  const toRows = (records: J[]) =>
    toV1({ ...(log.record as object), session_id: input.sessionId, threads: [{ ...thread.record, messages: records }] } as unknown as SessionLog)
      .rows.filter((r) => r.runtime_session_id === target);

  const read = await db.transaction(async (tx) => {
    // The rows `toV1` gives runtime session `target`. Only a superseded (out-of-context) message
    // carries its own runtime id; every other message has its thread's.
    const nativeIsTarget = nativeOf(thread) === target;
    const scope = and(
      eq(sessionLogMessages.sessionId, input.sessionId),
      eq(sessionLogMessages.threadId, thread.threadId),
      isNull(sessionLogMessages.deletedAt),
      // `toV1` gives a native thread's system and context messages no row.
      v1Thread
        ? undefined
        : sql`(${sessionLogMessages.role} <> 'system' AND ${sessionLogMessages.kind} <> 'context' OR ${sessionLogMessages.producer} ->> 'harness' = ${V1_IMPORT})`,
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
        writtenMs: sql<number | null>`(extract(epoch from max(${sessionLogMessages.updatedAt})) * 1000)::float8`,
      })
      .from(sessionLogMessages)
      .where(scope);
    if (!totals?.total) return null;

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
    return { totals, anchor, records: window.map((w) => w.record).reverse() };
  }, READ_ONLY);
  if (!read) return null;
  const { totals, anchor } = read;

  // F3: a text over 256 kB is a preview in the row; v1 bodies carry the whole text. Read after COMMIT, off the connection.
  const records = await rehydrateLargeTexts({ projectId: log.projectId, sessionId: input.sessionId }, read.records);
  const rows = toRows(records)
    .filter((r) => anchor === null || keyCompare(keyOf(r), anchor.key) < 0)
    .sort((a, b) => keyCompare(keyOf(b), keyOf(a)));
  const kept = rows.slice(0, input.limit);
  return {
    opencode_session_id: target,
    root_opencode_session_id: rootId,
    captured_at: new Date(Math.max(new Date(log.updatedAt).getTime(), Math.floor(totals.writtenMs ?? 0))).toISOString(),
    total: totals.total,
    head_complete: true,
    next_cursor: rows.length > input.limit ? idOf(kept.at(-1)!) : null,
    messages: kept.reverse().map((r) => ({
      info: r.info as unknown as J,
      parts: restoreStrippedToolParts((Array.isArray(r.parts) ? r.parts : []) as unknown as J[]),
    })),
  };
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

/** Bounded inventory read: no sandbox wake and no per-session log requests. */
export async function readSessionConversationModels(sessionIds: string[]): Promise<Map<string, string>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await db.select({
    sessionId: sessionLogs.sessionId,
    model: sql<unknown>`${sessionLogs.record}->'selection'->'model'`,
  }).from(sessionLogs).where(inArray(sessionLogs.sessionId, sessionIds));
  const models = new Map<string, string>();
  for (const row of rows) {
    const parsed = ModelRefSchema.safeParse(row.model);
    if (parsed.success && parsed.data.provider.trim() && parsed.data.model.trim()) {
      models.set(row.sessionId, `${parsed.data.provider}/${parsed.data.model}`);
    }
  }
  return models;
}
