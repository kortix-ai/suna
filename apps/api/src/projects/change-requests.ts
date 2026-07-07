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

import { and, eq, sql } from 'drizzle-orm';
import { changeRequests } from '@kortix/db';
import { db } from '../shared/db';

type ChangeRequestStatus = 'open' | 'merged' | 'closed';

type ChangeRequestRow = typeof changeRequests.$inferSelect;

export function serializeChangeRequest(row: ChangeRequestRow) {
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
