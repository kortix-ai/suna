import { subjects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';

/**
 * Subjects — external end-user identities an operator asserts for "Kortix as a
 * backend". See docs/specs/2026-07-08-kortix-as-a-backend-subject-identity.md and
 * ./session-scope.ts for the token boundary these identities key.
 */

export interface Subject {
  subjectId: string;
  accountId: string;
  projectId: string;
  externalRef: string;
  displayName: string | null;
  disabledAt: Date | null;
}

export interface UpsertSubjectParams {
  accountId: string;
  projectId: string;
  /** The operator's OWN id for this end-user. Unique per project. */
  externalRef: string;
  displayName?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Idempotently assert a subject. Keyed on (project_id, external_ref) so the operator
 * can call this every time an end-user shows up without accumulating duplicates.
 * Re-asserting clears any prior `disabled_at` (the operator vouches for them again)
 * and refreshes the display name / metadata.
 */
export async function upsertSubject(params: UpsertSubjectParams): Promise<Subject> {
  const [row] = await db
    .insert(subjects)
    .values({
      accountId: params.accountId,
      projectId: params.projectId,
      externalRef: params.externalRef,
      displayName: params.displayName ?? null,
      metadata: params.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [subjects.projectId, subjects.externalRef],
      set: {
        displayName: params.displayName ?? null,
        metadata: params.metadata ?? {},
        disabledAt: null,
      },
    })
    .returning();

  if (!row) throw new Error('Failed to upsert subject');
  return toSubject(row);
}

/** Resolve a subject by the operator's external id within a project. */
export async function getSubjectByExternalRef(
  projectId: string,
  externalRef: string,
): Promise<Subject | null> {
  const [row] = await db
    .select()
    .from(subjects)
    .where(and(eq(subjects.projectId, projectId), eq(subjects.externalRef, externalRef)))
    .limit(1);
  return row ? toSubject(row) : null;
}

/**
 * Disable a subject. Existing subject-scoped tokens are revoked separately (they
 * CASCADE off the subject row only on hard delete); disabling is the soft, reversible
 * offboarding signal an operator uses to stop minting new tokens for this end-user.
 */
export async function disableSubject(projectId: string, externalRef: string): Promise<void> {
  await db
    .update(subjects)
    .set({ disabledAt: new Date() })
    .where(and(eq(subjects.projectId, projectId), eq(subjects.externalRef, externalRef)));
}

function toSubject(row: typeof subjects.$inferSelect): Subject {
  return {
    subjectId: row.subjectId,
    accountId: row.accountId,
    projectId: row.projectId,
    externalRef: row.externalRef,
    displayName: row.displayName,
    disabledAt: row.disabledAt,
  };
}
