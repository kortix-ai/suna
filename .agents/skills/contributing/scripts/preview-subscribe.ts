#!/usr/bin/env bun
/**
 * Subscribe a preview-signed-in synthetic account to a real Stripe test-mode
 * plan, so it is entitled to Kortix-managed models before a demo is recorded.
 *
 * A fresh preview account is free tier. `accountIsFreeTierForModels`
 * (apps/api/src/billing/services/tiers.ts) denies managed models to any tier
 * that isn't paid — enforced everywhere on purpose since commit 406eb5e9ac
 * "fix(gateway): enforce paid managed model access", which deliberately
 * removed the earlier `env === 'dev' || env === 'preview'` bypass. Preview
 * keeps billing ON precisely so the subscribe -> entitlement -> managed-models
 * path is exercised, not skipped (tests/src/core/preview-stack.ts). The
 * sanctioned way for a demo account to reach real model output is the same
 * front door a real customer uses: Stripe test-mode subscribe
 * (preview-environments.md -> "Sign in": "subscribe with a Stripe test card").
 *
 * This script automates exactly that path — the same one GW-MANAGED-1
 * (tests/src/flows/llm-gateway.flow.ts) already drives against every preview —
 * so a PR demo does not need a human to click through Stripe Checkout by hand.
 * It does not touch the billing-enforcement code, an admin override, or any
 * account-creation default: it is tooling that calls the real subscribe route
 * for one account, the same way tests/src/fixtures/billing.ts's `subscribe()`
 * already does.
 *
 *   preview-subscribe.ts <origin> <access_token> <account_id> [tier_key]
 *
 * `access_token` is the signed-in account's Supabase JWT. Its personal
 * account id equals its user id (apps/api/src/accounts/core/
 * bootstrap-personal-account.ts: "Personal accounts use `accountId ===
 * userId`"). preview-subscribe.sh extracts both from the agent-browser
 * session's auth cookie and calls this.
 *
 * Reads STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET from the environment — the
 * same test-mode Stripe secret already used to test every preview
 * (KE2E_STRIPE_SECRET_KEY / KE2E_STRIPE_WEBHOOK_SECRET on the preview runtime
 * allowlist). No new secret; preview-subscribe.sh sources them from the
 * repo's own dotenvx-encrypted apps/api/.env.staging.
 */
import { Client } from '../../../../tests/src/core/client';
import { subscribe } from '../../../../tests/src/fixtures/billing';
import type { Env } from '../../../../tests/src/core/env';

async function main(): Promise<void> {
  const [origin, accessToken, accountId, tierKeyArg] = process.argv.slice(2);
  if (!origin || !accessToken || !accountId) {
    console.error(
      'usage: preview-subscribe.ts <origin> <access_token> <account_id> [tier_key]',
    );
    process.exit(1);
  }
  const tierKey = tierKeyArg || 'pro';

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
  const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!stripeSecretKey) {
    console.error('STRIPE_SECRET_KEY is required (see preview-subscribe.sh)');
    process.exit(1);
  }
  if (!stripeWebhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET is required (see preview-subscribe.sh)');
    process.exit(1);
  }

  const apiUrl = `${origin.replace(/\/+$/, '')}/v1`;
  // Only the three fields `subscribe()` reads (apiUrl, stripeSecretKey,
  // stripeWebhookSecret) are populated — this script never runs a flow, so
  // the rest of `Env` (Supabase creds, capability flags, …) has no caller.
  const env = { apiUrl, stripeSecretKey, stripeWebhookSecret } as Env;
  const client = new Client(apiUrl).withBearer(accessToken, 'preview-demo');

  await subscribe(env, client, accountId, tierKey);
  console.log(`subscribed ${accountId} to ${tierKey} on ${origin} — managed models are live`);
}

main().catch((err) => {
  console.error(`preview-subscribe failed: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
