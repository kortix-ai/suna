// Instance branding: what a self-host instance shows before anyone signs in
// (the sign-in page, the browser tab), and what an account with no branding
// of its own falls back to. Served by `GET /v1/access/branding`, no token.
//
// It is the branding of the OLDEST team account that set one in its Branding
// tab. There is no switch: on a self-host instance the company account that
// set a logo is the instance's face.
//
// Gates:
//   - Only an instance with the enterprise license
//     (`ENTERPRISE_LICENSE_AVAILABLE`, a self-host operator's setting) has
//     instance branding. The license is also what grants every account the
//     `branding` entitlement there. The Kortix cloud never sets it, so on the
//     cloud the answer is `null` without a query, and no customer's branding
//     can reach the cloud's sign-in page.
//   - Personal accounts never count (a personal account id is its user id).
//     Every member owns one, and a member must not rebrand the instance.

import { type AccountBrandingRecord, accounts } from '@kortix/db';
import { asc, sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { type AccountBranding, isBrandingEmpty, normalizeBranding } from './branding';

/** The stored branding of the oldest team account that set one, or null. */
export async function loadOldestTeamBranding(): Promise<AccountBrandingRecord | null> {
  const [row] = await db
    .select({ branding: accounts.branding })
    .from(accounts)
    .where(
      sql`${accounts.branding} <> '{}'::jsonb
        AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = ${accounts.accountId})`,
    )
    .orderBy(asc(accounts.createdAt))
    .limit(1);
  return row?.branding ?? null;
}

/**
 * The instance branding, or `null` for default Kortix. `licensed` and `load`
 * are injected so the gate is testable without a database or env.
 */
export async function instanceBranding(
  licensed: boolean = config.ENTERPRISE_LICENSE_AVAILABLE,
  load: () => Promise<AccountBrandingRecord | null> = loadOldestTeamBranding,
): Promise<AccountBranding | null> {
  if (!licensed) return null;
  const branding = normalizeBranding(await load());
  return isBrandingEmpty(branding) ? null : branding;
}
