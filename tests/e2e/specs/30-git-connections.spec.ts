import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { runDatabaseSql, seedDatabaseProject } from "../helpers/database";
import { createApiJsonClient } from "../helpers/http";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";

const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const supabaseUrl = process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321";
const password = "E2eGitConnections123!";
const api = createApiJsonClient(apiBase);
const authOptions = { supabaseUrl, password };

interface AccountSummary {
  account_id: string;
  personal_account: boolean;
}

/**
 * 30 — Git connections (account Git tab).
 *
 * Two scopes used to share one tab. "GitHub connections" is the account's
 * own: which GitHub owners this Kortix account may create in and import
 * from. "Managed GitHub" is the instance's: the one row that decides how
 * EVERY project on the deployment reaches GitHub. They rendered one above the
 * other, on a page scoped to one account, with nothing saying which was
 * which. On 2026-09-16 a platform admin used the second from a customer
 * account's settings and replaced production's GitHub App; every connection
 * on production broke for about six minutes.
 *
 * This journey pins the separation from the account side:
 *   - the Git tab renders the account's connections and a read-only line about
 *     the instance backend, and nothing that can write the instance row;
 *   - it never calls the platform-admin-only status route;
 *   - "Add account" opens a dialog whose PRIMARY action installs the Kortix
 *     App on a GitHub account or organization, with "link an installation you
 *     already administer" as the secondary path — it used to jump straight
 *     into an OAuth round trip with no label saying which of the two it was.
 * The instance side is pinned by 09 (`/admin/git`).
 */
test.describe("30 — Git connections", () => {
  test.setTimeout(180_000);

  test("the account Git tab owns account connections only and leads with installing the App", async ({
    page,
  }) => {
    const runId = randomUUID().slice(0, 8);
    const ownerEmail = `e2e-git-${runId}@example.test`;
    const owner = await createAuthUser(ownerEmail, authOptions);
    let projectId: string | null = null;
    try {
      const session = await signIn(ownerEmail, authOptions);
      const accounts = await api<AccountSummary[]>(session.access_token, "GET", "/accounts");
      const account = accounts.find((item) => item.personal_account) ?? accounts[0];
      expect(account?.account_id).toBeTruthy();
      projectId = await seedDatabaseProject({
        accountId: account.account_id,
        userId: owner.id,
        name: `Git connections ${runId}`,
      });

      // The tab must never read the platform-admin-only status route; that
      // is what the removed card did, and what 403'd for every non-staff
      // account owner.
      const platformStatusCalls: string[] = [];
      const backendReads: string[] = [];
      page.on("request", (request) => {
        const url = request.url();
        if (url.includes("/v1/platform/github-app/status")) platformStatusCalls.push(url);
        if (url.includes("/v1/projects/git/backend")) backendReads.push(url);
      });

      // The hub has no route of its own: it opens over a real page.
      await installBrowserSessionDirect(
        page,
        session,
        `/projects/${projectId}?accountId=${account.account_id}&accountTab=git`,
        authOptions,
      );

      await expect(page.getByText("GitHub connections", { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      const addAccount = page.getByRole("button", { name: "Add account", exact: true });
      await expect(addAccount).toBeVisible();

      // The read-only instance line, in one of its two configured states.
      await expect(
        page
          .getByText(/Kortix-managed repositories on this instance are created under/)
          .or(page.getByText(/Kortix-managed repositories are not available on this instance/))
          .first(),
      ).toBeVisible();

      // Nothing on this tab can write the instance row.
      await page.waitForLoadState("networkidle").catch(() => undefined);
      const bodyText = await page.locator("body").innerText();
      expect(bodyText).not.toContain("Managed GitHub");
      expect(bodyText).not.toContain("Reconfigure");
      expect(platformStatusCalls).toEqual([]);
      expect(backendReads.length).toBeGreaterThan(0);

      // "Add account" explains itself: install first, link-existing second.
      await addAccount.click();
      const dialog = page.getByRole("dialog", { name: "Add a GitHub account" });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText("Link a GitHub personal account or organization to this Kortix account."),
      ).toBeVisible();
      const install = dialog.getByRole("button", { name: "Install the Kortix App", exact: true });
      await expect(install).toBeVisible();
      // The install action is a real link to github.com/apps/<derived slug>/…
      // when the instance has an App, and says so when it has none — never a
      // 404 on github.com from a slug nobody verified.
      const installEnabled = await install.isEnabled();
      if (!installEnabled) {
        await expect(
          dialog.getByText("This instance has no GitHub App to install."),
        ).toBeVisible();
      }
      await expect(
        dialog.getByRole("button", { name: "Link an installation you already administer" }),
      ).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toBeHidden();

      // `/new` is a git ACCOUNT manager, not a repository menu: the first
      // question is whose account, with "Kortix managed" one option at the
      // end and "Add a GitHub account…" reachable from the same list. A
      // multi-account user arrives scoped to the account they chose
      // (`?account=`), and the page has a way out that is not Log out.
      await page.goto(`/new?account=${account.account_id}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("link", { name: "Back to projects" })).toBeVisible({
        timeout: 60_000,
      });
      // Name the project first. Leaving the name empty and clicking elsewhere
      // blurs the field, the "Name is required" line inserts above the
      // repository controls, and a click that started above the shift lands
      // beside its target.
      await page.getByRole("textbox", { name: "Project name" }).fill(`Git smoke ${runId}`);
      // Two honest states for an account with no connection. With managed git
      // configured (dev, staging, prod): the select, defaulting to "Kortix
      // managed", with "Add a GitHub account…" in the same list. Without it
      // (the local test profile excludes managed GitHub): no select at all —
      // the line saying so, and the add-account button as the only action.
      const gitAccount = page.getByRole("combobox", { name: "Git account" });
      const addGitHubAccount = page.getByRole("button", { name: /Add a GitHub account/ });
      await expect(gitAccount.or(addGitHubAccount).first()).toBeVisible({ timeout: 60_000 });
      if (await gitAccount.isVisible().catch(() => false)) {
        await expect(gitAccount).toHaveText(/Kortix managed/);
        await gitAccount.click();
        const listbox = page.getByRole("listbox");
        await expect(listbox.getByRole("option", { name: /Kortix managed/ })).toBeVisible();
        await expect(
          listbox.getByRole("option", { name: /Add a GitHub account/ }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
      } else {
        await expect(
          page.getByText("Kortix-managed repositories are not available on this instance", {
            exact: false,
          }),
        ).toBeVisible();
        await addGitHubAccount.click();
        await expect(page.getByRole("dialog", { name: "Add a GitHub account" })).toBeVisible();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
      }
      // Nothing under "create" asks for a branch — neither a managed default
      // nor an empty account.
      await expect(page.getByLabel("Default branch")).toHaveCount(0);
    } finally {
      if (projectId) {
        await runDatabaseSql(
          "delete from kortix.projects where project_id = $1::uuid",
          [projectId],
        ).catch(() => undefined);
      }
      await deleteAuthUser(owner.id, authOptions);
    }
  });
});
