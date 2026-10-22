import { randomUUID } from "node:crypto";
import { type Page, type Request, expect, test } from "@playwright/test";

import { loadEnv } from "../../src/core/env";
import {
  createDatabaseSession,
  seedDatabaseRunningFirstPrompt,
} from "../../src/fixtures/database-project";
import { createApiJsonClient } from "../helpers/http";
import { createManifestProject, fundAccount, type ManifestProject } from "../helpers/manifest-project";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import { dismissOnboarding, dismissWelcomeCard } from "../helpers/ui";

/**
 * A session keeps its own model in the web. The CLI, the SDK and Slack set a
 * session's model as its pin (`metadata.opencode_model`). The web composer
 * ignored the pin, showed this browser's pick or the account default, and its
 * first message ran on that model instead (audit #68). The composer must open
 * on the pinned model and send it, and must not carry it into another session.
 */

const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321",
  password: "E2eSessionOwnModel123!",
};
const api = createApiJsonClient(apiBase);

const AGENT = "kortix";
const PINNED_MODEL = "e2e-pinned-model";

function promptModel(request: Request): unknown {
  const body = request.postDataJSON() as { overrides?: { model?: unknown } };
  return body.overrides?.model;
}

async function openSession(page: Page, projectId: string, sessionId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/sessions/${sessionId}`);
  await dismissOnboarding(page);
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible({ timeout: 60_000 });
  await dismissWelcomeCard(page);
}

async function sendAndReadModel(page: Page, sessionId: string, text: string): Promise<unknown> {
  const sent = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith(`/sessions/${sessionId}/prompts`),
  );
  const input = page.getByRole("textbox", { name: "Message input" });
  await input.fill(text);
  await input.press("Enter");
  return promptModel(await sent);
}

test("55 — a session opens on its own model and its first web message keeps it", async ({ page }) => {
  test.setTimeout(240_000);
  const env = loadEnv();
  if (!env.databaseUrl) throw new Error("KE2E_DATABASE_URL is required");
  const runId = randomUUID();
  const user = await createAuthUser(`e2e-session-own-model-${runId}@example.test`, authOptions);
  let project: ManifestProject | undefined;

  try {
    const auth = await signIn(user.email!, authOptions);
    const accounts = await api<{ account_id: string; personal_account?: boolean }[]>(
      auth.access_token,
      "GET",
      "/accounts",
    );
    const accountId = (accounts.find((item) => item.personal_account) ?? accounts[0]).account_id;
    await fundAccount(env.databaseUrl, accountId);
    project = await createManifestProject({
      api,
      accessToken: auth.access_token,
      accountId,
      userId: user.id,
      name: `Session own model ${Date.now()}`,
      databaseUrl: env.databaseUrl,
    });
    const projectId = project.id;
    const defaults = await api<{ resolvedForCaller: string | null }>(
      auth.access_token,
      "GET",
      `/projects/${projectId}/model-defaults`,
    );
    const defaultModel = defaults.resolvedForCaller ?? "";
    expect(defaultModel).not.toBe("");
    const picker = await api<Record<string, unknown>>(
      auth.access_token,
      "GET",
      `/projects/${projectId}/model-picker`,
    );

    // A session set to a model by the CLI, the SDK or Slack: the pin those
    // surfaces write. Its first prompt is still running, so the web's message
    // queues behind it and no computer boots.
    const pinned = await createDatabaseSession(env, {
      projectId,
      accountId,
      userId: user.id,
      metadata: { opencode_model: `kortix/${PINNED_MODEL}`, opencode_model_source: "explicit" },
    });
    await seedDatabaseRunningFirstPrompt(env, { projectId, sessionId: pinned, accountId, userId: user.id });
    // A session of the same agent with no pin of its own.
    const unpinned = await createDatabaseSession(env, { projectId, accountId, userId: user.id });
    await seedDatabaseRunningFirstPrompt(env, { projectId, sessionId: unpinned, accountId, userId: user.id });

    await page.route("**/*", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      // The local profile has no managed model catalog: offer the resolved
      // default and the pinned model (as in spec 28).
      if (request.method() === "GET" && path === `/v1/projects/${projectId}/model-picker`) {
        const model = (id: string, name: string) => ({
          id,
          name,
          provider: "openai",
          enabled: true,
          tool_call: true,
          attachment: true,
          limit: { context: 128_000, output: 8_000 },
        });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...picker,
            models: {
              [defaultModel]: model(defaultModel, "E2E default model"),
              [PINNED_MODEL]: model(PINNED_MODEL, "E2E pinned model"),
            },
            defaultModel,
          }),
        });
        return;
      }
      // The computer stays in boot: the composer under test is the boot shell's.
      const start = path.match(/^\/v1\/projects\/[^/]+\/sessions\/([^/]+)\/start$/);
      if (start) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            stage: "provisioning",
            agent_name: AGENT,
            retriable: true,
            sandbox: null,
            opencode_session_id: null,
            failure: null,
          }),
        });
        return;
      }
      await route.continue();
    });
    await installBrowserSessionDirect(page, auth, `/projects/${projectId}`, authOptions);

    await test.step("the pinned session shows its model and its first web message sends it", async () => {
      await openSession(page, projectId, pinned);
      await expect(page.getByRole("button", { name: /E2E pinned model/ })).toBeVisible({ timeout: 30_000 });
      expect(await sendAndReadModel(page, pinned, "Summarize the open pull requests")).toEqual({
        providerID: "kortix",
        modelID: PINNED_MODEL,
      });
    });

    await test.step("another session does not inherit the pinned model", async () => {
      await openSession(page, projectId, unpinned);
      await expect(page.getByRole("button", { name: /E2E default model/ })).toBeVisible({ timeout: 30_000 });
      expect(await sendAndReadModel(page, unpinned, "Draft the release notes")).toEqual({
        providerID: "kortix",
        modelID: defaultModel,
      });
    });
  } finally {
    try {
      if (project) await project.dispose();
    } finally {
      await deleteAuthUser(user.id, authOptions);
    }
  }
});
