import { expect, test } from "@playwright/test";

import { loadEnv } from "../../src/core/env";
import {
  createDatabaseProject,
  deleteDatabaseProject,
} from "../../src/fixtures/database-project";
import { createApiJsonClient } from "../helpers/http";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import { dismissOnboarding, selectAccountForUi } from "../helpers/ui";

const apiBase = process.env.E2E_API_URL || "http://localhost:13738/v1";
const supabaseUrl = process.env.E2E_SUPABASE_URL || "http://localhost:13740";
const databaseUrl =
  process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const password = "E2eNoRedirectLoop123!";
const authOptions = { supabaseUrl, password };
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role: string;
}

test.describe("25 — A failed target cannot trap the user in a redirect loop", () => {
  // JAY-729 (Marko report, incident 13: "I am softlocked … It keeps auto
  // redirecting me to that project."). The last-project cookie names the
  // project the user last had open; when that target stops being renderable —
  // deleted here — `/`, sign-in, and the settings exit all used to funnel
  // straight back into its failure screen, whose own "Back to projects" link
  // ALSO read the cookie and pointed at the same dead project.
  test("a deleted remembered project renders one terminal screen, forgets itself, and every escape works", async ({
    page,
  }) => {
    test.skip(!databaseUrl, "KE2E_DATABASE_URL is required");
    test.setTimeout(240_000);

    const runId = Date.now().toString(36);
    const email = `e2e-no-redirect-loop-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    const env = loadEnv();
    const projectIds: string[] = [];

    try {
      const accounts = await api<AccountSummary[]>(
        session.access_token,
        "GET",
        "/accounts",
      );
      const account = accounts.find(
        (item) =>
          item.personal_account ||
          item.is_primary_owner ||
          item.account_role === "owner",
      );
      if (!account) throw new Error("the seeded user owns no account");

      const healthy = await createDatabaseProject(env, {
        accountId: account.account_id,
        userId: user.id,
        name: `Loop Healthy ${runId}`,
      });
      const doomed = await createDatabaseProject(env, {
        accountId: account.account_id,
        userId: user.id,
        name: `Loop Doomed ${runId}`,
      });
      projectIds.push(healthy.id, doomed.id);

      // Open the doomed project so the shell records it as the remembered
      // landing target (the `kortix_last_project` cookie).
      await installBrowserSessionDirect(
        page,
        session,
        `/projects/${doomed.id}`,
        authOptions,
      );
      await selectAccountForUi(page, account.account_id);
      await page.goto(`/projects/${doomed.id}`, {
        waitUntil: "domcontentloaded",
      });
      await dismissOnboarding(page);
      await expect
        .poll(async () => {
          const cookie = (await page.context().cookies()).find(
            (item) => item.name === "kortix_last_project",
          );
          return cookie ? decodeURIComponent(cookie.value) : null;
        })
        .toBe(`${user.id}:${doomed.id}`);

      // Delete the target out from under the browser.
      await deleteDatabaseProject(env, doomed.id);

      // `/` redirects to the remembered project — one canonicalization hop.
      // The dead target must render its terminal screen INLINE, not bounce.
      const navigations: string[] = [];
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations.push(frame.url());
      });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(
        page.getByText("This project is gone.", { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(page).toHaveURL(new RegExp(`/projects/${doomed.id}`));

      // Bounded hops: the `/` entry plus its one redirect — never a loop of
      // repeated navigations back into the dead project.
      expect(navigations.length).toBeLessThanOrEqual(3);

      // The terminal screen forgets the dead project as the landing target.
      await expect
        .poll(async () => {
          const cookie = (await page.context().cookies()).find(
            (item) => item.name === "kortix_last_project",
          );
          return cookie?.value || null;
        })
        .toBeNull();

      // The escape link must not point back at the project that is failing.
      // With the cookie cleared it goes through the landing door, which
      // resolves a project the user CAN open.
      await page
        .getByRole("link", { name: "Back to projects", exact: true })
        .first()
        .click();
      await expect(page).toHaveURL(
        new RegExp(`/projects/(start|${healthy.id})`),
        { timeout: 60_000 },
      );
      await expect(page).not.toHaveURL(new RegExp(doomed.id));

      // Account settings stays reachable and does not bounce back.
      await page.goto("/settings", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3_000);
      await expect(page).toHaveURL(/\/settings/);
      await expect(page).not.toHaveURL(new RegExp(doomed.id));

      // Another project stays reachable and does not bounce back.
      await page.goto(`/projects/${healthy.id}`, {
        waitUntil: "domcontentloaded",
      });
      await dismissOnboarding(page);
      await expect(page).toHaveURL(new RegExp(`/projects/${healthy.id}`));

      // And `/` now lands somewhere renderable — never the dead project again.
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page).not.toHaveURL(new RegExp(doomed.id), {
        timeout: 60_000,
      });
    } finally {
      for (const projectId of projectIds) {
        await deleteDatabaseProject(env, projectId).catch(() => undefined);
      }
      await deleteAuthUser(user.id, authOptions).catch(() => undefined);
    }
  });
});
