/**
 * Review Center — core data helpers for the per-project review inbox.
 *
 * A review_item is "one thing a human needs to look at or decide on": an agent
 * output / decision / batch submitted for review (kinds `change` and `approval`
 * are folded in by adapters in a later pass — they keep their own tables). The
 * polymorphic `detail` jsonb carries the kind-specific payload. Mirrors the CR
 * core module (./change-requests.ts). See docs/REVIEW_CENTER_DESIGN.md.
 */

import { changeRequests, executorExecutions, reviewItems } from '@kortix/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
// Lives in the telegram channel module to reuse its solved sandbox auth; the
// Review Center consumes it read-only. Move to a shared sandbox-permission
// module if a third caller appears.
import {
  type SandboxPermissionRow,
  listProjectPendingPermissions,
} from '../channels/telegram/question-relay';
import { captureException } from '../lib/sentry';
import { db } from '../shared/db';
import {
  changeRequestToReviewItem,
  executorExecutionToReviewItem,
  sandboxPermissionToReviewItem,
} from './review-adapters';

type ReviewItemRow = typeof reviewItems.$inferSelect;
type ChangeRequestRow = typeof changeRequests.$inferSelect;
type ExecutorExecutionRow = typeof executorExecutions.$inferSelect;

export type ReviewSegment = 'needs_you' | 'waiting' | 'done';
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

export async function getReviewItemById(reviewItemId: string, projectId: string) {
  const [row] = await db
    .select()
    .from(reviewItems)
    .where(and(eq(reviewItems.reviewItemId, reviewItemId), eq(reviewItems.projectId, projectId)))
    .limit(1);
  return row ?? null;
}

export async function listReviewItems(
  projectId: string,
  opts: { segment?: ReviewSegment; kind?: ReviewItemRow['kind'] } = {},
) {
  const where = [eq(reviewItems.projectId, projectId)];
  if (opts.segment) where.push(inArray(reviewItems.status, statusesForSegment(opts.segment)));
  if (opts.kind) where.push(eq(reviewItems.kind, opts.kind));
  return db
    .select()
    .from(reviewItems)
    .where(and(...where))
    .orderBy(desc(reviewItems.createdAt));
}

/**
 * One inbox source (native items, change requests, executor approvals). Each is
 * fetched INDEPENDENTLY and folded in memory — there is no SQL join.
 */
export interface InboxSources {
  native: () => Promise<ReviewItemRow[]>;
  changeRequests: () => Promise<ChangeRequestRow[]>;
  executorApprovals: () => Promise<ExecutorExecutionRow[]>;
  /** Live opencode permissions across the project's sandboxes (fetched, not a DB
   *  table) — the same blocking asks relayed to Telegram, shown in the inbox. */
  sandboxPermissions: () => Promise<SandboxPermissionRow[]>;
}

/**
 * Run one inbox source, degrading a failure to an empty contribution.
 *
 * This endpoint is POLLED by the sidebar (every 8–20s) and the Review Center, so
 * one flaky source must NEVER 500 the whole inbox. The recurring real-world cause
 * is schema/enum drift on a DB the API code has outrun (e.g. `review_items` not
 * yet migrated, or an `executor_execution_status` value the deployed enum lacks):
 * that throws a Postgres error which — unguarded — took the entire response down.
 * We surface the failure to Sentry (so the drift is still visible and fixable) but
 * return `[]` for that source and keep serving the sources that DO work.
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

/**
 * The full inbox read model: native review items UNIONed with adapted sources
 * (Change Requests now; executor/tunnel approvals next), filtered to a segment /
 * kind and sorted newest-first. Returns already-serialized DTOs.
 *
 * Every source and every row is fault-isolated (see {@link safeSource} /
 * {@link safeMap}) so a partial failure degrades to a partial (or empty) inbox
 * rather than a 500. Pure over its injected `sources` — unit-testable without a DB.
 */
export async function collectInboxItems(
  sources: InboxSources,
  opts: { segment?: ReviewSegment; kind?: ReviewItemRow['kind'] } = {},
) {
  const [nativeRows, crRows, execRows, permRows] = await Promise.all([
    safeSource('native', sources.native),
    safeSource('change_requests', sources.changeRequests),
    safeSource('executor_executions', sources.executorApprovals),
    safeSource('sandbox_permissions', sources.sandboxPermissions),
  ]);
  const items = [
    ...safeMap('native', nativeRows, serializeReviewItem),
    ...safeMap('change_requests', crRows, changeRequestToReviewItem),
    ...safeMap('executor_executions', execRows, executorExecutionToReviewItem),
    ...safeMap('sandbox_permissions', permRows, sandboxPermissionToReviewItem),
  ];
  const segmentStatuses = opts.segment ? statusesForSegment(opts.segment) : null;
  return items
    .filter(
      (i) =>
        (!segmentStatuses || segmentStatuses.includes(i.status)) &&
        (!opts.kind || i.kind === opts.kind),
    )
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export async function listInboxItems(
  projectId: string,
  opts: { segment?: ReviewSegment; kind?: ReviewItemRow['kind'] } = {},
) {
  return collectInboxItems(
    {
      native: () => db.select().from(reviewItems).where(eq(reviewItems.projectId, projectId)),
      changeRequests: () =>
        db.select().from(changeRequests).where(eq(changeRequests.projectId, projectId)),
      executorApprovals: () =>
        db
          .select()
          .from(executorExecutions)
          .where(
            and(
              eq(executorExecutions.projectId, projectId),
              eq(executorExecutions.status, 'pending_approval'),
            ),
          ),
      sandboxPermissions: () => listProjectPendingPermissions(projectId),
    },
    opts,
  );
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
  if (reviewItemIds.length === 0) return [];
  return db
    .update(reviewItems)
    .set({
      status: VERDICT_STATUS[opts.verdict],
      actedBy: opts.actingUserId,
      actedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(eq(reviewItems.projectId, projectId), inArray(reviewItems.reviewItemId, reviewItemIds)),
    )
    .returning();
}
