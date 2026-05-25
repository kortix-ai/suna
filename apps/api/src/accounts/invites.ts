import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { accountInvitations, accountMembers, accounts } from '@kortix/db';
import type { AppEnv } from '../types';
import { db } from '../shared/db';
import { supabaseAuth } from '../middleware/auth';
import { getSupabase } from '../shared/supabase';
import { createInviteAcceptRateLimitMiddleware } from '../shared/rate-limit';

export const accountInvitesRouter = new Hono<AppEnv>();

accountInvitesRouter.use('/:inviteId/accept', createInviteAcceptRateLimitMiddleware());
accountInvitesRouter.use('/*', supabaseAuth);

function normalizeEmail(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase();
}

function isExpired(invite: { expiresAt: Date; acceptedAt: Date | null }): boolean {
  return !invite.acceptedAt && invite.expiresAt.getTime() <= Date.now();
}

async function lookupAuthEmail(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  try {
    const { data } = await getSupabase().auth.admin.getUserById(userId);
    return data?.user?.email?.trim().toLowerCase() ?? null;
  } catch {
    return null;
  }
}

// GET /v1/account-invites/:inviteId — describe an invite. Redacts identifying
// fields when the caller's email doesn't match the invite, so the URL alone
// can't be used to enumerate accounts.
accountInvitesRouter.get('/:inviteId', async (c) => {
  const callerEmail = normalizeEmail(c.get('userEmail') as string | undefined);
  const inviteId = c.req.param('inviteId');

  const [invite] = await db
    .select()
    .from(accountInvitations)
    .where(eq(accountInvitations.inviteId, inviteId))
    .limit(1);

  if (!invite) return c.json({ error: 'Invite not found' }, 404);

  const expired = isExpired(invite);
  const emailMatchesCaller = callerEmail === invite.email.toLowerCase();

  if (!emailMatchesCaller) {
    return c.json({
      invite_id: invite.inviteId,
      email_matches_caller: false,
      expired,
      accepted_at: invite.acceptedAt?.toISOString() ?? null,
      // Identifying fields intentionally null — don't leak to wrong recipient.
      account_id: null,
      account_name: null,
      email: null,
      initial_role: null,
      inviter_email: null,
      created_at: null,
      expires_at: null,
    });
  }

  const [accountRow] = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.accountId, invite.accountId))
    .limit(1);

  const inviterEmail = await lookupAuthEmail(invite.invitedBy);

  return c.json({
    invite_id: invite.inviteId,
    account_id: invite.accountId,
    account_name: accountRow?.name ?? null,
    email: invite.email,
    initial_role: invite.initialRole,
    inviter_email: inviterEmail,
    created_at: invite.createdAt.toISOString(),
    expires_at: invite.expiresAt.toISOString(),
    accepted_at: invite.acceptedAt?.toISOString() ?? null,
    email_matches_caller: true,
    expired,
  });
});

// POST /v1/account-invites/:inviteId/accept — accept an invite. Validates email
// matches caller, invite isn't expired/accepted, then atomically inserts the
// member row + stamps accepted_at.
accountInvitesRouter.post('/:inviteId/accept', async (c) => {
  const userId = c.get('userId') as string;
  const callerEmail = normalizeEmail(c.get('userEmail') as string | undefined);
  const inviteId = c.req.param('inviteId');

  const [invite] = await db
    .select()
    .from(accountInvitations)
    .where(eq(accountInvitations.inviteId, inviteId))
    .limit(1);

  if (!invite) return c.json({ error: 'Invite not found' }, 404);

  if (callerEmail !== invite.email.toLowerCase()) {
    return c.json({ error: 'This invite is addressed to a different account.' }, 403);
  }

  if (invite.acceptedAt) {
    // Already accepted — make acceptance idempotent for the addressed user.
    await db
      .insert(accountMembers)
      .values({
        userId,
        accountId: invite.accountId,
        accountRole: invite.initialRole,
      })
      .onConflictDoNothing({
        target: [accountMembers.userId, accountMembers.accountId],
      });
    return c.json({
      account_id: invite.accountId,
      account_role: invite.initialRole,
      already_accepted: true,
    });
  }

  if (isExpired(invite)) {
    return c.json({ error: 'This invite has expired. Ask the owner to send a new one.' }, 410);
  }

  // Insert member (skip if already a member via some other path) and stamp
  // accepted_at. onConflictDoNothing on the (user, account) unique index keeps
  // this idempotent.
  await db
    .insert(accountMembers)
    .values({
      userId,
      accountId: invite.accountId,
      accountRole: invite.initialRole,
    })
    .onConflictDoNothing({
      target: [accountMembers.userId, accountMembers.accountId],
    });

  const acceptedRows = await db
    .update(accountInvitations)
    .set({ acceptedAt: new Date() })
    .where(
      and(
        eq(accountInvitations.inviteId, invite.inviteId),
        isNull(accountInvitations.acceptedAt),
      ),
    )
    .returning({ inviteId: accountInvitations.inviteId });

  if (acceptedRows.length === 0) {
    return c.json({
      account_id: invite.accountId,
      account_role: invite.initialRole,
      already_accepted: true,
    });
  }

  return c.json({
    account_id: invite.accountId,
    account_role: invite.initialRole,
  });
});

// POST /v1/account-invites/:inviteId/decline — decline an invite. Deletes the
// row outright (cleaner than a `declined_at` sentinel — the invite no longer
// exists from the recipient's perspective).
accountInvitesRouter.post('/:inviteId/decline', async (c) => {
  const callerEmail = normalizeEmail(c.get('userEmail') as string | undefined);
  const inviteId = c.req.param('inviteId');

  const [invite] = await db
    .select()
    .from(accountInvitations)
    .where(eq(accountInvitations.inviteId, inviteId))
    .limit(1);

  if (!invite) return c.json({ error: 'Invite not found' }, 404);

  if (invite.acceptedAt) {
    return c.json({ error: 'Invite has already been accepted' }, 409);
  }

  if (callerEmail !== invite.email.toLowerCase()) {
    return c.json({ error: 'This invite is addressed to a different account.' }, 403);
  }

  await db.delete(accountInvitations).where(eq(accountInvitations.inviteId, invite.inviteId));

  return c.json({ ok: true });
});
