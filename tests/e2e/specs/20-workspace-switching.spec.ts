import { type Locator, type Page, expect, test } from "@playwright/test";

import { loadEnv } from "../../src/core/env";
import {
  createDatabaseProject,
  deleteDatabaseProject,
} from "../../src/fixtures/database-project";
import { queryDatabaseRows, runDatabaseSql } from "../helpers/database";
import { createApiJsonClient } from "../helpers/http";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import {
  dismissOnboarding,
  selectAccountForUi,
  settingsPanel,
} from "../helpers/ui";

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

/** The sidebar's one control — trigger, then the "Switch Project" submenu.
 *  Every name here is `exact`: the trigger's menu is "Switch project" and the
 *  submenu it opens is "Switch Project", which differ only in case, and
 *  Playwright's accessible-name match is case-insensitive without it.
 *
 *  The noun was "Workspace" until the product settled on ONE word for a unit
 *  of work — project, the one the URL, API, CLI, manifest and DB already use
 *  (`features/workspace/workspace-vocabulary.test.ts`). */
async function openWorkspacePicker(page: Page): Promise<Locator> {
  const trigger = page
    .locator('[data-slot="sidebar"]')
    .getByRole("button", { name: "Switch project", exact: true });
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  await trigger.click();
  await page
    .getByRole("menuitem", { name: "Switch Project", exact: true })
    .click();
  const picker = page.getByRole("menu").filter({
    has: page.getByRole("menuitem", { name: "Account settings" }),
  });
  await expect(picker).toBeVisible();
  return picker;
}

/** Every project row: the picker's menu items minus the create rows and the
 *  "Account settings" row above the list — both are actions/navigation, not a
 *  destination project (`workspace-menu-section.tsx`'s standalone "Account
 *  settings" `DropdownMenuItem`, new since this test was written; it lives in
 *  the same "Switch Project" menu).
 *
 *  `hasNotText: "Create a"` is a PREFIX match and is load-bearing for more
 *  than it was written for: besides the global "Create a project…" row, the
 *  menu now carries one "Create a project in <account>" row per account group
 *  (the only affordance that says WHICH account a new project lands in). Both
 *  start with "Create a", so both stay out of the row count. */
function workspaceRows(picker: Locator): Locator {
  return picker
    .getByRole("menuitem")
    .filter({ hasNotText: "Create a" })
    .filter({ hasNotText: "Account settings" });
}

/** The palette's account switch: Search → Accounts → the account's row
 *  (`handleSelectAccount` in `features/workspace/command-palette.tsx`). */
async function switchAccountInPalette(page: Page, name: string): Promise<void> {
  await dismissOnboarding(page);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const palette = page.getByRole("dialog").filter({ has: page.locator("[cmdk-item]") });
  await expect(palette).toBeVisible();
  await palette.getByRole("option", { name: "Accounts", exact: true }).click();
  await palette.locator("[cmdk-item]", { hasText: name }).click();
}

/** The account every account-scoped surface reads (`kortix.currentAccount`). */
function selectedAccount(page: Page): () => Promise<string | null> {
  return () =>
    page.evaluate(() => {
      const saved = localStorage.getItem("kortix.currentAccount");
      return saved ? JSON.parse(saved).state.selectedAccountId : null;
    });
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
      await page.evaluate(() => localStorage.removeItem("kortix.currentAccount"));
      await page.goto(`/projects/${first.id}`, {
        waitUntil: "domcontentloaded",
      });
      await dismissOnboarding(page);
      await test.step("the live switcher seeds an unselected account", async () => {
        await expect.poll(() => page.evaluate(() => {
          const saved = localStorage.getItem("kortix.currentAccount");
          return saved ? JSON.parse(saved).state.selectedAccountId : null;
        })).toBe(account.account_id);
      });

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

      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await test.step("the live menu opens Profile without leaving the project", async () => {
        await page.locator('[data-slot="sidebar"]')
          .getByRole("button", { name: "Switch project", exact: true }).click();
        await page.getByRole("menuitem", { name: /^Settings/ }).click();
        const panel = settingsPanel(page);
        await expect(panel).toBeVisible();
        await expect(panel.getByRole("tab", { name: "Profile", exact: true }))
          .toHaveAttribute("aria-selected", "true");
        await expect(panel.getByRole("tabpanel")).toContainText(email);
        await expect(page).toHaveURL(new RegExp(`/projects/${first.id}`));
        await panel.getByRole("button", { name: "Back to app" }).click();
      });
      await test.step("account branding changes the document and restores on removal", async () => {
        const accountRoute = "**/v1/accounts";
        await page.route(accountRoute, async (route) => {
          const response = await route.fetch();
          const rows = await response.json();
          await route.fulfill({ response, json: rows.map((row: AccountSummary) => ({
            ...row,
            branding: row.account_id === account.account_id
              ? { app_name: "Synthetic Brand", favicon_url: "/favicon.png?brand=synthetic" } : null,
          })) });
        });
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page).toHaveTitle(/Synthetic Brand/);
        await expect(page.locator('link[rel="icon"]').first())
          .toHaveAttribute("href", "/favicon.png?brand=synthetic");
        await page.goto(`/projects/${second.id}`, { waitUntil: "domcontentloaded" });
        await expect(page).toHaveTitle(/Synthetic Brand/);
        await page.unroute(accountRoute);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page).toHaveTitle(/Kortix/);
        await expect(page).not.toHaveTitle(/Synthetic Brand/);
        await expect(page.locator('link[rel="icon"]').first())
          .not.toHaveAttribute("href", "/favicon.png?brand=synthetic");
      });
      await test.step("the live menu cancels then confirms sign-out", async () => {
        await dismissOnboarding(page);
        const trigger = page.locator('[data-slot="sidebar"]')
          .getByRole("button", { name: "Switch project", exact: true });
        await trigger.click();
        await page.getByRole("menuitem", { name: "Log out", exact: true }).click();
        const confirm = page.getByRole("alertdialog");
        await expect(confirm).toBeVisible();
        await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(confirm).not.toBeVisible();
        await trigger.click();
        await page.getByRole("menuitem", { name: "Log out", exact: true }).click();
        await confirm.getByRole("button", { name: "Log out", exact: true }).click();
        await expect(page).toHaveURL(/\/auth(?:[/?]|$)/, { timeout: 60_000 });
        await page.goto(`/projects/${first.id}`, { waitUntil: "domcontentloaded" });
        await expect(page).toHaveURL(/\/auth(?:[/?]|$)/);
      });
      expect(pageErrors).toEqual([]);
    } finally {
      for (const projectId of projectIds) {
        await deleteDatabaseProject(env, projectId).catch(() => {});
      }
      await deleteAuthUser(user.id, authOptions).catch(() => {});
    }
  });

  // KRTX-1731: an account switch from the command palette went to the plain
  // landing door, which reopened the project this browser remembered — in the
  // account just left — and set the selected account back to it. The palette
  // now asks the door for the picked account (`/projects/start?account=<id>`).
  test("a command-palette account switch lands in that account's project", async ({
    page,
  }) => {
    test.skip(!databaseUrl, "KE2E_DATABASE_URL is required");
    test.setTimeout(240_000);

    const runId = Date.now().toString(36);
    const email = `e2e-palette-account-switch-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    const env = loadEnv();
    const projectIds: string[] = [];
    const accountIds: string[] = [];
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    try {
      // The personal account comes first; the two named accounts give the
      // palette rows known labels (the personal one is named after the email).
      await api<AccountSummary[]>(session.access_token, "GET", "/accounts");
      const north = await api<{ account_id: string }>(
        session.access_token,
        "POST",
        "/accounts",
        { name: `Palette North ${runId}` },
        201,
      );
      accountIds.push(north.account_id);
      const south = await api<{ account_id: string }>(
        session.access_token,
        "POST",
        "/accounts",
        { name: `Palette South ${runId}` },
        201,
      );
      accountIds.push(south.account_id);

      const northHome = await createDatabaseProject(env, {
        accountId: north.account_id,
        userId: user.id,
        name: `North Home ${runId}`,
      });
      projectIds.push(northHome.id);
      const southOnly = await createDatabaseProject(env, {
        accountId: south.account_id,
        userId: user.id,
        name: `South Only ${runId}`,
      });
      projectIds.push(southOnly.id);

      await installBrowserSessionDirect(
        page,
        session,
        `/projects/${northHome.id}`,
        authOptions,
      );
      await selectAccountForUi(page, north.account_id);
      await page.goto(`/projects/${northHome.id}`, {
        waitUntil: "domcontentloaded",
      });
      await dismissOnboarding(page);
      // The project shell remembers the project it opened (the last-project cookie).
      await expect
        .poll(() => page.evaluate(() => document.cookie), { timeout: 60_000 })
        .toContain(northHome.id);

      await test.step("switching to an account opens its project, not the remembered one", async () => {
        await switchAccountInPalette(page, `Palette South ${runId}`);
        await expect(page).toHaveURL(new RegExp(`/projects/${southOnly.id}(\\?|$)`), {
          timeout: 60_000,
        });
        await expect.poll(selectedAccount(page)).toBe(south.account_id);
      });

      await test.step("switching back opens the first account's project", async () => {
        await switchAccountInPalette(page, `Palette North ${runId}`);
        await expect(page).toHaveURL(new RegExp(`/projects/${northHome.id}(\\?|$)`), {
          timeout: 60_000,
        });
        await expect.poll(selectedAccount(page)).toBe(north.account_id);
      });

      await test.step("an account with several projects shows the selector, on that account", async () => {
        const southTwo = await createDatabaseProject(env, {
          accountId: south.account_id,
          userId: user.id,
          name: `South Two ${runId}`,
        });
        projectIds.push(southTwo.id);
        // The door decides from the project lists the app holds (zero network
        // on the first frame), so the person has seen South's second project:
        // the selector lists it, then they go back to North Home.
        await page.goto("/projects", { waitUntil: "domcontentloaded" });
        await expect(page.getByText(`South Two ${runId}`).first()).toBeVisible({ timeout: 60_000 });
        await page.goto(`/projects/${northHome.id}`, { waitUntil: "domcontentloaded" });
        await expect
          .poll(() => page.evaluate(() => document.cookie), { timeout: 60_000 })
          .toContain(northHome.id);
        await switchAccountInPalette(page, `Palette South ${runId}`);
        // The door drops its own `account=` input on the way out.
        await expect(page).toHaveURL(/\/projects(\?|$)/, { timeout: 60_000 });
        await expect.poll(selectedAccount(page)).toBe(south.account_id);
      });

      expect(pageErrors).toEqual([]);
    } finally {
      for (const projectId of projectIds) {
        await deleteDatabaseProject(env, projectId).catch(() => {});
      }
      // The personal account too: every account this user belongs to.
      const memberships = await queryDatabaseRows<{ account_id: string }>(
        "select distinct account_id::text from kortix.account_members where user_id = $1::uuid",
        [user.id],
      ).catch(() => []);
      for (const accountId of new Set([...accountIds, ...memberships.map((row) => row.account_id)])) {
        await runDatabaseSql("delete from kortix.accounts where account_id = $1::uuid", [
          accountId,
        ]).catch(() => {});
      }
      await deleteAuthUser(user.id, authOptions).catch(() => {});
    }
  });
});
