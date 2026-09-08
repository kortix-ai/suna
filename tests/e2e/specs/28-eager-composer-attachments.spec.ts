import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, test, type Page, type Request } from "@playwright/test";

import { loadEnv } from "../../src/core/env";
import {
  createDatabaseProject,
  deleteDatabaseProject,
  mergeDatabaseProjectMetadata,
} from "../../src/fixtures/database-project";
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
import { dismissOnboarding } from "../helpers/ui";

const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321",
  password: "E2eEagerAttachments123!",
};
const api = createApiJsonClient(apiBase);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

type NetworkEvent = {
  method: string;
  path: string;
  attachmentIds?: string[];
  hasDataUrl?: boolean;
};

function pathname(request: Request): string {
  return new URL(request.url()).pathname;
}

function attachmentIds(body: unknown): string[] {
  const value = body as {
    pending_prompt?: { parts?: Array<{ attachment_id?: string }> };
    parts?: Array<{ attachment_id?: string }>;
  };
  return (value.pending_prompt?.parts ?? value.parts ?? [])
    .map((part) => part.attachment_id)
    .filter((id): id is string => typeof id === "string");
}

async function dispatchFileEvent(
  page: Page,
  kind: "drop" | "paste",
  input: { name: string; mime: string; bytes: number[] },
): Promise<void> {
  await page.getByRole("textbox", { name: "Message input" }).evaluate(
    (element, payload) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(payload.input.bytes)], payload.input.name, {
          type: payload.input.mime,
        }),
      );
      const event =
        payload.kind === "paste"
          ? new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: transfer,
            })
          : new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer,
            });
      element.dispatchEvent(event);
    },
    { kind, input },
  );
}

test("28 — eager composer uploads before Send and reuses handles after refusal", async ({
  page,
}, testInfo) => {
  const env = loadEnv();
  const email = `e2e-eager-attachments-${randomUUID()}@example.test`;
  const user = await createAuthUser(email, authOptions);
  let projectFixture: ManifestProject | undefined;
  const events: NetworkEvent[] = [];
  let chunkRequests = 0;
  let failChunks = 0;
  let holdChunk = false;
  let releaseHeldChunk = () => {};
  let observeHeldChunk = () => {};
  const heldChunk = new Promise<void>((resolve) => {
    observeHeldChunk = resolve;
  });
  const heldGate = new Promise<void>((resolve) => {
    releaseHeldChunk = resolve;
  });
  let failFirstSend = true;
  const promptBodies: unknown[] = [];

  try {
    const auth = await signIn(email, authOptions);
    const accounts = await api<
      { account_id: string; personal_account?: boolean }[]
    >(auth.access_token, "GET", "/accounts");
    const account =
      accounts.find((item) => item.personal_account) ?? accounts[0];
    if (!env.databaseUrl) throw new Error("KE2E_DATABASE_URL is required");
    await fundAccount(env.databaseUrl, account.account_id);
    const project = await createManifestProject({
      api,
      accessToken: auth.access_token,
      accountId: account.account_id,
      userId: user.id,
      name: `Eager Attachments ${Date.now()}`,
      databaseUrl: env.databaseUrl,
    });
    projectFixture = project;
    await mergeDatabaseProjectMetadata(env, project.id, {
      experimental: { apps: true, llm_gateway: true },
    });
    const defaults = await api<{ resolvedForCaller: string | null }>(
      auth.access_token,
      "GET",
      `/projects/${project.id}/model-defaults`,
    );
    expect(defaults.resolvedForCaller).toBeTruthy();
    const picker = await api<{
      models: Record<string, Record<string, unknown>>;
      [key: string]: unknown;
    }>(auth.access_token, "GET", `/projects/${project.id}/model-picker`);
    const modelId = defaults.resolvedForCaller ?? "";
    expect(modelId).not.toBe("");
    const enabledPicker = {
      ...picker,
      // The deterministic local profile intentionally has no live managed
      // model catalog. Supply its real server-resolved default to the picker so
      // the browser can exercise composer submission; every attachment and
      // prompt request below still reaches the real local API.
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

    await page.route("**/*", async (route) => {
      const request = route.request();
      const path = pathname(request);
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
      const isChunk =
        request.method() === "PUT" &&
        path.includes(`/v1/projects/${project.id}/attachments/`) &&
        path.includes("/chunks/");
      if (isChunk) {
        chunkRequests += 1;
        events.push({ method: request.method(), path });
        if (failChunks > 0) {
          failChunks -= 1;
          await route.abort("failed");
          return;
        }
        if (holdChunk) {
          holdChunk = false;
          observeHeldChunk();
          await heldGate;
        }
      }

      if (
        request.method() === "POST" &&
        path.includes(`/v1/projects/${project.id}/`)
      ) {
        const body = request.postDataJSON?.() as unknown;
        const ids = attachmentIds(body);
        if (ids.length > 0) {
          const serialized = JSON.stringify(body);
          promptBodies.push(body);
          events.push({
            method: request.method(),
            path,
            attachmentIds: ids,
            hasDataUrl: serialized.includes("data:"),
          });
          if (failFirstSend) {
            failFirstSend = false;
            await route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({
                error: { message: "Injected first-send refusal" },
              }),
            });
            return;
          }
        }
      }
      await route.continue();
    });

    await installBrowserSessionDirect(
      page,
      auth,
      `/projects/${project.id}`,
      authOptions,
    );
    await dismissOnboarding(page);
    const input = page.getByRole("textbox", { name: "Message input" });
    const send = page.getByRole("button", { name: "Send message" });
    await expect(input).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("button", { name: "Attach files" }),
    ).toBeVisible();
    await input.fill("fixture ready");
    await expect(send).toBeEnabled();
    await input.fill("");

    const pickerBegin = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        pathname(request) === `/v1/projects/${project.id}/attachments`,
    );
    await page.locator("input[type=file]").setInputFiles({
      name: "picker.png",
      mimeType: "image/png",
      buffer: PNG,
    });
    await pickerBegin;
    await expect(page.locator('img[alt="picker.png"]')).toBeVisible();

    failChunks = 3;
    await page.locator("input[type=file]").setInputFiles({
      name: "retry.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("retry me"),
    });
    await expect(page.getByText("Upload failed", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole("button", { name: "Retry retry.txt" }).click();
    await expect(
      page.getByRole("button", { name: "Retry retry.txt" }),
    ).toHaveCount(0, {
      timeout: 10_000,
    });

    await dispatchFileEvent(page, "drop", {
      name: "drop.txt",
      mime: "text/plain",
      bytes: Array.from(Buffer.from("drop bytes")),
    });
    await expect(page.getByText("drop.txt", { exact: true })).toBeVisible();

    holdChunk = true;
    const largeBytes = Array.from(Buffer.alloc(160 * 1024, 0x61));
    await dispatchFileEvent(page, "paste", {
      name: "paste-large.txt",
      mime: "text/plain",
      bytes: largeBytes,
    });
    await heldChunk;
    await input.fill("Eager attachment first prompt");
    await input.press("Enter");
    await page.waitForTimeout(250);
    expect(promptBodies).toHaveLength(0);
    await expect(send).toBeDisabled();

    releaseHeldChunk();
    await expect(page.getByText(/^(Uploading|Processing|Waiting)/)).toHaveCount(
      0,
      {
        timeout: 30_000,
      },
    );
    await expect(send).toBeEnabled();

    const deleteDrop = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        pathname(response.request()).includes(
          `/v1/projects/${project.id}/attachments/`,
        ),
    );
    await page.getByRole("button", { name: "Remove drop.txt" }).click();
    expect((await deleteDrop).status()).toBe(204);

    const chunksBeforeRetry = chunkRequests;
    await send.click();
    await expect(page.locator('img[alt="picker.png"]')).toBeVisible();
    await expect(input).toHaveText("Eager attachment first prompt");
    expect(promptBodies).toHaveLength(1);
    await send.click();
    await expect.poll(() => promptBodies.length, { timeout: 10_000 }).toBe(2);
    expect(attachmentIds(promptBodies[1])).toEqual(
      attachmentIds(promptBodies[0]),
    );
    expect(JSON.stringify(promptBodies[1])).not.toContain("data:");
    expect(chunkRequests).toBe(chunksBeforeRetry);
    await expect(input).toHaveText("Eager attachment first prompt");
    await expect(page.locator('img[alt="picker.png"]')).toBeVisible({
      timeout: 15_000,
    });

    await testInfo.attach("eager-composer-selected-and-retried", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    const evidencePath = testInfo.outputPath("eager-attachment-network.json");
    await writeFile(evidencePath, JSON.stringify(events, null, 2));
    await testInfo.attach("eager-attachment-network", {
      path: evidencePath,
      contentType: "application/json",
    });
    try {
      if (projectFixture) await projectFixture.dispose();
    } finally {
      await deleteAuthUser(user.id, authOptions);
    }
  }
});

test("28 — eager composer completed draft reload contains metadata only", async ({
  page,
}, testInfo) => {
  const env = loadEnv();
  const email = `e2e-eager-draft-${randomUUID()}@example.test`;
  const user = await createAuthUser(email, authOptions);
  let projectId: string | undefined;
  try {
    const auth = await signIn(email, authOptions);
    const accounts = await api<{ account_id: string }[]>(
      auth.access_token,
      "GET",
      "/accounts",
    );
    const project = await createDatabaseProject(env, {
      accountId: accounts[0].account_id,
      userId: user.id,
      name: `Eager Draft ${Date.now()}`,
    });
    projectId = project.id;
    await installBrowserSessionDirect(
      page,
      auth,
      `/projects/${project.id}`,
      authOptions,
    );
    await dismissOnboarding(page);

    await page.locator("input[type=file]").setInputFiles({
      name: "draft-safe.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("draft-safe"),
    });
    await expect(page.getByText(/^(Uploading|Processing|Waiting)/)).toHaveCount(
      0,
      {
        timeout: 20_000,
      },
    );
    const key = `kortix_draft:project:${project.id}`;
    await expect
      .poll(() =>
        page.evaluate((draftKey) => localStorage.getItem(draftKey), key),
      )
      .not.toBeNull();
    const raw = await page.evaluate(
      (draftKey) => localStorage.getItem(draftKey),
      key,
    );
    expect(raw).not.toContain("blob:");
    expect(raw).not.toContain("data:");
    expect(raw).not.toContain("signed");
    expect(raw).toContain("attachment_id");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("draft-safe.txt", { exact: true })).toBeVisible(
      { timeout: 30_000 },
    );
    await expect(
      page.getByRole("button", { name: "Remove draft-safe.txt" }),
    ).toBeVisible();
    await testInfo.attach("eager-composer-draft-restored", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    try {
      if (projectId) await deleteDatabaseProject(env, projectId);
    } finally {
      await deleteAuthUser(user.id, authOptions);
    }
  }
});
