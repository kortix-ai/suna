import { expect, test, type Locator, type Page } from "@playwright/test";

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
const password = "E2eFeatureFlagsUi123!";
const authOptions = { supabaseUrl, password };
const api = createApiJsonClient(apiBase);

/** The badge each stability renders as (feature-flags-view.tsx STABILITY_BADGE). */
const STABILITY_BADGE: Record<string, string> = {
  experimental: "Experimental",
  beta: "Beta",
  stable: "Stable",
};

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role: string;
}

/** One entry of the server's self-describing catalog — `buildFeatureFlagCatalog`
 *  in apps/api/src/feature-flags/registry.ts, serialized as
 *  `project.experimental_features`. The UI renders straight from it, so the
 *  spec reads its expectations from the same source instead of hard-coding a
 *  flag list that would rot the moment a flag is added. */
interface FeatureFlagView {
  key: string;
  name: string;
  description: string;
  stability: string;
  available: boolean;
  enabled: boolean;
  overridden: boolean;
}

interface ProjectResponse {
  project_id: string;
  experimental_features: FeatureFlagView[];
}

async function dismissOnboarding(page: Page): Promise<void> {
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
}

/**
 * Customize → Manage → Feature flags, driven exactly as a user does it: the
 * sidebar's Settings row opens the Customize overlay (a full-screen modal),
 * then the rail's "Feature flags" item selects the section.
 */
async function openFeatureFlags(page: Page): Promise<Locator> {
  const settings = page
    .locator('[data-slot="sidebar"]')
    .getByRole("button", { name: "Settings" });
  await expect(settings).toBeVisible({ timeout: 60_000 });
  await settings.click();
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Feature flags" }).click();
  await expect(
    panel.getByRole("heading", { name: "Feature flags", exact: true }),
  ).toBeVisible();
  return panel;
}

/** The `<li>` that owns one flag, identified by its switch's accessible name
 *  (`aria-label={flag.name}`) — never by DOM order, which is registry order and
 *  changes when a flag is added. */
function flagRow(panel: Locator, page: Page, name: string): Locator {
  return panel
    .getByRole("listitem")
    .filter({ has: page.getByRole("switch", { name, exact: true }) });
}

/** The origin line under a flag (`originLabel` in feature-flags-view.tsx). */
function originLabel(flag: FeatureFlagView): string {
  if (flag.overridden) return "Overridden for this project";
  return flag.enabled ? "Default on" : "Default off";
}

test.describe("19 — Feature flags UI", () => {
  // Coverage note: the viewer/read-only case (a member WITHOUT
  // project.customize.write sees the switches disabled) is NOT covered here.
  // It needs a second auth user, an account invite, and a custom project role
  // seeded per run — heavier than the rest of this spec put together. The
  // capability gate itself is unit-covered by the `canWrite` fail-closed logic
  // in feature-flags-view.tsx and enforced server-side by
  // `assertProjectCapability(PROJECT_CUSTOMIZE_WRITE)` on
  // `PATCH /projects/:id/features` (apps/api/src/projects/routes/r6.ts).
  test("lists every available flag, toggles one through PATCH /features, and persists it", async ({
    page,
  }) => {
    test.skip(!databaseUrl, "KE2E_DATABASE_URL is required");
    test.setTimeout(180_000);

    const runId = Date.now().toString(36);
    const email = `e2e-feature-flags-ui-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    const env = loadEnv();
    let workspaceId: string | null = null;
    const pageErrors: string[] = [];
    // The deprecated alias must stay unused by the web app: the canonical route
    // is `/features` and a silent fallback to `/experimental` would hide a
    // regression in the SDK's `updateFeatureFlag`.
    const deprecatedAliasCalls: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
      if (
        request.method() === "PATCH" &&
        request.url().endsWith(`/v1/projects/${workspaceId}/experimental`)
      ) {
        deprecatedAliasCalls.push(request.url());
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
      if (!account) throw new Error("the seeded user owns no account");

      const project = await createDatabaseProject(env, {
        accountId: account.account_id,
        userId: user.id,
        name: `Feature flags UI ${runId}`,
      });
      workspaceId = project.id;

      // The server's catalog IS the expectation for what the section renders.
      const before = await api<ProjectResponse>(
        session.access_token,
        "GET",
        `/projects/${project.id}`,
      );
      const flags = before.experimental_features.filter((f) => f.available);
      expect(flags.length).toBeGreaterThan(0);

      // Toggle target: prefer `review_center` — it is always available, defaults
      // OFF, and its toggle effects are pure web/DB (no connector
      // materialization, no sandbox env fan-out). Fall back to any available
      // flag that is currently off, so the spec survives a registry change.
      const target =
        flags.find((f) => f.key === "review_center" && !f.enabled) ??
        flags.find((f) => !f.enabled);
      if (!target) throw new Error("no available feature flag is currently off");

      await installBrowserSessionDirect(
        page,
        session,
        `/projects/${project.id}`,
        authOptions,
      );
      await selectAccountForUi(page, account.account_id);
      await page.goto(`/projects/${project.id}`, {
        waitUntil: "domcontentloaded",
      });
      await dismissOnboarding(page);

      // (b) every available flag renders a row with a stability badge and an
      //     origin line.
      const panel = await openFeatureFlags(page);
      await expect(panel.getByRole("switch")).toHaveCount(flags.length);
      for (const flag of flags) {
        const row = flagRow(panel, page, flag.name);
        await expect(row).toHaveCount(1);
        await expect(row.getByText(flag.name, { exact: true })).toBeVisible();
        const badge = STABILITY_BADGE[flag.stability];
        if (!badge) throw new Error(`unknown stability: ${flag.stability}`);
        await expect(row.getByText(badge, { exact: true })).toBeVisible();
        await expect(
          row.getByText(originLabel(flag), { exact: true }),
        ).toBeVisible();
        await expect(
          panel.getByRole("switch", { name: flag.name, exact: true }),
        ).toHaveAttribute("aria-checked", String(flag.enabled));
      }

      // (c) toggling one flag issues the canonical PATCH and persists.
      const patchRequest = page.waitForRequest(
        (request) =>
          request.method() === "PATCH" &&
          request.url().endsWith(`/v1/projects/${project.id}/features`),
      );
      const patchResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "PATCH" &&
          response.url().endsWith(`/v1/projects/${project.id}/features`),
      );
      await panel
        .getByRole("switch", { name: target.name, exact: true })
        .click();
      expect((await patchRequest).postDataJSON()).toEqual({
        feature: target.key,
        enabled: true,
      });
      expect((await patchResponse).status()).toBe(200);
      await expect(
        panel.getByRole("switch", { name: target.name, exact: true }),
      ).toHaveAttribute("aria-checked", "true");

      // The API is the source of truth for persistence, not the optimistic
      // cache write — read it back before trusting the reloaded UI.
      const after = await api<ProjectResponse>(
        session.access_token,
        "GET",
        `/projects/${project.id}`,
      );
      const persisted = after.experimental_features.find(
        (f) => f.key === target.key,
      );
      expect(persisted).toMatchObject({ enabled: true, overridden: true });

      await page.reload({ waitUntil: "domcontentloaded" });
      await dismissOnboarding(page);
      const reopened = await openFeatureFlags(page);
      const targetRow = flagRow(reopened, page, target.name);
      await expect(
        reopened.getByRole("switch", { name: target.name, exact: true }),
      ).toHaveAttribute("aria-checked", "true");
      await expect(
        targetRow.getByText("Overridden for this project", { exact: true }),
      ).toBeVisible();

      expect(deprecatedAliasCalls).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      if (workspaceId)
        await deleteDatabaseProject(env, workspaceId).catch(() => {});
      await deleteAuthUser(user.id, authOptions).catch(() => {});
    }
  });
});
