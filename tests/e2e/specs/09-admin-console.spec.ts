import { randomUUID } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";
import { runDatabaseSql } from "../helpers/database";
import { INFRASTRUCTURE_STATUSES, json } from "../helpers/http";
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

/**
 * Load `/admin` until the platform-admin guard actually lets the page through.
 *
 * `admin-shell.tsx:34` gates the whole route on `useAdminRole()`. It renders
 * three different things and only one of them contains a single word this spec
 * asserts:
 *   - resolving        → a bare `<Skeleton>`, no text at all (`:40-46`)
 *   - not an admin     → `<h1>Admin access required</h1>` (`:56-58`)
 *   - admin            → the overview
 * `useAdminRole` is a plain query with no `throwOnError`, so a 503 from the
 * role probe — which is exactly what staging-api was returning during release
 * runs 32240074477 and 32231251280 — resolves to "not an admin" and renders
 * the refusal screen. The old code then failed on
 * `expect(getByText('Admin overview')).toBeVisible()`, which names neither the
 * guard nor the 503.
 *
 * The grant itself can also lag: the spec inserts `platform_user_roles`
 * directly, and the replica serving the probe need not see it on the first
 * read. Both causes clear on a retry, so retry — and when it never clears,
 * fail naming which of the three states was actually on screen.
 */
async function openAdminOverview(page: Page, path: string): Promise<void> {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL((url) => url.pathname === path);
    const overview = page.getByText("Admin overview").first();
    const refused = page.getByRole("heading", {
      name: "Admin access required",
    });
    // Resolve the guard's skeleton into one of its two terminal states first,
    // so a slow probe is a wait and not a failure.
    await expect(overview.or(refused).first()).toBeVisible({ timeout: 60_000 });
    if (await overview.isVisible().catch(() => false)) return;
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
      consoleErrors.push(text);
    }
  });

  // First pass: get the guard to let us in. Any attempt here may have raced a
  // degraded replica, so nothing it recorded is evidence about the product.
  await openAdminOverview(page, path);
  badResponses.length = 0;
  consoleErrors.length = 0;

  // Second pass: this is the load the assertions below judge.
  await openAdminOverview(page, path);

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
        "Projects",
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
