/**
 * 26 — enterprise audit: the account-level audit log and its SIEM webhooks.
 * All reads.
 *
 * Run (from packages/sdk):  bun run playground/audit/26-audit.ts
 */
import { makeKortix, run } from "../_shared";

run("audit", async () => {
  const kortix = makeKortix();

  const accounts = await kortix.accounts.list();
  if (accounts.length === 0) {
    console.error("no accounts visible to this token");
    process.exit(1);
  }
  const accountId = accounts[0]!.account_id;

  try {
    const log = await kortix.accounts.audit.log(accountId);
    console.log(
      `✓ audit.log(${accountId.slice(0, 8)}…): ${JSON.stringify(log).slice(0, 300)}…`,
    );

    const webhooks = await kortix.accounts.audit.webhooks.list(accountId);
    console.log(
      `✓ audit.webhooks.list(): ${JSON.stringify(webhooks).slice(0, 200)}`,
    );
  } catch (error) {
    if ((error as { status?: number }).status === 402) {
      console.log(
        "✓ audit.log(): 402 entitlement_required — Enterprise-plan gate responded correctly",
      );
      console.log(`  (${(error as Error).message})`);
      return;
    }
    throw error;
  }
});
