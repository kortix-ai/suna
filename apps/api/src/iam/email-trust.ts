/**
 * When is an Auth user's email proof that the user owns that address?
 *
 * Supabase Auth marks every email a SAML IdP asserts as verified, and it does
 * not compare the address with the IdP's domains. The IdP is configured by an
 * account admin, so the asserted email is only as trustworthy as the admin's
 * claim on the domain. The rule, used by every email-keyed identity decision
 * (invite list/accept/decline, add-member-by-email, SAML JIT identity merge):
 *
 *   - A non-SSO identity (password, email code, social) keeps its email: Auth
 *     confirmed it by mail or through the social provider.
 *   - An SSO identity's email is trusted only when the IdP's account proved
 *     control of that email's domain (`account_sso_providers.domain_verified_at`
 *     set, and the email's domain equal to the provider's `primary_domain`).
 *
 * An untrusted SSO email still identifies the user inside the IdP's own account
 * (JIT membership, group sync); it only stops matching anything outside it.
 */
import { sql, type SQL } from 'drizzle-orm';
import { nonSsoIdentitySql, ssoProviderIdOf } from '../shared/auth-identity';
import { db } from '../shared/db';
import { isUuid } from '../shared/validate';

/**
 * SQL predicate over an `auth.users` row: its email is proof of ownership.
 *
 * `ownAccountId`, when given, also trusts an identity from that account's own
 * IdP: inside one account the IdP and the admin are the same authority.
 */
export function emailTrustedSql(user: SQL, ownAccountId?: string): SQL {
  const ssoId = ssoProviderIdOf(user);
  const own = ownAccountId
    ? sql`OR EXISTS (
        SELECT 1 FROM kortix.account_sso_providers own_provider
        WHERE own_provider.account_id = ${ownAccountId}::uuid
          AND own_provider.supabase_sso_provider_id::text = ${ssoId}
      )`
    : sql``;
  return sql`(
    ${nonSsoIdentitySql(user)}
    OR EXISTS (
      SELECT 1 FROM kortix.account_sso_providers vouching_provider
      WHERE vouching_provider.supabase_sso_provider_id::text = ${ssoId}
        AND vouching_provider.domain_verified_at IS NOT NULL
        AND vouching_provider.primary_domain = split_part(lower(trim(${user}.email)), '@', 2)
    )
    ${own}
  )`;
}

/**
 * The caller's email when it is proof of ownership, else ''. Reads the Auth
 * row, not the token: the row is what Supabase issued the token from, and it
 * carries `is_sso_user` for PAT and service callers too.
 */
export async function trustedEmailForUser(userId: string | null | undefined): Promise<string> {
  if (!isUuid(userId)) return '';
  const rows = (await db.execute(sql`
    SELECT lower(trim(u.email)) AS email, ${emailTrustedSql(sql`u`)} AS trusted
    FROM auth.users u
    WHERE u.id = ${userId}::uuid
    LIMIT 1
  `)) as unknown as Array<{ email: string | null; trusted: boolean }>;
  const row = rows[0];
  return row?.trusted && row.email ? row.email : '';
}
