/**
 * 29 — GitHub App linking: installations and repositories visible to the
 * account. All reads (link/save/delete need a real GitHub App flow).
 *
 * Run (from packages/sdk):  bun run playground/github/29-github.ts
 */
import { ApiError } from "../../src/index";
import { makeKortix, run } from "../_shared";

run("github", async () => {
  const kortix = makeKortix();

  const accounts = await kortix.accounts.list();
  const accountId = accounts[0]?.account_id;
  if (!accountId) {
    console.error("no accounts visible to this token");
    process.exit(1);
  }

  const installations = await kortix.github.listInstallations(accountId);
  console.log(
    `✓ github.listInstallations(): ${JSON.stringify(installations).slice(0, 250)}`,
  );

  try {
    const repositories = await kortix.github.listRepositories(accountId);
    console.log(
      `✓ github.listRepositories(): ${JSON.stringify(repositories).slice(0, 250)}`,
    );
  } catch (error) {
    const status =
      error instanceof ApiError
        ? (error.status ?? Number(error.code))
        : undefined;
    if (status === 409 || status === 404) {
      console.log(
        `✓ github.listRepositories(): ${status} — no GitHub App installation on this account (connect one via the web UI to exercise this)`,
      );
      return;
    }
    throw error;
  }
});
