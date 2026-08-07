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
import { selectAccountForUi } from "../helpers/ui";

const apiBase = process.env.E2E_API_URL || "http://localhost:13738/v1";
const supabaseUrl = process.env.E2E_SUPABASE_URL || "http://localhost:13740";
const databaseUrl =
  process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const password = "E2eAppsUi123!";
const authOptions = { supabaseUrl, password };
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role: string;
}

interface AppResponse {
  app_id: string;
  name: string;
  slug: string;
  url: string;
  desired_state: string;
}

test.describe("18 — Kortix Apps UI", () => {
  test("creates and manages Apps through the SDK-backed page in both themes", async ({
    context,
    page,
  }, testInfo) => {
    test.skip(!databaseUrl, "KE2E_DATABASE_URL is required");
    test.setTimeout(180_000);

    const runId = Date.now().toString(36);
    const email = `e2e-apps-ui-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    const env = loadEnv();
    let projectId: string | null = null;
    const pageErrors: string[] = [];
    const appsServerErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if (
        response.status() >= 500 &&
        response.url().includes("/v1/projects/") &&
        response.url().includes("/apps")
      ) {
        appsServerErrors.push(
          `${response.status()} ${response.request().method()} ${response.url()}`,
        );
      }
    });

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
      expect(account).toBeTruthy();

      const project = await createDatabaseProject(env, {
        accountId: account!.account_id,
        userId: user.id,
        name: `Apps UI ${runId}`,
      });
      projectId = project.id;

      const seeded = await api<AppResponse>(
        session.access_token,
        "POST",
        `/projects/${project.id}/apps`,
        { slug: `seed-${runId}`, name: "Seed App" },
        201,
      );
      expect(seeded.url).toContain(".apps.localhost:");

      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await installBrowserSessionDirect(
        page,
        session,
        "/projects",
        authOptions,
      );
      await selectAccountForUi(page, account!.account_id);

      const listResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          response.url().endsWith(`/v1/projects/${project.id}/apps`),
      );
      await page.goto(`/projects/${project.id}/apps`, {
        waitUntil: "domcontentloaded",
      });
      expect((await listResponse).status()).toBe(200);

      // First-run onboarding mounts after the project route has already loaded.
      await page.waitForTimeout(2_000);
      for (let step = 0; step < 12; step += 1) {
        const onboarding = page.getByRole("dialog").last();
        if (!(await onboarding.isVisible().catch(() => false))) break;
        const skip = onboarding
          .getByRole("button", { name: /^(Skip|Not now|Maybe later)/i })
          .last();
        if (await skip.isVisible().catch(() => false)) {
          await skip.click();
        } else {
          const primary = onboarding
            .getByRole("button", {
              name: /^(Continue|Done|Open project|Start building|Get started)$/i,
            })
            .last();
          if (!(await primary.isVisible().catch(() => false))) break;
          await primary.click();
        }
        await page.waitForTimeout(250);
      }
      await expect(page.getByRole("dialog")).toHaveCount(0);

      await expect(
        page.getByRole("heading", { name: "Apps", exact: true }),
      ).toBeVisible();
      await expect(page.getByText("Seed App", { exact: true })).toBeVisible();
      await expect(
        page.getByText("Deploy from a terminal", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("kortix apps deploy .", { exact: true }),
      ).toBeVisible();

      await page.getByRole("button", { name: "New App" }).click();
      const modal = page.getByRole("dialog", { name: "Create App" });
      await expect(modal).toBeVisible();
      await modal.getByLabel("Name").fill("UI Created App");
      const createdSlug = `ui-${runId}`;
      await modal.getByLabel("Slug").fill(createdSlug);

      const createRequest = page.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          request.url().endsWith(`/v1/projects/${project.id}/apps`),
      );
      const createResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`/v1/projects/${project.id}/apps`),
      );
      await modal.getByRole("button", { name: "Create App" }).click();
      expect((await createRequest).postDataJSON()).toEqual({
        name: "UI Created App",
        slug: createdSlug,
      });
      const createdHttpResponse = await createResponse;
      expect(createdHttpResponse.status()).toBe(201);
      const created = (await createdHttpResponse.json()) as AppResponse;
      await expect(modal).toHaveCount(0);

      const createdRow = page.getByRole("listitem", {
        name: "UI Created App App",
      });
      await expect(createdRow).toBeVisible();
      await expect(
        createdRow.getByText(created.url, { exact: true }),
      ).toBeVisible();
      await expect(
        createdRow.getByRole("button", { name: "Stop App" }),
      ).toBeDisabled();

      const copy = createdRow.getByRole("button", { name: "Copy code" });
      await copy.click();
      await expect(
        createdRow.getByRole("button", { name: "Copied" }),
      ).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(`kortix apps deploy . --app ${created.app_id}`);

      await createdRow.getByRole("button", { name: "Show versions" }).click();
      await expect(createdRow.getByText("No deployments yet.")).toBeVisible();

      await page.evaluate(() => localStorage.setItem("theme", "light"));
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator("html")).toHaveClass(/light/);
      await expect(
        page.getByText("UI Created App", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("apps-light.png"),
        fullPage: true,
      });

      await page.evaluate(() => localStorage.setItem("theme", "dark"));
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator("html")).toHaveClass(/dark/);
      await expect(
        page.getByText("UI Created App", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("apps-dark.png"),
        fullPage: true,
      });

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        page.getByRole("heading", { name: "Apps", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "New App" })).toBeVisible();
      await expect(
        page.getByText("UI Created App", { exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath("apps-narrow-dark.png"),
        fullPage: true,
      });

      expect(pageErrors).toEqual([]);
      expect(appsServerErrors).toEqual([]);
    } finally {
      if (projectId)
        await deleteDatabaseProject(env, projectId).catch(() => {});
      await deleteAuthUser(user.id, authOptions).catch(() => {});
    }
  });
});
