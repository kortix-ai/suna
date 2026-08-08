/**
 * Enterprise-demo unlock helper.
 *
 * `PUT /v1/accounts/:accountId/iam/enterprise-demo` is PLATFORM-ADMIN-ONLY
 * (apps/api/src/accounts/iam/enterprise-demo.ts): enabling the demo is an
 * operator decision made from the admin console, so the account OWNER — even
 * with `account.write` — now gets 403 `{code:'admin_required'}`. Flows that
 * need a fresh fixture account entitled for the rbac/sso/scim surface must go
 * through the run-scoped platform admin (`env.adminToken`, provisioned in
 * fixtures/world.ts).
 */
import type { Client } from '../core/client';
import type { FlowContext } from '../core/types';

export const ADMIN_TOKEN_LABEL = 'ADMIN_TOKEN';

export const NO_ADMIN_TOKEN_HINT =
  'PUT /v1/accounts/:accountId/iam/enterprise-demo is platform-admin-only; the account OWNER gets 403 admin_required. ' +
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
 * Entitle a fixture account for the Enterprise surface, as the platform admin.
 * Asserts the 200 `{enabled:true}` contract so a silent failure can never leave
 * the caller asserting entitlement-gated routes against a still-locked account.
 */
export async function enableEnterpriseDemo(ctx: FlowContext, accountId: string): Promise<void> {
  const r = await asPlatformAdmin(ctx).put(
    '/v1/accounts/:accountId/iam/enterprise-demo',
    { enabled: true },
    { params: { accountId } },
  );
  r.status(200).body().has('$.enabled', true);
}
