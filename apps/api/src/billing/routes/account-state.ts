import { Hono } from 'hono';
import type { AppEnv } from '../../types';
import { buildAccountState, buildMinimalAccountState, buildLocalAccountState } from '../services/account-state';
import { hasDatabase } from '../../shared/db';
import { config } from '../../config';
import { resolveScopedAccountId } from '../../shared/resolve-account';
import { maybeMigrateLegacyAccount } from '../services/legacy-account-migration';

export const accountStateRouter = new Hono<AppEnv>();

accountStateRouter.get('/', async (c) => {
  if (!hasDatabase) {
    return c.json(buildLocalAccountState());
  }
  const accountId = await resolveScopedAccountId(c, 'query');

  // Lazy migration: legacy customer → per-seat on first sign-in. Fire-and-
  // forget so we never delay the response on Stripe latency. The next refetch
  // (or any account_state call within ~5s of the migration) will see the new
  // billing_model + the granted credit.
  if (config.KORTIX_BILLING_INTERNAL_ENABLED) {
    void maybeMigrateLegacyAccount(accountId).catch((err) => {
      console.error(`[lazy-migrate] background migration failed for ${accountId}:`, err);
    });
  }

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
});

accountStateRouter.get('/minimal', async (c) => {
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
});
