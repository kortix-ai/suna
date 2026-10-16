import { randomUUID } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";

import { loadEnv } from "../../src/core/env";
import {
  createDatabaseSession,
  mergeDatabaseProjectMetadata,
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
 * A draft keeps its attached files. Draft text survived a session switch and a
 * reload, but the composer deleted its uploads when it unmounted, so the files
 * had to be attached again (audit #71). A finished upload now stays with the
 * draft by its handle: it comes back after a switch with its picture, after a
 * reload by name, and the next Send carries it.
 */

const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321",
  password: "E2eDraftKeepsUploads123!",
};
const api = createApiJsonClient(apiBase);

const AGENT = "kortix";
const FILE = "keep-me.png";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function composerReady(page: Page): Promise<void> {
  await dismissOnboarding(page);
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible({ timeout: 60_000 });
  await dismissWelcomeCard(page);
}

test("56 — a draft keeps its attached files across a session switch and a reload", async ({ page }) => {
  test.setTimeout(240_000);
  const env = loadEnv();
  if (!env.databaseUrl) throw new Error("KE2E_DATABASE_URL is required");
  const runId = randomUUID();
  const user = await createAuthUser(`e2e-draft-uploads-${runId}@example.test`, authOptions);
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
      name: `Draft keeps uploads ${Date.now()}`,
      databaseUrl: env.databaseUrl,
    });
    const projectId = project.id;
    await mergeDatabaseProjectMetadata(env, projectId, { experimental: { llm_gateway: true } });
    const defaults = await api<{ resolvedForCaller: string | null }>(
      auth.access_token,
      "GET",
      `/projects/${projectId}/model-defaults`,
    );
    const modelId = defaults.resolvedForCaller ?? "";
    expect(modelId).not.toBe("");
    const picker = await api<Record<string, unknown>>(
      auth.access_token,
      "GET",
      `/projects/${projectId}/model-picker`,
    );
    // Two sessions whose first prompt still runs: a message queues and no computer boots.
    const session = async (name: string) => {
      const id = await createDatabaseSession(env, {
        projectId,
        accountId,
        userId: user.id,
        metadata: { custom_name: name },
      });
      await seedDatabaseRunningFirstPrompt(env, { projectId, sessionId: id, accountId, userId: user.id });
      return id;
    };
    const first = await session("Draft alpha");
    const second = await session("Draft beta");

    const deletes: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "DELETE" && path.includes(`/v1/projects/${projectId}/attachments/`)) {
        deletes.push(path.split("/").pop() ?? "");
      }
    });
    await page.route("**/*", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      // The local profile has no managed model catalog (as in spec 28).
      if (request.method() === "GET" && path === `/v1/projects/${projectId}/model-picker`) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
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
          }),
        });
        return;
      }
      // The computers stay in boot: the composer under test is the boot shell's.
      if (/^\/v1\/projects\/[^/]+\/sessions\/[^/]+\/start$/.test(path)) {
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
    await installBrowserSessionDirect(page, auth, `/projects/${projectId}/sessions/${first}`, authOptions);
    await composerReady(page);

    const busy = page.locator(`li > div[aria-busy="true"]:has([title="${FILE}"])`);
    let attachmentId = "";
    await test.step("a file attached in the first session finishes uploading", async () => {
      const begin = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === `/v1/projects/${projectId}/attachments`,
      );
      await page.locator("input[type=file]").setInputFiles({ name: FILE, mimeType: "image/png", buffer: PNG });
      attachmentId = ((await (await begin).json()) as { attachment_id: string }).attachment_id;
      expect(attachmentId).not.toBe("");
      await expect(page.locator(`img[alt="${FILE}"]`)).toBeVisible();
      await expect(busy).toHaveCount(0, { timeout: 30_000 });
      await page.getByRole("textbox", { name: "Message input" }).fill("Describe this picture");
    });

    await test.step("a switch to another session and back keeps the file, with its picture", async () => {
      await page.getByText("Draft beta", { exact: true }).first().click();
      await expect(page).toHaveURL(new RegExp(`/sessions/${second}`));
      await composerReady(page);
      await expect(page.locator(`[title="${FILE}"]`)).toHaveCount(0);
      await page.getByText("Draft alpha", { exact: true }).first().click();
      await expect(page).toHaveURL(new RegExp(`/sessions/${first}`));
      await composerReady(page);
      await expect(page.getByRole("textbox", { name: "Message input" })).toHaveText("Describe this picture");
      await expect(page.locator(`img[alt="${FILE}"]`)).toBeVisible({ timeout: 15_000 });
      expect(deletes).not.toContain(attachmentId);
    });

    await test.step("a reload keeps the file by name", async () => {
      await page.reload();
      await composerReady(page);
      await expect(page.getByRole("textbox", { name: "Message input" })).toHaveText("Describe this picture");
      await expect(page.locator(`[title="${FILE}"]`)).toBeVisible({ timeout: 15_000 });
      expect(deletes).not.toContain(attachmentId);
    });

    await test.step("the next Send carries the kept upload by its handle", async () => {
      const sent = page.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          new URL(request.url()).pathname.endsWith(`/sessions/${first}/prompts`),
      );
      await page.getByRole("textbox", { name: "Message input" }).press("Enter");
      const body = (await sent).postDataJSON() as { parts?: Array<{ attachment_id?: string }> };
      expect((body.parts ?? []).map((part) => part.attachment_id).filter(Boolean)).toEqual([attachmentId]);
      expect(deletes).not.toContain(attachmentId);
    });
  } finally {
    try {
      if (project) await project.dispose();
    } finally {
      await deleteAuthUser(user.id, authOptions);
    }
  }
});
