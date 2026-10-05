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

import { and, desc, eq, sql } from 'drizzle-orm';
import type { ChangeRequest } from '@kortix/api-contract';
import { changeRequests } from '@kortix/db';
import { db } from '../shared/db';

type ChangeRequestStatus = 'open' | 'merged' | 'closed';

/** No caller passes a value above this — a safety ceiling, not a default
 *  (the list route stays unbounded when `limit` is omitted, matching every
 *  existing caller's current behavior). */
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
  /**
   * Capped at CHANGE_REQUEST_LIST_MAX_LIMIT. Omitted keeps the historical
   * unbounded response every existing caller (the panel, the open-CR badge,
   * `kortix cr list`) already depends on.
   */
  limit?: number;
}

/** The `GET /:projectId/change-requests` list query, extracted so it is
 *  unit-testable against a real Postgres without going through HTTP/auth. */
export async function listChangeRequestsForProject(
  projectId: string,
  options: ListChangeRequestsForProjectOptions = {},
) {
  const whereClauses = [eq(changeRequests.projectId, projectId)];
  if (options.status && options.status !== 'all') {
    whereClauses.push(eq(changeRequests.status, options.status));
  }
  if (options.originSessionId) {
    whereClauses.push(eq(changeRequests.originSessionId, options.originSessionId));
  }
  const baseQuery = db
    .select()
    .from(changeRequests)
    .where(and(...whereClauses))
    .orderBy(desc(changeRequests.number));
  const limit =
    options.limit != null ? Math.min(options.limit, CHANGE_REQUEST_LIST_MAX_LIMIT) : undefined;
  const rows = limit !== undefined ? await baseQuery.limit(limit) : await baseQuery;
  return rows.map(serializeChangeRequest);
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
