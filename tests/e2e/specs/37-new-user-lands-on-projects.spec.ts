import { expect, test } from "@playwright/test";

import { queryDatabaseRows, runDatabaseSql } from "../helpers/database";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";

const supabaseUrl = process.env.E2E_SUPABASE_URL || "http://localhost:13740";
const databaseUrl =
  process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const password = "E2eNewUserLanding123!";
const authOptions = { supabaseUrl, password };

test.describe("37 — A new user lands on create-or-join", () => {
  // Regression: KRTX-638 put a "Name your account" form in front of the
  // selector and then forwarded every new user to `/new?account=<id>`, the
  // create form. A member who joins to work in a team's project was forced to
  // create one. The landing page is the selector: open a project, join an
  // invite, or choose to create a project. Onboarding belongs to a project.
  // Workspaces (2026-11-05): sign-up creates no account, so a new user has 0
  // workspaces and the selector is "Create a workspace" with the invite hint.
  test("lands on /workspaces with create-or-join, no account, no redirect to /workspaces/new", async ({
    page,
  }) => {
    test.skip(!databaseUrl, "KE2E_DATABASE_URL is required");
    test.setTimeout(180_000);

    const email = `e2e-new-user-landing-${Date.now().toString(36)}@example.test`;
    const user = await createAuthUser(email, authOptions);

    try {
      const session = await signIn(email, authOptions);
      await installBrowserSessionDirect(page, session, "/workspaces/start", authOptions);

      await test.step("The landing door opens the selector on /workspaces", async () => {
        await expect(page).toHaveURL(/\/workspaces(\?|$)/, { timeout: 60_000 });
        await expect(
          page.getByRole("heading", { name: "Create a workspace" }),
        ).toBeVisible({ timeout: 60_000 });
        // The create form is on the page: a suggested name and one submit button.
        await expect(page.getByTestId("selector-create-form")).toBeVisible();
        await expect(page.getByLabel("Workspace name")).not.toHaveValue("");
        await expect(page.getByTestId("selector-create")).toHaveAttribute("type", "submit");
        await expect(page.getByText(`ask an admin to invite ${email}`)).toBeVisible();
        await expect(page.getByLabel("Account name")).toHaveCount(0);
        const members = await queryDatabaseRows<{ n: string }>(
          "select count(*)::text as n from kortix.account_members where user_id = $1::uuid",
          [user.id],
        );
        expect(members[0]?.n).toBe("0");
      });

      await test.step("The selector stays: nothing forwards the user to /workspaces/new", async () => {
        await page.waitForTimeout(3_000);
        await expect(page).toHaveURL(/\/workspaces(\?|$)/);
      });

      await test.step("More options is the user's own way to /workspaces/new", async () => {
        await page.getByTestId("selector-create-more").click();
        await expect(page).toHaveURL(/\/workspaces\/new(\?|$)/, { timeout: 60_000 });
        await expect(page).not.toHaveURL(/account=/);
      });
    } finally {
      const rows = await queryDatabaseRows<{ account_id: string }>(
        "select distinct account_id::text from kortix.account_members where user_id = $1::uuid",
        [user.id],
      ).catch(() => []);
      for (const row of rows) {
        await runDatabaseSql("delete from kortix.accounts where account_id = $1::uuid", [
          row.account_id,
        ]).catch(() => {});
      }
      await deleteAuthUser(user.id, authOptions);
    }
  });
});
