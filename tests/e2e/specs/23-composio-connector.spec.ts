import { expect, test } from "@playwright/test";

import { resolvePersonalAccountId } from "../helpers/accounts";
import { createApiJsonClient, createApiResultClient } from "../helpers/http";
import {
  type ManifestProject,
  createManifestProject,
} from "../helpers/manifest-project";
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
const databaseUrl =
  process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const password = "E2eComposioConnector123!";
const authOptions = { supabaseUrl, password };
const api = createApiJsonClient(apiBase);
const resultApi = createApiResultClient(apiBase);

interface ConnectStatus {
  configured: boolean;
  provider: string | null;
  providers?: string[];
}

interface ConnectionList {
  connections: Array<{
    connector_alias: string;
    owner_type: string;
    is_default: boolean;
    status: string;
    metadata: Record<string, unknown>;
  }>;
}

test.describe("23 — Composio managed connector", () => {
  test.setTimeout(240_000);

  let user: AuthUser;
  let session: AuthSession;
  let accountId: string;
  let project: ManifestProject;

  test.beforeAll(async () => {
    test.skip(!databaseUrl, "KE2E_DATABASE_URL is required");
    const runId = Date.now().toString(36);
    const email = `e2e-composio-${runId}@kortix.test`;
    user = await createAuthUser(email, authOptions);
    session = await signIn(email, authOptions);
    accountId = await resolvePersonalAccountId(resultApi, session.access_token);
    project = await createManifestProject({
      api,
      accessToken: session.access_token,
      accountId,
      userId: user.id,
      name: `Composio browser ${runId}`,
      databaseUrl: databaseUrl!,
    });
  });

  test.afterAll(async () => {
    await project?.dispose().catch(() => undefined);
    if (user?.id) await deleteAuthUser(user.id, authOptions);
  });

  test("short searches return matching connectors in Discovery and All", async ({
    page,
  }) => {
    const status = await api<ConnectStatus>(
      session.access_token,
      "GET",
      "/connectors/connect-status",
    );
    const providers =
      status.providers ?? (status.provider ? [status.provider] : []);
    if (!providers.includes("composio")) {
      expect(
        process.env.E2E_REQUIRE_COMPOSIO,
        "this run requires Composio",
      ).not.toBe("1");
      return;
    }
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if (
        response.url().includes("/connect/toolkits") &&
        response.status() >= 400
      ) {
        failedRequests.push(`${response.status()} ${response.url()}`);
      }
    });
    await installBrowserSessionDirect(
      page,
      session,
      `/projects/${project.id}/customize/connectors`,
      authOptions,
    );
    await selectAccountForUi(page, accountId);
    for (const scope of ["Discovery", "All"]) {
      await page.goto(`/projects/${project.id}/customize/connectors`, {
        waitUntil: "domcontentloaded",
      });
      await dismissOnboarding(page);
      await page.getByRole("tab", { name: scope, exact: true }).click();
      const search = page.getByPlaceholder("Search all connectors");
      for (const query of ["a", "sl", " G ", "gm", "gmail"]) {
        const response = page.waitForResponse((value) => {
          // Only the real request: on the cross-site staging pair the Authorization
          // header forces a CORS preflight — an OPTIONS on the SAME url and query that
          // answers 204 and matched this predicate before the GET did (release gate
          // v0.13.12, 2026-09-07/08, browser shard 3: "expected 200, received 204").
          if (value.request().method() === "OPTIONS") return false;
          const url = new URL(value.url());
          return (
            url.pathname.endsWith("/connect/toolkits") &&
            url.searchParams.get("q") === query.trim()
          );
        });
        await search.fill(query);
        const result = await response;
        expect(new URL(result.url()).origin).toBe(new URL(apiBase).origin);
        expect(result.status()).toBe(200);
        const body = await result.json();
        const items = body.toolkits ?? body.items;
        expect(items.length).toBeGreaterThan(0);
        const name = query.trim() === "sl" ? "Slack" : "Gmail";
        expect(items).toContainEqual(
          expect.objectContaining({ slug: name.toLowerCase() }),
        );
        for (const item of query.trim().length < 3 ? items : []) {
          expect(
            `${item.name} ${item.slug} ${item.description ?? ""}`.toLowerCase(),
          ).toContain(query.trim().toLowerCase());
        }
        await expect(
          page.getByRole("button", { name: new RegExp(`^${name}\\b`) }).first(),
        ).toBeVisible();
        await expect(
          page.getByText("Internal server error", { exact: true }),
        ).toHaveCount(0);
        if (query.trim().length < 3) {
          await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        }
        if (query === "sl") {
          await expect(
            page.getByRole("button", { name: /^Gmail\b/ }),
          ).toHaveCount(0);
        }
        if (query === "gm") {
          await expect(
            page.getByRole("button", { name: /^Slack\b/ }),
          ).toHaveCount(0);
        }
        if (query === "a") {
          await page.screenshot({
            path: test.info().outputPath(`${scope}-single-letter.png`),
          });
        }
      }
      // Backspacing restores the broader one-letter result set.
      const backspaceResponse = page.waitForResponse((value) => {
        // Only the real request: on the cross-site staging pair the Authorization
        // header forces a CORS preflight — an OPTIONS on the SAME url and query that
        // answers 204 and matched this predicate before the GET did (release gate
        // v0.13.12, 2026-09-07/08, browser shard 3: "expected 200, received 204").
        if (value.request().method() === "OPTIONS") return false;
        const url = new URL(value.url());
        return (
          url.pathname.endsWith("/connect/toolkits") &&
          url.searchParams.get("q") === "g"
        );
      });
      await search.fill("g");
      expect((await backspaceResponse).status()).toBe(200);
      await expect(
        page.getByRole("button", { name: /^GitHub\b/ }).first(),
      ).toBeVisible();
      const emptyResponse = page.waitForResponse((value) => {
        // Only the real request: on the cross-site staging pair the Authorization
        // header forces a CORS preflight — an OPTIONS on the SAME url and query that
        // answers 204 and matched this predicate before the GET did (release gate
        // v0.13.12, 2026-09-07/08, browser shard 3: "expected 200, received 204").
        if (value.request().method() === "OPTIONS") return false;
        const url = new URL(value.url());
        return (
          url.pathname.endsWith("/connect/toolkits") &&
          url.searchParams.get("q") === "☃"
        );
      });
      await search.fill("☃");
      const emptyResult = await emptyResponse;
      expect(emptyResult.status()).toBe(200);
      expect(await emptyResult.json()).toMatchObject({
        total: 0,
        toolkits: [],
        hasMore: false,
      });
      await expect(page.getByRole("button", { name: /^Gmail\b/ })).toHaveCount(
        0,
      );
      await expect(page.locator('[data-testid="catalog-add"]')).toHaveCount(0);
      await search.fill("");
      await expect(
        page.getByRole("button", { name: /^Computer Tunnels\b/ }).first(),
      ).toBeVisible();
    }
    expect(pageErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("discovers, creates, and connects a real no-auth toolkit through the UI", async ({
    page,
  }) => {
    const status = await api<ConnectStatus>(
      session.access_token,
      "GET",
      "/connectors/connect-status",
    );
    const providers =
      status.providers ?? (status.provider ? [status.provider] : []);
    const composioConfigured = providers.includes("composio");
    if (process.env.E2E_REQUIRE_COMPOSIO === "1" && !composioConfigured) {
      throw new Error(
        `Composio is required for this run but connect-status returned ${JSON.stringify(status)}`,
      );
    }

    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await installBrowserSessionDirect(
      page,
      session,
      `/projects/${project.id}/customize/connectors`,
      authOptions,
    );
    await selectAccountForUi(page, accountId);

    const statusResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/connectors/connect-status") &&
        response.request().method() === "GET",
    );
    await page.goto(`/projects/${project.id}/customize/connectors`, {
      waitUntil: "domcontentloaded",
    });
    await dismissOnboarding(page);
    expect((await statusResponse).status()).toBe(200);

    if (!composioConfigured) {
      await expect(
        page.getByRole("button", { name: /Composio Search/i }),
      ).toHaveCount(0);
      expect(pageErrors, `client errors: ${pageErrors.join(" | ")}`).toEqual(
        [],
      );
      return;
    }

    const toolkitResponse = page.waitForResponse(
      (response) =>
        response
          .url()
          .includes(`/v1/connectors/projects/${project.id}/connect/toolkits`) &&
        response.request().method() === "GET",
    );
    await page
      .getByPlaceholder("Search all connectors")
      .fill("Composio Search");
    const toolkitHttp = await toolkitResponse;
    expect(toolkitHttp.status()).toBe(200);
    const toolkitBody = (await toolkitHttp.json()) as {
      provider?: string;
      items?: Array<{ slug?: string; name?: string; isNoAuth?: boolean }>;
    };
    expect(toolkitBody.items).toContainEqual(
      expect.objectContaining({
        slug: "composio_search",
        name: "Composio Search",
        isNoAuth: true,
      }),
    );

    await page.getByRole("button", { name: /Composio Search/i }).click();
    const addDialog = page.getByRole("dialog", { name: "Add Composio Search" });
    await expect(addDialog).toBeVisible();

    const createRequestPromise = page.waitForRequest(
      (request) =>
        request
          .url()
          .endsWith(`/v1/connectors/projects/${project.id}/connectors`) &&
        request.method() === "POST",
    );
    const createResponsePromise = page.waitForResponse(
      (response) =>
        response
          .url()
          .endsWith(`/v1/connectors/projects/${project.id}/connectors`) &&
        response.request().method() === "POST",
    );
    await addDialog
      .getByRole("button", { name: "Add connector", exact: true })
      .click();
    const createRequest = await createRequestPromise;
    const createBody = createRequest.postDataJSON() as Record<string, unknown>;
    // `authorization_strategy` was a connector-level MODE that made project-
    // owned and member-owned accounts mutually exclusive, and the add dialog
    // carried an owner field that set it. 2bdc308a87 (PR #7326, 2026-09-16)
    // deleted that field and the key: ownership is a property of each ACCOUNT
    // (`owner_type` on the connection), so the draft names the account to
    // authorize (`account: "default"`) instead of a connector-wide strategy.
    // The route still answers the old strategy PUT as a deprecation no-op
    // (CONN-13), but no client sends the key on create any more.
    expect(createBody).toEqual(
      expect.objectContaining({
        name: "Composio Search",
        provider: "composio",
        app: "composio_search",
        account: "default",
        create_only: true,
      }),
    );
    expect(createBody).not.toHaveProperty("authorization_strategy");
    // A proposed connector slug is `<app>-<6 random base36>` since 7f6b8087f3
    // (so two connections to one app never collide). The suffix is random, so
    // read the slug the UI actually proposed and follow it for the rest of the
    // journey instead of asserting a fixed one.
    expect(createBody.slug).toMatch(/^composio-search-[a-z0-9]{6}$/);
    const connectorSlug = createBody.slug as string;
    expect(JSON.stringify(createBody)).not.toMatch(
      /api[_-]?key|credential|secret/i,
    );
    expect((await createResponsePromise).status()).toBe(200);

    await expect(page).toHaveURL(new RegExp(`[?&]scope=connected(?:&|$)`));
    await expect(page).toHaveURL(new RegExp(`[?&]c=${connectorSlug}(?:&|$)`));
    const detail = page.getByRole("dialog", { name: "Composio Search" });
    await expect(detail).toBeVisible();
    await expect(
      detail.getByRole("button", { name: "Connect", exact: true }),
    ).toBeVisible();

    const connectRequestPromise = page.waitForRequest(
      (request) =>
        request
          .url()
          .endsWith(
            `/v1/connectors/projects/${project.id}/connectors/${connectorSlug}/connect`,
          ) && request.method() === "POST",
    );
    const connectResponsePromise = page.waitForResponse(
      (response) =>
        response
          .url()
          .endsWith(
            `/v1/connectors/projects/${project.id}/connectors/${connectorSlug}/connect`,
          ) && response.request().method() === "POST",
    );
    await detail.getByRole("button", { name: "Connect", exact: true }).click();
    const connectRequest = await connectRequestPromise;
    expect(connectRequest.postDataJSON()).toEqual({});
    const connectResponse = await connectResponsePromise;
    expect(connectResponse.status()).toBe(200);
    const connectBody = (await connectResponse.json()) as Record<
      string,
      unknown
    >;
    expect(connectBody).toEqual(
      expect.objectContaining({
        provider: "composio",
        app: "composio_search",
        connected: true,
        isNoAuth: true,
      }),
    );
    expect(connectBody.sessionId).toEqual(expect.stringMatching(/^trs_/));
    expect(connectBody.connectionId).toEqual(expect.any(String));

    await expect(
      detail.getByRole("button", { name: "Reconnect", exact: true }),
    ).toBeVisible();
    await detail.getByRole("button", { name: "Close", exact: true }).click();
    await expect(detail).not.toBeVisible();
    await expect(
      page.getByRole("tab", { name: "Connected", exact: true }),
    ).toHaveAttribute("aria-selected", "true");

    const connections = await api<ConnectionList>(
      session.access_token,
      "GET",
      `/projects/${project.id}/connections`,
    );
    // The connector's shared account. Do NOT filter on `is_default`: since
    // 6b7e3c27c5 (PR #7326, 2026-09-16) `ensureDefaultConnection` never pins
    // the row it creates — an auto-authorized account is not a deliberate
    // choice, and silently defaulting it was the guess the `account_required`
    // rule refuses to make. Only `PUT /connections/:id/default` pins one now.
    // The EFFECTIVE project default is the connector's sole active
    // project-owned account, which is exactly what this journey created, so
    // assert that: one project-owned account, unpinned.
    const projectConnections = connections.connections.filter(
      (item) =>
        item.connector_alias === connectorSlug && item.owner_type === "project",
    );
    expect(projectConnections).toHaveLength(1);
    const connection = projectConnections[0];
    expect(connection.is_default).toBe(false);
    expect(connection?.status).toBe("active");
    expect(connection?.metadata).toEqual(
      expect.objectContaining({
        provider: "composio",
        toolkit: "composio_search",
        is_no_auth: true,
      }),
    );
    expect(connection?.metadata.session_id).toEqual(
      expect.stringMatching(/^trs_/),
    );
    expect(JSON.stringify(connection?.metadata)).not.toMatch(
      /api[_-]?key|credential|secret/i,
    );
    expect(pageErrors, `client errors: ${pageErrors.join(" | ")}`).toEqual([]);
  });

  test("renames an account from its row menu without re-authorizing it", async ({
    page,
  }) => {
    // A direct (MCP) connector: the row, its menu, and the rename modal are
    // the same for every provider, and this needs no provider credentials.
    const slug = `e2e-rename-${Date.now().toString(36)}`;
    await api(
      session.access_token,
      "POST",
      `/connectors/projects/${project.id}/connectors`,
      { slug, provider: "mcp", url: "https://ke2e.kortix.test/mcp", auth: { type: "none" } },
      200,
    );
    const created = await api<{ connection_id: string; label: string }>(
      session.access_token,
      "POST",
      `/projects/${project.id}/connections`,
      { connector_alias: slug, owner_type: "project", label: "Project connection" },
      201,
    );

    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installBrowserSessionDirect(
      page,
      session,
      `/projects/${project.id}/customize/connectors?scope=connected&c=${slug}`,
      authOptions,
    );
    await selectAccountForUi(page, accountId);
    await page.goto(
      `/projects/${project.id}/customize/connectors?scope=connected&c=${slug}`,
      { waitUntil: "domcontentloaded" },
    );
    await dismissOnboarding(page);

    const row = page.getByRole("listitem").filter({ hasText: "Project connection" });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.getByRole("button", { name: "Actions for Project connection" }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Rename Project connection" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name").fill("  Shared support inbox  ");

    const renameRequest = page.waitForRequest(
      (request) =>
        request
          .url()
          .endsWith(`/v1/projects/${project.id}/connections/${created.connection_id}/label`) &&
        request.method() === "PUT",
    );
    const renameResponse = page.waitForResponse(
      (response) =>
        response
          .url()
          .endsWith(`/v1/projects/${project.id}/connections/${created.connection_id}/label`) &&
        response.request().method() === "PUT",
    );
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    expect((await renameRequest).postDataJSON()).toEqual({ label: "Shared support inbox" });
    const response = await renameResponse;
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        connection_id: created.connection_id,
        label: "Shared support inbox",
        owner_type: "project",
        status: "active",
      }),
    );

    await expect(dialog).not.toBeVisible();
    await expect(page.getByText("Account renamed")).toBeVisible();
    await expect(
      page.getByRole("listitem").filter({ hasText: "Shared support inbox" }),
    ).toBeVisible();
    await expect(
      page.getByRole("listitem").filter({ hasText: "Project connection" }),
    ).toHaveCount(0);

    const readBack = await api<ConnectionList & {
      connections: Array<{ connection_id: string; label: string }>;
    }>(session.access_token, "GET", `/projects/${project.id}/connections`);
    expect(
      readBack.connections.find((item) => item.connection_id === created.connection_id)?.label,
    ).toBe("Shared support inbox");
    expect(pageErrors, `client errors: ${pageErrors.join(" | ")}`).toEqual([]);
  });

  test("a connect link for an already-connected account reads as success and names the identity", async ({
    page,
  }) => {
    // The API half (Composio reusing an active account, finalize naming it) is
    // proven against real Postgres in integration-connector-connected-as and
    // public-app.test. A hosted OAuth cannot complete in a browser run, so
    // this journey pins the three setup-link responses and asserts what the
    // human sees: before the fix this exact `/start` answer rendered
    // "Could not start the connect flow."
    const token = "ksl_e2e_already_connected";
    const finalizeCalls: string[] = [];
    await page.route(`**/setup-links/connectors/${token}`, (route) =>
      route.fulfill({
        json: {
          kind: "connector",
          project_name: "E2E project",
          slug: "gmail",
          app: "Gmail",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      }),
    );
    await page.route(`**/setup-links/connectors/${token}/start`, (route) =>
      route.fulfill({ json: { connect_url: null, connected: true, already_connected: true } }),
    );
    await page.route(`**/setup-links/connectors/${token}/finalize`, (route) => {
      finalizeCalls.push(route.request().method());
      return route.fulfill({ json: { connected: true, connected_as: "ops@example.test" } });
    });

    await page.goto(`/connect/${token}`, { waitUntil: "domcontentloaded" });
    const popups: string[] = [];
    page.on("popup", (popup) => popups.push(popup.url()));
    await page.getByRole("button", { name: "Connect Gmail" }).click();

    await expect(page.getByText("Already connected", { exact: true })).toBeVisible();
    await expect(page.getByTestId("connector-intake-connected-as")).toHaveText(
      "Connected as ops@example.test",
    );
    await expect(page.getByText("Could not start the connect flow.")).toHaveCount(0);
    await expect(page.getByText(/To use a different account/)).toBeVisible();
    expect(finalizeCalls).toEqual(["POST"]);
    expect(popups).toEqual([]);
  });

  // @quarantine: this journey calls `test.skip(!providers.includes("composio"))`
  // when the live `/connectors/connect-status` does not report composio. Under
  // the strict browser reporter (E2E_REQUIRE_ALL_BROWSER=1) any runtime skip
  // other than the tagged 17-oauth journey fails the whole shard — so this
  // deployment-conditional skip red-lit browser shard 3 of the v0.13.6 gate
  // (run 33002502228) even though its four siblings passed. It is the browser
  // twin of CONN-26 (both added 2026-08-24, 5b070ebb18) and, like CONN-26, has
  // never cleared a deployed gate. Tag it so the gate EXCLUDES it (an
  // authorized outcome) instead of counting a runtime skip as unauthorized.
  // Un-quarantine only in the PR whose staging dry run of tests-release.yml is
  // green with this journey enabled.
  test("a fresh Gmail Connect Link uses Composio managed auth and Google serves sign-in", { tag: "@quarantine" }, async ({
    page,
    request,
  }) => {
    const status = await api<ConnectStatus>(
      session.access_token,
      "GET",
      "/connectors/connect-status",
    );
    const providers =
      status.providers ?? (status.provider ? [status.provider] : []);
    test.skip(!providers.includes("composio"), "Composio is not configured");

    const slug = `gmail-oauth-${Date.now().toString(36)}`;
    await api(
      session.access_token,
      "POST",
      `/connectors/projects/${project.id}/connectors`,
      {
        slug,
        name: "Gmail OAuth regression",
        provider: "composio",
        app: "gmail",
        auth: { type: "none" },
        create_only: true,
      },
    );
    const connected = await api<{
      provider: string;
      app: string;
      connected: boolean;
      isNoAuth: boolean;
      connectUrl: string;
      sessionId: string;
      requestId: string;
    }>(
      session.access_token,
      "POST",
      `/connectors/projects/${project.id}/connectors/${slug}/connect`,
      {
        success_redirect_uri: "https://dev.kortix.com/oauth-proof",
        error_redirect_uri: "https://dev.kortix.com/oauth-proof-error",
      },
    );
    expect(connected).toEqual(
      expect.objectContaining({
        provider: "composio",
        app: "gmail",
        connected: false,
        isNoAuth: false,
        connectUrl: expect.stringMatching(/^https:\/\/connect\.composio\.dev\//),
        sessionId: expect.stringMatching(/^trs_/),
        requestId: expect.any(String),
      }),
    );

    const googleRequest = page.waitForRequest(
      (request) => new URL(request.url()).hostname === "accounts.google.com",
      { timeout: 60_000 },
    );
    await page.goto(connected.connectUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const googleUrl = new URL((await googleRequest).url());
    expect(googleUrl.hostname).toBe("accounts.google.com");
    const googleResponse = await request.get(googleUrl.toString(), {
      timeout: 60_000,
    });
    expect(googleResponse.ok()).toBe(true);
    const googleBody = await googleResponse.text();
    expect(googleBody).not.toMatch(/this app is blocked/i);
    expect(googleBody).toMatch(/sign in|choose an account/i);
  });
});
