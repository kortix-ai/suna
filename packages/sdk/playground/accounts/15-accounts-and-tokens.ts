/**
 * 15 — accounts + API-key (PAT) lifecycle: validateToken, accounts.list,
 * then a full token create→list→revoke round-trip (cleans up after itself).
 *
 * Run (from packages/sdk):  bun run playground/accounts/15-accounts-and-tokens.ts
 */
import { makeKortix, run } from "../_shared";

run("accounts-and-tokens", async () => {
  const kortix = makeKortix();

  const validation = await kortix.validateToken();
  console.log(`✓ validateToken(): ${JSON.stringify(validation).slice(0, 200)}`);

  const accounts = await kortix.accounts.list();
  console.log(
    `✓ ${accounts.length} account(s): ${accounts.map((a) => a.name ?? a.account_id).join(", ")}`,
  );

  const before = await kortix.accounts.tokens.list();
  console.log(`✓ ${before.length} PAT(s) before`);

  const created = await kortix.accounts.tokens.create({
    name: "sdk-playground-roundtrip",
  });
  if (!created.secret_key?.startsWith("kortix_pat_")) {
    console.error("✗ created token has no kortix_pat_ secret");
    process.exit(1);
  }
  console.log(
    `✓ created PAT ${created.token_id} (secret shown once, starts kortix_pat_…)`,
  );

  const during = await kortix.accounts.tokens.list();
  if (!during.some((t) => t.token_id === created.token_id)) {
    console.error("✗ created token missing from re-list");
    process.exit(1);
  }
  console.log("✓ re-listed — it is there");

  await kortix.accounts.tokens.revoke(created.token_id);
  console.log("✓ revoked — account left as found");
});
