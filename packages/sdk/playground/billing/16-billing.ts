/**
 * 16 — billing read surface: account state (credits/tier/subscription),
 * transactions, credit breakdown, usage history, tier configurations.
 * Reads only — checkout/portal mutations are deliberately not exercised.
 *
 * Run (from packages/sdk):  bun run playground/billing/16-billing.ts
 */
import { makeKortix, run } from "../_shared";

run("billing", async () => {
  const kortix = makeKortix();

  const state = await kortix.billing.accountState();
  console.log(`✓ accountState(): ${JSON.stringify(state).slice(0, 300)}…`);

  const summary = await kortix.billing.transactionsSummary();
  console.log(
    `✓ transactionsSummary(): ${JSON.stringify(summary).slice(0, 200)}`,
  );

  const breakdown = await kortix.billing.creditBreakdown();
  console.log(
    `✓ creditBreakdown(): ${JSON.stringify(breakdown).slice(0, 200)}`,
  );

  const usage = await kortix.billing.usageHistory();
  console.log(`✓ usageHistory(): ${JSON.stringify(usage).slice(0, 200)}`);

  const tiers = await kortix.billing.tierConfigurations();
  console.log(`✓ tierConfigurations(): ${JSON.stringify(tiers).slice(0, 200)}`);
});
