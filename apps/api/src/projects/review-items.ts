/**
 * Review Center — core data helpers for the per-project review inbox.
 *
 * A review_item is "one thing a human needs to look at or decide on": an agent
 * output / decision / batch submitted for review (kinds `change` and `approval`
 * are folded in by adapters in a later pass — they keep their own tables). The
 * polymorphic `detail` jsonb carries the kind-specific payload. Mirrors the CR
 * core module (./change-requests.ts).
 */

import { changeRequests, connectorCalls, projectSessions, reviewItems } from '@kortix/db';
import { type AnyColumn, type SQL, and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { captureException } from '../lib/sentry';
import { db } from '../shared/db';
import { isUuid } from '../shared/validate';
import {
  CR_REVIEW_STATUS,
  adapterSourceForId,
  changeRequestToReviewItem,
  connectorCallToReviewItem,
} from './review-adapters';
import {
  type ApprovalCaller,
  type ApprovalResolvers,
  approvalResolvers,
  approvalTargetOf,
  mayResolveApproval,
} from './lib/approval-authority';

type ReviewItemRow = typeof reviewItems.$inferSelect;
type ChangeRequestRow = typeof changeRequests.$inferSelect;
type ConnectorCallRow = typeof connectorCalls.$inferSelect;

export type ReviewSegment = 'needs_you' | 'waiting' | 'done';

/** What one caller may do with one pending connector call (KRTX-1724). */
export interface ConnectorCallVerdict {
  canResolve: boolean;
  resolvers: ApprovalResolvers;
}
export type ReviewVerdict = 'approve' | 'reject' | 'changes' | 'answer' | 'dismiss';

/** Kinds an agent may submit. `change`/`approval` come from adapters, not submit. */
export const SUBMITTABLE_KINDS = ['output', 'decision', 'batch'] as const;
export type SubmittableKind = (typeof SUBMITTABLE_KINDS)[number];

const VERDICT_STATUS: Record<ReviewVerdict, ReviewItemRow['status']> = {
  approve: 'approved',
  reject: 'rejected',
  changes: 'changes_requested',
  answer: 'done',
  dismiss: 'dismissed',
};

/** The statuses that belong to each inbox segment. */
export function statusesForSegment(segment: ReviewSegment): ReviewItemRow['status'][] {
  if (segment === 'needs_you') return ['needs_you'];
  if (segment === 'waiting') return ['waiting'];
  return ['approved', 'changes_requested', 'rejected', 'done', 'dismissed'];
}

export function isReviewVerdict(value: unknown): value is ReviewVerdict {
  return (
    value === 'approve' ||
    value === 'reject' ||
    value === 'changes' ||
    value === 'answer' ||
    value === 'dismiss'
  );
}

export function isSubmittableKind(value: unknown): value is SubmittableKind {
  return value === 'output' || value === 'decision' || value === 'batch';
}

export function serializeReviewItem(row: ReviewItemRow) {
  return {
    review_item_id: row.reviewItemId,
    account_id: row.accountId,
    project_id: row.projectId,
    origin_session_id: row.originSessionId,
    kind: row.kind,
    status: row.status,
    risk: row.risk,
    source: row.source,
    title: row.title,
    summary: row.summary,
    detail: row.detail ?? {},
    agent: row.agent,
    created_by: row.createdBy,
    acted_by: row.actedBy,
    acted_at: row.actedAt?.toISOString() ?? null,
    feedback: row.feedback,
    metadata: row.metadata ?? {},
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * One native review item by id, scoped to its project. A non-uuid id can never
 * match the uuid column — Postgres would answer 22P02 and the request would
 * die as a 500 (KRTX-2442: a client sent `nonexistent-item` to the act and
 * bulk endpoints). Answer like a miss instead, the same contract `getInboxItem`
 * keeps for an id that is not a uuid.
 */
export async function getReviewItemById(reviewItemId: string, projectId: string) {
  if (!isUuid(reviewItemId)) return null;
  const [row] = await db
    .select()
    .from(reviewItems)
    .where(and(eq(reviewItems.reviewItemId, reviewItemId), eq(reviewItems.projectId, projectId)))
    .limit(1);
  return row ?? null;
}

/** `GET /review/items` page size: the default, and the ceiling above which the
 *  route answers 400 (the 2026-09-16 rule: every list ships bounded). */
export const REVIEW_PAGE_DEFAULT_LIMIT = 50;
export const REVIEW_PAGE_MAX_LIMIT = 200;

/** The segment a review status belongs to (the inverse of `statusesForSegment`). */
export function segmentForStatus(status: ReviewItemRow['status']): ReviewSegment {
  return status === 'needs_you' || status === 'waiting' ? status : 'done';
}

/**
 * Inbox order: segment (Needs you, Waiting, Done), then newest first. A list
 * without a segment therefore starts with every pending item, so a client that
 * derives its segments from page one (an older app) still sees all of them.
 * Ties break on the source, then on the raw id (a uuid: Postgres and
 * JavaScript order it the same way).
 */
const SEGMENT_RANK: Record<ReviewSegment, number> = { needs_you: 0, waiting: 1, done: 2 };
const SOURCE_RANK = { native: 0, change_request: 1, connector_call: 2 } as const;

/** One item's place in the inbox order. `at` is `created_at` at microsecond
 *  precision: a millisecond cursor skips rows that share the millisecond. */
export interface InboxCursor {
  rank: number;
  at: string;
  source: number;
  id: string;
}

const MICRO_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeInboxCursor(cursor: InboxCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.rank, cursor.at, cursor.source, cursor.id]),
  ).toString('base64url');
}

/** Null for anything that is not a cursor this API issued (the route answers 400). */
export function decodeInboxCursor(raw: string): InboxCursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 4) return null;
    const [rank, at, source, id] = value;
    if (![0, 1, 2].includes(rank) || ![0, 1, 2].includes(source)) return null;
    if (typeof at !== 'string' || !MICRO_ISO_RE.test(at)) return null;
    if (!isUuid(id)) return null;
    return { rank, at, source, id };
  } catch {
    return null;
  }
}

function compareInboxOrder(a: InboxCursor, b: InboxCursor): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.source !== b.source) return a.source - b.source;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/** `created_at` as `YYYY-MM-DDTHH:MM:SS.ffffffZ`, the cursor's spelling. */
const microIso = (column: AnyColumn) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The SQL twin of `SEGMENT_RANK` over one source's status column. */
function rankSql(column: AnyColumn, statusesFor: (segment: ReviewSegment) => string[]): SQL {
  return sql`(case when ${inArray(column, statusesFor('needs_you'))} then 0 when ${inArray(column, statusesFor('waiting'))} then 1 else 2 end)`;
}

/** Rows strictly after `after` in the inbox order, for one SQL source. */
function afterCursorSql(
  after: InboxCursor | null | undefined,
  source: number,
  rank: SQL,
  at: AnyColumn,
  id: AnyColumn,
): SQL | undefined {
  if (!after) return undefined;
  const ts = sql`${after.at}::timestamptz`;
  const tie =
    source > after.source
      ? sql`true`
      : source < after.source
        ? sql`false`
        : sql`${id} < ${after.id}::uuid`;
  return sql`(${rank} > ${after.rank} or (${rank} = ${after.rank} and (${at} < ${ts} or (${at} = ${ts} and ${tie}))))`;
}

/** The CR statuses whose inbox status falls in `segment` (`CR_REVIEW_STATUS`). */
export function changeRequestStatusesForSegment(
  segment: ReviewSegment,
): ChangeRequestRow['status'][] {
  return (Object.keys(CR_REVIEW_STATUS) as ChangeRequestRow['status'][]).filter(
    (status) => segmentForStatus(CR_REVIEW_STATUS[status]) === segment,
  );
}

/** What one page of the inbox is filtered to. */
export interface InboxQuery {
  segment?: ReviewSegment;
  kind?: ReviewItemRow['kind'];
  /** Only the items that one session raised (`origin_session_id`). */
  sessionId?: string;
  /** Default `REVIEW_PAGE_DEFAULT_LIMIT`. The route enforces the ceiling. */
  limit?: number;
  after?: InboxCursor | null;
}

/** A row plus its `created_at` at microsecond precision (`microIso`). */
type Sortable<T> = T & { sortAt?: string };

/** A pending connector call, with the facts of its session the approval rule reads. */
export type PendingConnectorCall = Sortable<ConnectorCallRow> & {
  sessionCreatedBy?: string | null;
  sessionOrigin?: string | null;
};

/**
 * One inbox source (native items, change requests, connector approvals). Each is
 * fetched INDEPENDENTLY and folded in memory — there is no SQL join. The two
 * sources that keep history (native items, change requests) apply the query in
 * SQL and return at most `limit + 1` rows. Pending connector calls are read
 * whole: they are not history, and their segment depends on the caller.
 */
export interface InboxSources {
  native: (query: InboxQuery & { limit: number }) => Promise<Sortable<ReviewItemRow>[]>;
  changeRequests: (
    query: InboxQuery & { limit: number },
  ) => Promise<Sortable<ChangeRequestRow>[]>;
  connectorApprovals: () => Promise<PendingConnectorCall[]>;
}

/**
 * Run one inbox source, degrading a failure to an empty contribution.
 *
 * The Review Center polls this endpoint, so one flaky source must NEVER 500
 * the whole inbox. The recurring real-world cause is schema/enum drift on a DB
 * the API code has outrun (e.g. `review_items` not yet migrated, or an
 * `connector_call_status` value the deployed enum lacks): that throws a
 * Postgres error which — unguarded — took the entire response down. We surface
 * the failure to Sentry (so the drift is still visible and fixable) but return
 * `[]` for that source and keep serving the sources that DO work.
 */
async function safeSource<T>(label: string, run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run();
  } catch (error) {
    console.error(`[review-items] inbox source "${label}" failed; degrading to empty`, error);
    captureException(error, { reviewInboxSource: label });
    return [];
  }
}

/** Map rows to DTOs, skipping (not throwing on) any single row that fails to serialize. */
function safeMap<T, R>(label: string, rows: T[], fn: (row: T) => R): R[] {
  const out: R[] = [];
  for (const row of rows) {
    try {
      out.push(fn(row));
    } catch (error) {
      console.error(`[review-items] failed to serialize a "${label}" row; skipping`, error);
      captureException(error, { reviewInboxSource: label, phase: 'serialize' });
    }
  }
  return out;
}

// `can_resolve` + `resolvers` are set on connector calls only.
type InboxItem = ReturnType<typeof serializeReviewItem> & {
  can_resolve?: boolean;
  resolvers?: ApprovalResolvers | null;
};

/**
 * One page of the inbox read model: native review items UNIONed with adapted
 * sources (Change Requests, pending connector calls), filtered to the query and
 * in inbox order. Returns already-serialized DTOs and the cursor of the next
 * page (null on the last page).
 *
 * The filters and the cursor apply here again over what the sources return:
 * this function is the specification, and the SQL only bounds the read. Every
 * source and every row is fault-isolated (see {@link safeSource} /
 * {@link safeMap}) so a partial failure degrades to a partial (or empty) inbox
 * rather than a 500. Pure over its injected `sources` — unit-testable without a DB.
 */
export async function collectInboxItems(
  sources: InboxSources,
  opts: InboxQuery & {
    /** The caller's resolve verdict for one pending call (`mayResolveApproval`)
     *  and who decides it. Undefined: no verdict, fail closed. */
    connectorCallVerdict?: (row: PendingConnectorCall) => ConnectorCallVerdict | undefined;
  } = {},
): Promise<{ items: InboxItem[]; nextCursor: string | null }> {
  const limit = opts.limit ?? REVIEW_PAGE_DEFAULT_LIMIT;
  const query = { ...opts, limit };
  const [nativeRows, crRows, execRows] = await Promise.all([
    safeSource('native', () => sources.native(query)),
    safeSource('change_requests', () => sources.changeRequests(query)),
    safeSource('connector_calls', sources.connectorApprovals),
  ]);
  const placed = (item: InboxItem, source: number, id: string, row: Sortable<{ createdAt: Date }>) => ({
    item,
    key: {
      rank: SEGMENT_RANK[segmentForStatus(item.status)],
      // A row read without `sortAt` (a unit-test fixture) sits at its millisecond.
      at: row.sortAt ?? row.createdAt.toISOString().replace(/Z$/, '000Z'),
      source,
      id,
    },
  });
  const all = [
    ...safeMap('native', nativeRows, (row) =>
      placed(serializeReviewItem(row), SOURCE_RANK.native, row.reviewItemId, row),
    ),
    ...safeMap('change_requests', crRows, (row) =>
      placed(changeRequestToReviewItem(row), SOURCE_RANK.change_request, row.crId, row),
    ),
    ...safeMap('connector_calls', execRows, (row) =>
      placed(
        connectorCallToReviewItem(row, opts.connectorCallVerdict?.(row)),
        SOURCE_RANK.connector_call,
        row.executionId,
        row,
      ),
    ),
  ];
  const segmentStatuses = opts.segment ? statusesForSegment(opts.segment) : null;
  const matching = all
    .filter(
      ({ item, key }) =>
        (!segmentStatuses || segmentStatuses.includes(item.status)) &&
        (!opts.kind || item.kind === opts.kind) &&
        (!opts.sessionId || item.origin_session_id === opts.sessionId) &&
        (!opts.after || compareInboxOrder(key, opts.after) > 0),
    )
    .sort((a, b) => compareInboxOrder(a.key, b.key));
  const page = matching.slice(0, limit);
  return {
    items: page.map(({ item }) => item),
    nextCursor: matching.length > limit ? encodeInboxCursor(page[page.length - 1].key) : null,
  };
}

/**
 * Every pending connector call of the project, with the created-by and origin
 * of its session (the inputs of `approvalTargetOf`), in one read. The list and
 * the summary need the same rows.
 */
async function pendingConnectorCalls(
  projectId: string,
  sessionId?: string,
): Promise<PendingConnectorCall[]> {
  const rows = await db
    .select({
      call: connectorCalls,
      sortAt: microIso(connectorCalls.createdAt),
      sessionCreatedBy: projectSessions.createdBy,
      sessionOrigin: projectSessions.origin,
    })
    .from(connectorCalls)
    .leftJoin(
      projectSessions,
      and(
        eq(projectSessions.sessionId, sql`${connectorCalls.sessionId}::text`),
        eq(projectSessions.projectId, connectorCalls.projectId),
      ),
    )
    .where(
      and(
        eq(connectorCalls.projectId, projectId),
        eq(connectorCalls.status, 'pending_approval'),
        sessionId ? sql`${connectorCalls.sessionId}::text = ${sessionId}` : undefined,
      ),
    );
  return rows.map((row) => ({
    ...row.call,
    sortAt: row.sortAt,
    sessionCreatedBy: row.sessionCreatedBy,
    sessionOrigin: row.sessionOrigin,
  }));
}

/**
 * The caller's verdict on each pending call: the resolve route's own rule
 * (`approvalCallerOf` + `mayResolveApproval`). It decides what this caller
 * sees: `args_preview` (email bodies, recipients, URLs) only for a human who
 * may resolve the exact call — the broad `project.review.read` leaf may list
 * the row, no more — plus `can_resolve` and the status (Needs you for a
 * resolver, Waiting for everyone else; KRTX-1724). The caller probe runs only
 * when something is pending.
 */
async function connectorCallVerdicts(
  calls: PendingConnectorCall[],
  resolveCaller: () => Promise<ApprovalCaller>,
): Promise<(row: PendingConnectorCall) => ConnectorCallVerdict | undefined> {
  if (calls.length === 0) return () => undefined;
  const caller = await resolveCaller();
  return (row) => {
    const { origin, createdBy } = approvalTargetOf(row, {
      createdBy: row.sessionCreatedBy ?? null,
      origin: row.sessionOrigin ?? null,
    });
    const target = { targetSessionOrigin: origin, targetSessionCreatedBy: createdBy };
    return {
      canResolve: mayResolveApproval({ ...caller, ...target }).allowed,
      resolvers: approvalResolvers(target),
    };
  };
}

/** One page of the project's inbox for the caller (`GET /review/items`). */
export async function listInboxItems(
  projectId: string,
  query: InboxQuery,
  resolveCaller: () => Promise<ApprovalCaller>,
) {
  const calls = await safeSource('connector_calls', () =>
    pendingConnectorCalls(projectId, query.sessionId),
  );
  const nativeRank = rankSql(reviewItems.status, statusesForSegment);
  const crRank = rankSql(changeRequests.status, changeRequestStatusesForSegment);
  return collectInboxItems(
    {
      native: (q) =>
        db
          .select({ ...getTableColumns(reviewItems), sortAt: microIso(reviewItems.createdAt) })
          .from(reviewItems)
          .where(
            and(
              eq(reviewItems.projectId, projectId),
              q.segment ? inArray(reviewItems.status, statusesForSegment(q.segment)) : undefined,
              q.kind ? eq(reviewItems.kind, q.kind) : undefined,
              q.sessionId ? eq(reviewItems.originSessionId, q.sessionId) : undefined,
              afterCursorSql(
                q.after,
                SOURCE_RANK.native,
                nativeRank,
                reviewItems.createdAt,
                reviewItems.reviewItemId,
              ),
            ),
          )
          .orderBy(nativeRank, desc(reviewItems.createdAt), desc(reviewItems.reviewItemId))
          .limit(q.limit + 1),
      changeRequests: async (q) => {
        if (q.kind && q.kind !== 'change') return [];
        const statuses = q.segment ? changeRequestStatusesForSegment(q.segment) : null;
        if (statuses?.length === 0) return [];
        return db
          .select({ ...getTableColumns(changeRequests), sortAt: microIso(changeRequests.createdAt) })
          .from(changeRequests)
          .where(
            and(
              eq(changeRequests.projectId, projectId),
              statuses ? inArray(changeRequests.status, statuses) : undefined,
              q.sessionId ? eq(changeRequests.originSessionId, q.sessionId) : undefined,
              afterCursorSql(
                q.after,
                SOURCE_RANK.change_request,
                crRank,
                changeRequests.createdAt,
                changeRequests.crId,
              ),
            ),
          )
          .orderBy(crRank, desc(changeRequests.createdAt), desc(changeRequests.crId))
          .limit(q.limit + 1);
      },
      connectorApprovals: async () => calls,
    },
    { ...query, connectorCallVerdict: await connectorCallVerdicts(calls, resolveCaller) },
  );
}

/**
 * One inbox item by its id, in the shape and with the verdict the list gives
 * it: a native id, `cr:<cr_id>` or `call:<execution_id>`. The list is
 * bounded, so a link to an item (a change request's `?id=cr:…`) must not
 * depend on that item being on a loaded page. A connector call is in the
 * inbox only while it is pending; null for anything else, and for an id that
 * is not a uuid.
 */
export async function getInboxItem(
  projectId: string,
  id: string,
  resolveCaller: () => Promise<ApprovalCaller>,
): Promise<InboxItem | null> {
  const source = adapterSourceForId(id);
  const rawId = source ? id.slice(id.indexOf(':') + 1) : id;
  if (!isUuid(rawId)) return null;
  if (source === 'cr') {
    const [row] = await db
      .select()
      .from(changeRequests)
      .where(and(eq(changeRequests.crId, rawId), eq(changeRequests.projectId, projectId)))
      .limit(1);
    return row ? changeRequestToReviewItem(row) : null;
  }
  if (source === 'call') {
    const call = (await pendingConnectorCalls(projectId)).find((row) => row.executionId === rawId);
    if (!call) return null;
    const verdict = await connectorCallVerdicts([call], resolveCaller);
    return connectorCallToReviewItem(call, verdict(call));
  }
  const row = await getReviewItemById(rawId, projectId);
  return row ? serializeReviewItem(row) : null;
}

/**
 * The counts the always-mounted surfaces show (the web sidebar, footer,
 * settings and Sessions page, the mobile project root): how many items wait on
 * the caller (`needs_you`), in total and by originating session. Counted in
 * SQL, so the cost does not grow with the inbox history. Pending connector
 * calls take the list's verdict, so a call the caller may not resolve counts
 * nowhere (it is Waiting). An item with no session counts in the total only.
 * Same fault isolation as the list.
 */
export async function reviewSummary(
  projectId: string,
  resolveCaller: () => Promise<ApprovalCaller>,
): Promise<{ needs_you_total: number; needs_you_by_session: Record<string, number> }> {
  const [nativeCounts, crCounts, calls] = await Promise.all([
    safeSource('native', () =>
      db
        .select({ sessionId: reviewItems.originSessionId, count: sql<number>`count(*)::int` })
        .from(reviewItems)
        .where(
          and(
            eq(reviewItems.projectId, projectId),
            inArray(reviewItems.status, statusesForSegment('needs_you')),
          ),
        )
        .groupBy(reviewItems.originSessionId),
    ),
    safeSource('change_requests', () =>
      db
        .select({ sessionId: changeRequests.originSessionId, count: sql<number>`count(*)::int` })
        .from(changeRequests)
        .where(
          and(
            eq(changeRequests.projectId, projectId),
            inArray(changeRequests.status, changeRequestStatusesForSegment('needs_you')),
          ),
        )
        .groupBy(changeRequests.originSessionId),
    ),
    safeSource('connector_calls', () => pendingConnectorCalls(projectId)),
  ]);
  const verdict = await connectorCallVerdicts(calls, resolveCaller);
  const callCounts = calls
    .filter((call) => verdict(call)?.canResolve === true)
    .map((call) => ({ sessionId: call.sessionId, count: 1 }));
  let total = 0;
  const bySession: Record<string, number> = {};
  for (const { sessionId, count } of [...nativeCounts, ...crCounts, ...callCounts]) {
    total += count;
    if (sessionId) bySession[sessionId] = (bySession[sessionId] ?? 0) + count;
  }
  return { needs_you_total: total, needs_you_by_session: bySession };
}

export interface InsertReviewItemInput {
  accountId: string;
  projectId: string;
  kind: SubmittableKind;
  title: string;
  summary?: string;
  risk?: ReviewItemRow['risk'];
  detail?: Record<string, unknown>;
  agent?: string;
  source?: ReviewItemRow['source'];
  originSessionId?: string | null;
  createdBy: string;
}

export async function insertReviewItem(input: InsertReviewItemInput) {
  const [row] = await db
    .insert(reviewItems)
    .values({
      accountId: input.accountId,
      projectId: input.projectId,
      kind: input.kind,
      status: 'needs_you',
      risk: input.risk ?? 'none',
      source: input.source ?? 'agent',
      title: input.title,
      summary: input.summary ?? '',
      detail: input.detail ?? {},
      agent: input.agent ?? '',
      originSessionId: input.originSessionId ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  return row;
}

/** Apply a human verdict to one item, recording who acted, when, and any note. */
export async function applyVerdict(
  reviewItemId: string,
  projectId: string,
  opts: { verdict: ReviewVerdict; feedback?: string | null; actingUserId: string },
) {
  // Same 22P02 contract as `getReviewItemById`: a non-uuid id is a miss (KRTX-2442).
  if (!isUuid(reviewItemId)) return null;
  const [row] = await db
    .update(reviewItems)
    .set({
      status: VERDICT_STATUS[opts.verdict],
      actedBy: opts.actingUserId,
      actedAt: new Date(),
      feedback: opts.feedback ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(reviewItems.reviewItemId, reviewItemId), eq(reviewItems.projectId, projectId)))
    .returning();
  return row ?? null;
}

/** Apply the same verdict to many items at once (multi-select bulk). */
export async function bulkApplyVerdict(
  reviewItemIds: string[],
  projectId: string,
  opts: { verdict: ReviewVerdict; actingUserId: string },
) {
  // An id that is not a uuid would make the whole batch die on the uuid cast
  // (22P02, KRTX-2442): drop it and apply the verdict to the rest.
  const ids = reviewItemIds.filter((id) => isUuid(id));
  if (ids.length === 0) return [];
  return db
    .update(reviewItems)
    .set({
      status: VERDICT_STATUS[opts.verdict],
      actedBy: opts.actingUserId,
      actedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(eq(reviewItems.projectId, projectId), inArray(reviewItems.reviewItemId, ids)),
    )
    .returning();
}
