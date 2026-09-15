import { expect, test, type Page } from "@playwright/test";

import { loadEnv } from "../../src/core/env";
import {
  createDatabaseProject,
  deleteDatabaseProject,
  setDatabaseEnterpriseDemo,
} from "../../src/fixtures/database-project";
import { resolvePersonalAccountId } from "../helpers/accounts";
import { createApiResultClient } from "../helpers/http";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import { dismissOnboarding, selectAccountForUi } from "../helpers/ui";

const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const supabaseUrl = process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321";
const databaseUrl =
  process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const password = "E2eIdentityWizard123!";
const authOptions = { supabaseUrl, password };
const api = createApiResultClient(apiBase);

/** The hub's prefixed params on the page URL (`account-panel-store.ts`). */
function hubParams(page: Page): URLSearchParams {
  return new URL(page.url()).searchParams;
}

/**
 * A marker on `window` survives pushState/replaceState and dies with a
 * document load. Every move inside the wizard is a move inside the hub modal,
 * so the marker must still be there after each one.
 */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __wizardDoc?: number }).__wizardDoc = 1;
  });
}

async function expectSameDocument(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => (window as unknown as { __wizardDoc?: number }).__wizardDoc,
    ),
    "a wizard move reloaded the document instead of moving inside the hub",
  ).toBe(1);
}

/**
 * React render loops surface as console errors, not page errors. Collect them
 * so a wizard that "works" while re-rendering forever still fails.
 */
function collectRenderLoops(page: Page): string[] {
  const loops: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /Maximum update depth/.test(message.text())) {
      loops.push(message.text());
    }
  });
  return loops;
}

/** Click every rail step in order and assert each one becomes the active step. */
async function visitEveryStep(page: Page): Promise<number> {
  const rail = page.getByRole("navigation", { name: "Setup steps" });
  const steps = rail.getByRole("button");
  const total = await steps.count();
  expect(total).toBeGreaterThan(1);
  for (let index = 0; index < total; index += 1) {
    await steps.nth(index).click();
    await expect(stepCounter(page, index + 1)).toBeVisible();
    await expect(steps.nth(index)).toHaveAttribute("aria-current", "step");
  }
  return total;
}

function stepCounter(page: Page, step: number) {
  return page.getByText(new RegExp(`^Step ${step} of \\d+$`));
}

/**
 * Seed an Enterprise user with one project and open the identity wizard pane
 * of the account hub over that project. Returns the cleanup.
 *
 * The project matters: a user with no project lands on onboarding, which
 * provisions a managed repository the local profile does not have.
 */
async function openIdentityWizard(
  page: Page,
  flow: "sso" | "scim",
): Promise<() => Promise<void>> {
  const runId = Date.now().toString(36);
  const env = loadEnv();
  const email = `e2e-${flow}-wizard-${runId}@example.test`;
  const user = await createAuthUser(email, authOptions);
  let projectId: string | null = null;
  try {
    const session = await signIn(email, authOptions);
    const accountId = await resolvePersonalAccountId(api, session.access_token);
    // SSO and SCIM are Enterprise entitlements; without them the pane is an upsell.
    await setDatabaseEnterpriseDemo(env, accountId, true);
    const project = await createDatabaseProject(env, {
      accountId,
      userId: user.id,
      name: `Identity wizard ${runId}`,
    });
    projectId = project.id;

    const url = `/projects/${project.id}?accountId=${accountId}&accountTab=identity&accountSetup=${flow}`;
    // Install the session on a static asset, then navigate to the app ONCE.
    // Landing on the app twice aborts the first page's in-flight
    // `GET /auth/v1/user`, and AuthProvider answers that fetch failure with a
    // global sign-out (preview run 34896117591 landed on /auth this way).
    await installBrowserSessionDirect(page, session, "/favicon.png", authOptions);
    await selectAccountForUi(page, accountId);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await dismissOnboarding(page);
  } catch (error) {
    if (projectId) await deleteDatabaseProject(env, projectId).catch(() => {});
    await deleteAuthUser(user.id, authOptions);
    throw error;
  }
  return async () => {
    if (projectId) await deleteDatabaseProject(env, projectId).catch(() => {});
    await deleteAuthUser(user.id, authOptions);
  };
}

test.describe("28 — Identity setup wizards advance past the provider picker", () => {
  // Regression, 2026-09-14: `123c1d91c5` moved the wizards from
  // `/accounts/<id>/sso-setup?provider=…` into the account hub modal, where
  // the provider lives in the prefixed `accountProvider` param. The wizard kept
  // reading the bare `provider` param, so every provider click re-rendered the
  // picker and the multi-step setup could not be reached at all.
  test("SSO: pick a provider, move through the steps, survive a reload, change provider", async ({
    page,
  }) => {
    test.skip(!databaseUrl, "KE2E_DATABASE_URL is required");
    test.setTimeout(240_000);

    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const renderLoops = collectRenderLoops(page);
    const cleanup = await openIdentityWizard(page, "sso");

    try {
      const picker = page.getByRole("heading", {
        name: "Select your identity provider",
      });
      await expect(picker).toBeVisible({ timeout: 60_000 });
      await markDocument(page);

      // Pick Entra: the URL gains `accountProvider=entra` and the stepper
      // replaces the picker on step 1.
      await page
        .getByRole("button", { name: /Microsoft Entra ID \(Azure AD\)/ })
        .click();
      await expect.poll(() => hubParams(page).get("accountProvider")).toBe(
        "entra",
      );
      expect(hubParams(page).get("accountSetup")).toBe("sso");
      await expect(picker).toBeHidden();
      await expect(stepCounter(page, 1)).toBeVisible();
      await expect(
        page.getByRole("heading", {
          level: 2,
          name: "Create an enterprise application",
        }),
      ).toBeVisible();
      const rail = page.getByRole("navigation", { name: "Setup steps" });
      await expect(
        rail.getByRole("button", { name: /Create an enterprise application/ }),
      ).toHaveAttribute("aria-current", "step");

      // Continue marks step 1 done and advances to step 2, then step 3.
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(stepCounter(page, 2)).toBeVisible();
      await expect(
        page.getByRole("heading", { level: 2, name: "Basic SAML configuration" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(stepCounter(page, 3)).toBeVisible();

      // Back returns one step; the rail jumps straight to any step.
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(stepCounter(page, 2)).toBeVisible();
      await rail
        .getByRole("button", { name: /Create an enterprise application/ })
        .click();
      await expect(stepCounter(page, 1)).toBeVisible();
      // Step navigation holds: no effect snaps the stepper back to step 3.
      await page.waitForTimeout(1_000);
      await expect(stepCounter(page, 1)).toBeVisible();
      await expectSameDocument(page);

      // Every step body renders, including the inline import and test steps.
      await visitEveryStep(page);
      await rail
        .getByRole("button", { name: /Create an enterprise application/ })
        .click();
      await expect(stepCounter(page, 1)).toBeVisible();
      expect(renderLoops).toEqual([]);

      // A reload of the same URL reopens the wizard on the first incomplete
      // step: the provider comes from the URL, progress from localStorage.
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(stepCounter(page, 3)).toBeVisible({ timeout: 60_000 });
      await expect(picker).toBeHidden();
      await markDocument(page);

      // Change provider with progress asks first, then returns to the picker
      // with `accountProvider` gone and the SSO wizard pane still open.
      await page
        .getByRole("button", { name: "Change provider", exact: true })
        .click();
      const confirm = page.getByRole("alertdialog").or(
        page.getByRole("dialog", { name: /Change provider/ }),
      );
      await confirm
        .getByRole("button", { name: "Change provider", exact: true })
        .click();
      await expect(picker).toBeVisible();
      await expect.poll(() => hubParams(page).get("accountProvider")).toBeNull();
      expect(hubParams(page).get("accountSetup")).toBe("sso");
      await expectSameDocument(page);

      // A second provider opens its own guide from step 1.
      await page.getByRole("button", { name: /^Okta/ }).click();
      await expect.poll(() => hubParams(page).get("accountProvider")).toBe(
        "okta",
      );
      await expect(stepCounter(page, 1)).toBeVisible();
      await expectSameDocument(page);

      expect(pageErrors).toEqual([]);
      expect(renderLoops).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("Directory Sync: pick a provider, advance, go back, and open every step", async ({ page }) => {
    test.skip(!databaseUrl, "KE2E_DATABASE_URL is required");
    test.setTimeout(180_000);

    const renderLoops = collectRenderLoops(page);
    const cleanup = await openIdentityWizard(page, "scim");

    try {
      const picker = page.getByRole("heading", {
        name: "Set up Directory Sync",
      });
      await expect(picker).toBeVisible({ timeout: 60_000 });

      await page.getByRole("button", { name: /^Okta/ }).click();
      await expect.poll(() => hubParams(page).get("accountProvider")).toBe(
        "okta",
      );
      expect(hubParams(page).get("accountSetup")).toBe("scim");
      await expect(picker).toBeHidden();
      await expect(stepCounter(page, 1)).toBeVisible();

      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(stepCounter(page, 2)).toBeVisible();

      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(stepCounter(page, 1)).toBeVisible();
      await visitEveryStep(page);
      expect(renderLoops).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
