import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

import { loadEnv } from "../../src/core/env";
import {
  createDatabaseSession,
  mergeDatabaseProjectMetadata,
} from "../../src/fixtures/database-project";
import { runDatabaseSql } from "../helpers/database";
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

type ListedPrompt = {
  prompt_id: string;
  client_message_id: string;
  full_text: string;
  state: string;
  placement: string;
  attachments: Array<{ filename: string; mime: string }>;
};

// While a new session's computer boots, the instant shell is the session page:
// the first prompt waits in it and later messages queue above its composer.
// Edit on a queued row used to DELETE the row and refill the composer with its
// text parts only, so every file on the message was lost. Edit now opens the
// row in place and Submit PATCHes its text, which keeps the row's files.
test("39 — editing a message queued during boot keeps its files", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const env = loadEnv();
  const user = await createAuthUser(
    `e2e-boot-queue-edit-${randomUUID()}@example.test`,
    authOptions,
  );
  let projectFixture: ManifestProject | undefined;
  const promptWrites: Array<{ method: string; path: string }> = [];
  // While set, the save waits for it, so the server still has the old words.
  let saveHeld: Promise<void> | undefined;

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
    // composer can send; every prompt request below reaches the real API. A
    // deployed target keeps its real catalog: a text file needs no vision.
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

    // A session in boot, seeded as the server holds one: the session row, and
    // its first prompt as the inbox row a create with `pending_prompt` writes
    // (`pending:<session_id>`). During boot the drain has that prompt claimed
    // and waits for the runtime (`deliver.ts`), so it is seeded delivering,
    // under a fixture lock no drain takes over. Every later message waits
    // behind it, on any target, and nothing provisions a computer. The local
    // profile could not create the session anyway: `POST /sessions` answers
    // 503 KORTIX_URL_UNREACHABLE there.
    const sessionId = await createDatabaseSession(env, {
      projectId: project.id,
      accountId: account.account_id,
      userId: user.id,
    });
    await runDatabaseSql(
      `INSERT INTO kortix.session_lifecycle_commands
         (command_type, source, status, project_id, session_id, account_id,
          actor_user_id, idempotency_key, payload, result, locked_by, locked_until)
       VALUES ('continue_session', 'ui', 'running', $1, $2, $3, $4, $5, $6::jsonb,
         $7::jsonb, 'browser-boot-queue-fixture', now() + interval '10 minutes')`,
      [
        project.id,
        sessionId,
        account.account_id,
        user.id,
        `prompt:${sessionId}:pending-first`,
        JSON.stringify({
          text: FIRST,
          clientMessageId: `pending:${sessionId}`,
          remintOnDelivery: true,
          parts: [{ type: "text", text: FIRST }],
        }),
        JSON.stringify({ delivery_started_at: new Date().toISOString() }),
      ],
      env.databaseUrl,
    );
    const promptsPath = `/v1/projects/${project.id}/sessions/${sessionId}/prompts`;
    const listPrompts = async () =>
      (
        await api<{ prompts: ListedPrompt[] }>(
          auth.access_token,
          "GET",
          `/projects/${project.id}/sessions/${sessionId}/prompts`,
        )
      ).prompts;

    await page.route("**/*", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.startsWith(promptsPath) && request.method() !== "GET") {
        promptWrites.push({ method: request.method(), path });
      }
      if (saveHeld && request.method() === "PATCH" && path.startsWith(`${promptsPath}/`)) {
        await saveHeld;
      }
      if (
        !isDeployedTarget() &&
        request.method() === "GET" &&
        path === `/v1/projects/${project.id}/model-picker`
      ) {
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
            failure: null,
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
    // The shell draws the first prompt from its inbox row.
    await expect(
      page.getByText(FIRST, { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    // The floating welcome card covers the lower-right of the composer.
    await dismissWelcomeCard(page);

    let queuedRow: ListedPrompt | undefined;
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
      const accepted = await queued;
      expect(accepted.status()).toBe(202);
      expect(accepted.request().postDataJSON()).toMatchObject({
        placement: "composer",
        parts: [
          { type: "text", text: QUEUED },
          expect.objectContaining({ attachment_id: expect.any(String) }),
        ],
      });
      const row = page.locator("[data-queued-prompt-id]").filter({ hasText: QUEUED });
      await expect(row).toHaveAttribute("data-queued-state", "queued", { timeout: 30_000 });
      await expect(row).toContainText("1 file");
      // The POST's drain claims the row, finds the first prompt in delivery
      // and puts the row back behind it. Edit once it waits there, outside
      // that short claim.
      await expect
        .poll(
          async () => {
            queuedRow = (await listPrompts()).find((p) => p.full_text === QUEUED);
            return queuedRow?.state;
          },
          { timeout: 30_000 },
        )
        .toBe("waiting");
      expect(queuedRow!.attachments).toEqual([
        expect.objectContaining({ filename: "notes.txt" }),
      ]);
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
      // The PATCH names the queued row itself.
      const save = page.waitForRequest(
        (request) =>
          request.method() === "PATCH" &&
          new URL(request.url()).pathname === `${promptsPath}/${queuedRow!.prompt_id}`,
      );
      // Hold the save. Until it lands, the row must already show the new words,
      // once, with its file — and keep them through an inbox read the server
      // answers with the old words. It used to flash the old words back.
      let releaseSave!: () => void;
      saveHeld = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      await page.getByRole("button", { name: "Submit", exact: true }).click();
      const saved = await save;
      const rows = page.locator("[data-queued-prompt-id]");
      try {
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toContainText(EDITED);
        await expect(rows.first()).toContainText("1 file");
        const staleRead = await page.waitForResponse(
          (response) =>
            response.request().method() === "GET" &&
            new URL(response.url()).pathname === promptsPath,
        );
        expect(
          ((await staleRead.json()) as { prompts: ListedPrompt[] }).prompts.map((p) => p.full_text),
        ).toContain(QUEUED);
        // Let the page draw that read before looking again.
        await page.waitForTimeout(500);
        await expect(rows.first()).toContainText(EDITED, { timeout: 2_000 });
      } finally {
        saveHeld = undefined;
        releaseSave();
      }
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

    await test.step("the server row holds the new text and the same file", async () => {
      const prompts = await listPrompts();
      // The first prompt and the edited row; no copy of the old words.
      expect(prompts.map((p) => p.client_message_id).sort()).toEqual(
        [`pending:${sessionId}`, queuedRow!.client_message_id].sort(),
      );
      const edited = prompts.find((p) => p.prompt_id === queuedRow!.prompt_id);
      expect(edited).toMatchObject({ full_text: EDITED, state: "waiting" });
      expect(edited!.attachments).toEqual(queuedRow!.attachments);
    });
  } finally {
    try {
      if (projectFixture) await projectFixture.dispose();
    } finally {
      await deleteAuthUser(user.id, authOptions);
    }
  }
});
