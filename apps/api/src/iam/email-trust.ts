/**
 * When is an Auth user's email proof that the user owns that address?
 *
 * Supabase Auth marks every email a SAML IdP asserts as verified, and it does
 * not compare the address with the IdP's domains. The IdP is configured by an
 * account admin, so the asserted email is only as trustworthy as the admin's
 * claim on the domain. The rule, used by every email-keyed identity decision
 * (invite list/accept/decline, invite auto-claim at sign-in,
 * add-member-by-email, SCIM binding, SAML JIT identity merge):
 *
 *   - A non-SSO identity (password, email code, social) keeps its email: Auth
 *     confirmed it by mail or through the social provider.
 *   - Not while Auth auto-confirms sign-ups (`ENABLE_EMAIL_AUTOCONFIRM`, a
 *     self-host with no email provider): then whoever signed up first holds the
 *     address, and only an account that already holds the user as a member
 *     trusts that email, inside that account (KRTX-1715).
 *   - An SSO identity's email is trusted only when the IdP's account proved
 *     control of that email's domain (`account_sso_providers.domain_verified_at`
 *     set, and the email's domain equal to the provider's `primary_domain`).
 *
 * An untrusted SSO email still identifies the user inside the IdP's own account
 * (JIT membership, group sync); it only stops matching anything outside it.
 */
import { sql, type SQL } from 'drizzle-orm';
import { config } from '../config';
import { nonSsoIdentitySql, ssoProviderIdOf } from '../shared/auth-identity';
import { db } from '../shared/db';
import { isUuid } from '../shared/validate';

export interface EmailTrustOptions {
  /**
   * Keep a non-SSO email trusted while Auth auto-confirms sign-ups. Only the
   * invitee routes (accounts/invites.ts) pass it, and only for an invite a
   * person sent: the invitee accepts that one in person (KRTX-1715).
   */
  allowAutoconfirmed?: boolean;
}

/** SQL predicate: the non-SSO identity's email was proven (see the module comment). */
function provenNonSsoSql(user: SQL, ownAccountId: string | undefined, opts: EmailTrustOptions): SQL {
  if (!config.ENABLE_EMAIL_AUTOCONFIRM || opts.allowAutoconfirmed) return nonSsoIdentitySql(user);
  if (!ownAccountId) return sql`false`;
  return sql`(${nonSsoIdentitySql(user)} AND EXISTS (
    SELECT 1 FROM kortix.account_memberships held
    WHERE held.account_id = ${ownAccountId}::uuid AND held.user_id = ${user}.id
  ))`;
}

/**
 * SQL predicate over an `auth.users` row: its email is proof of ownership.
 *
 * `ownAccountId`, when given, also trusts an identity from that account's own
 * IdP: inside one account the IdP and the admin are the same authority.
 */
export function emailTrustedSql(user: SQL, ownAccountId?: string, opts: EmailTrustOptions = {}): SQL {
  const ssoId = ssoProviderIdOf(user);
  const own = ownAccountId
    ? sql`OR EXISTS (
        SELECT 1 FROM kortix.account_sso_providers own_provider
        WHERE own_provider.account_id = ${ownAccountId}::uuid
          AND own_provider.supabase_sso_provider_id::text = ${ssoId}
      )`
    : sql``;
  return sql`(
    ${provenNonSsoSql(user, ownAccountId, opts)}
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
export async function trustedEmailForUser(
  userId: string | null | undefined,
  opts: EmailTrustOptions = {},
): Promise<string> {
  if (!isUuid(userId)) return '';
  const rows = (await db.execute(sql`
    SELECT lower(trim(u.email)) AS email, ${emailTrustedSql(sql`u`, undefined, opts)} AS trusted
    FROM auth.users u
    WHERE u.id = ${userId}::uuid
    LIMIT 1
  `)) as unknown as Array<{ email: string | null; trusted: boolean }>;
  const row = rows[0];
  return row?.trusted && row.email ? row.email : '';
}
