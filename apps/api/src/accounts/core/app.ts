import { z } from '@hono/zod-openapi';
import { accountInvitations, accountMembers, accountMemberships, iamRoles, roleAssignments, type accounts } from '@kortix/db';
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { makeOpenApiApp } from '../../openapi';
import { db } from '../../shared/db';
import {
  isImpersonatingAccount,
  isImpersonationBlockedAccount,
} from '../../shared/impersonation';
import { accountRoleFor, countAccountOwners } from '../../iam/read-models';
import { assignRole, SYSTEM_ACTOR } from '../../iam/assignments';
import { resolveAccountId } from '../../shared/resolve-account';
import { lookupEmailsByUserIds } from './owner-emails';
import type { AppEnv } from '../../types';

// ─── Public router (leaf module — no route imports here to avoid cycles) ─────
export const accountsRouter = makeOpenApiApp<AppEnv>();

export function defaultAccountName(email: string | null | undefined): string {
  const normalized = email?.trim();
  return normalized ? `${normalized}'s Account` : 'Account';
}

// A stored name counts as "proper" only when it isn't one of the placeholder
// values migrations left behind ('Personal', 'User'). Placeholder accounts
// fall back to an email-derived name.
export function properAccountName(name: string | null | undefined): string | null {
  const normalized = name?.trim();
  if (!normalized || normalized === 'Personal' || normalized === 'User') return null;
  return normalized;
}

export function accountDisplayName(
  name: string | null | undefined,
  email: string | null | undefined,
): string {
  return properAccountName(name) ?? defaultAccountName(email);
}

// ─── Shared response/request schemas (power the Scalar docs) ────────────────

/** Organization branding as members SEE it (see ../branding.ts). Absent or
 *  null = default Kortix marks — either nothing is set or the account's plan
 *  no longer carries the `branding` entitlement. */
export const EffectiveBrandingSchema = z
  .object({
    logo_url: z.string().nullable(),
    icon_url: z.string().nullable(),
    favicon_url: z.string().nullable(),
    logo_dark_url: z.string().nullable(),
    icon_dark_url: z.string().nullable(),
    favicon_dark_url: z.string().nullable(),
  })
  .nullable()
  .optional();

export const AccountSummarySchema = z
  .object({
    account_id: z.string(),
    name: z.string(),
    slug: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    account_role: z.string().optional(),
    is_primary_owner: z.boolean().optional(),
    branding: EffectiveBrandingSchema,
  })
  .openapi('AccountSummary');

export const AccountDetailSchema = z
  .object({
    account_id: z.string(),
    name: z.string(),
    member_count: z.number(),
    project_count: z.number(),
    role: z.string(),
    /** Account-wide MFA enforcement flag — drives the members-list MFA badges. */
    mfa_required: z.boolean().optional(),
    branding: EffectiveBrandingSchema,
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('AccountDetail');

export const AccountMemberSchema = z
  .object({
    user_id: z.string(),
    email: z.string().nullable(),
    account_role: z.string(),
    is_super_admin: z.boolean(),
    explicit_project_count: z.number(),
    /** Direct project grants only (mirrors explicit_project_count) — group-
     *  derived and implicit (owner/admin) access aren't enumerated here. */
    projects: z.array(z.object({ project_id: z.string(), name: z.string(), role: z.string() })),
    groups: z.array(z.object({ group_id: z.string(), name: z.string() })),
    active_pat_count: z.number(),
    has_verified_mfa: z.boolean(),
    joined_at: z.string(),
  })
  .openapi('AccountMember');

export const AccountTokenSchema = z
  .object({
    token_id: z.string(),
    name: z.string(),
    project_id: z.string().nullable().optional(),
    public_key: z.string(),
    status: z.string(),
    expires_at: z.string().nullable(),
    last_used_at: z.string().nullable().optional(),
    created_at: z.string(),
    revoked_at: z.string().nullable().optional(),
    secret_key: z.string().optional(),
  })
  .openapi('AccountToken');

export const AccountInviteSchema = z
  .object({
    invite_id: z.string(),
    email: z.string(),
    initial_role: z.string(),
    invited_by: z.string().nullable(),
    created_at: z.string(),
    expires_at: z.string(),
    invite_url: z.string(),
  })
  .openapi('AccountInvite');

export const OkSchema = z.object({ ok: z.boolean() }).openapi('OkResponse');

export const MeSchema = z
  .object({
    user_id: z.string(),
    email: z.string(),
    token_context: z
      .object({
        auth_type: z.string().nullable(),
        project_id: z.string().nullable(),
        session_id: z.string().nullable(),
        agent: z.string().nullable(),
        connectors: z.union([z.literal('all'), z.array(z.string())]).nullable(),
        kortix_cli: z.union([z.literal('all'), z.array(z.string())]).nullable(),
        env: z.union([z.literal('all'), z.array(z.string())]).nullable(),
      })
      .optional(),
    accounts: z.array(
      z.object({
        account_id: z.string(),
        slug: z.string(),
        name: z.string(),
        role: z.string(),
      }),
    ),
  })
  .openapi('AccountMe');

export const AccountIdParam = z.object({ accountId: z.string() });

// ─── Shared helpers ─────────────────────────────────────────────────────────

export type AccountRole = 'owner' | 'admin' | 'member';

export async function readBodyTokens(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) ?? {};
  } catch {
    return {};
  }
}

export async function resolveAccountForUser(
  userId: string,
  override: string | undefined,
): Promise<string> {
  if (override) {
    const [membership] = await db
      .select({ accountId: accountMembers.accountId })
      .from(accountMembers)
      .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, override)))
      .limit(1);
    if (!membership) {
      throw new Error('not a member of the requested account');
    }
    return membership.accountId;
  }
  return resolveAccountId(userId);
}

export async function readBody(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) ?? {};
  } catch {
    return {};
  }
}

export function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeEmail(value: unknown): string | null {
  const raw = normalizeString(value);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (!lower.includes('@')) return null;
  return lower;
}

export function parseRole(value: unknown, allowed: AccountRole[]): AccountRole | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return (allowed as string[]).includes(v) ? (v as AccountRole) : null;
}

export async function getMembership(userId: string, accountId: string) {
  // ACT-AS: an operator with a live grant on this account reads as its owner.
  // Only ever widens the OPERATOR's own id — `impersonatedAccountFor` compares
  // against the grant's admin_user_id, so the several call sites that pass a
  // TARGET user's id (member role changes, invites) keep getting that user's
  // real membership, which is exactly what those routes must decide on.
  if (isImpersonatingAccount(userId, accountId)) {
    return { accountRole: 'owner' as const };
  }
  // Confinement, same as getAccountMembership: one account for the duration.
  if (isImpersonationBlockedAccount(userId, accountId)) return null;
  // Membership IS the account-scope assignment. `account_members` keeps the
  // identity columns (is_super_admin, scim_external_id, joined_at); the ROLE
  // comes from `role_assignments`, which is what the engine reads.
  const accountRole = await accountRoleFor(accountId, userId);
  return accountRole ? { accountRole } : null;
}

export async function countOwners(accountId: string): Promise<number> {
  return countAccountOwners(accountId);
}

// Batched + cached owner-email lookup. Lives in ./owner-emails so it stays a
// leaf module (db + sql only) and can be unit-tested without the account graph.
// Re-exported here because it was part of this module's public surface.
export { clearOwnerEmailCache, ownerEmailCacheSize } from './owner-emails';
export { lookupEmailsByUserIds };

// Display names for a batch of accounts, deriving the fallback for unnamed
// (placeholder-named) accounts from the account OWNER's email — not the
// caller's. Deriving from the caller made every unnamed account a user was
// invited into render as "<caller>'s Account", so shared projects looked like
// they lived in the caller's own personal account.
export async function resolveAccountDisplayNames(
  rows: Array<{ accountId: string; name: string | null }>,
  caller: { userId: string; email: string | null | undefined },
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unnamed: string[] = [];
  for (const row of rows) {
    const proper = properAccountName(row.name);
    if (proper) names.set(row.accountId, proper);
    else unnamed.push(row.accountId);
  }
  if (unnamed.length === 0) return names;

  // Primary owner per unnamed account = the earliest-joined holder of the
  // `owner` role. The ROLE comes from `role_assignments` (the store the engine
  // reads); `account_members.joined_at` is identity and stays where it is.
  const ownerByAccount = new Map<string, string>();
  try {
    const owners = await db
      .select({ accountId: accountMembers.accountId, userId: accountMembers.userId })
      .from(accountMembers)
      .innerJoin(
        roleAssignments,
        and(
          eq(roleAssignments.accountId, accountMembers.accountId),
          eq(roleAssignments.principalType, 'user'),
          eq(roleAssignments.principalId, accountMembers.userId),
          eq(roleAssignments.scopeType, 'account'),
        ),
      )
      .innerJoin(
        iamRoles,
        and(
          eq(iamRoles.roleId, roleAssignments.roleId),
          isNull(iamRoles.accountId),
          eq(iamRoles.key, 'owner'),
        ),
      )
      .where(
        and(
          inArray(accountMembers.accountId, unnamed),
          or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, sql`now()`)),
        ),
      )
      .orderBy(asc(accountMembers.joinedAt));
    for (const o of owners) {
      if (!ownerByAccount.has(o.accountId)) ownerByAccount.set(o.accountId, o.userId);
    }
  } catch {
    // the tables may not exist yet — fall through to caller email below.
  }

  const foreignOwnerIds = [...new Set(ownerByAccount.values())].filter(
    (id) => id !== caller.userId,
  );
  const ownerEmails = await lookupEmailsByUserIds(foreignOwnerIds);

  for (const accountId of unnamed) {
    const ownerId = ownerByAccount.get(accountId);
    const email =
      !ownerId || ownerId === caller.userId
        ? caller.email // ownerless account: caller email beats a bare 'Account'
        : (ownerEmails.get(ownerId) ?? caller.email);
    names.set(accountId, defaultAccountName(email));
  }
  return names;
}

export function serializeAccount(row: typeof accounts.$inferSelect) {
  return {
    account_id: row.accountId,
    name: row.name,
    slug: row.accountId.slice(0, 8),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// Auto-claim any pending *account* invitations matching the caller's email. Each
// invite becomes an account_members row (skipped on duplicate) and its accepted_at
// is stamped so subsequent calls are no-ops. Errors are swallowed — auto-claim is
// best-effort and must never block account listing.
//
// Project invites (the ones carrying bootstrap grants) are deliberately left
// untouched: they must go through the explicit accept/decline dialog so the
// recipient consents AND the project_members grant actually gets applied. See
// the per-invite skip in the loop below.
export async function autoClaimPendingInvites(userId: string, email: string): Promise<void> {
  if (!email) return;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return;

  try {
    const pending = await db
      .select()
      .from(accountInvitations)
      .where(
        and(
          sql`lower(${accountInvitations.email}) = ${normalized}`,
          isNull(accountInvitations.acceptedAt),
          gt(accountInvitations.expiresAt, new Date()),
        ),
      );

    for (const invite of pending) {
      // Project invites carry bootstrap grants and MUST go through the explicit
      // accept flow (POST /account-invites/:id/accept) — that's the only path
      // that applies the project_members grants. Silently auto-claiming one here
      // stamps accepted_at and adds the account membership but never grants
      // project access, so the inviter sees "accepted" while the invitee joins
      // the account, can't see the project, and is never shown the accept/decline
      // dialog. Leave grant-carrying invites pending for the recipient to act on.
      if ((invite.bootstrapGrants ?? []).length > 0) continue;
      try {
        // IDENTITY, then the ROLE. `accountMemberships` is the table;
        // `accountMembers` is a view over it plus role_assignments, and a
        // TARGETED `ON CONFLICT` cannot run against a view (no index to infer).
        await db
          .insert(accountMemberships)
          .values({ userId, accountId: invite.accountId })
          .onConflictDoNothing({
            target: [accountMemberships.userId, accountMemberships.accountId],
          });
        await assignRole(SYSTEM_ACTOR, invite.accountId, {
          principal: { type: 'user', id: userId },
          roleKey: invite.initialRole,
          scope: { type: 'account' },
          source: 'invite',
          exclusive: true,
        });
        await db
          .update(accountInvitations)
          .set({ acceptedAt: new Date() })
          .where(eq(accountInvitations.inviteId, invite.inviteId));
      } catch {
        // Skip individual invite failures; keep processing the rest.
      }
    }
  } catch {
    // Table may not exist yet — fall through.
  }
}
