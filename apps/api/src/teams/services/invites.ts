import { sql } from 'drizzle-orm';
import type { Database } from '@kortix/db';
import { getSupabase } from '../../shared/supabase';
import { invalidatePreviewCacheForUser } from '../../shared/preview-ownership';

import {
  AlreadyAcceptedError,
  AlreadyMemberError,
  InviteExpiredError,
  NotFoundError,
  ValidationError,
  WrongEmailError,
} from '../domain/errors';
import type { AccountRole, SandboxInvite } from '../domain/types';
import { ensureAccountMember } from '../repositories/accounts';
import {
  addSandboxMember,
  isSandboxMember as memberExists,
} from '../repositories/members';
import {
  createInvite as repoCreateInvite,
  deleteInvite,
  findInviteById,
  findPendingInviteForSandbox,
  listPendingInvitesForEmail,
  markInviteAccepted,
} from '../repositories/invites';
import { sendInviteEmail } from './notifications';

function normalizeEmail(raw: string | undefined | null): string {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value.includes('@')) {
    throw new ValidationError('A valid email is required');
  }
  return value;
}

async function findAuthUserIdByEmail(db: Database, email: string): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(
    sql`SELECT id FROM auth.users WHERE lower(email) = ${email} LIMIT 1`,
  );
  const user = (rows as any)?.[0] ?? (rows as any)?.rows?.[0] ?? null;
  return user?.id ?? null;
}

async function lookupAuthEmail(userId: string): Promise<string | null> {
  try {
    const { data, error } = await getSupabase().auth.admin.getUserById(userId);
    if (error) return null;
    return data?.user?.email?.trim().toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function isExpired(invite: { expiresAt: Date; acceptedAt: Date | null }): boolean {
  return !invite.acceptedAt && invite.expiresAt.getTime() <= Date.now();
}

export async function createInvite(
  db: Database,
  input: {
    sandboxId: string;
    accountId: string;
    sandboxName: string;
    email: string;
    invitedBy: string;
    inviterEmail: string | null;
    /** Role the invitee will receive on accept. Defaults to 'member'. */
    role?: 'admin' | 'member';
  },
): Promise<{ invite: SandboxInvite | null; status: 'invited' | 'reused' }> {
  const email = normalizeEmail(input.email);
  const initialRole: 'admin' | 'member' = input.role ?? 'member';
  if (initialRole !== 'admin' && initialRole !== 'member') {
    throw new ValidationError(`Invalid role: ${initialRole}`);
  }

  const existingUserId = await findAuthUserIdByEmail(db, email);
  if (existingUserId && (await memberExists(db, input.sandboxId, existingUserId))) {
    throw new AlreadyMemberError('User is already a member of this sandbox');
  }

  let invite = await repoCreateInvite(db, {
    sandboxId: input.sandboxId,
    accountId: input.accountId,
    email,
    invitedBy: input.invitedBy,
    initialRole,
  });
  let status: 'invited' | 'reused' = 'invited';
  if (!invite) {
    invite = await findPendingInviteForSandbox(db, input.sandboxId, email);
    status = 'reused';
  }

  void sendInviteEmail({
    email,
    sandboxName: input.sandboxName,
    inviterEmail: input.inviterEmail,
    inviteId: invite?.inviteId ?? null,
    role: invite?.initialRole === 'admin' ? 'admin' : 'member',
  });

  return { invite, status };
}

export async function describeInvite(
  db: Database,
  inviteId: string,
  callerEmail: string | undefined,
): Promise<
  SandboxInvite & {
    sandboxName: string | null;
    inviterEmail: string | null;
    emailMatchesCaller: boolean;
    expired: boolean;
  }
> {
  const invite = await findInviteById(db, inviteId);
  if (!invite) throw new NotFoundError('Invite not found');
  const inviterEmail = invite.invitedBy ? await lookupAuthEmail(invite.invitedBy) : null;
  const normalizedCaller = (callerEmail ?? '').trim().toLowerCase();
  return {
    ...invite,
    inviterEmail,
    emailMatchesCaller: normalizedCaller === invite.email.toLowerCase(),
    expired: isExpired(invite),
  };
}

export async function acceptInvite(
  db: Database,
  inviteId: string,
  input: { userId: string; email: string | undefined },
): Promise<{ sandboxId: string; alreadyAccepted: boolean }> {
  const invite = await findInviteById(db, inviteId);
  if (!invite) throw new NotFoundError('Invite not found');

  if (invite.acceptedAt) {
    return { sandboxId: invite.sandboxId, alreadyAccepted: true };
  }

  if (isExpired(invite)) {
    throw new InviteExpiredError('This invite has expired. Ask the owner to send a new one.');
  }

  const callerEmail = (input.email ?? '').trim().toLowerCase();
  if (callerEmail !== invite.email.toLowerCase()) {
    throw new WrongEmailError('This invite is addressed to a different account.');
  }

  // Use the role the inviter preselected. Accept never promotes to owner.
  const grantedRole: AccountRole =
    invite.initialRole === 'admin' ? 'admin' : 'member';
  await ensureAccountMember(db, input.userId, invite.accountId, grantedRole);
  await addSandboxMember(db, {
    sandboxId: invite.sandboxId,
    userId: input.userId,
    addedBy: invite.invitedBy ?? null,
  });
  await markInviteAccepted(db, invite.inviteId);

  // Flush any cached "denied" decisions from before the accept so the proxy
  // immediately recognises the new access grant.
  invalidatePreviewCacheForUser(input.userId);

  return { sandboxId: invite.sandboxId, alreadyAccepted: false };
}

export async function declineInvite(
  db: Database,
  inviteId: string,
  callerEmail: string | undefined,
): Promise<void> {
  const invite = await findInviteById(db, inviteId);
  if (!invite) throw new NotFoundError('Invite not found');
  if (invite.acceptedAt) {
    throw new AlreadyAcceptedError('Invite has already been accepted');
  }
  // Expired invites can still be "declined" (deleted) — harmless cleanup.
  const normalizedCaller = (callerEmail ?? '').trim().toLowerCase();
  if (normalizedCaller !== invite.email.toLowerCase()) {
    throw new WrongEmailError('This invite is addressed to a different account.');
  }
  await deleteInvite(db, invite.inviteId);
}

export async function revokeInvite(
  db: Database,
  sandboxId: string,
  inviteId: string,
): Promise<void> {
  await deleteInvite(db, inviteId, sandboxId);
}

export async function claimPendingInvitesOnSignup(
  db: Database,
  userId: string,
  email: string,
): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const pending = await listPendingInvitesForEmail(db, normalized);
  if (pending.length === 0) return null;

  for (const invite of pending) {
    const grantedRole: AccountRole =
      invite.initialRole === 'admin' ? 'admin' : 'member';
    await ensureAccountMember(db, userId, invite.accountId, grantedRole);
    await addSandboxMember(db, {
      sandboxId: invite.sandboxId,
      userId,
      addedBy: invite.invitedBy ?? null,
    });
    await markInviteAccepted(db, invite.inviteId);
  }

  invalidatePreviewCacheForUser(userId);
  return pending[0].accountId;
}
