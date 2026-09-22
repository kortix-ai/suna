import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, test, type Page, type Request } from "@playwright/test";

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
  // This journey drives five files through begin → upload → complete, and the
  // deployed profile's default attempt budget is 120 s. Measured on staging
  // (release-gate run 35242868705, browser shard 3): one `POST /attachments`
  // takes 2.67-6.80 s and one `POST .../complete` takes 3.43-10.14 s, so the
  // round trips alone spend more than that budget. Declare the real cost here,
  // the way 10-billing and 13-sdk-only do, instead of trimming the assertions.
  test.setTimeout(240_000);
  const env = loadEnv();
  const email = `e2e-eager-attachments-${randomUUID()}@example.test`;
  const user = await createAuthUser(email, authOptions);
  let projectFixture: ManifestProject | undefined;
  const events: NetworkEvent[] = [];
  let uploadRequests = 0;
  let failUploads = false;
  // A request the route handler parks until the test releases it: `observed`
  // settles when it arrives, `gate` when the test lets it through.
  type RequestHold = { observed: Promise<void>; gate: Promise<void>; observe: () => void; release: () => void };
  const makeHold = (): RequestHold => {
    let observe = () => {};
    let release = () => {};
    const observed = new Promise<void>((resolve) => {
      observe = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { observed, gate, observe: () => observe(), release: () => release() };
  };
  let hold: RequestHold | undefined;
  const holdNextUpload = (): RequestHold => {
    hold = makeHold();
    return hold;
  };
  // The refused create below is held the same way, so the composer's in-flight
  // surface can be asserted while the request is still open.
  let createHold: RequestHold | undefined;
  let failFirstSend = true;
  // Refuses the session create that a Send with a held upload makes at once.
  // A deployed target would accept it and navigate away; a refusal keeps the
  // journey on the project home for both targets.
  let failHeldCreate = false;
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
    // A deployed target keeps its REAL catalog (the stub below is local-only),
    // and this journey attaches images. The composer refuses an image on a model
    // whose catalog says it cannot read one, so pin a vision-capable default
    // first — otherwise the spec asserts against a correct refusal.
    if (isDeployedTarget()) {
      const visionModel = Object.entries(picker.models).find(([, model]) => {
        if ((model as { enabled?: boolean }).enabled === false) return false;
        const input = (model as { modalities?: { input?: string[] } }).modalities?.input;
        if (input) return input.includes("image");
        return (model as { attachment?: boolean }).attachment === true;
      })?.[0];
      expect(
        visionModel,
        "deployed catalog exposes no vision-capable model for the image assertions",
      ).toBeTruthy();
      await api(
        auth.access_token,
        "PUT",
        `/projects/${project.id}/model-defaults`,
        { scope: "project", model: visionModel as string },
      );
    }
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
      // Completions are recorded so a removed upload can be proven never to complete.
      if (request.method() === "POST" && path.endsWith("/complete")) {
        events.push({ method: request.method(), path });
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
      // A warm session makes the held Send a network-free take, so no create
      // reaches the refusal below. Refuse the warm create on every target: the
      // app then has no warm session and creates, as on the local profile.
      if (
        request.method() === "POST" &&
        path === `/v1/projects/${project.id}/sessions/warm`
      ) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { message: "Injected warm-session refusal" },
          }),
        });
        return;
      }
      // The server selects the transport: API chunk PUTs, or one direct Storage
      // PUT to a signed URL. `pathname` never includes the URL token.
      const isUpload =
        request.method() === "PUT" &&
        ((path.includes(`/v1/projects/${project.id}/attachments/`) &&
          path.includes("/chunks/")) ||
          path.includes("/storage/v1/object/upload/sign/"));
      if (isUpload) {
        uploadRequests += 1;
        events.push({ method: request.method(), path });
        if (failUploads) {
          // A 403 is not transient, so the SDK reports the failure without its
          // 60-second retry budget. A direct URL is re-signed once first.
          await route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ statusCode: "403", error: "Injected upload refusal" }),
          });
          return;
        }
        if (hold) {
          const current = hold;
          hold = undefined;
          current.observe();
          await current.gate;
          // The page can abandon a held upload (Remove): continuing it then fails.
          await route.continue().catch(() => {});
          return;
        }
      }

      if (
        failHeldCreate &&
        request.method() === "POST" &&
        path === `/v1/projects/${project.id}/sessions`
      ) {
        failHeldCreate = false;
        if (createHold) {
          const current = createHold;
          createHold = undefined;
          current.observe();
          await current.gate;
        }
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: { message: "Injected held-send create refusal" },
          }),
        });
        return;
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
    // The local preview appears before its upload settles. Wait for the
    // actual upload state so the forced retry.txt failures cannot hit picker.png.
    await expect(
      page.locator('li > div[aria-busy="true"]:has([title="picker.png"])'),
    ).toHaveCount(0, { timeout: 30_000 });

    failUploads = true;
    await page.locator("input[type=file]").setInputFiles({
      name: "retry.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("retry me"),
    });
    // A failed upload shows a scrim with one Retry icon button on its tile.
    const retryUpload = page.getByRole("button", {
      name: "Retry upload of retry.txt",
    });
    // Reaching the failed state costs TWO server round trips, not one: the
    // begin, the refused PUT, then a re-sign begin for the same attachment and
    // its refused PUT. Measured on staging that chain took 10.35 s, so the
    // 10 s override this assertion used to carry could not pass there. Inherit
    // the profile's own element budget (45 s deployed, 30 s local) instead.
    await expect(retryUpload).toBeVisible();
    // A failed attachment refuses Send, and the control says why.
    await expect(send).toBeDisabled();
    await expect(send).toHaveAttribute(
      "title",
      "Retry or remove the failed attachment.",
    );
    failUploads = false;
    await retryUpload.click();
    await expect(retryUpload).toHaveCount(0, { timeout: 10_000 });

    await dispatchFileEvent(page, "drop", {
      name: "drop.txt",
      mime: "text/plain",
      bytes: Array.from(Buffer.from("drop bytes")),
    });
    await expect(page.getByText("drop.txt", { exact: true })).toBeVisible();
    // This case removes a READY attachment, so wait for its upload to settle.
    // The tile is drawn from the local File before its begin answers, and Remove
    // deletes by attachment id: click it inside that window and the id does not
    // exist yet. Removing DURING the upload is the remove-me.txt case below;
    // removing before the id is known is covered by the SDK's own tests
    // (packages/sdk/src/core/attachments/prompt-attachments.test.ts).
    await expect(
      page.locator('li > div[aria-busy="true"]:has([title="drop.txt"])'),
    ).toHaveCount(0, { timeout: 60_000 });

    const deleteDrop = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        pathname(response.request()).includes(
          `/v1/projects/${project.id}/attachments/`,
        ),
    );
    await page.getByRole("button", { name: "Remove drop.txt" }).click();
    expect((await deleteDrop).status()).toBe(204);

    // Remove while the upload still runs: its unbound upload is deleted, and
    // the abandoned upload never completes.
    const removalHold = holdNextUpload();
    await dispatchFileEvent(page, "drop", {
      name: "remove-me.txt",
      mime: "text/plain",
      bytes: Array.from(Buffer.alloc(160 * 1024, 0x62)),
    });
    await removalHold.observed;
    await expect(
      page.locator('li > div[aria-busy="true"]:has([title="remove-me.txt"])'),
    ).toHaveCount(1);
    const deleteRemoved = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        pathname(response.request()).includes(
          `/v1/projects/${project.id}/attachments/`,
        ),
    );
    await page.getByRole("button", { name: "Remove remove-me.txt" }).click();
    const removed = await deleteRemoved;
    expect(removed.status()).toBe(204);
    const removedId = pathname(removed.request()).split("/").pop() ?? "";
    expect(removedId).not.toBe("");
    await expect(page.getByText("remove-me.txt", { exact: true })).toHaveCount(0);
    removalHold.release();
    // Give an unaborted upload time to reach completion; the aborted one never does.
    await page.waitForTimeout(1_000);
    expect(
      events.some(
        (event) =>
          event.method === "POST" &&
          event.path.endsWith(`/attachments/${removedId}/complete`),
      ),
    ).toBe(false);

    const pasteHold = holdNextUpload();
    const largeBytes = Array.from(Buffer.alloc(160 * 1024, 0x61));
    await input.fill("Eager attachment first prompt");
    await dispatchFileEvent(page, "paste", {
      name: "paste-large.txt",
      mime: "text/plain",
      bytes: largeBytes,
    });
    await pasteHold.observed;
    // Send never waits for an upload: the control stays enabled while the
    // upload runs, and Enter creates the session at once. The create carries
    // no prompt, because the held upload has no handle yet.
    await expect(send).toBeEnabled();
    failHeldCreate = true;
    createHold = makeHold();
    const heldCreateHold = createHold;
    const heldCreate = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        pathname(request) === `/v1/projects/${project.id}/sessions`,
    );
    await input.press("Enter");

    // THE SEND IS REAL FROM THE KEYPRESS, not from the create's answer. The
    // create is parked open below, so everything asserted here is the surface
    // the user is looking at while the round trip runs — the window that used
    // to show the typed sentence frozen in a locked box behind a spinner
    // (measured 1165ms end to end on localhost, `POST .../sessions` 908ms of
    // it). The box is empty and the message is on screen as its own bubble,
    // with the picture it carries, exactly as the session it is about to open
    // will draw it.
    await heldCreateHold.observed;
    const optimisticTurn = page.locator("[data-turn-id='optimistic']");
    await expect(optimisticTurn).toBeVisible();
    await expect(optimisticTurn).toContainText("Eager attachment first prompt");
    await expect(input).toHaveText("");
    // The project-home heading is gone: the column is a thread now, and the
    // composer has left the hero position for the dock under it.
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
    heldCreateHold.release();

    expect(attachmentIds((await heldCreate).postDataJSON())).toEqual([]);
    expect(promptBodies).toHaveLength(0);
    // The injected create refusal keeps the draft and returns every upload.
    // NOTHING was created and nothing navigated, so the bubble goes back to
    // being an editable draft rather than staying on screen as a lie.
    await expect(optimisticTurn).toHaveCount(0, { timeout: 10_000 });
    await expect(input).toHaveText("Eager attachment first prompt", {
      timeout: 10_000,
    });
    pasteHold.release();
    await expect(page.locator('li > div[aria-busy="true"]')).toHaveCount(0, {
      timeout: 30_000,
    });
    // Every upload is ready: the create carries the prompt and its handles.
    await send.click();
    await expect
      .poll(() => promptBodies.length, { timeout: 30_000 })
      .toBe(1);
    // picker.png, retry.txt, and paste-large.txt; drop.txt was removed.
    expect(attachmentIds(promptBodies[0])).toHaveLength(3);
    const uploadsBeforeRetry = uploadRequests;
    // The injected first-send refusal keeps the draft and every handle.
    await expect(page.locator('img[alt="picker.png"]')).toBeVisible();
    await expect(input).toHaveText("Eager attachment first prompt", {
      timeout: 10_000,
    });
    const secondResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        pathname(response.request()) === `/v1/projects/${project.id}/sessions`,
    );
    await send.click();
    await expect.poll(() => promptBodies.length, { timeout: 10_000 }).toBe(2);
    expect(attachmentIds(promptBodies[1])).toEqual(
      attachmentIds(promptBodies[0]),
    );
    expect(JSON.stringify(promptBodies[1])).not.toContain("data:");
    expect(uploadRequests).toBe(uploadsBeforeRetry);
    const response = await secondResponse;
    await expect(page.locator('[title="picker.png"]')).toBeVisible({
      timeout: 30_000,
    });
    // The tile carries no upload chrome: no progress ring inside it, no busy
    // box around it, and a real picture.
    await expect(
      page.locator('[title="picker.png"] [role="progressbar"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[aria-busy="true"]:has([title="picker.png"])'),
    ).toHaveCount(0);
    await expect(page.locator('img[alt="picker.png"]').first()).toHaveAttribute(
      "src",
      /\S/,
    );
    if (isDeployedTarget()) {
      expect(response.ok()).toBe(true);
      await expect(page).toHaveURL(/\/projects\/[^/]+\/sessions\/[^/]+/, {
        timeout: 60_000,
      });
      await expect(page.locator('img[alt="picker.png"]')).toBeVisible({
        timeout: 30_000,
      });
    } else {
      expect(response.status()).toBe(503);
      await expect(input).toHaveText("Eager attachment first prompt");
      await expect(page.locator('img[alt="picker.png"]')).toBeVisible({
        timeout: 15_000,
      });
    }

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
