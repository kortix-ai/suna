import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { accountGroupMembers, accountInvitations } from '@kortix/db';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { config } from '../config';
import { db, withDbTransaction } from '../shared/db';
import { supabaseAuth } from '../middleware/auth';
import { getSupabase } from '../shared/supabase';
import { createInviteAcceptRateLimitMiddleware } from '../middleware/rate-limit';
import { getMembership } from './core/app';
import { makeOpenApiApp, json, errors, auth, ErrorSchema } from '../openapi';
import { normalizeProjectRole } from '../iam/roles';
import { assignRole, convertPendingAssignments, SYSTEM_ACTOR } from '../iam/assignments';
import { addWorkspaceMember } from '../iam/workspace-members';
import { trustedEmailForUser } from '../iam/email-trust';
import { getSsoProvider } from '../repositories/sso';
import { isUuid } from '../shared/validate';
import { logger } from '../lib/logger';
import { captureProductEvent } from '../shared/product-analytics';
import { accountsView, projectsView } from '../workspaces/rows';

export const accountInvitesRouter = makeOpenApiApp<AppEnv>();

accountInvitesRouter.use('/:inviteId/accept', createInviteAcceptRateLimitMiddleware());
accountInvitesRouter.use('/*', supabaseAuth);

const InviteIdParam = z.object({ inviteId: z.string() });
const InviteDescribeSchema = z
  .object({
    invite_id: z.string(),
    email_matches_caller: z.boolean(),
    expired: z.boolean(),
    accepted_at: z.string().nullable(),
    account_id: z.string().nullable(),
    account_name: z.string().nullable(),
    email: z.string().nullable(),
    initial_role: z.string().nullable(),
    inviter_email: z.string().nullable(),
    created_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    /** Projects the invite grants on accept, for the invited caller only;
     *  empty for anyone else and for a plain workspace invite (KRTX-1731). */
    projects: z.array(z.object({ project_id: z.string(), name: z.string(), role: z.string() })),
    /** Why the invite is not addressed to the caller; absent when it is. Same codes as a refused accept. */
    reason: z.enum(['email_unconfirmed', 'sso_email_domain_unverified', 'wrong_account']).optional(),
    /** With `email_unconfirmed`: the Supabase SSO provider of the invite's account, to sign in through it. */
    sso_provider_id: z.string().nullable().optional(),
  })
  .openapi('InviteDescribe');
const InviteAcceptSchema = z
  .object({
    account_id: z.string(),
    account_role: z.string(),
    already_accepted: z.boolean(),
    bootstrap_grants_applied: z.array(
      z.object({ project_id: z.string(), role: z.string() }),
    ),
  })
  .openapi('InviteAccept');

function normalizeEmail(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase();
}

/** The caller's email for invite matching, and whether Auth proved it. */
interface CallerInviteEmail {
  email: string;
  proven: boolean;
}

/**
 * The caller's email for invite matching: the Auth row's email, and only when
 * it proves ownership (see iam/email-trust.ts). An SSO identity matches when
 * its IdP verified the email's domain, or when the IdP belongs to the invite's
 * own account (`accountId`): inside one account the IdP and the admin are the
 * same authority. Any other SSO identity matches no invite.
 *
 * While Auth auto-confirms sign-ups, a password email is unproven: whoever
 * signed up first holds the address (KRTX-1715). It still matches an invite a
 * person sent or resent (`invited_by` set), which the invitee accepts in
 * person; sign-in never claims it. It does not match an invite the account's
 * IdP pushed through SCIM (`invited_by` null): nobody shares that invite, and
 * the directory's groups ride on it. That person signs in through the
 * account's IdP instead (`sso_provider_id` on the describe), or an admin
 * resends the invite.
 */
async function callerInviteEmail(c: any, accountId?: string): Promise<CallerInviteEmail> {
  const userId = c.get('userId') as string | undefined;
  const email = await trustedEmailForUser(userId, { allowAutoconfirmed: true, accountId });
  const proven =
    !email || !config.ENABLE_EMAIL_AUTOCONFIRM || (await trustedEmailForUser(userId, { accountId })) === email;
  return { email, proven };
}

function addressedToCaller(caller: CallerInviteEmail, invite: { email: string; invitedBy: string | null }): boolean {
  return caller.email === invite.email.toLowerCase() && (caller.proven || invite.invitedBy !== null);
}

/** Why an invite is not addressed to the caller. The describe returns it as `reason`; accept and decline as `code`. */
type InviteRefusal = {
  code: 'email_unconfirmed' | 'sso_email_domain_unverified' | 'wrong_account';
  error: string;
};

function inviteRefusal(c: any, caller: CallerInviteEmail, invite: { email: string }): InviteRefusal {
  const address = invite.email.toLowerCase();
  if (caller.email === address) {
    return {
      code: 'email_unconfirmed',
      error:
        "Your organization's directory manages this invite. Sign in with your organization's single sign-on to join, or ask an account admin to resend the invite.",
    };
  }
  // The token names the invite's email, but the SSO identity cannot prove it.
  if (normalizeEmail(c.get('userEmail') as string | undefined) === address) {
    return {
      code: 'sso_email_domain_unverified',
      error:
        "Your single sign-on provider has not verified this email's domain. Sign in with your email address to use this invite.",
    };
  }
  return { code: 'wrong_account', error: 'This invite is addressed to a different account.' };
}

/** 403 for an accept or decline of an invite not addressed to the caller. */
function refuseInvite(c: Context<AppEnv>, caller: CallerInviteEmail, invite: { email: string }) {
  return c.json(inviteRefusal(c, caller, invite), 403);
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
// handler would feed garbage straight into the grant store (e.g., a
// non-UUID project_id would 22023 on the insert, or an out-of-range
// role would 22P02 on the enum cast). Validate defensively so an
// unrelated future code path can't break invite acceptance.
type ValidatedGrant = {
  project_id: string;
  role: 'manager' | 'member';
  expires_at: string | null;
};

function validateBootstrapGrant(raw: unknown): ValidatedGrant | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  if (!isUuid(g.project_id)) return null;
  if (typeof g.role !== 'string') return null;
  const role = normalizeProjectRole(g.role);
  if (!role) return null;
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
    role,
    expires_at: expiresAt,
  };
}

/**
 * The projects each invite grants on accept, named. A grant counts only when
 * its project still exists in the invite's own account: a deleted project
 * drops out instead of showing a blank row.
 */
async function invitedProjects(
  invites: ReadonlyArray<{ inviteId: string; accountId: string; bootstrapGrants: unknown[] | null }>,
): Promise<Map<string, Array<{ project_id: string; name: string; role: string }>>> {
  const grantsByInvite = new Map(
    invites.map((invite) => [
      invite.inviteId,
      (invite.bootstrapGrants ?? []).map(validateBootstrapGrant).filter((g): g is ValidatedGrant => g !== null),
    ]),
  );
  const projectIds = [...new Set([...grantsByInvite.values()].flat().map((g) => g.project_id))];
  const projectNames = new Map<string, string>();
  if (projectIds.length > 0) {
    const projectRows = await db
      .select({ projectId: projectsView.projectId, name: projectsView.name, accountId: projectsView.accountId })
      .from(projectsView)
      .where(inArray(projectsView.projectId, projectIds));
    for (const row of projectRows) projectNames.set(`${row.accountId}:${row.projectId}`, row.name);
  }
  return new Map(
    invites.map((invite) => [
      invite.inviteId,
      (grantsByInvite.get(invite.inviteId) ?? []).flatMap((g) => {
        const name = projectNames.get(`${invite.accountId}:${g.project_id}`);
        return name ? [{ project_id: g.project_id, name, role: g.role }] : [];
      }),
    ]),
  );
}

// A `{ group_id }` bootstrap entry: a SCIM Group membership pushed for this user
// while they were still a pending invite (see scim/groups.ts). Validated the same
// defensive way as project grants so a bad jsonb write can't break acceptance.
// Exported for unit tests.
export function validateBootstrapGroup(raw: unknown): { group_id: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  if (!isUuid(g.group_id)) return null;
  return { group_id: g.group_id };
}

// Apply the invite's bootstrap grants (the project_members rows the inviter
// wanted this user to land on). Idempotent — onConflictDoUpdate means a
// re-accept simply re-asserts the grant rather than erroring. Owners/admins
// skip these: they already hold implicit Manager on every project, so a direct
// grant is redundant. Errors are best-effort and logged; the account
// membership itself is already committed and shouldn't roll back because a
// project no longer exists. Each entry is validated first (see
// validateBootstrapGrant) so a bad jsonb write can't break acceptance.
/** A time-boxed invite's membership end (`{account_expires_at}` in bootstrap_grants), or null. */
function inviteMembershipExpiry(invite: typeof accountInvitations.$inferSelect): Date | null {
  for (const raw of (invite.bootstrapGrants ?? []) as unknown[]) {
    if (raw && typeof raw === 'object' && 'account_expires_at' in raw) {
      const at = new Date(String((raw as { account_expires_at: unknown }).account_expires_at));
      if (!Number.isNaN(at.getTime())) return at;
    }
  }
  return null;
}

async function applyBootstrapGrants(
  invite: typeof accountInvitations.$inferSelect,
  userId: string,
): Promise<Array<{ project_id: string; role: string }>> {
  const applied: Array<{ project_id: string; role: string }> = [];
  const rawBootstraps = invite.bootstrapGrants ?? [];
  if (rawBootstraps.length === 0 || invite.initialRole !== 'member') return applied;

  for (const raw of rawBootstraps) {
    // The membership expiry entry is applied by the membership write itself.
    if (raw && typeof raw === 'object' && 'account_expires_at' in raw) continue;
    // A SCIM Group membership parked while this user was a pending invite —
    // materialize it now that they have a real user row. Idempotent.
    const grp = validateBootstrapGroup(raw);
    if (grp) {
      try {
        await db
          .insert(accountGroupMembers)
          .values({ groupId: grp.group_id, userId })
          .onConflictDoNothing();
      } catch (err) {
        console.warn(
          '[accept-invite] failed to apply bootstrap group',
          { group_id: grp.group_id },
          err,
        );
      }
      continue;
    }
    const g = validateBootstrapGrant(raw);
    if (!g) {
      console.warn('[accept-invite] skipping malformed bootstrap grant', {
        invite_id: invite.inviteId,
        raw,
      });
      continue;
    }
    try {
      // The ONE write path. `kortix.project_members` is a view over
      // `kortix.role_assignments` as of the cutover, so this single call is the
      // whole grant, and it emits one `iam.assignment.granted` per project the
      // inviter staged.
      await assignRole(SYSTEM_ACTOR, invite.accountId, {
        principal: { type: 'user', id: userId },
        roleKey: g.role,
        scope: { type: 'project', id: g.project_id },
        expiresAt: g.expires_at ? new Date(g.expires_at) : null,
        source: 'invite',
        exclusive: true,
        grantedBy: invite.invitedBy,
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

const MyInviteSchema = z
  .object({
    invite_id: z.string(),
    account_id: z.string(),
    account_name: z.string().nullable(),
    initial_role: z.string(),
    inviter_email: z.string().nullable(),
    created_at: z.string(),
    expires_at: z.string(),
    /** Projects the invite grants on accept. Empty for a plain workspace invite. */
    projects: z.array(z.object({ project_id: z.string(), name: z.string(), role: z.string() })),
  })
  .openapi('MyInvite');

// GET /v1/account-invites — the pending invites addressed to the caller's
// email. The chooser at /projects/start lists them, so an invitee who signs up
// without the email link still finds the workspace or project they were
// invited to. Only unexpired, unaccepted invites; nothing is redacted because
// every row is addressed to the caller.
accountInvitesRouter.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['accounts'],
    summary: "List the caller's pending invites",
    ...auth,
    responses: {
      200: json(z.object({ invites: z.array(MyInviteSchema) }), 'Pending invites'),
      ...errors(401),
    },
  }),
  async (c: any) => {
    const caller = await callerInviteEmail(c);
    if (!caller.email) return c.json({ invites: [] });

    const rows = await db
      .select({ invite: accountInvitations, accountName: accountsView.name })
      .from(accountInvitations)
      .leftJoin(accountsView, eq(accountsView.accountId, accountInvitations.accountId))
      .where(
        and(
          sql`lower(${accountInvitations.email}) = ${caller.email}`,
          isNull(accountInvitations.acceptedAt),
          gt(accountInvitations.expiresAt, new Date()),
          caller.proven ? undefined : isNotNull(accountInvitations.invitedBy),
        ),
      )
      .orderBy(accountInvitations.createdAt);

    const projectsByInvite = await invitedProjects(rows.map(({ invite }) => invite));

    const inviters = new Map<string, string | null>();
    for (const { invite } of rows) {
      if (invite.invitedBy && !inviters.has(invite.invitedBy)) {
        inviters.set(invite.invitedBy, await lookupAuthEmail(invite.invitedBy));
      }
    }

    return c.json({
      invites: rows.map(({ invite, accountName }) => ({
        invite_id: invite.inviteId,
        account_id: invite.accountId,
        account_name: accountName ?? null,
        initial_role: invite.initialRole,
        inviter_email: invite.invitedBy ? (inviters.get(invite.invitedBy) ?? null) : null,
        created_at: invite.createdAt.toISOString(),
        expires_at: invite.expiresAt.toISOString(),
        projects: projectsByInvite.get(invite.inviteId) ?? [],
      })),
    });
  },
);

// GET /v1/account-invites/:inviteId — describe an invite. Redacts identifying
// fields when the caller's email doesn't match the invite, so the URL alone
// can't be used to enumerate accounts.
accountInvitesRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{inviteId}',
    tags: ['accounts'],
    summary: 'Describe an invite (redacted unless caller email matches)',
    ...auth,
    request: { params: InviteIdParam },
    responses: {
      200: json(InviteDescribeSchema, 'Invite description'),
      ...errors(401, 404),
    },
  }),
  async (c: any) => {
  const inviteId = c.req.param('inviteId');
  // Not a uuid: no invite has it, and Postgres would reject the cast (500).
  if (!isUuid(inviteId)) return c.json({ error: 'Invite not found' }, 404);

  const [invite] = await db
    .select()
    .from(accountInvitations)
    .where(eq(accountInvitations.inviteId, inviteId))
    .limit(1);

  if (!invite) return c.json({ error: 'Invite not found' }, 404);
  const caller = await callerInviteEmail(c, invite.accountId);

  const expired = isExpired(invite);
  const emailMatchesCaller = addressedToCaller(caller, invite);

  if (!emailMatchesCaller) {
    const reason = inviteRefusal(c, caller, invite).code;
    // The account's own IdP vouches for this address (callerInviteEmail), so
    // signing in through it is the way in. Its email domain may be any, so the
    // sign-in page cannot find it from the address.
    const ssoProvider = reason === 'email_unconfirmed' ? await getSsoProvider(invite.accountId) : null;
    return c.json({
      reason,
      sso_provider_id: ssoProvider?.supabaseSsoProviderId ?? null,
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
      projects: [],
    });
  }

  const [accountRow] = await db
    .select({ name: accountsView.name })
    .from(accountsView)
    .where(eq(accountsView.accountId, invite.accountId))
    .limit(1);

  const inviterEmail = await lookupAuthEmail(invite.invitedBy);
  const projectsByInvite = await invitedProjects([invite]);

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
    projects: projectsByInvite.get(invite.inviteId) ?? [],
  });
  },
);

// POST /v1/account-invites/:inviteId/accept — accept an invite. Validates email
// matches caller, invite isn't expired/accepted, then atomically inserts the
// member row + stamps accepted_at.
accountInvitesRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{inviteId}/accept',
    tags: ['accounts'],
    summary: 'Accept an invite',
    ...auth,
    request: { params: InviteIdParam },
    responses: {
      200: json(InviteAcceptSchema, 'Invite accepted'),
      403: json(ErrorSchema, 'Forbidden'),
      410: json(ErrorSchema, 'Invite expired'),
      409: json(ErrorSchema, 'Invite no longer open'),
      ...errors(401, 404, 429),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const inviteId = c.req.param('inviteId');
  // Not a uuid: no invite has it, and Postgres would reject the cast (500).
  if (!isUuid(inviteId)) return c.json({ error: 'Invite not found' }, 404);

  const [invite] = await db
    .select()
    .from(accountInvitations)
    .where(eq(accountInvitations.inviteId, inviteId))
    .limit(1);

  if (!invite) return c.json({ error: 'Invite not found' }, 404);
  const caller = await callerInviteEmail(c, invite.accountId);

  if (!addressedToCaller(caller, invite)) return refuseInvite(c, caller, invite);

  const alreadyAccepted = !!invite.acceptedAt;
  if (alreadyAccepted && invite.acceptedByUserId && invite.acceptedByUserId !== userId) {
    return c.json({ error: 'Invite has already been accepted by another account.' }, 409);
  }

  // A fresh accept is refused on expiry. Re-entry of an accepted invite
  // changes nothing (below), so it answers the same whatever the date.
  if (!alreadyAccepted && isExpired(invite)) {
    return c.json({ error: 'This invite has expired. Ask the owner to send a new one.' }, 410);
  }

  const existingMembership = await getMembership(userId, invite.accountId);
  // After removal or leave an accepted invite must not re-create the
  // membership: the owner sends a new invite.
  if (alreadyAccepted && !existingMembership) {
    return c.json({ error: 'This invite was already used. Ask the owner to send a new one.' }, 410);
  }
  // Re-entry of an accepted invite applies nothing. Its grants were the
  // inviter's intent at invite time; an admin or the IdP may have removed a
  // project role or a group since, and an old link must not undo that.
  if (alreadyAccepted) {
    return c.json({
      account_id: invite.accountId,
      account_role: invite.initialRole,
      already_accepted: true,
      bootstrap_grants_applied: [],
    });
  }

  // One transaction: the stamp is a compare-and-set on `accepted_at IS NULL`
  // and an unexpired invite, so of two concurrent accepts only one applies the
  // membership and the role, and an invite that expired or was revoked since
  // the read above applies nothing.
  const accepted = await withDbTransaction(async () => {
    const [stamped] = await db
      .update(accountInvitations)
      .set({ acceptedAt: new Date(), acceptedByUserId: userId })
      .where(
        and(
          eq(accountInvitations.inviteId, invite.inviteId),
          isNull(accountInvitations.acceptedAt),
          gt(accountInvitations.expiresAt, new Date()),
        ),
      )
      .returning({ inviteId: accountInvitations.inviteId });
    if (!stamped) return null;
    // THE membership write. Membership is access: the invitee reaches the
    // workspace with no second grant. Members are unlimited and free: there
    // is no seat check. `SYSTEM_ACTOR`: the writer is the INVITEE, who holds
    // no permission here yet — the invitation is the authorization.
    await addWorkspaceMember(invite.accountId, userId, invite.initialRole === 'admin' ? 'admin' : 'member', [], {
      writer: SYSTEM_ACTOR,
      source: 'invite',
      grantedBy: invite.invitedBy,
      expiresAt: inviteMembershipExpiry(invite),
    });
    return true;
  });
  if (!accepted) {
    return c.json({ error: 'This invite is no longer open. Reload it, or ask the owner to send a new one.' }, 409);
  }
  // Only the accept that won the stamp applies the grants. They are
  // best-effort per grant (a project may be gone), so they run after the
  // commit: a failed statement inside the transaction would abort it.
  const appliedGrants = await applyBootstrapGrants(invite, userId);

  // Staged `pending` assignments become this user's own. They are the
  // account's current staging (SCIM, an admin), not a replay of the invite.
  try {
    await convertPendingAssignments(invite.accountId, invite.email, userId);
  } catch (err) {
    console.warn('[accept-invite] converting pending assignments failed', err);
  }

  {
    captureProductEvent({
      userId,
      accountId: invite.accountId,
      event: 'member_joined',
      dedupeKey: invite.inviteId,
      properties: { via: 'invite', role: invite.initialRole },
    });
  }

  return c.json({
    account_id: invite.accountId,
    account_role: invite.initialRole,
    already_accepted: false,
    bootstrap_grants_applied: appliedGrants,
  });
  },
);

// POST /v1/account-invites/:inviteId/decline — decline an invite. Deletes the
// row outright (cleaner than a `declined_at` sentinel — the invite no longer
// exists from the recipient's perspective).
accountInvitesRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{inviteId}/decline',
    tags: ['accounts'],
    summary: 'Decline an invite',
    ...auth,
    request: { params: InviteIdParam },
    responses: {
      200: json(z.object({ ok: z.boolean() }), 'Invite declined'),
      ...errors(401, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const inviteId = c.req.param('inviteId');
  // Not a uuid: no invite has it, and Postgres would reject the cast (500).
  if (!isUuid(inviteId)) return c.json({ error: 'Invite not found' }, 404);

  const [invite] = await db
    .select()
    .from(accountInvitations)
    .where(eq(accountInvitations.inviteId, inviteId))
    .limit(1);

  if (!invite) return c.json({ error: 'Invite not found' }, 404);
  const caller = await callerInviteEmail(c, invite.accountId);

  if (invite.acceptedAt) {
    return c.json({ error: 'Invite has already been accepted' }, 409);
  }

  if (!addressedToCaller(caller, invite)) return refuseInvite(c, caller, invite);

  await db.delete(accountInvitations).where(eq(accountInvitations.inviteId, invite.inviteId));

  return c.json({ ok: true });
  },
);
