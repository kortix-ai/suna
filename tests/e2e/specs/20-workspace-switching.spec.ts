import { type Locator, type Page, expect, test } from "@playwright/test";

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
const password = "E2eWorkspaceSwitch123!";
const authOptions = { supabaseUrl, password };
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role: string;
}

/** The sidebar's one control — trigger, then the "Switch Workspace" submenu.
 *  Every name here is `exact`: the trigger's menu is "Switch workspace" and the
 *  submenu it opens is "Switch Workspace", which differ only in case, and
 *  Playwright's accessible-name match is case-insensitive without it. */
async function openWorkspacePicker(page: Page): Promise<Locator> {
  const trigger = page
    .locator('[data-slot="sidebar"]')
    .getByRole("button", { name: "Switch workspace", exact: true });
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Switch Workspace", exact: true })
    .click();
  const picker = page.getByRole("menu", {
    name: "Switch Workspace",
    exact: true,
  });
  await expect(picker).toBeVisible();
  return picker;
}

/** Every workspace row: the picker's menu items minus the "Create a workspace…"
 *  row, which is an action, not a destination. */
function workspaceRows(picker: Locator): Locator {
  return picker.getByRole("menuitem").filter({ hasNotText: "Create a" });
}

test.describe("20 — Workspace switching", () => {
  // Regression: `project-switch-store` had no caller for its clear action, so
  // ONE switch left `targetProjectId` set for the life of the tab. The picker
  // read that as a global "switching" flag and painted every non-active row as
  // a disabled spinner — permanently, with no way back. The assertions that
  // matter here are the SECOND switch and the absence of any stuck row state.
  test("switches workspace repeatedly and leaves no row stuck loading", async ({
    page,
  }) => {
    test.skip(!databaseUrl, "KE2E_DATABASE_URL is required");
    test.setTimeout(240_000);

    const runId = Date.now().toString(36);
    const email = `e2e-workspace-switching-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    const env = loadEnv();
    const projectIds: string[] = [];
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

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

      const first = await createDatabaseProject(env, {
        accountId: account.account_id,
        userId: user.id,
        name: `Switch First ${runId}`,
      });
      const second = await createDatabaseProject(env, {
        accountId: account.account_id,
        userId: user.id,
        name: `Switch Second ${runId}`,
      });
      projectIds.push(first.id, second.id);

      await installBrowserSessionDirect(
        page,
        session,
        `/projects/${first.id}`,
        authOptions,
      );
      await selectAccountForUi(page, account.account_id);
      await page.goto(`/projects/${first.id}`, {
        waitUntil: "domcontentloaded",
      });
      await dismissOnboarding(page);

      // First switch: first -> second.
      let picker = await openWorkspacePicker(page);
      await picker
        .getByRole("menuitem", { name: `Switch Second ${runId}` })
        .click();
      await expect(page).toHaveURL(new RegExp(`/projects/${second.id}`));
      await dismissOnboarding(page);

      // The regression, in one assertion pair: re-open the picker and NOTHING
      // is left pending. Before the fix both non-active rows carried
      // `data-disabled` and a spinner here, forever.
      picker = await openWorkspacePicker(page);
      const rows = workspaceRows(picker);
      await expect(rows).toHaveCount(2);
      await expect(picker.locator("[data-disabled]")).toHaveCount(0);
      await expect(picker.locator('svg[class*="animate-spinner"]')).toHaveCount(
        0,
      );

      // Second switch, back to where we started — impossible before the fix,
      // because the row was disabled.
      await picker
        .getByRole("menuitem", { name: `Switch First ${runId}` })
        .click();
      await expect(page).toHaveURL(new RegExp(`/projects/${first.id}`));

      picker = await openWorkspacePicker(page);
      await expect(picker.locator("[data-disabled]")).toHaveCount(0);
      await expect(picker.locator('svg[class*="animate-spinner"]')).toHaveCount(
        0,
      );

      expect(pageErrors).toEqual([]);
    } finally {
      for (const projectId of projectIds) {
        await deleteDatabaseProject(env, projectId).catch(() => {});
      }
      await deleteAuthUser(user.id, authOptions).catch(() => {});
    }
  });
});
