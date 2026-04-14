import { Hono } from 'hono';
import type { AppEnv } from '../../types';
import { buildAccountState, buildMinimalAccountState, buildLocalAccountState } from '../services/account-state';
import { hasDatabase } from '../../shared/db';
import { config } from '../../config';
import { resolveAccountId } from '../../shared/resolve-account';

export const accountStateRouter = new Hono<AppEnv>();

accountStateRouter.get('/', async (c) => {
  if (!hasDatabase) {
    return c.json(buildLocalAccountState());
  }
  const accountId = await resolveAccountId(c.get('userId'));
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
  const accountId = await resolveAccountId(c.get('userId'));
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
