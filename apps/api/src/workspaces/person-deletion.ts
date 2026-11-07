/**
 * "Delete my account" deletes the PERSON, never a workspace picked for them
 * (review finding 2; design.md §3.1 item 2, §3.2 C2). Deleting your Slack
 * account is a different act from deleting a Slack workspace.
 *
 * The plan, per membership of the person:
 *   - sole owner and only member  → the workspace is deleted with them;
 *   - sole owner with other members → a blocker: transfer ownership or delete
 *     the workspace first (409 `sole_owner_of_shared_workspace`);
 *   - anything else (a co-owner, an admin, a member) → they leave it.
 * The login (`deleteLogin`) goes LAST, so a failure on the way leaves the
 * person able to sign in and retry.
 *
 * `deletePerson(userId, 'now')` runs the plan. `'scheduled'` writes
 * `kortix.person_deletion_requests` with the 14-day grace and ends the
 * person's sign-ins; the account-deletion worker runs the plan when it is due
 * (`processScheduledPersonDeletions`).
 */
import { personDeletionRequests } from '@kortix/db';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';

import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { asWorkspaceId, isUuid, type WorkspaceId } from './ids';
import { liveRecordsOf } from './store';

export const SOLE_OWNER_OF_SHARED_WORKSPACE_CODE = 'sole_owner_of_shared_workspace';
export const PERSON_DELETION_GRACE_DAYS = 14;

export interface PersonDeletionBlocker {
  workspaceId: WorkspaceId;
  name: string;
  memberCount: number;
}

export interface PersonDeletionPlan {
  deleteWorkspaces: WorkspaceId[];
  leaveWorkspaces: WorkspaceId[];
  blockers: PersonDeletionBlocker[];
  /** The name of every workspace the plan lists, for the confirmation dialog. */
  names?: Record<string, string>;
}

/** 409: the person is the sole owner of a workspace other people use. */
export class SoleOwnerOfSharedWorkspaceError extends Error {
  readonly code = SOLE_OWNER_OF_SHARED_WORKSPACE_CODE;
  constructor(readonly blockers: readonly PersonDeletionBlocker[]) {
    super(
      'You are the only owner of a workspace other people use. Make someone else an owner, or delete the workspace, before you delete your account.',
    );
    this.name = 'SoleOwnerOfSharedWorkspaceError';
  }
}

interface MembershipFacts {
  accountId: string;
  role: string | null;
  owners: number;
  members: number;
}

/** The plan, plus the account keys it acts on (internal). */
interface PlanDetail {
  plan: PersonDeletionPlan;
  deleteAccounts: string[];
  leaveAccounts: string[];
}

async function planDetail(userId: string): Promise<PlanDetail> {
  const empty: PlanDetail = { plan: { deleteWorkspaces: [], leaveWorkspaces: [], blockers: [], names: {} }, deleteAccounts: [], leaveAccounts: [] };
  if (!isUuid(userId)) return empty;
  const uid = userId.toLowerCase();
  const facts = (await db.execute<{ account_id: string; role: string | null; owners: number; members: number }>(sql`
    SELECT m.account_id::text AS account_id,
           (SELECT am.account_role::text FROM kortix.account_members am
             WHERE am.account_id = m.account_id AND am.user_id = m.user_id LIMIT 1) AS role,
           (SELECT count(*)::int FROM kortix.account_members o
             WHERE o.account_id = m.account_id AND o.account_role = 'owner') AS owners,
           (SELECT count(*)::int FROM kortix.account_memberships x WHERE x.account_id = m.account_id) AS members
      FROM kortix.account_memberships m
     WHERE m.user_id = ${uid}::uuid
     ORDER BY m.joined_at, m.account_id`)).map(
    (row): MembershipFacts => ({ accountId: row.account_id, role: row.role, owners: Number(row.owners), members: Number(row.members) }),
  );
  if (facts.length === 0) return empty;

  const records = await liveRecordsOf(
    sql`SELECT jsonb_array_elements_text(${JSON.stringify(facts.map((f) => f.accountId))}::jsonb)::uuid AS id`,
  );
  const byAccount = new Map<string, typeof records>();
  for (const record of records) byAccount.set(record.accountId, [...(byAccount.get(record.accountId) ?? []), record]);

  const detail: PlanDetail = { plan: { deleteWorkspaces: [], leaveWorkspaces: [], blockers: [], names: {} }, deleteAccounts: [], leaveAccounts: [] };
  for (const fact of facts) {
    const live = byAccount.get(fact.accountId) ?? [];
    // An account always has a live row; the account key stands in when it has none.
    const ids = live.length ? live.map((record) => record.workspaceId) : [asWorkspaceId(fact.accountId)];
    for (const record of live) detail.plan.names![record.workspaceId] = record.name;
    const soleOwner = fact.role === 'owner' && fact.owners <= 1;
    if (soleOwner && fact.members <= 1) {
      detail.plan.deleteWorkspaces.push(...ids);
      detail.deleteAccounts.push(fact.accountId);
    } else if (soleOwner) {
      for (const id of ids) {
        detail.plan.blockers.push({ workspaceId: id, name: detail.plan.names![id] ?? '', memberCount: fact.members });
      }
    } else {
      detail.plan.leaveWorkspaces.push(...ids);
      detail.leaveAccounts.push(fact.accountId);
    }
  }
  return detail;
}

/** What deleting `userId` would do. Read-only. */
export async function planPersonDeletion(userId: string): Promise<PersonDeletionPlan> {
  return (await planDetail(userId)).plan;
}

/** Run the plan now. Throws `SoleOwnerOfSharedWorkspaceError` before any write when a blocker exists. */
async function runPlan(userId: string): Promise<PersonDeletionPlan> {
  const detail = await planDetail(userId);
  if (detail.plan.blockers.length > 0) throw new SoleOwnerOfSharedWorkspaceError(detail.plan.blockers);
  const deletion = await import('../billing/services/account-deletion');

  // 1. The workspaces that die with the person. No requester: the sandbox
  //    sweep stays inside each deleted account (never a co-owned workspace),
  //    and the login waits for step 3.
  for (const accountId of detail.deleteAccounts) await deletion.deleteAccountForPerson(accountId);

  // 2. The workspaces the person leaves: the same offboarding as "Leave".
  if (detail.leaveAccounts.length > 0) {
    const { offboardMember } = await import('../accounts/core/offboard-member');
    const { SYSTEM_ACTOR } = (await import('../iam/assignments')) as typeof import('../iam/assignments');
    for (const accountId of detail.leaveAccounts) await offboardMember(SYSTEM_ACTOR as never, accountId, userId, 'left');
  }

  // 3. The login, last.
  await deletion.deleteLogin(userId);
  await db
    .update(personDeletionRequests)
    .set({ status: 'completed', completedAt: new Date() })
    .where(and(eq(personDeletionRequests.userId, userId), inArray(personDeletionRequests.status, ['pending', 'processing'])));
  return detail.plan;
}

/**
 * Delete the person now, or schedule it 14 days out. Both refuse with
 * `SoleOwnerOfSharedWorkspaceError` while a blocker exists. A second schedule
 * while one is pending answers the existing date.
 */
export async function deletePerson(
  userId: string,
  when: 'now' | 'scheduled',
): Promise<{ plan: PersonDeletionPlan; scheduledFor: Date | null }> {
  if (when === 'now') return { plan: await runPlan(userId), scheduledFor: null };

  const plan = await planPersonDeletion(userId);
  if (plan.blockers.length > 0) throw new SoleOwnerOfSharedWorkspaceError(plan.blockers);
  const scheduledFor = new Date(Date.now() + PERSON_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const [row] = await db
    .insert(personDeletionRequests)
    .values({ userId, scheduledFor, status: 'pending' })
    .onConflictDoUpdate({
      target: personDeletionRequests.userId,
      set: { requestedAt: new Date(), scheduledFor, status: 'pending', completedAt: null },
      setWhere: sql`${personDeletionRequests.status} IN ('cancelled', 'completed')`,
    })
    .returning({ scheduledFor: personDeletionRequests.scheduledFor });
  if (!row) {
    const [existing] = await db
      .select({ scheduledFor: personDeletionRequests.scheduledFor })
      .from(personDeletionRequests)
      .where(eq(personDeletionRequests.userId, userId))
      .limit(1);
    return { plan, scheduledFor: existing?.scheduledFor ?? scheduledFor };
  }
  // A scheduled deletion ends existing sign-ins, not the identity: a fresh
  // sign-in can still cancel during the grace.
  await db.execute(sql`DELETE FROM auth.sessions WHERE user_id = ${userId}::uuid`);
  return { plan, scheduledFor: row.scheduledFor };
}

/** The person's pending scheduled deletion, or null. */
export async function getPersonDeletionRequest(userId: string) {
  const [row] = await db
    .select()
    .from(personDeletionRequests)
    .where(and(eq(personDeletionRequests.userId, userId), inArray(personDeletionRequests.status, ['pending', 'processing'])))
    .limit(1);
  return row ?? null;
}

/** Cancel the person's pending scheduled deletion. False when none was pending. */
export async function cancelPersonDeletion(userId: string): Promise<boolean> {
  const done = await db
    .update(personDeletionRequests)
    .set({ status: 'cancelled' })
    .where(and(eq(personDeletionRequests.userId, userId), eq(personDeletionRequests.status, 'pending')))
    .returning({ userId: personDeletionRequests.userId });
  return done.length > 0;
}

/**
 * The worker's pass over due person deletions, oldest first, `limit` per
 * tick. Each request is claimed (pending → processing) before its work; a
 * blocker or a failure puts it back to pending for the next tick.
 */
export async function processScheduledPersonDeletions(limit = 25): Promise<{ processed: number; errors: string[] }> {
  const due = await db
    .select({ userId: personDeletionRequests.userId })
    .from(personDeletionRequests)
    .where(and(eq(personDeletionRequests.status, 'pending'), lte(personDeletionRequests.scheduledFor, new Date())))
    .orderBy(personDeletionRequests.scheduledFor)
    .limit(limit);
  let processed = 0;
  const errors: string[] = [];
  for (const { userId } of due) {
    const claimed = await db
      .update(personDeletionRequests)
      .set({ status: 'processing' })
      .where(and(eq(personDeletionRequests.userId, userId), eq(personDeletionRequests.status, 'pending')))
      .returning({ userId: personDeletionRequests.userId });
    if (claimed.length === 0) continue;
    try {
      await runPlan(userId);
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[PersonDeletion] scheduled deletion failed', {
        user_id: userId,
        code: error instanceof SoleOwnerOfSharedWorkspaceError ? error.code : undefined,
        error: message,
      });
      errors.push(message);
      await db
        .update(personDeletionRequests)
        .set({ status: 'pending' })
        .where(and(eq(personDeletionRequests.userId, userId), eq(personDeletionRequests.status, 'processing')));
    }
  }
  return { processed, errors };
}
