import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

import { loadEnv } from "../../src/core/env";
import { mergeDatabaseProjectMetadata } from "../../src/fixtures/database-project";
import { createApiJsonClient } from "../helpers/http";
import {
  createManifestProject,
  fundAccount,
  isDeployedTarget,
  type ManifestProject,
} from "../helpers/manifest-project";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import { dismissOnboarding, dismissWelcomeCard } from "../helpers/ui";

const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321",
  password: "E2eBootQueueEdit123!",
};
const api = createApiJsonClient(apiBase);

const FIRST = "Set up the release checklist";
const QUEUED = "Then compare it with the attached notes";
const EDITED = "Then compare it with the attached notes and list the gaps";

// While a new session's computer boots, the instant shell is the session page:
// the first prompt waits in it and later messages queue above its composer.
// Edit on a queued row used to DELETE the row and refill the composer with its
// text parts only, so every file on the message was lost. Edit now opens the
// row in place and Submit PATCHes its text, which keeps the row's files.
test("39 — editing a message queued during boot keeps its files", async ({ page }, testInfo) => {
  // The journey holds the session in boot by answering `/start` itself. A
  // deployed target would boot a real computer and swap the shell for the chat.
  test.skip(isDeployedTarget(), "local profile only: /start is held at provisioning");
  test.setTimeout(180_000);
  const env = loadEnv();
  const user = await createAuthUser(
    `e2e-boot-queue-edit-${randomUUID()}@example.test`,
    authOptions,
  );
  let projectFixture: ManifestProject | undefined;
  const promptWrites: Array<{ method: string; path: string }> = [];

  try {
    const auth = await signIn(user.email!, authOptions);
    const accounts = await api<{ account_id: string; personal_account?: boolean }[]>(
      auth.access_token,
      "GET",
      "/accounts",
    );
    const account = accounts.find((item) => item.personal_account) ?? accounts[0];
    if (!env.databaseUrl) throw new Error("KE2E_DATABASE_URL is required");
    await fundAccount(env.databaseUrl, account.account_id);
    const project = await createManifestProject({
      api,
      accessToken: auth.access_token,
      accountId: account.account_id,
      userId: user.id,
      name: `Boot queue edit ${Date.now()}`,
      databaseUrl: env.databaseUrl,
    });
    projectFixture = project;
    await mergeDatabaseProjectMetadata(env, project.id, {
      experimental: { llm_gateway: true },
    });
    // The deterministic local profile has no live managed model catalog. Hand
    // the picker its real server-resolved default, as journey 28 does, so the
    // composer can send; every prompt request below reaches the real API.
    const defaults = await api<{ resolvedForCaller: string | null }>(
      auth.access_token,
      "GET",
      `/projects/${project.id}/model-defaults`,
    );
    const modelId = defaults.resolvedForCaller ?? "";
    expect(modelId).not.toBe("");
    const picker = await api<Record<string, unknown>>(
      auth.access_token,
      "GET",
      `/projects/${project.id}/model-picker`,
    );
    const enabledPicker = {
      ...picker,
      models: {
        [modelId]: {
          id: modelId,
          name: "E2E managed model",
          provider: "openai",
          enabled: true,
          tool_call: true,
          attachment: true,
          limit: { context: 128_000, output: 8_000 },
        },
      },
      defaultModel: modelId,
    };

    // A new session whose first prompt is already durable: the page opens it
    // on the instant shell.
    const session = await api<{ session_id: string }>(
      auth.access_token,
      "POST",
      `/projects/${project.id}/sessions`,
      { pending_prompt: { text: FIRST, parts: [{ type: "text", text: FIRST }] } },
      201,
    );
    const sessionId = session.session_id;
    const promptsPath = `/v1/projects/${project.id}/sessions/${sessionId}/prompts`;

    await page.route("**/*", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.startsWith(promptsPath) && request.method() !== "GET") {
        promptWrites.push({ method: request.method(), path });
      }
      if (request.method() === "GET" && path === `/v1/projects/${project.id}/model-picker`) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(enabledPicker),
        });
        return;
      }
      // The computer stays in boot for the whole journey.
      if (path === `/v1/projects/${project.id}/sessions/${sessionId}/start`) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            stage: "provisioning",
            agent_name: "kortix",
            retriable: true,
            sandbox: null,
            opencode_session_id: null,
          }),
        });
        return;
      }
      await route.continue();
    });

    await installBrowserSessionDirect(
      page,
      auth,
      `/projects/${project.id}/sessions/${sessionId}`,
      authOptions,
    );
    await dismissOnboarding(page);
    const input = page.getByRole("textbox", { name: "Message input" });
    await expect(input).toBeVisible({ timeout: 60_000 });
    // The shell draws the first prompt from the server's inbox row.
    await expect(
      page.getByText(FIRST, { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 30_000 });

    await test.step("a message with a file queues behind the first prompt", async () => {
      await page.locator("input[type=file]").setInputFiles({
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Release notes to compare"),
      });
      await expect(
        page.locator('li > div[aria-busy="true"]:has([title="notes.txt"])'),
      ).toHaveCount(0, { timeout: 30_000 });
      await input.fill(QUEUED);
      const queued = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === promptsPath,
      );
      // Ctrl+Enter is the explicit queue intent: the row joins the list above
      // the composer, where Edit lives.
      await input.press("Control+Enter");
      expect((await queued).status()).toBe(202);
      const row = page.locator("[data-queued-prompt-id]").filter({ hasText: QUEUED });
      await expect(row).toHaveAttribute("data-queued-state", "queued", { timeout: 30_000 });
      await expect(row).toContainText("1 file");
    });

    await test.step("Edit opens the row in place and sends nothing", async () => {
      const writesBefore = promptWrites.length;
      const row = page.locator("[data-queued-prompt-id]").filter({ hasText: QUEUED });
      await dismissWelcomeCard(page);
      await row.hover();
      await row.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(input).toHaveText(QUEUED);
      // The row stays in its slot, drawn as the editing row.
      await expect(row).toHaveCount(0);
      await expect(page.locator("[data-queued-editing]")).toContainText(QUEUED);
      // The send control says Submit, not the boot-time disabled Stop.
      await expect(page.getByRole("button", { name: "Submit", exact: true })).toBeEnabled();
      expect(promptWrites.slice(writesBefore)).toEqual([]);
      await testInfo.attach("boot-shell-queued-edit-open", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });

    await test.step("Submit saves the words into the same row, and the file stays", async () => {
      const writesBefore = promptWrites.length;
      await input.fill(EDITED);
      const save = page.waitForRequest(
        (request) =>
          request.method() === "PATCH" &&
          new URL(request.url()).pathname.startsWith(`${promptsPath}/`),
      );
      await page.getByRole("button", { name: "Submit", exact: true }).click();
      const saved = await save;
      expect(saved.postDataJSON()).toEqual({ text: EDITED });
      expect((await saved.response())?.status()).toBe(200);
      // One PATCH: no DELETE of the row and no re-POST of the message.
      expect(promptWrites.slice(writesBefore).map((write) => write.method)).toEqual(["PATCH"]);
      await expect(input).toBeEmpty();
      const row = page.locator("[data-queued-prompt-id]").filter({ hasText: EDITED });
      await expect(row).toBeVisible();
      await expect(row).toContainText("1 file");
      await expect(page.locator("[data-queued-editing]")).toHaveCount(0);
      await testInfo.attach("boot-shell-queued-edit-saved", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });

    await test.step("the server row holds the new text and the file", async () => {
      const listed = await api<{
        prompts: Array<{
          full_text: string;
          placement: string;
          attachments: Array<{ filename: string; mime: string }>;
        }>;
      }>(auth.access_token, "GET", `/projects/${project.id}/sessions/${sessionId}/prompts`);
      expect(listed.prompts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            placement: "composer",
            full_text: EDITED,
            attachments: [{ filename: "notes.txt", mime: "text/plain" }],
          }),
        ]),
      );
    });
  } finally {
    try {
      if (projectFixture) await projectFixture.dispose();
    } finally {
      await deleteAuthUser(user.id, authOptions);
    }
  }
});
