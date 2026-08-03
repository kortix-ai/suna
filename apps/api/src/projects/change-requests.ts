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

import { changeRequests } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { type GitBackedProject, resolveBranchAheadState } from './git';

type ChangeRequestStatus = 'open' | 'merged' | 'closed';

export type ChangeRequestRow = typeof changeRequests.$inferSelect;

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

export type CreateChangeRequestForBranchResult =
  | { ok: true; row: ChangeRequestRow }
  | { ok: false; status: 400 | 422 | 500; body: Record<string, unknown> };

function isDuplicateKey(error: unknown): boolean {
  if ((error as { code?: unknown })?.code === '23505') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate key/.test(message);
}

export async function createChangeRequestForBranch(input: {
  accountId: string;
  projectId: string;
  userId: string;
  projectForGit: GitBackedProject;
  title: string;
  description?: string;
  baseRef: string;
  headRef: string;
  originSessionId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<CreateChangeRequestForBranchResult> {
  if (input.baseRef === input.headRef) {
    return {
      ok: false,
      status: 400,
      body: { error: 'head_ref and base_ref must differ' },
    };
  }

  let baseSha: string | null = null;
  let headSha: string | null = null;
  try {
    const aheadState = await resolveBranchAheadState(
      input.projectForGit,
      input.baseRef,
      input.headRef,
    );
    baseSha = aheadState.baseSha;
    headSha = aheadState.headSha;
    if (!aheadState.ahead) {
      return {
        ok: false,
        status: 422,
        body: {
          error: `head_ref "${input.headRef}" has no commits ahead of "${input.baseRef}"`,
          code: 'CR_HEAD_NOT_AHEAD',
        },
      };
    }
  } catch (error) {
    return {
      ok: false,
      status: 400,
      body: {
        error: error instanceof Error ? error.message : 'Failed to resolve branches',
      },
    };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const number = await getNextCrNumber(input.projectId);
    try {
      const [row] = await db
        .insert(changeRequests)
        .values({
          accountId: input.accountId,
          projectId: input.projectId,
          number,
          title: input.title,
          description: input.description ?? '',
          baseRef: input.baseRef,
          headRef: input.headRef,
          headCommitSha: headSha,
          baseCommitSha: baseSha,
          originSessionId: input.originSessionId ?? null,
          createdBy: input.userId,
          metadata: input.metadata ?? {},
        })
        .returning();
      if (row) return { ok: true, row };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }

  return { ok: false, status: 500, body: { error: 'Failed to allocate CR number' } };
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
