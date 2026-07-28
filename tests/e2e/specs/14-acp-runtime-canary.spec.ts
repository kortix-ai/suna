import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createApiJsonClient } from "../helpers/http";
import {
  type AuthSession,
  type AuthUser,
  createAuthUser,
  deleteAuthUser,
  installBrowserSession,
  signIn,
} from "../helpers/session-auth";

const enabled = process.env.E2E_ENABLE_ACP_RUNTIME === "1";
const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const supabaseUrl = process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321";
const databaseUrl =
  process.env.E2E_DATABASE_URL ||
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const password = "AcpRuntimeCanary123!";
const api = createApiJsonClient(apiBase);
const authOptions = { supabaseUrl, password };

async function waitForReadySession(
  token: string,
  projectId: string,
  sessionId: string,
  expectedTransport: "acp" | "rest",
): Promise<string> {
  const deadline = Date.now() + 12 * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const result = await api<{
      stage: string;
      runtime_transport?: "acp" | "rest";
      sandbox?: { status?: string; external_id?: string | null } | null;
    }>(
      token,
      "POST",
      `/projects/${projectId}/sessions/${sessionId}/start?wait_ms=8000`,
      {},
    );
    last = `${result.stage}:${result.sandbox?.status ?? "none"}:${result.runtime_transport}`;
    if (result.stage === "failed" || result.sandbox?.status === "failed") {
      throw new Error(`session failed before readiness: ${last}`);
    }
    if (
      result.stage === "ready" &&
      result.sandbox?.status === "active" &&
      result.sandbox.external_id &&
      result.runtime_transport === expectedTransport
    ) {
      return result.sandbox.external_id;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`session did not become ready: ${last}`);
}

async function waitForRuntimeHealth(
  token: string,
  sandboxExternalId: string,
): Promise<void> {
  const deadline = Date.now() + 2 * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const health = await api<{
        runtimeReady?: boolean;
        opencode?: string;
        opencode_session_id?: string | null;
      }>(token, "GET", `/p/${sandboxExternalId}/8000/kortix/health`);
      last = `${health.runtimeReady}:${health.opencode}:${health.opencode_session_id}`;
      if (
        health.runtimeReady === true &&
        health.opencode === "ok" &&
        health.opencode_session_id
      ) {
        return;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`runtime did not recover after restart: ${last}`);
}

test.describe.serial("14 — OpenCode ACP runtime canary", () => {
  test.skip(
    !enabled,
    "Set E2E_ENABLE_ACP_RUNTIME=1 for the real sandbox flow.",
  );
  test.setTimeout(20 * 60_000);

  let user: AuthUser;
  let auth: AuthSession;
  let projectId = "";
  let sessionId = "";
  let sandboxExternalId = "";

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(20 * 60_000);
    const email = `acp-runtime-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
    user = await createAuthUser(email, authOptions);
    auth = await signIn(email, authOptions);

    const accounts = await api<
      Array<{ account_id: string; personal_account?: boolean }>
    >(auth.access_token, "GET", "/accounts");
    const account =
      accounts.find((item) => item.personal_account) ?? accounts[0];
    expect(account?.account_id).toBeTruthy();
    execFileSync(
      "psql",
      [
        databaseUrl,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `INSERT INTO kortix.credit_accounts (account_id, balance, tier)
         VALUES ('${account.account_id}', 1000, 'tier_2_20')
         ON CONFLICT (account_id)
         DO UPDATE SET balance = 1000, tier = 'tier_2_20'`,
      ],
      { stdio: "ignore" },
    );

    const project = await api<{ project_id: string }>(
      auth.access_token,
      "POST",
      "/projects/provision",
      {
        account_id: account.account_id,
        name: `ACP runtime E2E ${Date.now()}`,
        seed_starter: true,
      },
      201,
    );
    projectId = project.project_id;
    await api(auth.access_token, "PATCH", `/projects/${projectId}/onboarding`, {
      completed: true,
    });
    await api(
      auth.access_token,
      "PUT",
      `/projects/${projectId}/model-defaults`,
      { scope: "project", model: "claude-sonnet-4.6" },
    );
    const agentConfig = await api<{
      editable: boolean;
      block: {
        opencode?: {
          permission?: string | Record<string, unknown>;
          [key: string]: unknown;
        };
        [key: string]: unknown;
      } | null;
    }>(auth.access_token, "GET", `/projects/${projectId}/agents/kortix/config`);
    expect(agentConfig.editable).toBe(true);
    expect(agentConfig.block).toBeTruthy();
    const currentPermission = agentConfig.block?.opencode?.permission;
    const allowAllAgentCapabilities = {
      read: "allow",
      edit: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      task: "allow",
      external_directory: "allow",
      lsp: "allow",
      todowrite: "allow",
      question: "allow",
      webfetch: "allow",
      websearch: "allow",
      doom_loop: "allow",
      skill: "allow",
    };
    const permission =
      currentPermission &&
      typeof currentPermission === "object" &&
      !Array.isArray(currentPermission)
        ? { ...currentPermission, bash: "ask" }
        : { ...allowAllAgentCapabilities, bash: "ask" };
    await api(
      auth.access_token,
      "PUT",
      `/projects/${projectId}/agents/kortix/config`,
      {
        ...agentConfig.block,
        opencode: {
          ...agentConfig.block?.opencode,
          permission,
        },
      },
    );
    await api(
      auth.access_token,
      "PATCH",
      `/projects/${projectId}/experimental`,
      { feature: "acp_runtime", enabled: false },
    );
    const session = await api<{ session_id: string }>(
      auth.access_token,
      "POST",
      `/projects/${projectId}/sessions`,
      {
        name: "ACP browser canary",
        opencode_model: "kortix/claude-sonnet-4.6",
      },
      201,
    );
    sessionId = session.session_id;
    sandboxExternalId = await waitForReadySession(
      auth.access_token,
      projectId,
      sessionId,
      "rest",
    );
  });

  test.afterAll(async ({}, testInfo) => {
    testInfo.setTimeout(2 * 60_000);
    if (projectId && sessionId) {
      await api(
        auth.access_token,
        "DELETE",
        `/projects/${projectId}/sessions/${sessionId}`,
      ).catch(() => {});
    }
    if (projectId) {
      await api(auth.access_token, "DELETE", `/projects/${projectId}`).catch(
        () => {},
      );
    }
    if (user?.id) {
      await deleteAuthUser(user.id, {
        supabaseUrl,
        envFiles: ["apps/api/.env", "apps/web/.env"],
      });
    }
  });

  test("preserves the interactive ACP parity matrix and REST rollback", async ({
    page,
  }) => {
    const acpRpcRequests: Array<{
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }> = [];
    const acpStreamHeaders: Array<Record<string, string>> = [];
    const restPromptRequests: string[] = [];

    // Intercept one stream only. Remove the route before the reconnect so
    // Chromium can consume the deployed SSE response incrementally.
    const acpRoutePattern = /\/kortix\/acp\//;
    await page.route(
      acpRoutePattern,
      async function interruptFirstAcpStream(route) {
        const request = route.request();
        if (request.method() !== "GET") {
          await route.continue();
          return;
        }
        const origin =
          request.headers().origin ?? new URL(request.url()).origin;
        await route.fulfill({
          status: 200,
          headers: {
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Origin": origin,
            "Cache-Control": "no-cache",
            "Content-Type": "text/event-stream",
          },
          body: 'id: 0\ndata: {"jsonrpc":"2.0","method":"kortix/cursor"}\n\n',
        });
        await page.unroute(acpRoutePattern, interruptFirstAcpStream);
      },
    );

    page.on("request", (request) => {
      if (
        request.method() === "GET" &&
        request.url().includes("/kortix/acp/")
      ) {
        acpStreamHeaders.push(request.headers());
      }
      if (
        request.method() === "POST" &&
        request.url().includes("/kortix/acp/")
      ) {
        const raw = request.postData();
        if (!raw) return;
        try {
          acpRpcRequests.push({
            url: request.url(),
            headers: request.headers(),
            body: JSON.parse(raw) as Record<string, unknown>,
          });
        } catch {}
      }
      if (request.url().includes("/prompt_async")) {
        restPromptRequests.push(request.url());
      }
    });

    await installBrowserSession(
      page,
      auth,
      `/projects/${projectId}/sessions/${sessionId}?acp`,
      password,
    );
    const input = page.getByRole("textbox", { name: "Message input" });
    await expect(input).toBeVisible({ timeout: 120_000 });
    await expect
      .poll(
        () =>
          acpRpcRequests.filter(
            (request) => request.body.method === "session/load",
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(
        () =>
          acpStreamHeaders.some((headers) => headers["last-event-id"] === "0"),
        { timeout: 30_000 },
      )
      .toBe(true);
    const welcomeCard = page.getByRole("complementary", {
      name: /Welcome from Marko/i,
    });
    await welcomeCard
      .getByRole("button", { name: "Dismiss" })
      .click({ timeout: 30_000 });
    await expect(welcomeCard).toBeHidden({ timeout: 10_000 });
    await input.fill("Reply with exactly: ACP_PONG");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
      page.getByText("ACP_PONG", { exact: true }).last(),
    ).toBeVisible({
      timeout: 120_000,
    });
    expect(
      acpRpcRequests.filter(
        (request) => request.body.method === "session/prompt",
      ),
    ).toHaveLength(1);
    expect(restPromptRequests).toHaveLength(0);

    const loadCountBeforeReload = acpRpcRequests.filter(
      (request) => request.body.method === "session/load",
    ).length;
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(input).toBeVisible({ timeout: 120_000 });
    await expect(
      page.getByText("ACP_PONG", { exact: true }).last(),
    ).toBeVisible({ timeout: 120_000 });
    await expect
      .poll(
        () =>
          acpRpcRequests.filter(
            (request) => request.body.method === "session/load",
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(loadCountBeforeReload);

    await input.fill(
      "Use the bash tool to run `printf TOOL_PROOF`. Then reply with exactly TOOL_DONE.",
    );
    await input.press("Enter");
    const permissionCard = page.getByText("The agent needs your permission", {
      exact: true,
    });
    await expect(permissionCard).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(/printf TOOL_PROOF/).first()).toBeVisible();
    await page
      .getByRole("button", { name: "Allow everything", exact: true })
      .click();
    await expect(
      page.getByText("TOOL_DONE", { exact: true }).last(),
    ).toBeVisible({ timeout: 120_000 });
    expect(
      acpRpcRequests.some((request) => {
        const result = request.body.result;
        return (
          !!result &&
          typeof result === "object" &&
          JSON.stringify(result).includes('"outcome":"selected"')
        );
      }),
    ).toBe(true);

    await input.fill(
      'Use the question tool to ask "Choose one" with options Alpha and Beta. If I choose Beta, reply with exactly QUESTION_BETA.',
    );
    await input.press("Enter");
    await expect(
      page.getByText("Choose one", { exact: true }).last(),
    ).toBeVisible({ timeout: 120_000 });
    await page
      .getByRole("button", { name: "BetaOption Beta", exact: true })
      .click();
    await expect(
      page.getByText("QUESTION_BETA", { exact: true }).last(),
    ).toBeVisible({ timeout: 120_000 });
    expect(
      acpRpcRequests.some((request) => {
        const result = request.body.result;
        return (
          !!result &&
          typeof result === "object" &&
          JSON.stringify(result).includes('"action":"accept"') &&
          JSON.stringify(result).includes("Beta")
        );
      }),
    ).toBe(true);

    const fileChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Attach files" }).click();
    await (
      await fileChooser
    ).setFiles({
      name: "acp-attachment.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("ATTACHMENT_PROOF"),
    });
    await input.fill(
      "Read the attached file. Reply with exactly ATTACHMENT_OK if it contains ATTACHMENT_PROOF.",
    );
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
      page.getByText("ATTACHMENT_OK", { exact: true }).last(),
    ).toBeVisible({ timeout: 120_000 });

    await input.fill(
      "Use bash to run `sleep 5`. After it completes, reply with exactly FIRST_DONE.",
    );
    await input.press("Enter");
    await expect(page.getByText(/sleep 5/).first()).toBeVisible({
      timeout: 120_000,
    });
    await input.fill("Reply with exactly QUEUE_DONE");
    await input.press("Enter");
    await expect(
      page.getByText("Reply with exactly QUEUE_DONE", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("FIRST_DONE", { exact: true }).last(),
    ).toBeVisible({ timeout: 120_000 });
    await expect(
      page.getByText("QUEUE_DONE", { exact: true }).last(),
    ).toBeVisible({ timeout: 120_000 });

    const cancelCountBefore = acpRpcRequests.filter(
      (request) => request.body.method === "session/cancel",
    ).length;
    const promptCountBeforeCancel = acpRpcRequests.filter(
      (request) => request.body.method === "session/prompt",
    ).length;
    await input.fill(
      "Use bash to run `sleep 60`. After it completes, reply with exactly CANCEL_FAILED.",
    );
    await input.press("Enter");
    await expect
      .poll(
        () =>
          acpRpcRequests.filter(
            (request) => request.body.method === "session/prompt",
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(promptCountBeforeCancel);
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect
      .poll(
        () =>
          acpRpcRequests.filter(
            (request) => request.body.method === "session/cancel",
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(cancelCountBefore);
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("CANCEL_FAILED", { exact: true })).toHaveCount(
      0,
    );

    const promptCountBeforeCommand = acpRpcRequests.filter(
      (request) => request.body.method === "session/prompt",
    ).length;
    const cancelCountBeforeCommand = acpRpcRequests.filter(
      (request) => request.body.method === "session/cancel",
    ).length;
    await input.fill("/review");
    await input.press("Enter");
    await expect(
      page.getByText("/review", { exact: true }).last(),
    ).toBeVisible();
    await input.press("Enter");
    await expect
      .poll(
        () =>
          acpRpcRequests
            .filter((request) => request.body.method === "session/prompt")
            .slice(promptCountBeforeCommand)
            .some((request) =>
              JSON.stringify(request.body.params).includes(
                '"prompt":[{"type":"text","text":"/review"}]',
              ),
            ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect
      .poll(
        () =>
          acpRpcRequests.filter(
            (request) => request.body.method === "session/cancel",
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(cancelCountBeforeCommand);
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toBeVisible({ timeout: 30_000 });

    const streamCountBeforeRestart = acpStreamHeaders.length;
    await api(
      auth.access_token,
      "POST",
      `/p/${sandboxExternalId}/8000/kortix/refresh/`,
      {},
    );
    await waitForRuntimeHealth(auth.access_token, sandboxExternalId);
    await expect
      .poll(() => acpStreamHeaders.length, { timeout: 120_000 })
      .toBeGreaterThan(streamCountBeforeRestart);
    await input.fill("Reply with exactly: POST_RESTART_PONG");
    await input.press("Enter");
    await expect(
      page.getByText("POST_RESTART_PONG", { exact: true }).last(),
    ).toBeVisible({ timeout: 120_000 });

    const rewindPrompt = "Reply with exactly: ACP_PONG";
    const rewindTurn = page
      .getByText(rewindPrompt, { exact: true })
      .locator('xpath=ancestor::*[@data-turn-id][1]');
    const revertCountBefore = acpRpcRequests.filter(
      (request) => request.body.method === "session/revert",
    ).length;
    await rewindTurn.hover();
    await rewindTurn
      .getByRole("button", { name: "Edit message and rewind session" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Edit from this message?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Rewind session" }).click();
    await expect(input).toHaveValue(rewindPrompt);
    await expect(page.getByText("Session rewound", { exact: true })).toBeVisible();
    await expect
      .poll(
        () =>
          acpRpcRequests.filter(
            (request) => request.body.method === "session/revert",
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(revertCountBefore);
    await expect(
      page.getByText("POST_RESTART_PONG", { exact: true }),
    ).toHaveCount(0);

    const unrevertCountBefore = acpRpcRequests.filter(
      (request) => request.body.method === "session/unrevert",
    ).length;
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect
      .poll(
        () =>
          acpRpcRequests.filter(
            (request) => request.body.method === "session/unrevert",
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(unrevertCountBefore);
    await expect(
      page.getByText("POST_RESTART_PONG", { exact: true }).last(),
    ).toBeVisible();
    await expect(input).toHaveValue("");

    const restoredRewindTurn = page
      .getByText(rewindPrompt, { exact: true })
      .locator('xpath=ancestor::*[@data-turn-id][1]');
    await restoredRewindTurn.hover();
    await restoredRewindTurn
      .getByRole("button", { name: "Edit message and rewind session" })
      .click();
    await page.getByRole("button", { name: "Rewind session" }).click();
    await expect(input).toHaveValue(rewindPrompt);
    await input.fill("Reply with exactly: ACP_REWIND_REPLACEMENT_UI");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
      page.getByText("ACP_REWIND_REPLACEMENT_UI", { exact: true }).last(),
    ).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("Session rewound", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByText("POST_RESTART_PONG", { exact: true }),
    ).toHaveCount(0);

    await page.goto(`/projects/${projectId}/sessions/${sessionId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(input).toBeVisible({ timeout: 120_000 });
    const modelPicker = page.getByRole("button", { name: "Model picker" });
    await expect(modelPicker).toBeVisible({ timeout: 120_000 });
    await modelPicker.click();
    const restModel = page
      .locator('[data-slot="command-item"]')
      .filter({ hasText: "Claude Sonnet 4.6" })
      .first();
    await expect(restModel).toBeVisible({ timeout: 120_000 });
    await page.keyboard.press("Escape");
    await expect(restModel).toBeHidden({ timeout: 30_000 });
    expect(restPromptRequests).toHaveLength(0);
    await input.fill("Reply with exactly: REST_PONG");
    await input.press("Enter");
    await expect(
      page.getByText("REST_PONG", { exact: true }).last(),
    ).toBeVisible({
      timeout: 120_000,
    });
    expect(restPromptRequests).toHaveLength(1);
  });
});
