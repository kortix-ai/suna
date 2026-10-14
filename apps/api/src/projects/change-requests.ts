/**
 * Change Requests — Kortix-native PR layer.
 *
 * The CR is metadata that proposes merging `head_ref` into `base_ref` for a
 * project. All underlying git work goes through `./git.ts`, which talks to
 * whichever backend the project's repo URL points to (GitHub, GitLab,
 * plain git). The CR system is therefore backend-agnostic — the
 * review UI lives in Kortix even when the repo is hosted elsewhere.
 *
 * v1 is intentionally minimal: status (open / merged / closed), head/base
 * refs, an auto-refreshed head_commit_sha. No reviews, no comments, no
 * mirrored commit history — git remains the source of truth for who changed
 * what.
 */

import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { ChangeRequest } from '@kortix/api-contract';
import { changeRequests } from '@kortix/db';
import { db } from '../shared/db';

type ChangeRequestStatus = 'open' | 'merged' | 'closed';

/** The list route's page size: the default, and the ceiling above which it
 *  answers 400. The unbounded list measured 565 KB on prod (KRTX-1727). */
export const CHANGE_REQUEST_LIST_DEFAULT_LIMIT = 50;
export const CHANGE_REQUEST_LIST_MAX_LIMIT = 500;

type ChangeRequestRow = typeof changeRequests.$inferSelect;

export function serializeChangeRequest(row: ChangeRequestRow): ChangeRequest {
  return {
    cr_id: row.crId,
    account_id: row.accountId,
    project_id: row.projectId,
    number: row.number,
    title: row.title,
    description: row.description,
    base_ref: row.baseRef,
    head_ref: row.headRef,
    status: row.status,
    head_commit_sha: row.headCommitSha,
    base_commit_sha: row.baseCommitSha,
    origin_session_id: row.originSessionId,
    created_by: row.createdBy,
    merged_at: row.mergedAt?.toISOString() ?? null,
    merged_by: row.mergedBy,
    merge_commit_sha: row.mergeCommitSha,
    closed_at: row.closedAt?.toISOString() ?? null,
    closed_by: row.closedBy,
    metadata: row.metadata ?? {},
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export interface ListChangeRequestsForProjectOptions {
  status?: ChangeRequestStatus | 'all';
  /**
   * Scope to one session's change requests. The "outcome" cards used to fetch
   * every change request in the project, every 60s, per open session thread,
   * just to filter down to the ones that session opened (measured on prod:
   * 565KB body for the unfiltered list). This does the filtering at the
   * source instead.
   */
  originSessionId?: string;
  /** Default CHANGE_REQUEST_LIST_DEFAULT_LIMIT. The route refuses a value
   *  above CHANGE_REQUEST_LIST_MAX_LIMIT; this clamps as a second line. */
  limit?: number;
  /** A previous page's `next_cursor`: the rows numbered below it. */
  cursor?: number;
}

/** A list cursor is the number of the last row of the page (rows are unique by
 *  (project_id, number), newest first). Null for anything else. */
export function decodeChangeRequestCursor(raw: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  const number = Number(raw);
  return number <= 2_147_483_647 ? number : null;
}

/** The `GET /:projectId/change-requests` list query, extracted so it is
 *  unit-testable against a real Postgres without going through HTTP/auth.
 *  One keyset page by `number`, newest first. */
export async function listChangeRequestsForProject(
  projectId: string,
  options: ListChangeRequestsForProjectOptions = {},
): Promise<{ change_requests: ChangeRequest[]; next_cursor: string | null }> {
  const whereClauses = [eq(changeRequests.projectId, projectId)];
  if (options.status && options.status !== 'all') {
    whereClauses.push(eq(changeRequests.status, options.status));
  }
  if (options.originSessionId) {
    whereClauses.push(eq(changeRequests.originSessionId, options.originSessionId));
  }
  if (options.cursor != null) {
    whereClauses.push(lt(changeRequests.number, options.cursor));
  }
  const limit = Math.min(
    options.limit ?? CHANGE_REQUEST_LIST_DEFAULT_LIMIT,
    CHANGE_REQUEST_LIST_MAX_LIMIT,
  );
  const rows = await db
    .select()
    .from(changeRequests)
    .where(and(...whereClauses))
    .orderBy(desc(changeRequests.number))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    change_requests: page.map(serializeChangeRequest),
    next_cursor: rows.length > limit ? String(page[page.length - 1].number) : null,
  };
}

/**
 * Next per-project CR number. The table has a unique index on
 * (project_id, number) so racing opens surface as 23505 — callers should
 * retry once.
 */
export async function getNextCrNumber(projectId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${changeRequests.number}), 0)` })
    .from(changeRequests)
    .where(eq(changeRequests.projectId, projectId));
  return (row?.max ?? 0) + 1;
}

export async function getCrById(crId: string, projectId: string) {
  const [row] = await db
    .select()
    .from(changeRequests)
    .where(and(eq(changeRequests.crId, crId), eq(changeRequests.projectId, projectId)))
    .limit(1);
  return row ?? null;
}

/** One human "please change this" note recorded against a CR. */
export interface RequestedChange {
  text: string;
  by: string; // userId
  at: string; // ISO
}

/** Read the requested-changes log off a CR's metadata (safe on any shape). */
export function requestedChangesOf(row: ChangeRequestRow): RequestedChange[] {
  const list = (row.metadata as Record<string, unknown> | null)?.requested_changes;
  return Array.isArray(list) ? (list as RequestedChange[]) : [];
}

/**
 * Append a human "request changes" note to a CR's metadata. CRs have no comment
 * table (git is the source of truth for content), so the review feedback lives
 * here — persistent, and surfaced back in the Review Center detail so the ask is
 * never lost. Returns the updated row, or null if the CR is gone.
 */
export async function recordRequestedChange(
  crId: string,
  projectId: string,
  entry: RequestedChange,
): Promise<ChangeRequestRow | null> {
  const cr = await getCrById(crId, projectId);
  if (!cr) return null;
  const meta = (cr.metadata as Record<string, unknown> | null) ?? {};
  const [row] = await db
    .update(changeRequests)
    .set({
      metadata: { ...meta, requested_changes: [...requestedChangesOf(cr), entry] },
      updatedAt: new Date(),
    })
    .where(and(eq(changeRequests.crId, crId), eq(changeRequests.projectId, projectId)))
    .returning();
  return row ?? null;
}
