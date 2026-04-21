import type { Database } from '@kortix/db';
import { getSupabase } from '../../shared/supabase';

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
}

export async function listMembers(
  db: Database,
  sandboxId: string,
  sandboxAccountId: string,
): Promise<SandboxMember[]> {
  const rows = await listMembersForSandbox(db, sandboxId);
  if (rows.length === 0) return [];

  // Fetch both account roles and auth emails in parallel — both keyed by userId.
  const [accountRoster, supabase] = await Promise.all([
    listAccountMembers(db, sandboxAccountId),
    Promise.resolve(getSupabase()),
  ]);
  const roleByUser = new Map(accountRoster.map((r) => [r.userId, r.role]));

  const emails = new Map<string, string | null>();
  await Promise.all(
    Array.from(new Set(rows.map((r) => r.userId))).map(async (uid) => {
      try {
        const { data } = await supabase.auth.admin.getUserById(uid);
        emails.set(uid, data?.user?.email ?? null);
      } catch {
        emails.set(uid, null);
      }
    }),
  );

  return rows.map((r) => ({
    sandboxId: r.sandboxId,
    userId: r.userId,
    email: emails.get(r.userId) ?? null,
    accountRole: roleByUser.get(r.userId) ?? null,
    addedBy: r.addedBy,
    addedAt: r.addedAt,
  }));
}
