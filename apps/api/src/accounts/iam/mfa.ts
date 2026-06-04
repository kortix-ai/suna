// IAM V2 routes: account-wide MFA enforcement.
// When enabled, the IAM engine denies every JWT request whose session is
// not aal2. Super-admins and PATs are exempt. Mirrors the strict-mode
// surface: GET status, GET preview (who would be locked out), PATCH to
// flip — with a lockout guard refusing flips that would orphan the
// account.

import { createRoute, z } from '@hono/zod-openapi';
import { json, errors, auth } from '../../openapi';
import { and, eq, sql } from 'drizzle-orm';
import { accountMembers, accounts } from '@kortix/db';
import { db } from '../../shared/db';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { iamRouter, AccountIdParam } from './app';
import { auditIam, readBody } from './helpers';

iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/mfa-required',
    tags: ['iam'],
    summary: 'Get account MFA-required status',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ enabled: z.boolean() }), 'MFA-required status'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);

  const [row] = await db
    .select({ mfaRequired: accounts.mfaRequired })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!row) return c.json({ error: 'account not found' }, 404);
  return c.json({ enabled: row.mfaRequired });
  },
);

// Preview: members who have no VERIFIED MFA factor enrolled. These users
// would lose access the moment the flag flips — admins should see the
// list before clicking. Super-admins are still flagged (so admins can
// nudge them too) but called out separately so the UI can soften the
// warning (super-admins won't be locked out).
iamRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/iam/mfa-required/preview',
    tags: ['iam'],
    summary: 'Preview who would be locked out by MFA enforcement',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.object({ total_members: z.number(), members_with_mfa: z.number(), losers: z.array(z.object({ user_id: z.string(), account_role: z.string(), is_super_admin: z.boolean() })), will_lock_out_account: z.boolean() }), 'MFA enforcement preview'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);

  // Pull all members and the count of their verified MFA factors in one
  // round-trip. LEFT JOIN so members with zero factors still appear.
  const rows = await db.execute<{
    user_id: string;
    account_role: string;
    is_super_admin: boolean;
    verified_factors: number;
  }>(sql`
    SELECT
      am.user_id::text AS user_id,
      am.account_role::text AS account_role,
      am.is_super_admin,
      COALESCE((
        SELECT COUNT(*)::int FROM auth.mfa_factors mf
        WHERE mf.user_id = am.user_id AND mf.status = 'verified'
      ), 0) AS verified_factors
    FROM kortix.account_members am
    WHERE am.account_id = ${accountId}::uuid
  `);

  // Drizzle's .execute returns { rows: [...] } for raw SQL on pg.
  const dataRows = ((rows as unknown) as { rows: typeof rows }).rows ?? rows;

  const losers: Array<{
    user_id: string;
    account_role: string;
    is_super_admin: boolean;
  }> = [];
  let withMfa = 0;
  let total = 0;
  for (const r of dataRows as Array<{
    user_id: string;
    account_role: string;
    is_super_admin: boolean;
    verified_factors: number;
  }>) {
    total++;
    if (r.verified_factors > 0) {
      withMfa++;
      continue;
    }
    // Super-admins are exempt from enforcement but we still surface them
    // so the admin can prod them to enrol. Marked is_super_admin so the
    // UI can downgrade the warning style.
    losers.push({
      user_id: r.user_id,
      account_role: r.account_role,
      is_super_admin: r.is_super_admin,
    });
  }

  // Safety: at least one non-super-admin must already have MFA, OR there
  // must be a super-admin who'd retain access. Otherwise the flip would
  // orphan the account.
  const willLockOutAccount = !losers.some((l) => l.is_super_admin)
    && withMfa === 0;

  return c.json({
    total_members: total,
    members_with_mfa: withMfa,
    losers,
    will_lock_out_account: willLockOutAccount,
  });
  },
);

iamRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}/iam/mfa-required',
    tags: ['iam'],
    summary: 'Enable or disable account MFA requirement',
    ...auth,
    request: { params: AccountIdParam, body: { content: { 'application/json': { schema: z.object({ enabled: z.boolean() }) } } } },
    responses: {
      200: json(z.object({ enabled: z.boolean(), unchanged: z.boolean().optional() }), 'Updated MFA-required status'),
      ...errors(401, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  // Gate on account.write — same level as renaming the account or
  // flipping strict mode. Avoids inventing a new role action.
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const body = await readBody(c);
  const enabled = body.enabled === true;

  const [before] = await db
    .select({ mfaRequired: accounts.mfaRequired })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!before) return c.json({ error: 'account not found' }, 404);
  if (before.mfaRequired === enabled) {
    return c.json({ enabled, unchanged: true });
  }

  // Two-person rule: turning MFA OFF is dangerous (instantly relaxes
  // the account's security posture), so it's gated by approvals when
  // V1 approval-gate on MFA disable was removed in PR5c with the rest
  // of the approvals workflow. Disable now applies immediately, gated
  // only by the caller's own account.write permission asserted above.

  // Lockout guard on enable: there must be either at least one
  // super-admin (always exempt) OR at least one member with verified
  // MFA — otherwise the flip would orphan the account.
  if (enabled) {
    const [superAdmin] = await db
      .select({ userId: accountMembers.userId })
      .from(accountMembers)
      .where(
        and(
          eq(accountMembers.accountId, accountId),
          eq(accountMembers.isSuperAdmin, true),
        ),
      )
      .limit(1);
    if (!superAdmin) {
      const enrolled = await db.execute<{ user_id: string }>(sql`
        SELECT am.user_id
        FROM kortix.account_members am
        WHERE am.account_id = ${accountId}::uuid
          AND EXISTS (
            SELECT 1 FROM auth.mfa_factors mf
            WHERE mf.user_id = am.user_id AND mf.status = 'verified'
          )
        LIMIT 1
      `);
      const enrolledRows = ((enrolled as unknown) as { rows: typeof enrolled }).rows ?? enrolled;
      if (!enrolledRows || (enrolledRows as unknown as unknown[]).length === 0) {
        return c.json(
          {
            error:
              'Cannot enable MFA requirement: no super-admins and nobody has MFA enrolled. ' +
              'Promote a super-admin or have at least one member enrol MFA first.',
          },
          409,
        );
      }
    }
  }

  await db
    .update(accounts)
    .set({ mfaRequired: enabled, updatedAt: new Date() })
    .where(eq(accounts.accountId, accountId));

  await auditIam(c, {
    accountId,
    action: enabled ? 'iam.mfa_required.enable' : 'iam.mfa_required.disable',
    resourceType: 'account',
    resourceId: accountId,
    before: { mfa_required: before.mfaRequired },
    after: { mfa_required: enabled },
  });

  return c.json({ enabled });
  },
);
