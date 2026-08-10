import { randomUUID } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";
import { runDatabaseSql } from "../helpers/database";
import { json } from "../helpers/http";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";

const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const supabaseUrl = process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321";
const password = process.env.E2E_ADMIN_PASSWORD || "E2eAccountAccess123!";
const authOptions = { supabaseUrl, password, envFiles: ["apps/api/.env"] };

async function assertAdminRouteClean(
  page: Page,
  path: string,
  expectedTexts: string[],
) {
  const badResponses: string[] = [];
  const consoleErrors: string[] = [];

  page.on("response", (response) => {
    if (response.status() >= 400) {
      const url = response.url();
      if (
        url.includes("/_vercel/insights/") ||
        url.includes("/_vercel/speed-insights/")
      ) {
        return;
      }
      badResponses.push(
        `${response.status()} ${response.request().method()} ${response.url()}`,
      );
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = message.text();
      if (
        text.includes(
          "Failed to load resource: the server responded with a status of 404",
        )
      ) {
        return;
      }
      consoleErrors.push(text);
    }
  });

  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL((url) => url.pathname === path);

  for (const text of expectedTexts) {
    await expect(page.getByText(text).first()).toBeVisible();
  }

  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(1000);
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toContain("Not found");
  expect(badResponses).toEqual([]);
  expect(consoleErrors).toEqual([]);
}

test.describe("09 - Admin console", () => {
  test.setTimeout(180_000);

  test("admin opens the current overview with live platform data", async ({
    page,
  }) => {
    await json(await fetch(`${apiBase.replace(/\/v1$/, "")}/health`), 200);
    const configuredAdminEmail = process.env.E2E_ADMIN_EMAIL?.trim();
    const syntheticEmail = `e2e-browser-admin-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
    const adminEmail = configuredAdminEmail || syntheticEmail;
    const synthetic = configuredAdminEmail
      ? null
      : await createAuthUser(adminEmail, authOptions);
    if (synthetic) {
      await runDatabaseSql(`
insert into kortix.platform_user_roles (account_id, role)
values ('${synthetic.id}'::uuid, 'super_admin'::kortix.platform_role)
on conflict (account_id) do update set role = excluded.role;
`);
    }
    try {
      const session = await signIn(adminEmail, authOptions);
      // Let the assertions below own the admin navigations; otherwise the
      // immediate duplicate /admin load can abort Supabase's user fetch.
      await installBrowserSessionDirect(
        page,
        session,
        "/favicon.png",
        authOptions,
      );

      await assertAdminRouteClean(page, "/admin", [
        "Admin overview",
        "Accounts",
        "Workspaces",
        "Sandboxes",
        "Maintenance",
      ]);

    } finally {
      if (synthetic) {
        await runDatabaseSql(
          `delete from kortix.platform_user_roles where account_id = '${synthetic.id}'::uuid;`,
        );
        await deleteAuthUser(synthetic.id, authOptions);
      }
    }
  });
});
