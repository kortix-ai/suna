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
      `/projects/${project.id}/connectors`,
      authOptions,
    );
    await selectAccountForUi(page, accountId);

    const statusResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/connectors/connect-status") &&
        response.request().method() === "GET",
    );
    await page.goto(`/projects/${project.id}/connectors`, {
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
    expect(createBody).toEqual(
      expect.objectContaining({
        name: "Composio Search",
        slug: "composio-search",
        provider: "composio",
        app: "composio_search",
        authorization_strategy: "project",
        create_only: true,
      }),
    );
    expect(JSON.stringify(createBody)).not.toMatch(
      /api[_-]?key|credential|secret/i,
    );
    expect((await createResponsePromise).status()).toBe(200);

    await expect(page).toHaveURL(new RegExp(`[?&]scope=connected(?:&|$)`));
    await expect(page).toHaveURL(new RegExp(`[?&]c=composio-search(?:&|$)`));
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
            `/v1/connectors/projects/${project.id}/connectors/composio-search/connect`,
          ) && request.method() === "POST",
    );
    const connectResponsePromise = page.waitForResponse(
      (response) =>
        response
          .url()
          .endsWith(
            `/v1/connectors/projects/${project.id}/connectors/composio-search/connect`,
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
    await expect(
      page.getByRole("heading", { name: "Connected", exact: true }),
    ).toBeVisible();

    const connections = await api<ConnectionList>(
      session.access_token,
      "GET",
      `/projects/${project.id}/connections`,
    );
    const connection = connections.connections.find(
      (item) =>
        item.connector_alias === "composio-search" &&
        item.owner_type === "project" &&
        item.is_default,
    );
    expect(connection).toBeDefined();
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
});
