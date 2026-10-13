/**
 * KRTX-2185: adding a connector never ends in a dead end, and a personal
 * sign-in never lands on the project's shared account.
 *
 * - The custom connector form closes and opens the new connector's page in
 *   every outcome. A failed first sync shows its reason and Retry there.
 * - An MCP server that answers its first tools/list with 401 is a sign-in
 *   still to do: the page opens "Add account" with "Only you" selected.
 * - With no account of their own, the notice's Set credential button opens
 *   "Add account" instead of credential entry for the project's account.
 */
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

import { resolvePersonalAccountId } from "../helpers/accounts";
import { createApiJsonClient, createApiResultClient } from "../helpers/http";
import { type ManifestProject, createManifestProject } from "../helpers/manifest-project";
import {
  type AuthSession,
  type AuthUser,
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import { dismissOnboarding, selectAccountForUi } from "../helpers/ui";

const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const supabaseUrl = process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321";
const databaseUrl = process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const password = "E2eConnectLanding123!";
const authOptions = { supabaseUrl, password };
const api = createApiJsonClient(apiBase);
const resultApi = createApiResultClient(apiBase);
// No resolver answers `.test`, so the first sync of this server always fails.
const unreachableMcp = "https://ke2e.kortix.test/mcp";

interface ConnectorList {
  connectors: Array<{ slug: string; status: string; lastError?: string | null }>;
}

test.describe("49 — Connector connect lands on the connector page", () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("kortix:marko-welcome-dismissed", "1"));
  });

  let user: AuthUser;
  let session: AuthSession;
  let accountId: string;
  let project: ManifestProject;

  test.beforeAll(async () => {
    test.skip(!databaseUrl, "KE2E_DATABASE_URL is required");
    const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const email = `e2e-connect-landing-${runId}@kortix.test`;
    user = await createAuthUser(email, authOptions);
    session = await signIn(email, authOptions);
    accountId = await resolvePersonalAccountId(resultApi, session.access_token);
    project = await createManifestProject({
      api,
      accessToken: session.access_token,
      accountId,
      userId: user.id,
      name: `Connect landing ${runId}`,
      databaseUrl: databaseUrl!,
    });
  });

  test.afterAll(async () => {
    await project?.dispose().catch(() => undefined);
    if (user?.id) await deleteAuthUser(user.id, authOptions);
  });

  /** Open the custom connector form and fill an MCP server. */
  async function fillCustomMcp(page: Page, slug: string) {
    const url = `/projects/${project.id}/customize/connectors`;
    await installBrowserSessionDirect(page, session, url, authOptions);
    await selectAccountForUi(page, accountId);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await dismissOnboarding(page);
    await page.getByRole("button", { name: /^New$/i }).click({ timeout: 60_000 });
    await page.getByRole("menuitem", { name: /^Add a custom connector/i }).click();
    const form = page.getByRole("dialog", { name: /^Add a custom connector$/i });
    await expect(form).toBeVisible();
    await form.getByRole("combobox", { name: "Provider" }).click();
    await page.getByRole("option", { name: "MCP", exact: true }).click();
    await form.getByLabel("Slug").fill(slug);
    await form.getByLabel("URL", { exact: true }).fill(unreachableMcp);
    return form;
  }

  test("a failed first sync closes the form and opens the connector page with Retry", async ({
    page,
  }) => {
    const slug = `e2e-landing-${Date.now().toString(36)}`;
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const form = await fillCustomMcp(page, slug);

    const createPath = `/v1/connectors/projects/${project.id}/connectors`;
    // The create commits kortix.yaml and runs the first sync: give it time.
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith(createPath) && response.request().method() === "POST",
      { timeout: 120_000 },
    );
    await form.getByRole("button", { name: "Add connector" }).click();
    const response = await created;
    expect(response.request().postDataJSON()).toEqual(
      expect.objectContaining({ slug, provider: "mcp", url: unreachableMcp, create_only: true }),
    );
    const body = (await response.json()) as { sync?: { errors: Array<{ slug: string; error: string }> } };
    const syncError = body.sync?.errors.find((error) => error.slug === slug)?.error ?? "";
    expect(syncError, "the first sync of an unreachable server fails").not.toBe("");
    expect(syncError).not.toMatch(/\bHTTP 40[13]\b/);

    // The form is gone and the page is the connector's, with no Add account.
    await expect(page.getByText(`${slug} is installed. Kortix could not load its tools`)).toBeVisible();
    await expect(form).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/customize/connectors/connected/${slug}$`), {
      timeout: 60_000,
    });
    const notice = page.getByRole("alert").filter({ hasText: "Kortix could not load" });
    await expect(notice).toBeVisible({ timeout: 60_000 });
    await expect(notice.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: /^Add a .+ account$/ })).toHaveCount(0);

    // Read back: the connector exists and holds the failure.
    const list = await api<ConnectorList>(
      session.access_token,
      "GET",
      `/connectors/projects/${project.id}/connectors?include_schemas=false`,
    );
    expect(list.connectors.find((connector) => connector.slug === slug)?.status).toBe("error");
    expect(pageErrors, `client errors: ${pageErrors.join(" | ")}`).toEqual([]);
  });

  test("an MCP server that asks for sign-in opens Add account with Only you selected", async ({
    page,
  }) => {
    const slug = `e2e-signin-${Date.now().toString(36)}`;
    const createPath = `/v1/connectors/projects/${project.id}/connectors`;
    // The create runs for real. Only its sync verdict is replaced with the
    // 401 an OAuth MCP server answers before sign-in: no runner-local server
    // is reachable from a deployed API.
    await page.route(`**${createPath}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      const json = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        json: {
          ...json,
          sync: { synced: 1, errors: [{ slug, error: "MCP tools/list failed: HTTP 401" }] },
        },
      });
    });
    const form = await fillCustomMcp(page, slug);
    await form.getByRole("button", { name: "Add connector" }).click();

    await expect(form).toHaveCount(0, { timeout: 120_000 });
    await expect(page).toHaveURL(new RegExp(`/customize/connectors/connected/${slug}`), {
      timeout: 60_000,
    });
    const addDialog = page.getByRole("dialog", { name: /^Add a .+ account$/ });
    await expect(addDialog).toBeVisible({ timeout: 60_000 });
    await expect(addDialog.getByRole("radio", { name: /^Only you/ })).toBeChecked();
    // The hand-off is one-shot: `?add=1` leaves the URL once handled.
    await expect(page).toHaveURL(new RegExp(`/customize/connectors/connected/${slug}$`));
  });

  test("with no account of your own, Set credential opens Add account, not the shared account", async ({
    page,
  }) => {
    // A direct API that needs a credential. Creating it also creates its
    // empty project account, so the caller has only that shared row.
    const slug = `e2e-banner-${Date.now().toString(36)}`;
    await api(
      session.access_token,
      "POST",
      `/connectors/projects/${project.id}/connectors`,
      { slug, provider: "http", baseUrl: "https://crm.example.com", auth: { type: "bearer" } },
      200,
    );
    const before = await api<{ connections: Array<{ connector_alias: string; owner_type: string }> }>(
      session.access_token,
      "GET",
      `/projects/${project.id}/connections`,
    );
    expect(
      before.connections.filter((c) => c.connector_alias === slug).map((c) => c.owner_type),
    ).toEqual(["project"]);

    const url = `/projects/${project.id}/customize/connectors/connected/${slug}`;
    await installBrowserSessionDirect(page, session, url, authOptions);
    await selectAccountForUi(page, accountId);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await dismissOnboarding(page);

    const notice = page.getByRole("alert").filter({ hasText: "needs a credential" });
    await expect(notice).toBeVisible({ timeout: 60_000 });
    await notice.getByRole("button", { name: "Set credential", exact: true }).click();

    const addDialog = page.getByRole("dialog", { name: /^Add a .+ account$/ });
    await expect(addDialog).toBeVisible();
    await expect(addDialog.getByRole("radio", { name: /^Only you/ })).toBeChecked();
    const mine = page.waitForRequest(
      (request) =>
        request.url().endsWith(`/projects/${project.id}/connections/me`) &&
        request.method() === "POST",
    );
    await addDialog.getByRole("button", { name: "Continue", exact: true }).click();
    expect((await mine).postDataJSON()).toEqual(expect.objectContaining({ connector_alias: slug }));

    // Read back: a private account now sits beside the untouched shared one.
    const after = await api<{ connections: Array<{ connector_alias: string; owner_type: string }> }>(
      session.access_token,
      "GET",
      `/projects/${project.id}/connections`,
    );
    expect(
      after.connections
        .filter((c) => c.connector_alias === slug)
        .map((c) => c.owner_type)
        .sort(),
    ).toEqual(["member", "project"]);
  });
});
