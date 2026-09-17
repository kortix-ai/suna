import { randomUUID } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";
import { runDatabaseSql } from "../helpers/database";
import { INFRASTRUCTURE_STATUSES, createApiJsonClient, json } from "../helpers/http";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";

const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const supabaseUrl = process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321";
const databaseUrl = process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const password = process.env.E2E_ADMIN_PASSWORD || "E2eAccountAccess123!";
const authOptions = { supabaseUrl, password, envFiles: ["apps/api/.env"] };
const api = createApiJsonClient(apiBase);

/**
 * Load `/admin` until the platform-admin guard actually lets the page through.
 *
 * `admin-shell.tsx` gates the whole route on `useAdminRole()`. It renders
 * three different things and only one of them contains the heading this spec
 * asserts:
 *   - resolving        → the route loader, no page text at all
 *   - not an admin     → an `EmptyState` reading "Admin access required"
 *   - admin            → the overview, whose page heading is "Overview"
 * `useAdminRole` is a plain query with no `throwOnError`, so a 503 from the
 * role probe — which is exactly what staging-api was returning during release
 * runs 32240074477 and 32231251280 — resolves to "not an admin" and renders
 * the refusal screen. A sentinel that named neither the guard nor the 503 (the
 * old `getByText('Admin overview')`) failed on the refusal instead of retrying.
 *
 * The grant itself can also lag: the spec inserts `platform_user_roles`
 * directly, and the replica serving the probe need not see it on the first
 * read. Both causes clear on a retry, so retry — and when it never clears,
 * fail naming which of the three states was actually on screen.
 */
async function openAdminOverview(
  page: Page,
  path: string,
  heading = "Overview",
): Promise<void> {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const roleResponse = page.waitForResponse((response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname.endsWith("/v1/user-roles"),
    );
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL((url) => url.pathname === path);
    const response = await roleResponse;
    if (response.ok() && (await response.json()).isAdmin === true) {
      await expect(page.getByRole("heading", { name: heading }).first())
        .toBeVisible({ timeout: 60_000 });
      return;
    }
    if (attempt < attempts) await page.waitForTimeout(5_000);
  }
  throw new Error(
    `/admin still renders "Admin access required" after ${attempts} attempts: the ` +
      `platform-admin probe never saw this user's super_admin grant.`,
  );
}

async function assertAdminRouteClean(
  page: Page,
  path: string,
  expectedTexts: string[],
  heading = "Overview",
) {
  const badResponses: string[] = [];
  const consoleErrors: string[] = [];

  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    const url = response.url();
    if (
      url.includes("/_vercel/insights/") ||
      url.includes("/_vercel/speed-insights/")
    ) {
      return;
    }
    // 502/503/504 on this shared staging origin is the edge or the maintenance
    // gate, not a defect in the admin console. `openAdminOverview` already
    // retries past it; asserting on it here would just re-fail the lane for the
    // environment. A 500 — an unhandled exception in a route — still counts.
    if (INFRASTRUCTURE_STATUSES.has(status)) return;
    badResponses.push(
      `${status} ${response.request().method()} ${response.url()}`,
    );
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
      if (
        text.includes("MIME type ('text/plain')") &&
        (text.includes("/_vercel/insights/script.js") ||
          text.includes("/_vercel/speed-insights/script.js"))
      ) {
        return;
      }
      consoleErrors.push(text);
    }
  });

  // First pass: get the guard to let us in. Any attempt here may have raced a
  // degraded replica, so nothing it recorded is evidence about the product.
  await openAdminOverview(page, path, heading);
  badResponses.length = 0;
  consoleErrors.length = 0;

  // Second pass: this is the load the assertions below judge.
  await openAdminOverview(page, path, heading);

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
    let grantedAccountId: string | null = null;
    try {
      const session = await signIn(adminEmail, authOptions);
      if (synthetic) {
        // /v1/user-roles resolves the authenticated user id, not an account
        // selected from /v1/accounts. Keep the grant key tied to the JWT sub.
        grantedAccountId = synthetic.id;
        await runDatabaseSql(`
insert into kortix.platform_user_roles (account_id, role)
values ('${grantedAccountId}'::uuid, 'super_admin'::kortix.platform_role)
on conflict (account_id) do update set role = excluded.role;
`, [], databaseUrl);
        const role = await api<{ isAdmin: boolean; role: string | null }>(
          session.access_token,
          "GET",
          "/user-roles",
        );
        expect(role).toEqual({ isAdmin: true, role: "super_admin" });
      }
      // Let the assertions below own the admin navigations; otherwise the
      // immediate duplicate /admin load can abort Supabase's user fetch.
      await installBrowserSessionDirect(
        page,
        session,
        "/favicon.png",
        authOptions,
      );

      await assertAdminRouteClean(page, "/admin", [
        "Overview",
        "Accounts",
        "Projects",
        "Sandboxes",
        "Maintenance",
        "Git",
      ]);

      // /admin/git — the instance's ONE managed-git surface. It lived on the
      // account Git tab until 2026-09-16, when a platform admin ran its
      // manifest flow from a customer's settings and replaced production's
      // GitHub App. The card renders here and nowhere else; the page says in
      // words that it decides how every project on the instance reaches
      // GitHub.
      await assertAdminRouteClean(
        page,
        "/admin/git",
        ["Managed GitHub", "One connection for the whole instance"],
        "Git",
      );

    } finally {
      if (grantedAccountId) {
        await runDatabaseSql(
          `delete from kortix.platform_user_roles where account_id = '${grantedAccountId}'::uuid;`,
          [],
          databaseUrl,
        );
      }
      if (synthetic) {
        await deleteAuthUser(synthetic.id, authOptions);
      }
    }
  });
});
