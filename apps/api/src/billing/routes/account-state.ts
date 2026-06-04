import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../../types';
import { buildAccountState, buildMinimalAccountState, buildLocalAccountState } from '../services/account-state';
import { hasDatabase } from '../../shared/db';
import { config } from '../../config';
import { resolveScopedAccountId } from '../../shared/resolve-account';
import { makeOpenApiApp, json, auth } from '../../openapi';

export const accountStateRouter = makeOpenApiApp<AppEnv>();

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
      return c.json(buildLocalAccountState());
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
      return c.json(state);
    } catch (err) {
      // DB schema may not have billing tables (e.g. local dev without kortix schema).
      // Fall back to local account state so the app isn't blocked.
      console.error('[billing] account-state failed, falling back to local:', (err as Error)?.message || err);
      return c.json(buildLocalAccountState());
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
      return c.json(buildLocalAccountState());
    }
    const accountId = await resolveScopedAccountId(c, 'query');
    try {
      const state = await buildMinimalAccountState(accountId);
      if (!config.KORTIX_BILLING_INTERNAL_ENABLED) {
        state.credits.can_run = true;
      }
      return c.json(state);
    } catch (err) {
      console.error('[billing] minimal account-state failed, falling back to local:', (err as Error)?.message || err);
      return c.json(buildLocalAccountState());
    }
  },
);
