import type { Database } from '@kortix/db';
import { getSupabase } from '../../shared/supabase';
import { invalidatePreviewCacheForUser } from '../../shared/preview-ownership';

import {
  NotFoundError,
  ValidationError,
} from '../domain/errors';
import type { AccountRole, SandboxMember } from '../domain/types';
import {
  getAccountRole,
  listAccountMembers,
  updateAccountRole,
} from '../repositories/accounts';
import {
  addSandboxMember as repoAdd,
  listMembersForSandbox,
  removeSandboxMember as repoRemove,
} from '../repositories/members';

export async function registerCreator(
  db: Database,
  sandboxId: string,
  userId: string,
): Promise<void> {
  await repoAdd(db, { sandboxId, userId, addedBy: userId });
}

export async function removeMember(
  db: Database,
  sandboxId: string,
  userId: string,
): Promise<void> {
  await repoRemove(db, sandboxId, userId);
  // The removed member may still have a "preview allowed" cache entry — drop
  // it immediately so the kick takes effect on the next request.
  invalidatePreviewCacheForUser(userId);
}

/**
 * Change a teammate's account role. V1 policy:
 *   - only 'admin' ⇄ 'member' transitions allowed
 *   - promoting or demoting the `owner` role is an ownership transfer and is
 *     explicitly out of scope until we build that separate flow
 *
 * The owner-only gate lives in the route (`manage_members` action).
 */
export async function changeMemberRole(
  db: Database,
  input: {
    accountId: string;
    targetUserId: string;
    role: AccountRole;
  },
): Promise<void> {
  if (input.role === 'owner') {
    throw new ValidationError('Ownership transfer is not supported from the Members panel');
  }
  if (input.role !== 'admin' && input.role !== 'member') {
    throw new ValidationError(`Invalid role: ${input.role}`);
  }

  const currentRole = await getAccountRole(db, input.targetUserId, input.accountId);
  if (!currentRole) {
    throw new NotFoundError('User is not a member of this account');
  }
  if (currentRole === 'owner') {
    throw new ValidationError("The owner's role cannot be changed from here");
  }

  await updateAccountRole(db, input.targetUserId, input.accountId, input.role);
  // Role change alters blanket visibility (admin → member loses all sandboxes
  // they don't have explicit grants for). Force a re-evaluation next request.
  invalidatePreviewCacheForUser(input.targetUserId);
}

const ROLE_RANK: Record<AccountRole, number> = {
  owner: 0,
  admin: 1,
  member: 2,
};

/**
 * Who can access this sandbox right now. Union of:
 *   - explicit sandbox_members grants (plain members added individually)
 *   - every owner/admin of the sandbox's account (implicit access via role)
 *
 * We expose both in the list so the Members panel always shows the owner
 * and admins, not just explicitly granted users. Without this, sandboxes
 * created before registerCreator existed would have no owner row at all.
 *
 * Sorted owners → admins → members, then alphabetically by email.
 */
export async function listMembers(
  db: Database,
  sandboxId: string,
  sandboxAccountId: string,
): Promise<SandboxMember[]> {
  const [sandboxRows, accountRoster] = await Promise.all([
    listMembersForSandbox(db, sandboxId),
    listAccountMembers(db, sandboxAccountId),
  ]);

  const roleByUser = new Map(accountRoster.map((r) => [r.userId, r.role]));
  const sandboxRowByUser = new Map(sandboxRows.map((r) => [r.userId, r]));

  // Build the union of user ids to display.
  const userIds = new Set<string>();
  for (const r of sandboxRows) userIds.add(r.userId);
  for (const r of accountRoster) {
    if (r.role === 'owner' || r.role === 'admin') userIds.add(r.userId);
  }

  if (userIds.size === 0) return [];

  // Hydrate emails for every unique user, in parallel.
  const supabase = getSupabase();
  const emails = new Map<string, string | null>();
  await Promise.all(
    Array.from(userIds).map(async (uid) => {
      try {
        const { data } = await supabase.auth.admin.getUserById(uid);
        emails.set(uid, data?.user?.email ?? null);
      } catch {
        emails.set(uid, null);
      }
    }),
  );

  const rows: SandboxMember[] = Array.from(userIds).map((userId) => {
    const sbRow = sandboxRowByUser.get(userId);
    return {
      sandboxId,
      userId,
      email: emails.get(userId) ?? null,
      accountRole: roleByUser.get(userId) ?? null,
      addedBy: sbRow?.addedBy ?? null,
      // Owners/admins surfaced implicitly don't have a sandbox_members row;
      // fall back to epoch so sort-by-addedAt is deterministic.
      addedAt: sbRow?.addedAt ?? new Date(0),
    };
  });

  rows.sort((a, b) => {
    const ra = a.accountRole ? ROLE_RANK[a.accountRole] : 99;
    const rb = b.accountRole ? ROLE_RANK[b.accountRole] : 99;
    if (ra !== rb) return ra - rb;
    return (a.email ?? a.userId).localeCompare(b.email ?? b.userId);
  });

  return rows;
}
