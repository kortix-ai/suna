/**
 * Enterprise-access helper.
 *
 * Enterprise features (SSO, SCIM, advanced RBAC, audit) come from the
 * Enterprise plan. A fixture account gets them the way an operator gives them
 * to a prospect: an Enterprise trial, granted by a platform admin through
 * `POST /v1/admin/api/accounts/:id/trial` (.agents/skills/billing/references/plans-and-access.md).
 * The account OWNER cannot grant it, so flows go through the run-scoped
 * platform admin (`env.adminToken`, provisioned in fixtures/world.ts).
 */
import type { Client } from '../core/client';
import type { FlowContext } from '../core/types';

export const ADMIN_TOKEN_LABEL = 'ADMIN_TOKEN';

/** The route a fixture grants Enterprise through. */
export const GRANT_TRIAL_ROUTE = 'POST /v1/admin/api/accounts/:id/trial';

export const NO_ADMIN_TOKEN_HINT =
  'Granting an Enterprise trial (POST /v1/admin/api/accounts/:id/trial) is platform-admin-only. ' +
  'Provide KE2E_ADMIN_TOKEN, or run against a non-prod target with KE2E_SUPABASE_SERVICE_ROLE_KEY + database access ' +
  'so the suite can synthesize its own run-scoped platform admin.';

/** A client bound to the run-scoped platform admin. Throws if none exists. */
export function asPlatformAdmin(ctx: FlowContext): Client {
  if (!ctx.env.adminToken) {
    throw new Error(`no platform-admin token for this run — ${NO_ADMIN_TOKEN_HINT}`);
  }
  return ctx.client.withBearer(ctx.env.adminToken, ADMIN_TOKEN_LABEL);
}

/** The trial body every fixture uses: 30 days of Enterprise, no credits. */
export const ENTERPRISE_TRIAL_BODY = { tier_key: 'enterprise', duration_days: 30, credit_grant: 0 } as const;

/**
 * Put a fixture account on an Enterprise trial, as the platform admin.
 * Asserts the 200 contract so a silent failure can never leave the caller
 * asserting entitlement-gated routes against a still-locked account.
 */
export async function grantEnterpriseTrial(ctx: FlowContext, accountId: string): Promise<void> {
  const r = await asPlatformAdmin(ctx).post('/v1/admin/api/accounts/:id/trial', ENTERPRISE_TRIAL_BODY, {
    params: { id: accountId },
  });
  r.status(200).body().has('$.trial.status', 'active').has('$.trial.tier', 'enterprise');
}
