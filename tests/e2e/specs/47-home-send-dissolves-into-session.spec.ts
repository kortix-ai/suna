import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

import { loadEnv } from "../../src/core/env";
import {
  createDatabaseSession,
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
  password: "E2eHomeSendHandoff123!",
};
const api = createApiJsonClient(apiBase);

const PROMPT = "Summarize the release notes in three bullet points";

/** What the page drew on every animation frame, from load to the end. */
type HandoffRecord = {
  ghostFrames: number;
  /** The project's pending screen painted with no opaque copy over it. */
  uncoveredPendingFrames: number;
  untitledFrames: number;
  toastFrames: number;
};

// Project home → the session a send opens. It was a cut, and on a production
// build a double one: the route prefetch stops at `projects/[id]/loading.tsx`,
// so the home page, then the pulsing Kortix mark, then the session each
// painted in single frames, with a "Starting session… / Session started"
// toast over the new composer and its header reading "Untitled" before
// "New session". The home page now leaves a copy of itself that dissolves
// once the session's own surface is in the DOM.
test("47 — a home composer send dissolves into its session", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const env = loadEnv();
  if (!env.databaseUrl) throw new Error("KE2E_DATABASE_URL is required");
  const user = await createAuthUser(
    `e2e-home-send-handoff-${randomUUID()}@example.test`,
    authOptions,
  );
  let projectFixture: ManifestProject | undefined;
  const createBodies: Array<{ session_id?: string; pending_prompt?: { text?: string } }> = [];
  let releaseCreate: () => void = () => {};
  const createHeld = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  let createObserved: () => void = () => {};
  const createSeen = new Promise<void>((resolve) => {
    createObserved = resolve;
  });

  try {
    const auth = await signIn(user.email!, authOptions);
    const accounts = await api<{ account_id: string; personal_account?: boolean }[]>(
      auth.access_token,
      "GET",
      "/accounts",
    );
    const account = accounts.find((item) => item.personal_account) ?? accounts[0];
    await fundAccount(env.databaseUrl, account.account_id);
    const project = await createManifestProject({
      api,
      accessToken: auth.access_token,
      accountId: account.account_id,
      userId: user.id,
      name: `Home send handoff ${Date.now()}`,
      databaseUrl: env.databaseUrl,
    });
    projectFixture = project;
    await mergeDatabaseProjectMetadata(env, project.id, {
      experimental: { llm_gateway: true },
    });
    // The local profile has no live model catalog: hand the picker its real
    // server-resolved default, as journeys 28 and 39 do, so the composer sends.
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

    await page.addInitScript(() => {
      const record = { ghostFrames: 0, uncoveredPendingFrames: 0, untitledFrames: 0, toastFrames: 0 };
      (window as unknown as { __handoff: typeof record }).__handoff = record;
      const tick = () => {
        const ghost = document.querySelector("[data-session-open-ghost]");
        const ghostOpacity = ghost ? Number.parseFloat(getComputedStyle(ghost).opacity) : 0;
        if (ghost) record.ghostFrames += 1;
        const pending = document.querySelector('[data-slot="project-pending-screen"]');
        if (
          pending &&
          location.pathname.includes("/sessions/") &&
          pending.getBoundingClientRect().width > 0 &&
          ghostOpacity < 0.99
        ) {
          record.uncoveredPendingFrames += 1;
        }
        const text = document.body?.textContent ?? "";
        if (text.includes("Untitled")) record.untitledFrames += 1;
        if (text.includes("Starting session") || text.includes("Session started")) {
          record.toastFrames += 1;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    let sessionId: string | undefined;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
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
      // No warm session to adopt: the send takes the create path.
      if (path === `/v1/projects/${project.id}/sessions/warm`) {
        await route.abort();
        return;
      }
      // The create, as the server answers it, minus the computer: the row the
      // browser asked for (its own `session_id`) exists, and nothing boots.
      // The local profile could not create it anyway (`POST /sessions`
      // answers 503 KORTIX_URL_UNREACHABLE there). Held until the sending
      // state has been asserted.
      if (request.method() === "POST" && path === `/v1/projects/${project.id}/sessions`) {
        const body = request.postDataJSON() as (typeof createBodies)[number];
        createBodies.push(body);
        createObserved();
        await createHeld;
        sessionId = await createDatabaseSession(env, {
          projectId: project.id,
          accountId: account.account_id,
          userId: user.id,
          sessionId: body.session_id,
        });
        const row = await api<Record<string, unknown>>(
          auth.access_token,
          "GET",
          `/projects/${project.id}/sessions/${sessionId}`,
        );
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(row),
        });
        return;
      }
      // The computer stays in boot for the whole journey.
      if (sessionId && path === `/v1/projects/${project.id}/sessions/${sessionId}/start`) {
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

    await installBrowserSessionDirect(page, auth, `/projects/${project.id}`, authOptions);
    await dismissOnboarding(page);
    const input = page.getByRole("textbox", { name: "Message input" });
    await expect(input).toBeVisible({ timeout: 60_000 });

    await test.step("Enter keeps the message readable while the session is created", async () => {
      await input.fill(PROMPT);
      await input.press("Enter");
      await createSeen;
      expect(createBodies).toHaveLength(1);
      expect(createBodies[0].session_id).toEqual(expect.any(String));
      expect(createBodies[0].pending_prompt?.text).toBe(PROMPT);
      // Still project home: the words stay in the composer at full contrast —
      // read-only, not the dimmed look of a control that stopped working.
      await expect(input).toHaveText(PROMPT);
      await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
      const editorOpacity = await input.evaluate(
        (element) => getComputedStyle(element.closest(".kortix-composer-editor")!).opacity,
      );
      expect(editorOpacity).toBe("1");
      releaseCreate();
    });

    await test.step("the page dissolves into the session it opened", async () => {
      await expect(page).toHaveURL(
        new RegExp(`/projects/${project.id}/sessions/${createBodies[0].session_id}$`),
        { timeout: 60_000 },
      );
      const surface = page.locator(`[data-session-surface="${createBodies[0].session_id}"]`);
      await expect(surface.getByText(PROMPT, { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(surface.getByText("New session").first()).toBeVisible();
      // The departing page's copy is gone once the dissolve has run.
      await expect(page.locator("[data-session-open-ghost]")).toHaveCount(0, { timeout: 10_000 });
      const record = await page.evaluate(
        () => (window as unknown as { __handoff: HandoffRecord }).__handoff,
      );
      expect(record.ghostFrames).toBeGreaterThan(0);
      expect(record.uncoveredPendingFrames).toBe(0);
      expect(record.untitledFrames).toBe(0);
      expect(record.toastFrames).toBe(0);
      await testInfo.attach("home-send-handoff-arrived", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });
  } finally {
    releaseCreate();
    try {
      if (projectFixture) await projectFixture.dispose();
    } finally {
      await deleteAuthUser(user.id, authOptions);
    }
  }
});
