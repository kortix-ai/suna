/**
 * UI e2e for the workspace-less sandbox-templates refactor.
 *
 * Mirrors the auth pattern from `08-accounts-project-access.spec.ts`:
 * provisions a fresh Supabase user via the admin API, signs them in to get a
 * session, then drives the Next dashboard. We verify the settings panel's
 * Sandbox templates tab:
 *
 *   1. Provision a managed-GitHub project for the test user.
 *   2. GET /sandboxes — platform default present (API-level smoke).
 *   3. Open the project's Sandbox tab in the browser; assert it renders
 *      WITHOUT a runtime error (catches the regression where the card crashed
 *      with "Cannot read properties of undefined (reading 'find')").
 *   4. Create a project template and click Rebuild; expect the build API call
 *      → 202 and no client console error.
 *
 * Designed for the local-dev stack (Next on :3000, API on :8008, Supabase on
 * :54321).
 */

import { randomUUID } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";
import { resolvePersonalAccountId } from "../helpers/accounts";
import { seedDatabaseProject } from "../helpers/database";
import { createApiResultClient } from "../helpers/http";
import {
  type AuthSession,
  type AuthUser,
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import {
  dismissOnboarding,
  selectAccountForUi,
} from "../helpers/ui";

const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const supabaseUrl = process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321";
const providerTemplateBuildEnabled =
  process.env.E2E_ENABLE_SANDBOX_TEMPLATE_BUILD === "1";
const password = "E2eSandboxTpl123!";
const api = createApiResultClient(apiBase);
const authOptions = { supabaseUrl, password };

interface TemplateCreateResult {
  template_id: string;
  slug: string;
}

async function openSandboxSection(page: Page, projectId: string) {
  // Sandbox templates is a Workspace row of the Mod+, Settings overlay again
  // (2026-09-02; `/projects/[id]/config` is gone). `/settings/<tab>` is the
  // overlay's deep-link route: it opens the store on that tab and lands on the
  // project page with the overlay over it.
  await page.goto(`/projects/${projectId}/settings/sandbox`, {
    waitUntil: "domcontentloaded",
  });
  await dismissOnboarding(page);
  // "Sandbox templates" is the rail row's label (`settings/rail.ts`) and the
  // `SettingsTabHeader` title `sandbox-tab.tsx` renders from it.
  await expect(
    page.getByRole("heading", { name: "Sandbox templates", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
}

test.describe("12 — Sandbox templates UI", () => {
  test.setTimeout(180_000);

  let user: AuthUser;
  let session: AuthSession;
  let projectId: string;
  let accountId: string;
  let customTemplateId: string | null = null;

  test.beforeAll(async () => {
    const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const email = `e2e-sbx-${runId}@kortix.test`;
    user = await createAuthUser(email, authOptions);
    session = await signIn(email, authOptions);
    const projectName = `e2e-ui-tpl-${runId}`;
    accountId = await resolvePersonalAccountId(api, session.access_token);
    projectId = await seedDatabaseProject({
      accountId,
      userId: user.id,
      name: projectName,
    });
  });

  test.afterAll(async () => {
    if (projectId && session) {
      if (customTemplateId) {
        await api(
          session.access_token,
          "DELETE",
          `/projects/${projectId}/sandbox-templates/${customTemplateId}`,
        ).catch(() => {});
      }
      await api(session.access_token, "DELETE", `/projects/${projectId}`).catch(
        () => {},
      );
    }
    if (user?.id) await deleteAuthUser(user.id, authOptions);
  });

  test("sandboxes API returns platform default before opening the panel", async () => {
    const { status, json } = await api<{
      items: Array<{ slug: string; is_default: boolean; source: string }>;
      default_slug: string | null;
    }>(session.access_token, "GET", `/projects/${projectId}/sandbox-templates`);
    expect(status).toBe(200);
    expect(json?.default_slug).toBe("default");
    const platformDefault = json?.items.find(
      (t) => t.is_default && t.slug === "default",
    );
    expect(platformDefault, "platform default must be present").toBeTruthy();
    expect(platformDefault?.source).toBe("platform");
  });

  test("Sandbox panel renders the platform default row without runtime errors", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await installBrowserSessionDirect(
      page,
      session,
      "/favicon.png",
      authOptions,
    );
    await selectAccountForUi(page, accountId);
    await openSandboxSection(page, projectId);
    pageErrors.length = 0;

    // Platform default row: "Default" name + "default" slug code chip.
    await expect(
      page.getByText("Default", { exact: true }).first(),
    ).toBeVisible({
      timeout: 60_000,
    });

    // The card is pinned by its lowercase `default` slug badge — the platform
    // default's old "Platform default · shared by every project" sub-line is
    // gone; `is_default` now renders as a `Default` badge in the same header
    // (sandbox-tab.tsx:472-476, and `describeBase`'s comment above it).
    const platformRow = page
      .getByRole("listitem")
      .filter({ has: page.getByText("default", { exact: true }) });
    await expect(platformRow).toHaveCount(1);
    // Last exact "Default" in the card is that badge (the first is the
    // template name), so this holds whatever the platform default is called.
    await expect(
      platformRow.getByText("Default", { exact: true }).last(),
    ).toBeVisible();

    // Every available provider reports its real launch state. A local stack can
    // legitimately report Not ready when no provider snapshot exists.
    //
    // The pinned provider renders `Daytona•Selected•Ready`, not `Daytona•Ready`
    // (`sandbox-provider-coverage.tsx:119-126`), so the optional `Selected`
    // segment is part of the contract — without it this assertion silently
    // depends on the project never pinning a provider.
    const launchState = "Ready|Building|Failed|Not ready|Unavailable|Unknown";
    const providerState = (provider: string) =>
      new RegExp(`${provider}(?:[^A-Za-z]*Selected)?[^A-Za-z]*(?:${launchState})`);
    await expect(platformRow).toContainText(providerState("Daytona"));
    await expect(platformRow).toContainText(providerState("Platinum"));

    expect(pageErrors, `client errors: ${pageErrors.join(" | ")}`).toEqual([]);
  });

  test("clicking Rebuild on a project template calls the API and does not crash", async ({
    page,
  }) => {
    test.skip(
      !providerTemplateBuildEnabled,
      "Set E2E_ENABLE_SANDBOX_TEMPLATE_BUILD=1 to create and delete real provider snapshots.",
    );
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    const customSlug = `e2e-image-${Date.now()}`;
    const created = await api<TemplateCreateResult>(
      session.access_token,
      "POST",
      `/projects/${projectId}/sandbox-templates`,
      {
        slug: customSlug,
        name: "E2E image template",
        image: "kortix/kortix-sandbox:selfhost-local",
      },
    );
    expect(created.status).toBe(201);
    expect(created.json?.template_id).toBeTruthy();
    if (!created.json) throw new Error("template creation returned no body");
    const templateId = created.json.template_id;
    customTemplateId = templateId;

    // Capture rebuild POSTs as they happen — armed before navigation so we
    // never miss the response between fixture setup and the actual click.
    const seenRebuildStatuses: number[] = [];
    page.on("response", (res) => {
      if (
        res
          .url()
          .includes(
            `/projects/${projectId}/sandbox-templates/${templateId}/build`,
          ) &&
        res.request().method() === "POST"
      ) {
        seenRebuildStatuses.push(res.status());
      }
    });

    await installBrowserSessionDirect(
      page,
      session,
      "/favicon.png",
      authOptions,
    );
    await selectAccountForUi(page, accountId);
    await openSandboxSection(page, projectId);
    pageErrors.length = 0;

    // The template list nests list items, so `getByRole('listitem')` filtered by
    // the slug matches every ANCESTOR row as well as the real one. The old
    // `templateRow.getByText(customSlug, { exact: true })` then resolved to 3
    // elements against staging and failed on strict mode. Pinning the row to the
    // innermost list item that actually owns a Rebuild button makes the row —
    // and the button inside it — unique, and `filter({ hasText })` already
    // proves the slug is on screen, so the extra text lookup bought nothing.
    const templateRow = page
      .getByRole("listitem")
      .filter({ hasText: customSlug })
      .filter({ has: page.getByRole("button", { name: /^Rebuild$/i }) })
      .last();
    const rebuildButton = templateRow.getByRole("button", {
      name: /^Rebuild$/i,
    });
    // No explicit timeout: the deployed lane's 45s expect budget covers the
    // panel's template fetch, which does not fit in 15s against a cross-region
    // database. Local keeps its own 30s default.
    await expect(templateRow).toBeVisible();
    await expect(rebuildButton).toBeEnabled();
    await rebuildButton.click();

    // Wait up to 30s for the template build POST to land — toast feedback gives the
    // user the cue too, but for the assertion we watch the network.
    await expect
      .poll(() => seenRebuildStatuses.length, {
        timeout: 30_000,
        intervals: [500],
      })
      .toBeGreaterThan(0);
    expect(seenRebuildStatuses[0]).toBe(202);

    expect(
      pageErrors,
      `client errors after Rebuild: ${pageErrors.join(" | ")}`,
    ).toEqual([]);
  });
});
