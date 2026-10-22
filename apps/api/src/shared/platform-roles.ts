import { platformUserRoles } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { nonSsoIdentitySql } from './auth-identity';
import { db, hasDatabase } from './db';
import { isSelfHostOperatorEmail, selfHostOperatorAllowlist } from './self-host-operator';

export type PlatformRole = 'user' | 'admin' | 'super_admin';

/**
 * Self-host operator allowlist. KORTIX_PLATFORM_ADMIN_EMAILS (comma-separated)
 * grants platform admin to those emails without any DB seeding — the way a
 * self-host operator becomes admin so they can configure server-wide settings
 * (e.g. the managed GitHub App) in-app. Unset on cloud, so it is inert there;
 * cloud continues to grant admin through platform_user_roles rows.
 *
 * Only a password, email-code or social identity matches the allowlist, never
 * a SAML one. Any account admin can register an IdP that asserts any address,
 * and Supabase creates a separate SSO user for it: an allowlist match on that
 * user made a stranger platform admin (KRTX-1715).
 */
async function allowlistedEmailOf(accountId: string): Promise<string | undefined> {
  const rows = (await db.execute(
    sql`SELECT u.email FROM auth.users u WHERE u.id = ${accountId} AND ${nonSsoIdentitySql(sql`u`)} LIMIT 1`,
  )) as unknown as Array<{ email: string | null }>;
  return rows?.[0]?.email?.trim().toLowerCase() || undefined;
}

export async function getPlatformRole(accountId: string): Promise<PlatformRole> {
  if (!hasDatabase) {
    return 'user';
  }

  // Env allowlist wins — a self-host operator listed here is always admin even
  // before any platform_user_roles row exists. Personal account id == auth user
  // id, so the email lives in auth.users under the same id.
  const allowlist = selfHostOperatorAllowlist();
  if (allowlist.length > 0) {
    try {
      const email = await allowlistedEmailOf(accountId);
      if (email && allowlist.includes(email)) {
        return 'admin';
      }
    } catch {
      // Fall through to the role table on any lookup error.
    }
  }

  const [row] = await db
    .select({ role: platformUserRoles.role })
    .from(platformUserRoles)
    .where(eq(platformUserRoles.accountId, accountId))
    .limit(1);

  if (row?.role === 'admin' || row?.role === 'super_admin') {
    return row.role;
  }

  return 'user';
}

export async function isPlatformAdmin(accountId: string): Promise<boolean> {
  const role = await getPlatformRole(accountId);
  return role === 'admin' || role === 'super_admin';
}

/**
 * Is this account the SELF-HOST OPERATOR — the narrow gate the managed-git PAT
 * paths must use instead of `isPlatformAdmin`?
 *
 * See `./self-host-operator` for the full reasoning. In short: `isPlatformAdmin`
 * also admits cloud staff, for whom `MANAGED_GIT_GITHUB_OWNER` is the shared
 * `managed-kortix` org holding every customer's repository.
 *
 * Short-circuits before any query when the allowlist is empty — the cloud case,
 * where this is always false and a DB round-trip would be pure waste.
 */
export async function isSelfHostOperator(accountId: string): Promise<boolean> {
  if (!hasDatabase) return false;
  if (selfHostOperatorAllowlist().length === 0) return false;
  try {
    return isSelfHostOperatorEmail(await allowlistedEmailOf(accountId));
  } catch {
    // Fail CLOSED: an email lookup that errors must not open an
    // operator-only capability.
    return false;
  }
}
