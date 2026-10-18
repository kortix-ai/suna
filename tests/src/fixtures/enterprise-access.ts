/**
 * Enterprise-access helper.
 *
 * Enterprise features (SSO, SCIM, advanced RBAC, audit) are a feature layer:
 * off, Demo (self-serve) or Licensed (a contract)
 * (.agents/skills/billing/references/plans-and-access.md). A fixture account
 * gets them through the Enterprise demo, switched on by the run-scoped platform
 * admin (`env.adminToken`, provisioned in fixtures/world.ts) so the helper does
 * not depend on which principal owns the account.
 */
import type { Client } from '../core/client';
import type { FlowContext } from '../core/types';

export const ADMIN_TOKEN_LABEL = 'ADMIN_TOKEN';

/** The route a fixture turns Enterprise on through. */
export const ENTERPRISE_DEMO_ROUTE = 'PUT /v1/accounts/:accountId/iam/enterprise-demo';

export const NO_ADMIN_TOKEN_HINT =
  'Turning the Enterprise demo on for a fixture account uses the platform admin. ' +
  'Provide KE2E_ADMIN_TOKEN, or run against a non-prod target with KE2E_SUPABASE_SERVICE_ROLE_KEY + database access ' +
  'so the suite can synthesize its own run-scoped platform admin.';

/** A client bound to the run-scoped platform admin. Throws if none exists. */
export function asPlatformAdmin(ctx: FlowContext): Client {
  if (!ctx.env.adminToken) {
    throw new Error(`no platform-admin token for this run — ${NO_ADMIN_TOKEN_HINT}`);
  }
  return ctx.client.withBearer(ctx.env.adminToken, ADMIN_TOKEN_LABEL);
}

/**
 * Turn the Enterprise demo on for a fixture account. Asserts the 200 contract
 * so a silent failure can never leave the caller asserting entitlement-gated
 * routes against a still-locked account.
 */
export async function enableEnterpriseDemo(ctx: FlowContext, accountId: string): Promise<void> {
  const r = await asPlatformAdmin(ctx).put('/v1/accounts/:accountId/iam/enterprise-demo', { enabled: true }, {
    params: { accountId },
  });
  r.status(200).body().has('$.enabled', true).has('$.state', 'demo');
}
