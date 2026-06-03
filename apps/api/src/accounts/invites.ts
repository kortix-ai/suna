import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { accountInvitations, accountMembers, accounts, projectMembers } from '@kortix/db';
import type { AppEnv } from '../types';
import { db } from '../shared/db';
import { supabaseAuth } from '../middleware/auth';
import { getSupabase } from '../shared/supabase';
import { createInviteAcceptRateLimitMiddleware } from '../shared/rate-limit';
import { onMemberAdded } from '../billing/services/seat-management';

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

// ─── Bootstrap-grant payload validation ───────────────────────────────────
//
// The bootstrap_grants column is a jsonb array shape-enforced app-side
// (no DB CHECK constraint) because the entries are typed as JSON. Today
// only POST /v1/projects/:id/access/invite writes to it, and it
// constructs entries from validated inputs — so in practice we trust
// what's there. The cost of being wrong, though, is that the accept
// handler would feed garbage straight into projectMembers (e.g., a
// non-UUID project_id would 22023 on the insert, or an out-of-range
// role would 22P02 on the enum cast). Validate defensively so an
// unrelated future code path can't break invite acceptance.
type ValidatedGrant = {
  project_id: string;
  role: 'manager' | 'editor' | 'viewer';
  expires_at: string | null;
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_PROJECT_ROLES = new Set(['manager', 'editor', 'viewer']);

function validateBootstrapGrant(raw: unknown): ValidatedGrant | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  if (typeof g.project_id !== 'string' || !UUID_RE.test(g.project_id)) return null;
  if (typeof g.role !== 'string' || !VALID_PROJECT_ROLES.has(g.role)) return null;
  // expires_at is optional; when present must parse to a real date.
  let expiresAt: string | null = null;
  if (g.expires_at != null) {
    if (typeof g.expires_at !== 'string') return null;
    const d = new Date(g.expires_at);
    if (Number.isNaN(d.getTime())) return null;
    expiresAt = g.expires_at;
  }
  return {
    project_id: g.project_id,
    role: g.role as 'manager' | 'editor' | 'viewer',
    expires_at: expiresAt,
  };
}

// Apply the invite's bootstrap grants (the project_members rows the inviter
// wanted this user to land on). Idempotent — onConflictDoUpdate means a
// re-accept simply re-asserts the grant rather than erroring. Owners/admins
// skip these: they already hold implicit Manager on every project, so a direct
// grant is redundant. Errors are best-effort and logged; the account
// membership itself is already committed and shouldn't roll back because a
// project no longer exists. Each entry is validated first (see
// validateBootstrapGrant) so a bad jsonb write can't break acceptance.
async function applyBootstrapGrants(
  invite: typeof accountInvitations.$inferSelect,
  userId: string,
): Promise<Array<{ project_id: string; role: string }>> {
  const applied: Array<{ project_id: string; role: string }> = [];
  const rawBootstraps = invite.bootstrapGrants ?? [];
  if (rawBootstraps.length === 0 || invite.initialRole !== 'member') return applied;

  for (const raw of rawBootstraps) {
    const g = validateBootstrapGrant(raw);
    if (!g) {
      console.warn('[accept-invite] skipping malformed bootstrap grant', {
        invite_id: invite.inviteId,
        raw,
      });
      continue;
    }
    try {
      await db
        .insert(projectMembers)
        .values({
          accountId: invite.accountId,
          projectId: g.project_id,
          userId,
          projectRole: g.role,
          grantedBy: invite.invitedBy,
          expiresAt: g.expires_at ? new Date(g.expires_at) : null,
        })
        .onConflictDoUpdate({
          target: [projectMembers.projectId, projectMembers.userId],
          set: {
            projectRole: g.role,
            grantedBy: invite.invitedBy,
            updatedAt: new Date(),
            ...(g.expires_at ? { expiresAt: new Date(g.expires_at) } : {}),
          },
        });
      applied.push({ project_id: g.project_id, role: g.role });
    } catch (err) {
      console.warn(
        '[accept-invite] failed to apply bootstrap grant',
        { project_id: g.project_id, role: g.role },
        err,
      );
    }
  }
  return applied;
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

  const alreadyAccepted = !!invite.acceptedAt;

  // Only block a *fresh* accept on expiry. An already-accepted invite stays
  // redeemable for the addressed user so re-entry can heal a grant that was
  // never written (see below).
  if (!alreadyAccepted && isExpired(invite)) {
    return c.json({ error: 'This invite has expired. Ask the owner to send a new one.' }, 410);
  }

  // Ensure account membership. onConflictDoNothing on the (user, account) unique
  // index keeps this idempotent whether it's a first accept or a re-entry.
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

  // Stamp accepted_at on first accept. The isNull guard makes concurrent
  // accepts collapse to a single write without us caring who won — both
  // callers still go on to (idempotently) apply grants below.
  if (!alreadyAccepted) {
    await db
      .update(accountInvitations)
      .set({ acceptedAt: new Date() })
      .where(
        and(
          eq(accountInvitations.inviteId, invite.inviteId),
          isNull(accountInvitations.acceptedAt),
        ),
      );
  }

  // Billing v2 — mint per-member YOLO + push +1 seat to Stripe. No-op for
  // legacy accounts (guarded inside the service). Idempotent on re-accept.
  // Fire-and-forget so Stripe hiccups don't block invite acceptance.
  void onMemberAdded(invite.accountId, userId).catch(() => {});

  // Apply bootstrap grants on EVERY accept path — this is what makes acceptance
  // self-healing. Previously grants ran only on the first accept, AFTER
  // accepted_at was stamped and best-effort; any failure there (or a retried /
  // concurrent accept hitting the already-accepted early return) left the
  // member with no project_members row, so the invited project was invisible
  // to them and re-clicking the link never fixed it. applyBootstrapGrants is
  // idempotent, so re-running it on re-entry just heals the missing grant.
  const appliedGrants = await applyBootstrapGrants(invite, userId);

  return c.json({
    account_id: invite.accountId,
    account_role: invite.initialRole,
    already_accepted: alreadyAccepted,
    bootstrap_grants_applied: appliedGrants,
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
