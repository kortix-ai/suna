import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AccountStateResponse, AppEnv } from '../../types';
import { buildAccountState, buildMinimalAccountState, buildLocalAccountState } from '../services/account-state';
import { hasDatabase } from '../../shared/db';
import { config } from '../../config';
import { resolveScopedAccountId } from '../../middleware/resolve-account';
import { authorize } from '../../iam/authorize';
import { actorOf } from '../../iam/actor';
import { ACCOUNT_ACTIONS } from '../../iam/actions';
import { makeOpenApiApp, json, auth } from '../../openapi';

export const accountStateRouter = makeOpenApiApp<AppEnv>();

// Per-caller verdicts, computed per request (NOT inside the cached
// buildAccountState) so one caller's verdict is never served to another.
// `can_manage_billing` (billing.write) is a UI hint only — the billing routes
// enforce the same gate server-side (http-require-billing-write.ts) — so it
// defaults to `true` on a probe error. `billing.read` gates the money fields
// below, so it fails closed.
async function billingVerdicts(c: Context<AppEnv>, accountId: string): Promise<{ read: boolean; write: boolean }> {
  try {
    const actor = await actorOf(c, accountId);
    const [read, write] = await Promise.all([
      authorize(actor, ACCOUNT_ACTIONS.BILLING_READ),
      authorize(actor, ACCOUNT_ACTIONS.BILLING_WRITE),
    ]);
    return { read: read.allowed, write: write.allowed };
  } catch {
    return { read: false, write: true };
  }
}

// What a caller without `billing.read` sees: only the fields that gate the
// product (can it run, which plan and entitlements apply). Membership alone
// is not enough to read the subscription, balance, contract or usage: a
// project-bound token, an agent session or a custom role without
// `billing.read` reached them before (pentest 2026-07 finding 1, BOLA).
// An allowlist, so a field added to the state later stays hidden here.
function gatingView(state: AccountStateResponse) {
  return {
    model_access: state.model_access,
    billing_state: state.billing_state,
    has_active_subscription: state.has_active_subscription,
    plan: state.plan && { ...state.plan, monthly_usd: null },
    credits: { can_run: state.credits.can_run },
    subscription: { tier_key: state.subscription.tier_key, tier_display_name: state.subscription.tier_display_name },
    tier: { name: state.tier.name, display_name: state.tier.display_name, entitlements: state.tier.entitlements },
    enterprise_license_available: state.enterprise_license_available,
    enterprise_entitled: state.enterprise_entitled,
    enterprise: state.enterprise,
    grace: state.grace,
  };
}

async function viewFor(c: Context<AppEnv>, accountId: string, state: AccountStateResponse): Promise<Record<string, unknown>> {
  const { read, write } = await billingVerdicts(c, accountId);
  return read ? { ...state, can_manage_billing: write } : { ...gatingView(state), can_manage_billing: false };
}

// Opaque account-state payload (credits, tier, subscription, …). Permissive on
// purpose — the real shape is large and varies by mode (live / minimal / local mock).
const AccountStateSchema = z.record(z.string(), z.any());
const AccountStateQuerySchema = z.object({ account_id: z.string().optional() });

accountStateRouter.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['billing'],
    summary: 'Full account billing state (always available; returns local mock when billing disabled)',
    ...auth,
    request: { query: AccountStateQuerySchema },
    responses: {
      200: json(AccountStateSchema, 'Account billing state'),
    },
  }),
  async (c) => {
    if (!hasDatabase) {
      return c.json({ ...buildLocalAccountState(), can_manage_billing: true });
    }
    const accountId = await resolveScopedAccountId(c, 'query');

    try {
      const state = await buildAccountState(accountId);
      // Billing disabled — return real data but never block the user
      if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
        state.credits.can_run = true;
      }
      return c.json(await viewFor(c, accountId, state), 200);
    } catch (err) {
      // DB schema may not have billing tables (e.g. local dev without kortix schema).
      // Fall back to local account state so the app isn't blocked.
      console.error('[billing] account-state failed, falling back to local:', (err as Error)?.message || err);
      return c.json({ ...buildLocalAccountState(), can_manage_billing: true });
    }
  },
);

accountStateRouter.openapi(
  createRoute({
    method: 'get',
    path: '/minimal',
    tags: ['billing'],
    summary: 'Minimal account billing state (always available; returns local mock when billing disabled)',
    ...auth,
    request: { query: AccountStateQuerySchema },
    responses: {
      200: json(AccountStateSchema, 'Minimal account billing state'),
    },
  }),
  async (c) => {
    if (!hasDatabase) {
      return c.json({ ...buildLocalAccountState(), can_manage_billing: true });
    }
    const accountId = await resolveScopedAccountId(c, 'query');
    try {
      const state = await buildMinimalAccountState(accountId);
      if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
        state.credits.can_run = true;
      }
      return c.json(await viewFor(c, accountId, state), 200);
    } catch (err) {
      console.error('[billing] minimal account-state failed, falling back to local:', (err as Error)?.message || err);
      return c.json({ ...buildLocalAccountState(), can_manage_billing: true });
    }
  },
);
