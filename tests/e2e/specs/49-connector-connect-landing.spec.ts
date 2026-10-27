/**
 * KRTX-2185: adding a connector never ends in a dead end, and a personal
 * sign-in never lands on the project's shared account.
 *
 * - The custom connector form closes and opens the new connector's page in
 *   every outcome. A failed first sync shows its reason and Retry there.
 * - An MCP server that answers its first tools/list with 401 is a sign-in
 *   still to do when the connector has an auth scheme: the page opens
 *   "Add account" with "Only you" selected, and Continue opens credential
 *   entry. With no auth scheme the 401 is the failure, shown with Retry.
 * - With no account of their own, the notice's Set credential button opens
 *   "Add account" instead of credential entry for the project's account.
 * - "Everyone" signs in the empty shared account made with the connector,
 *   never a second one: two unpinned shared accounts leave no default.
 * - That empty shared account is a placeholder: it is not listed, so a new
 *   connector reads "has no account", never "Everyone in <project>".
 * - The form proposes the slug from the URL's domain.
 * - Removing a connector lands on the list with no "connector not found".
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
// IANA's reserved example host: public https, so the create passes the
// endpoint check, and it answers an MCP initialize with 405, so the first sync
// fails for a reason other than sign-in. A host that never resolves (`.test`)
// fails earlier: the endpoint check refuses the create itself (400).
const unreachableMcp = "https://example.com/mcp";

interface ConnectorList {
  connectors: Array<{ slug: string; status: string; lastError?: string | null }>;
}

test.describe("49 — Connector connect lands on the connector page", () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("kortix:marko-welcome-dismissed", "1"));
    // The founder welcome card can still mount over the account rows; close it
    // whenever it is in the way of a click.
    await page.addLocatorHandler(page.getByRole("complementary", { name: "Welcome from Marko" }), async (card) => {
      await card.getByRole("button", { name: "Dismiss" }).click();
    });
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

  /** Replace the create's first sync with the 401 an OAuth MCP server answers
   *  before sign-in. The create runs for real; no runner-local server is
   *  reachable from a deployed API. */
  async function answer401(page: Page, slug: string) {
    const createPath = `/v1/connectors/projects/${project.id}/connectors`;
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
  }

  /** Open a connector's page as the project owner. */
  async function openConnectorPage(page: Page, slug: string) {
    const url = `/projects/${project.id}/customize/connectors/connected/${slug}`;
    await installBrowserSessionDirect(page, session, url, authOptions);
    await selectAccountForUi(page, accountId);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await dismissOnboarding(page);
  }

  /** A direct API that needs a credential. Creating it also creates its
   *  empty project account; returns that account's id. */
  async function createBearerHttp(slug: string): Promise<string> {
    await api(
      session.access_token,
      "POST",
      `/connectors/projects/${project.id}/connectors`,
      { slug, provider: "http", baseUrl: "https://crm.example.com", auth: { type: "bearer" } },
      200,
    );
    const rows = await accountsOf(slug);
    expect(rows.map((row) => row.owner_type)).toEqual(["project"]);
    return rows[0]!.connection_id;
  }

  async function accountsOf(slug: string) {
    const list = await api<{
      connections: Array<{ connection_id: string; connector_alias: string; owner_type: string }>;
    }>(session.access_token, "GET", `/projects/${project.id}/connections`);
    return list.connections.filter((connection) => connection.connector_alias === slug);
  }

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
    // The server has not named itself yet: the slug comes from the URL's domain.
    await form.getByLabel("URL", { exact: true }).fill(unreachableMcp);
    await expect(form.getByLabel("Slug")).toHaveValue("example");
    await form.getByLabel("Slug").fill(slug);
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

  test("an MCP server that asks for sign-in opens Add account, and Continue opens credential entry", async ({
    page,
  }) => {
    const slug = `e2e-signin-${Date.now().toString(36)}`;
    await answer401(page, slug);
    const form = await fillCustomMcp(page, slug);
    // An auth scheme the connector sends a sign-in with. Without one no
    // account can fix a 401 (the next test).
    await form.getByRole("combobox", { name: "Auth" }).click();
    await page.getByRole("option", { name: "Bearer", exact: true }).click();
    await form.getByRole("button", { name: "Add connector" }).click();

    await expect(form).toHaveCount(0, { timeout: 120_000 });
    await expect(page.getByText(`Added ${slug}`)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/customize/connectors/connected/${slug}`), {
      timeout: 60_000,
    });
    const addDialog = page.getByRole("dialog", { name: /^Add a .+ account$/ });
    await expect(addDialog).toBeVisible({ timeout: 60_000 });
    await expect(addDialog.getByRole("radio", { name: /^Only you/ })).toBeChecked();
    // The hand-off is one-shot: `?add=1` leaves the URL once handled.
    await expect(page).toHaveURL(new RegExp(`/customize/connectors/connected/${slug}$`));

    // Continue creates the private account and starts its sign-in. The
    // server has no one-click OAuth, so credential entry opens for it.
    const mine = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/projects/${project.id}/connections/me`) &&
        response.request().method() === "POST",
    );
    await addDialog.getByRole("button", { name: "Continue", exact: true }).click();
    const account = (await (await mine).json()) as { connection_id: string; owner_type: string };
    expect(account.owner_type).toBe("member");
    await expect(page.getByText(/^Set credential for /)).toBeVisible({ timeout: 60_000 });
  });

  test("an MCP 401 on a connector with no auth scheme shows the failure, not Add account", async ({
    page,
  }) => {
    const slug = `e2e-noauth-${Date.now().toString(36)}`;
    await answer401(page, slug);
    const form = await fillCustomMcp(page, slug);
    // Auth stays on Auto-detect, and the server sent no challenge.
    await form.getByRole("button", { name: "Add connector" }).click();

    await expect(form).toHaveCount(0, { timeout: 120_000 });
    await expect(
      page.getByText(
        `${slug} is installed. Kortix could not load its tools: MCP tools/list failed: HTTP 401`,
      ),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/customize/connectors/connected/${slug}$`), {
      timeout: 60_000,
    });
    const notice = page.getByRole("alert").filter({ hasText: "Kortix could not load" });
    await expect(notice).toBeVisible({ timeout: 60_000 });
    await expect(notice.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: /^Add a .+ account$/ })).toHaveCount(0);
  });

  test("with no account of your own, Set credential opens Add account, not the shared account", async ({
    page,
  }) => {
    // The caller has only the connector's empty shared account.
    const slug = `e2e-banner-${Date.now().toString(36)}`;
    await createBearerHttp(slug);
    await openConnectorPage(page, slug);

    // The empty shared account is not listed: nothing reads "Everyone".
    const notice = page.getByRole("alert").filter({ hasText: "has no account" });
    await expect(notice).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/^Everyone in /)).toHaveCount(0);
    await notice.getByRole("button", { name: /Add account/ }).click();

    const addDialog = page.getByRole("dialog", { name: /^Add a .+ account$/ });
    await expect(addDialog).toBeVisible();
    await expect(addDialog.getByRole("radio", { name: /^Only you/ })).toBeChecked();
    // The slot's name is free: the proposal is the connector's own name.
    await expect(addDialog.getByLabel("Name")).toHaveValue(slug);
    // The response, not the request: the read-back below must run after the
    // API stored the account (a slower runner read it back first, 3 of 3).
    const mine = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/projects/${project.id}/connections/me`) &&
        response.request().method() === "POST",
    );
    await addDialog.getByRole("button", { name: "Continue", exact: true }).click();
    const created = await mine;
    expect(created.request().postDataJSON()).toEqual(expect.objectContaining({ connector_alias: slug }));
    expect(created.ok(), `POST connections/me answered ${created.status()}`).toBe(true);

    // Read back: a private account now sits beside the untouched shared one.
    expect((await accountsOf(slug)).map((row) => row.owner_type).sort()).toEqual([
      "member",
      "project",
    ]);
  });

  test("Everyone signs in the empty shared account, never a second one", async ({ page }) => {
    // Two unpinned shared accounts leave the connector with no default, and a
    // sign-in on a non-default shared account never loads the tools.
    const slug = `e2e-everyone-${Date.now().toString(36)}`;
    const slotId = await createBearerHttp(slug);
    await openConnectorPage(page, slug);

    const notice = page.getByRole("alert").filter({ hasText: "has no account" });
    await expect(notice).toBeVisible({ timeout: 60_000 });
    await notice.getByRole("button", { name: /Add account/ }).click();
    const addDialog = page.getByRole("dialog", { name: /^Add a .+ account$/ });
    await expect(addDialog).toBeVisible();
    await addDialog.getByRole("radio", { name: /^Everyone in / }).check();

    // A new shared account is `POST /connections`: it must not be sent.
    const sharedCreates: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith(`/projects/${project.id}/connections`)
      ) {
        sharedCreates.push(request.url());
      }
    });
    await addDialog.getByRole("button", { name: "Continue", exact: true }).click();
    // Credential entry opens for the empty shared account itself.
    await expect(page.getByText(/^Set credential for /)).toBeVisible({ timeout: 60_000 });
    expect(sharedCreates).toEqual([]);

    // Read back: still exactly one shared account, the same row.
    expect(
      (await accountsOf(slug)).map((row) => [row.connection_id, row.owner_type]),
    ).toEqual([[slotId, "project"]]);
  });

  test("removing a connector lands on the list with no connector-not-found error", async ({
    page,
  }) => {
    const slug = `e2e-remove-${Date.now().toString(36)}`;
    await createBearerHttp(slug);
    await openConnectorPage(page, slug);
    const notFound: string[] = [];
    page.on("response", (response) => {
      if (response.status() === 404 && response.url().includes(`/connectors/${slug}`)) {
        notFound.push(response.url());
      }
    });

    // The connector's own tablist: its Settings tab renders only once write
    // access resolves, and the project nav has a "Settings" tab too.
    const connectorTabs = page
      .getByRole("tablist")
      .filter({ has: page.getByRole("tab", { name: "Accounts", exact: true }) });
    await connectorTabs.getByRole("tab", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    const removed = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/connectors/${slug}`) && response.request().method() === "DELETE",
    );
    await page.getByRole("button", { name: "Remove connector", exact: true }).click();
    expect((await removed).ok()).toBe(true);

    await expect(page).toHaveURL(/\/customize\/connectors$/, { timeout: 60_000 });
    await expect(page.getByText("connector not found")).toHaveCount(0);
    expect(notFound).toEqual([]);
    expect(await accountsOf(slug)).toEqual([]);
  });
});
