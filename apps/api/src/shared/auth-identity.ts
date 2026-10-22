/**
 * Which kind of identity an `auth.users` row is. Supabase marks every email a
 * SAML IdP asserts as verified and does not compare it with the IdP's domains,
 * and any account admin can register an IdP. So an SSO identity's email proves
 * nothing outside that IdP's account (`iam/email-trust.ts`), and it never
 * matches an operator allowlist (`shared/platform-roles.ts`).
 */
import { sql, type SQL } from 'drizzle-orm';

/**
 * SQL expression: the Supabase `sso_providers` id an Auth user row signed in
 * with, or NULL. Mirrors `extractSsoProviderId` (iam/sso-sync.ts): an explicit
 * `sso_provider_id`/`provider_id`, then `provider = 'sso:<id>'`, then the first
 * `providers[]` entry of that shape.
 */
export function ssoProviderIdOf(user: SQL): SQL {
  return sql`coalesce(
    nullif(${user}.raw_app_meta_data->>'sso_provider_id', ''),
    nullif(${user}.raw_app_meta_data->>'provider_id', ''),
    CASE WHEN ${user}.raw_app_meta_data->>'provider' LIKE 'sso:%'
      THEN nullif(substr(${user}.raw_app_meta_data->>'provider', 5), '') END,
    (SELECT nullif(substr(tag, 5), '')
       FROM jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(${user}.raw_app_meta_data->'providers') = 'array'
           THEN ${user}.raw_app_meta_data->'providers' ELSE '[]'::jsonb END
       ) AS tag
      WHERE tag LIKE 'sso:%'
      LIMIT 1)
  )`;
}

/**
 * SQL predicate over an `auth.users` row: a password, email-code or social
 * identity, not a SAML one.
 */
export function nonSsoIdentitySql(user: SQL): SQL {
  return sql`(NOT coalesce(${user}.is_sso_user, false) AND ${ssoProviderIdOf(user)} IS NULL)`;
}
