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
import { db } from '../shared/db';
import { changeRequestToReviewItem, executorExecutionToReviewItem } from './review-adapters';

type ReviewItemRow = typeof reviewItems.$inferSelect;

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
 * The full inbox read model: native review items UNIONed with adapted sources
 * (Change Requests now; executor/tunnel approvals next), filtered to a segment /
 * kind and sorted newest-first. Returns already-serialized DTOs.
 */
export async function listInboxItems(
  projectId: string,
  opts: { segment?: ReviewSegment; kind?: ReviewItemRow['kind'] } = {},
) {
  const [nativeRows, crRows, execRows] = await Promise.all([
    db.select().from(reviewItems).where(eq(reviewItems.projectId, projectId)),
    db.select().from(changeRequests).where(eq(changeRequests.projectId, projectId)),
    db
      .select()
      .from(executorExecutions)
      .where(
        and(
          eq(executorExecutions.projectId, projectId),
          eq(executorExecutions.status, 'pending_approval'),
        ),
      ),
  ]);
  const items = [
    ...nativeRows.map(serializeReviewItem),
    ...crRows.map(changeRequestToReviewItem),
    ...execRows.map(executorExecutionToReviewItem),
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

export interface InsertReviewItemInput {
  /** Pre-generated id — lets a git-backed submission name its keep-ref
   *  (refs/kortix/submissions/<id>) before the row exists, so the ref and the
   *  row land in one pass instead of insert-then-update. */
  reviewItemId?: string;
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
      ...(input.reviewItemId ? { reviewItemId: input.reviewItemId } : {}),
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
