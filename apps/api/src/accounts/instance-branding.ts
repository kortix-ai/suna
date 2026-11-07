// Instance branding: what a self-host instance shows before anyone signs in
// (the sign-in page, the browser tab), and what an account with no branding
// of its own falls back to. Served by `GET /v1/access/branding`, no token.
//
// It is the branding of the OLDEST account that set one in its Branding tab,
// among the accounts the instance operator controls. There is no switch: on a
// self-host instance the company account that set a logo is the instance's face.
//
// Gates:
//   - Only an instance with the enterprise license
//     (`ENTERPRISE_LICENSE_AVAILABLE`, a self-host operator's setting) has
//     instance branding. The license is also what grants every account the
//     `branding` entitlement there. The Kortix cloud never sets it, so on the
//     cloud the answer is `null` without a query, and no customer's branding
//     can reach the cloud's sign-in page.
//   - Which accounts count: every team account (on a self-host instance only
//     a platform admin creates one, `KORTIX_RESTRICT_ACCOUNT_CREATION`), and
//     the personal account of a self-host operator (`KORTIX_PLATFORM_ADMIN_EMAILS`,
//     a password, email-code or social identity, never SSO: KRTX-1715). An
//     operator often runs the company in their own personal account. Any other
//     personal account never counts: every member owns one, and a member must
//     not rebrand the instance. (A personal account id is its user id.)

import { type AccountBrandingRecord } from '@kortix/db';
import { asc, sql } from 'drizzle-orm';
import { config } from '../config';
import { nonSsoIdentitySql } from '../shared/auth-identity';
import { db } from '../shared/db';
import { qualifiedColumn } from '../shared/sql-qualified-column';
import { selfHostOperatorAllowlist } from '../shared/self-host-operator';
import { type AccountBranding, isBrandingEmpty, normalizeBranding } from './branding';
import { accountsView } from '../workspaces/rows';

/**
 * The stored branding of the oldest account that set one and that the
 * operator controls (a team account, or an operator's personal account), or
 * null. `operatorEmails` is the normalized `KORTIX_PLATFORM_ADMIN_EMAILS`.
 */
export async function loadOldestOperatorBranding(
  operatorEmails: readonly string[] = selfHostOperatorAllowlist(),
): Promise<AccountBrandingRecord | null> {
  const operatorPersonal =
    operatorEmails.length > 0
      ? sql`OR EXISTS (
          SELECT 1 FROM auth.users u
          WHERE u.id = ${qualifiedColumn(accountsView.accountId)}
            AND lower(u.email) IN (${sql.join(
              operatorEmails.map((email) => sql`${email}`),
              sql`, `,
            )})
            AND ${nonSsoIdentitySql(sql`u`)}
        )`
      : sql``;
  const [row] = await db
    .select({ branding: accountsView.branding })
    .from(accountsView)
    .where(
      sql`${qualifiedColumn(accountsView.branding)} <> '{}'::jsonb AND (
        NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = ${qualifiedColumn(accountsView.accountId)})
        ${operatorPersonal}
      )`,
    )
    .orderBy(asc(accountsView.createdAt))
    .limit(1);
  return row?.branding ?? null;
}

/**
 * The instance branding, or `null` for default Kortix. `licensed` and `load`
 * are injected so the gate is testable without a database or env.
 */
export async function instanceBranding(
  licensed: boolean = config.ENTERPRISE_LICENSE_AVAILABLE,
  load: () => Promise<AccountBrandingRecord | null> = loadOldestOperatorBranding,
): Promise<AccountBranding | null> {
  if (!licensed) return null;
  const branding = normalizeBranding(await load());
  return isBrandingEmpty(branding) ? null : branding;
}
