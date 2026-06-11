import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../../types';
import { buildAccountState, buildMinimalAccountState, buildLocalAccountState } from '../services/account-state';
import { hasDatabase } from '../../shared/db';
import { config } from '../../config';
import { resolveScopedAccountId } from '../../shared/resolve-account';
import { authorize } from '../../iam/dispatcher';
import { ACCOUNT_ACTIONS } from '../../iam/actions';
import { makeOpenApiApp, json, auth } from '../../openapi';

export const accountStateRouter = makeOpenApiApp<AppEnv>();

// Whether the CURRENT user may change billing for `accountId` (billing.write —
// owners only by default). Surfaced on account-state so the UI can disable the
// "Subscribe" / "Manage billing" CTAs for members instead of letting them click
// through to a 403. This is a UI hint only — the billing routes enforce the
// same gate server-side (see require-billing-write.ts). Computed per-request
// (NOT inside the cached buildAccountState) so one user's verdict is never
// served to another. Defaults to `true` on a probe error so a transient glitch
// never hides the CTA from a legitimate owner.
async function canManageBilling(c: any, accountId: string): Promise<boolean> {
  try {
    const userId = c.get('userId') as string;
    const { allowed } = await authorize(userId, accountId, ACCOUNT_ACTIONS.BILLING_WRITE);
    return allowed;
  } catch {
    return true;
  }
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

    // NOTE: legacy → per-seat migration is NOT auto-triggered on sign-in anymore.
    // Silently cancelling a customer's subs + creating a seat sub without consent
    // was surprising. It now runs ONLY when the user explicitly clicks "Claim
    // seat-based pricing" (POST /v1/billing/claim-per-seat → maybeMigrateLegacyAccount).

    try {
      const state = await buildAccountState(accountId);
      // Billing disabled — return real data but never block the user
      if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
        state.credits.can_run = true;
      }
      return c.json({ ...state, can_manage_billing: await canManageBilling(c, accountId) });
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
      return c.json({ ...state, can_manage_billing: await canManageBilling(c, accountId) });
    } catch (err) {
      console.error('[billing] minimal account-state failed, falling back to local:', (err as Error)?.message || err);
      return c.json({ ...buildLocalAccountState(), can_manage_billing: true });
    }
  },
);
