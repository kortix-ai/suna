import { Context } from 'hono';
import { z } from '@hono/zod-openapi';
import { and, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { makeOpenApiApp } from '../../openapi';
import { accountInvitations, accountMembers, accounts } from '@kortix/db';
import type { AppEnv } from '../../types';
import { db } from '../../shared/db';
import { getSupabase } from '../../shared/supabase';
import { resolveAccountId } from '../../shared/resolve-account';

// ─── Public router (leaf module — no route imports here to avoid cycles) ─────
export const accountsRouter = makeOpenApiApp<AppEnv>();

export function defaultAccountName(email: string | null | undefined): string {
  const normalized = email?.trim();
  return normalized ? `${normalized}'s Account` : 'Account';
}

export function accountDisplayName(
  name: string | null | undefined,
  email: string | null | undefined,
): string {
  const normalized = name?.trim();
  if (!normalized || normalized === 'Personal' || normalized === 'User') {
    return defaultAccountName(email);
  }
  return normalized;
}

// ─── Shared response/request schemas (power the Scalar docs) ────────────────

export const AccountSummarySchema = z
  .object({
    account_id: z.string(),
    name: z.string(),
    slug: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    account_role: z.string().optional(),
    is_primary_owner: z.boolean().optional(),
  })
  .openapi('AccountSummary');

export const AccountDetailSchema = z
  .object({
    account_id: z.string(),
    name: z.string(),
    member_count: z.number(),
    project_count: z.number(),
    role: z.string(),
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
  const [row] = await db
    .select({ accountRole: accountMembers.accountRole })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);
  return row ?? null;
}

export async function countOwners(accountId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.accountRole, 'owner')));
  return Number(row?.n ?? 0);
}

export async function lookupEmailsByUserIds(userIds: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (userIds.length === 0) return result;
  const supabase = getSupabase();
  await Promise.all(
    userIds.map(async (uid) => {
      try {
        const { data } = await supabase.auth.admin.getUserById(uid);
        result.set(uid, data?.user?.email ?? null);
      } catch {
        result.set(uid, null);
      }
    }),
  );
  return result;
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

// Auto-claim any pending invitations matching the caller's email. Each invite
// becomes an account_members row (skipped on duplicate) and its accepted_at is
// stamped so subsequent calls are no-ops. Errors are swallowed — auto-claim is
// best-effort and must never block account listing.
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
      try {
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
