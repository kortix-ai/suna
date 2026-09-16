import {
  expect,
  test as browserTest,
  _electron,
  type Locator,
  type ElectronApplication,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnv } from "../../src/core/env";
import { createDatabaseSession } from "../../src/fixtures/database-project";
import { runDatabaseSql } from "../helpers/database";
import { createApiJsonClient } from "../helpers/http";
import {
  createManifestProject,
  isDeployedTarget,
  type ManifestProject,
} from "../helpers/manifest-project";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import {
  dismissOnboarding,
  dismissWelcomeCard,
  selectAccountForUi,
} from "../helpers/ui";

const test = browserTest.extend<{ desktopApp: ElectronApplication | null }>({
  desktopApp: async ({ baseURL }, use) => {
    if (process.env.E2E_DESKTOP_NATIVE !== "1") return use(null);
    const desktopRoot = fileURLToPath(
      new URL("../../../apps/desktop-electron", import.meta.url),
    );
    const profile = await mkdtemp(join(tmpdir(), "kortix-desktop-parity-"));
    const requireDesktop = createRequire(join(desktopRoot, "package.json"));
    let app: ElectronApplication | undefined;
    try {
      app = await _electron.launch({
        executablePath: requireDesktop("electron"),
        args: [desktopRoot],
        env: {
          ...process.env,
          KORTIX_DESKTOP_USER_DATA: profile,
          KORTIX_DESKTOP_URL: `${baseURL}/projects`,
        },
      });
      const launchedApp = app;
      await expect
        .poll(
          () =>
            launchedApp
              .windows()
              .some((window) => window.url().startsWith(baseURL!)),
          { timeout: 120_000 },
        )
        .toBe(true);
      await use(app);
    } finally {
      try {
        await app?.close();
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    }
  },
  page: async ({ page, desktopApp, baseURL }, use) => {
    await use(
      desktopApp
        ?.windows()
        .find((window) => window.url().startsWith(baseURL!)) ?? page,
    );
  },
});

const api = createApiJsonClient(
  process.env.E2E_API_URL || "http://localhost:8008/v1",
);
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321",
  password: "DesktopParity123!",
};

/** Check rendered geometry: a source-string assertion cannot detect collapsed flex lists. */
async function expectSeparateRows(rows: Locator) {
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  const boxes = await rows.evaluateAll((elements) =>
    elements
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label: element.textContent,
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
        };
      })
      .filter((rect) => rect.height > 0),
  );
  expect(boxes.length).toBeGreaterThan(1);
  for (let index = 1; index < boxes.length; index++) {
    expect(
      boxes[index].top,
      `${boxes[index - 1].label} overlaps ${boxes[index].label}`,
    ).toBeGreaterThanOrEqual(boxes[index - 1].bottom - 1);
  }
}

const runtimes =
  process.env.E2E_DESKTOP_NATIVE === "1" ? ["desktop"] : ["web", "desktop"];
for (const runtime of runtimes) {
  const desktop = runtime === "desktop";
  test.describe(`27 — desktop parity (${runtime})`, () => {
    test.use({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36" +
        (desktop ? " KortixDesktop/0.1.0" : ""),
    });

    test("sidebar, settings, agents and connectors remain aligned and clickable", async ({
      page,
      baseURL,
      desktopApp,
    }) => {
      test.setTimeout(300_000);
      const resize = async (width: number, height: number) => {
        if (desktopApp) {
          const window = await desktopApp.browserWindow(page);
          await window.evaluate(
            (window, size) => window.setContentSize(size.width, size.height),
            { width, height },
          );
        } else {
          await page.setViewportSize({ width, height });
        }
      };
      await resize(1440, 900);
      const databaseUrl =
        process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
      if (!databaseUrl)
        throw new Error("Desktop parity requires the configured test database");
      await page.addInitScript(() =>
        Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }),
      );
      const email = `e2e-desktop-${randomUUID()}@example.test`;
      const user = await createAuthUser(email, authOptions);
      const session = await signIn(email, authOptions);
      let project: ManifestProject | undefined;
      try {
        const accounts = await api<{ account_id: string }[]>(
          session.access_token,
          "GET",
          "/accounts",
        );
        const accountId = accounts[0].account_id;
        project = await createManifestProject({
          api,
          accessToken: session.access_token,
          accountId,
          userId: user.id,
          name: "Desktop parity",
          databaseUrl,
        });
        await installBrowserSessionDirect(
          page,
          session,
          `${baseURL}/projects/${project.id}`,
          authOptions,
        );
        await selectAccountForUi(page, accountId);
        await page.goto(`${baseURL}/projects/${project.id}`);
        await dismissOnboarding(page);
        if (desktop)
          await expect(page.locator("html")).toHaveAttribute(
            "data-desktop-platform",
            "macos",
          );
        else
          await expect(page.locator("html")).not.toHaveAttribute(
            "data-desktop",
            "true",
          );

        const switcher = page.getByRole("button", {
          name: "Switch project",
          exact: true,
        });
        await expect(switcher).toBeVisible();
        const box = await switcher.boundingBox();
        expect(
          box!.y,
          "workspace selector must clear native window controls",
        ).toBeGreaterThanOrEqual(desktop ? 40 : 0);
        await switcher.click();
        await expect(
          page.getByRole("menuitem", { name: "Download app", exact: true }),
        ).toHaveCount(desktop ? 0 : 1);
        await page.getByRole("menuitem", { name: /^Settings/ }).click();
        const dialog = page.getByRole("dialog");
        await expect(
          dialog.getByRole("button", { name: "Back to app" }),
        ).toBeVisible();
        expect(
          (await dialog
            .getByRole("button", { name: "Back to app" })
            .boundingBox())!.y,
        ).toBeGreaterThanOrEqual(desktop ? 40 : 0);
        await expectSeparateRows(
          dialog.locator(
            '[role="tablist"][aria-orientation="vertical"] [role="tab"]',
          ),
        );
        for (const name of [
          "Security",
          "Appearance",
          "Notifications",
          "Language & shortcuts",
          "Personal access keys",
          "Profile",
        ]) {
          const tab = dialog.getByRole("tab", { name, exact: true });
          await tab.click();
          await expect(tab).toHaveAttribute("aria-selected", "true");
          await expect(dialog.getByRole("tabpanel")).toBeVisible();
          await expect(dialog.getByRole("tabpanel")).toContainText(/\S/);
        }
        await dialog
          .getByRole("tab", { name: "Appearance", exact: true })
          .click();
        for (const theme of ["Light", "Dark"]) {
          await dialog
            .getByRole("button", { name: theme, exact: true })
            .click();
          await expect(page.locator("html")).toHaveClass(
            new RegExp(theme.toLowerCase()),
          );
          await expectSeparateRows(
            dialog.locator(
              '[role="tablist"][aria-orientation="vertical"] [role="tab"]',
            ),
          );
          // Cold dev routes can load the mono font after the dialog appears.
          // Finish font loading within the journey deadline before capture.
          await page.evaluate(async () => {
            await document.fonts.ready;
          });
          await page.screenshot({
            path: test.info().outputPath(`settings-${theme.toLowerCase()}.png`),
            scale: "css",
          });
        }
        await dialog.getByRole("button", { name: "Back to app" }).click();
        await page
          .getByRole("link", { name: "Customize", exact: true })
          .click();
        await expect(page).toHaveURL(/\/customize\/agents/);
        await page
          .locator(`a[href="/projects/${project.id}/customize/agents/kortix"]`)
          .click();
        await expect(page).toHaveURL(/\/customize\/agents\/kortix/);
        await expectSeparateRows(
          page.locator(
            '[role="tablist"][aria-orientation="vertical"] [role="tab"]',
          ),
        );
        for (const name of [
          "Basics",
          "People",
          "Triggers",
          "Skills",
          "Connectors",
          "Secrets",
          "Project actions",
          "Model",
          "Tools",
          "Workspace",
          "Overview",
        ]) {
          const tab = page
            .locator('[role="tablist"][aria-orientation="vertical"]')
            .getByRole("tab", { name, exact: true });
          await tab.click();
          await expect(tab).toHaveAttribute("aria-selected", "true");
          await expect(page.locator("main main")).toBeVisible();
          await expect(page.locator("main main")).toContainText(/\S/);
        }
        await page.screenshot({
          path: test.info().outputPath("agent-sections.png"),
          scale: "css",
        });
        const connectors = page
          .getByRole("tab", { name: "Connectors", exact: true })
          .first();
        await connectors.click();
        await expect(page).toHaveURL(/\/customize\/connectors/);
        // A fresh document must also load real data, independent of the agent
        // editor's cached connector query. Do not accept a Next.js page GET.
        const response = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
              `/v1/connectors/projects/${project!.id}/connectors` &&
            response.request().method() === "GET",
        );
        await page.reload();
        const connectorResponse = await response;
        expect(connectorResponse.status()).toBe(200);
        expect(await connectorResponse.json()).toMatchObject({
          connectors: expect.any(Array),
        });
        await expect(
          page.getByRole("tab", { name: "Connected", exact: true }),
        ).toBeVisible();
        await page.getByRole("tab", { name: "Connected", exact: true }).click();
        await expect(
          page.getByRole("tab", { name: "Connected", exact: true }),
        ).toHaveAttribute("aria-selected", "true");
        await page.screenshot({
          path: test.info().outputPath("desktop-connectors.png"),
          scale: "css",
        });
        await resize(720, 480);
        const opener = page.getByRole("button", {
          name: desktop ? "Open sidebar" : "Collapse sidebar",
          exact: true,
        });
        await expect(opener).toBeVisible();
        await opener.click();
        await expect(switcher).toBeVisible();
        await page.screenshot({
          path: test.info().outputPath("desktop-narrow-sidebar.png"),
          scale: "css",
        });
        await page.keyboard.press("Escape");
        await expect(switcher).toBeHidden();
        const settingsTab = page
          .locator(".kx-titlebar-tabs")
          .getByRole("tab", { name: "Settings", exact: true });
        await settingsTab.click();
        await expect(page).toHaveURL(/\/customize\/settings/);
        await expect(settingsTab).toBeInViewport();
        await page.screenshot({
          path: test.info().outputPath("desktop-narrow-settings.png"),
          scale: "css",
        });
        await resize(1440, 900);
        if (desktopApp) {
          const window = await desktopApp.browserWindow(page);
          const originalZoom = await window.evaluate((window) =>
            window.webContents.getZoomFactor(),
          );
          await page.keyboard.press("Meta+=");
          await expect
            .poll(() =>
              window.evaluate((window) => window.webContents.getZoomFactor()),
            )
            .toBeGreaterThan(originalZoom);
          await page.keyboard.press("Meta+-");
          await page.keyboard.press("Meta+0");
          await expect
            .poll(() =>
              window.evaluate((window) => window.webContents.getZoomFactor()),
            )
            .toBe(originalZoom);
          await expect(switcher).toBeVisible();
          await switcher.click();
          await expect(
            page.getByRole("menuitem", { name: /^Settings/ }),
          ).toBeVisible();
          await page.keyboard.press("Escape");
          // Full document navigation also stays in the explicitly configured
          // frontend. SPA routing alone does not exercise Electron's gate.
          await page.evaluate(
            (url) => window.location.assign(url),
            `${baseURL}/projects/${project.id}/customize/connectors`,
          );
          await expect(page).toHaveURL(/\/customize\/connectors/);
          await expect(
            page.getByRole("tab", { name: "Connected", exact: true }),
          ).toBeVisible();
          const denied = await desktopApp.evaluate(
            async ({ BrowserWindow }, options) => {
              const other = new BrowserWindow({
                show: false,
                webPreferences: {
                  contextIsolation: true,
                  preload: options.preload,
                },
              });
              try {
                await other.webContents.loadURL(options.url);
                return await other.webContents.executeJavaScript(
                  "window.__TAURI__.core.invoke('get_frontend_url').then(() => 'allowed', error => error.message)",
                );
              } finally {
                other.destroy();
              }
            },
            {
              url: `${baseURL}/favicon.png`,
              preload: fileURLToPath(
                new URL(
                  "../../../apps/desktop-electron/src/preload.js",
                  import.meta.url,
                ),
              ),
            },
          );
          expect(denied).toContain("Unauthorized IPC sender");
        }
      } finally {
        await project?.dispose();
        await deleteAuthUser(user.id, authOptions);
      }
    });

    test("Enter and Command+Enter keep distinct pending prompt placements", async ({
      page,
      baseURL,
      desktopApp,
    }) => {
      test.setTimeout(180_000);
      const databaseUrl =
        process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
      if (!databaseUrl)
        throw new Error("Queue parity requires the configured test database");
      const user = await createAuthUser(
        `e2e-queue-${randomUUID()}@example.test`,
        authOptions,
      );
      const auth = await signIn(user.email!, authOptions);
      let project: ManifestProject | undefined;
      let sessionId = "";
      let bootSessionId = "";
      try {
        const accounts = await api<{ account_id: string }[]>(
          auth.access_token,
          "GET",
          "/accounts",
        );
        project = await createManifestProject({
          api,
          accessToken: auth.access_token,
          accountId: accounts[0].account_id,
          userId: user.id,
          name: "Queue placement",
          databaseUrl,
        });
        if (!isDeployedTarget()) {
          // A saved test credential makes a real catalog model selectable.
          // This journey verifies pending submission, not model execution.
          const base = `/projects/${project.id}`;
          await api(auth.access_token, "PATCH", `${base}/experimental`, {
            feature: "llm_gateway",
            enabled: true,
          });
          await api(
            auth.access_token,
            "POST",
            `${base}/secrets`,
            {
              name: "OPENAI_API_KEY",
              value: "sk-e2e-unused-queue-placement",
              strategy: "broker",
              consumer: "llm_gateway",
            },
            [200, 201],
          );
          await api(auth.access_token, "PUT", `${base}/model-access`, {
            target: "model",
            id: "openai/gpt-5.5",
            enabled: true,
          });
          await api(auth.access_token, "PUT", `${base}/model-defaults`, {
            scope: "project",
            model: "openai/gpt-5.5",
          });
        }
        if (!isDeployedTarget()) {
          // A persisted conversation is the real offline submission surface.
          // The local profile deliberately has no cloud session provisioning.
          sessionId = await createDatabaseSession(loadEnv(), {
            projectId: project.id,
            accountId: accounts[0].account_id,
            userId: user.id,
          });
          const rootId = `ses_${sessionId.replaceAll("-", "")}`;
          const now = Date.now() - 60_000;
          await runDatabaseSql(
            "UPDATE kortix.project_sessions SET status = 'stopped', opencode_session_id = $2, sandbox_id = $1, sandbox_url = 'http://127.0.0.1:1' WHERE session_id = $1",
            [sessionId, rootId],
            databaseUrl,
          );
          await runDatabaseSql(
            "INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status, external_id, base_url) VALUES ($1::uuid,$1,$2,$3,'stopped',$1,'http://127.0.0.1:1')",
            [sessionId, accounts[0].account_id, project.id],
            databaseUrl,
          );
          await runDatabaseSql(
            "INSERT INTO kortix.session_transcript_mirrors (session_id, project_id, account_id, opencode_session_id, head_complete) VALUES ($1,$2,$3,$4,true)",
            [sessionId, project.id, accounts[0].account_id, rootId],
            databaseUrl,
          );
          for (const role of ["user", "assistant"] as const) {
            const id =
              role === "user"
                ? "msg_000000000000000000000001"
                : "msg_000000000000000000000002";
            const info = {
              id,
              sessionID: rootId,
              role,
              agent: "kortix",
              time: {
                created: now,
                ...(role === "assistant" ? { completed: now + 1 } : {}),
              },
              ...(role === "user"
                ? { model: { providerID: "kortix", modelID: "openai/gpt-5.5" } }
                : {
                    parentID: "msg_000000000000000000000001",
                    providerID: "kortix",
                    modelID: "openai/gpt-5.5",
                    mode: "build",
                    cost: 0,
                    tokens: {
                      input: 0,
                      output: 0,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                    },
                    finish: "stop",
                    path: { cwd: "/workspace", root: "/workspace" },
                  }),
            };
            const parts = [
              {
                id: `prt_queue_${role}`,
                sessionID: rootId,
                messageID: id,
                type: "text",
                text: role === "user" ? "Previous prompt" : "Previous response",
              },
            ];
            await runDatabaseSql(
              "INSERT INTO kortix.session_transcript_messages (session_id, message_id, opencode_session_id, role, message_created_at, info, parts) VALUES ($1,$2,$3,$4,$5,$6,$7)",
              [
                sessionId,
                id,
                rootId,
                role,
                new Date(now),
                JSON.stringify(info),
                JSON.stringify(parts),
              ],
              databaseUrl,
            );
          }
          // Keep the cached conversation mounted. The local test sandbox has
          // no provider behind it, so a real /start eventually marks it stopped.
          // Prompt acceptance and read-back still use the real API below.
          await page.route(`**/sessions/${sessionId}/start?*`, async (route) => {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                stage: "ready",
                agent_name: "kortix",
                retriable: false,
                opencode_session_id: rootId,
                sandbox: {
                  sandbox_id: sessionId,
                  session_id: sessionId,
                  project_id: project.id,
                  account_id: accounts[0].account_id,
                  provider: "daytona",
                  external_id: sessionId,
                  base_url: "http://127.0.0.1:1",
                  status: "active",
                  config: {},
                  metadata: {},
                  last_used_at: null,
                  created_at: new Date(now).toISOString(),
                  updated_at: new Date(now).toISOString(),
                },
              }),
            });
          });
        }
        await installBrowserSessionDirect(
          page,
          auth,
          `${baseURL}/projects/${project.id}${sessionId ? `/sessions/${sessionId}` : ""}`,
          authOptions,
        );
        await dismissOnboarding(page);
        const input = page.getByRole("textbox", { name: "Message input" });
        await expect(input).toBeVisible({ timeout: 60_000 });
        if (isDeployedTarget()) {
          await input.fill("Run sleep 45 in the terminal, then reply READY.");
          await input.press("Enter");
          await expect(page).toHaveURL(/\/sessions\/[^/?]+/, {
            timeout: 60_000,
          });
          sessionId = new URL(page.url()).pathname.split("/").at(-1)!;
          await expect(input).toBeEmpty();
        } else {
          await expect(
            page.getByText("Previous response", { exact: true }),
          ).toBeVisible();
        }
        const send = async (
          text: string,
          key: string,
          placement: string,
          fill = true,
        ) => {
          const request = page.waitForRequest(
            (request) =>
              request.method() === "POST" &&
              new URL(request.url()).pathname.endsWith(
                `/sessions/${sessionId}/prompts`,
              ),
          );
          if (fill) await input.fill(text);
          await input.press(key);
          const sent = await request;
          const outgoing = sent.postDataJSON();
          expect(outgoing.placement).toBe(placement);
          expect(outgoing.parts).toContainEqual(
            expect.objectContaining({ type: "text", text }),
          );
          await expect(input).toBeEmpty();
          expect([200, 202]).toContain((await sent.response())?.status());
        };
        const transcriptText = "Enter pending placement";
        const composerText = "Command pending placement";
        const pending = page
          .locator("[data-pending-prompt-id]")
          .filter({ hasText: transcriptText });
        // Keep the first real API acceptance in flight. A second Enter must
        // paint and POST without waiting for that response to reach the tab.
        let releaseAcceptance!: () => void;
        const acceptanceGate = new Promise<void>((resolve) => { releaseAcceptance = resolve; });
        const promptsUrl = `**/sessions/${sessionId}/prompts`;
        await page.route(promptsUrl, async (route) => {
          const request = route.request();
          if (request.method() !== "POST" || !request.postData()?.includes(transcriptText)) {
            await route.continue();
            return;
          }
          const response = await route.fetch();
          await acceptanceGate;
          await route.fulfill({ response });
        });
        const firstSend = send(transcriptText, "Enter", "transcript");
        try {
          await expect(pending).toBeVisible({ timeout: 1_000 });
          await input.fill(composerText);
          const nextRequest = page.waitForRequest((request) =>
            request.method() === "POST" && request.url().endsWith(`/sessions/${sessionId}/prompts`) &&
            Boolean(request.postData()?.includes(composerText)), { timeout: 1_000 });
          await input.press("Meta+Enter");
          await expect(page.locator("[data-queued-prompt-id]").filter({ hasText: composerText }))
            .toBeVisible({ timeout: 1_000 });
          expect((await nextRequest).postDataJSON().placement).toBe("composer");
        } finally {
          releaseAcceptance();
          await firstSend;
          await page.unroute(promptsUrl);
        }
        await expect(pending).toHaveAttribute("data-queue-tone", "pending");
        await expect(pending).not.toContainText(/Quick Queue|Waiting|Sending|Queued/);
        if (!isDeployedTarget()) {
          await expect(page.getByText("Thinking", { exact: true })).toHaveCount(0);
          await expect(page.getByText(/This session is idle/)).toHaveCount(0);
        }
        const row = page
          .locator("[data-queued-prompt-id]")
          .filter({ hasText: composerText });
        await expect(row).toBeVisible();
        await expect(
          page
            .locator("[data-queued-prompt-id]")
            .filter({ hasText: transcriptText }),
        ).toHaveCount(0);
        await expect(
          row.getByRole("button", { name: "Edit", exact: true }),
        ).toBeEnabled();
        await dismissWelcomeCard(page);
        await row.hover();
        await row.getByRole("button", { name: "Edit", exact: true }).click();
        await expect(input).toHaveText(composerText);
        await expect(row).toHaveCount(0);
        await input.press("End");
        const codeLines = [
          "```ts",
          "const values = [1, 2, 3];",
          "for (const value of values) {",
          "  console.log(value);",
          "}",
          "```",
        ];
        for (const line of codeLines) {
          await input.press("Shift+Enter");
          await input.pressSequentially(line);
        }
        await expect(input).toContainText("console.log(value)");
        const editedText = `${composerText}\n${codeLines.join("\n")}`;
        await send(editedText, "Control+Enter", "composer", false);
        const persisted = await api<{
          prompts: Array<{ placement: string; full_text: string }>;
        }>(
          auth.access_token,
          "GET",
          `/projects/${project.id}/sessions/${sessionId}/prompts`,
        );
        expect(persisted.prompts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              placement: "transcript",
              full_text: transcriptText,
            }),
            expect.objectContaining({
              placement: "composer",
              full_text: editedText,
            }),
          ]),
        );
        for (const theme of ["Dark", "Light"]) {
          await page
            .getByRole("button", { name: "Switch project", exact: true })
            .click();
          await page.getByRole("menuitem", { name: /^Settings/ }).click();
          const settings = page.getByRole("dialog");
          await settings
            .getByRole("tab", { name: "Appearance", exact: true })
            .click();
          await settings
            .getByRole("button", { name: theme, exact: true })
            .click();
          await settings.getByRole("button", { name: "Back to app" }).click();
          await expect(page.locator("html")).toHaveClass(
            new RegExp(theme.toLowerCase()),
          );
          await expect(row).toBeVisible();
          await page.screenshot({
            path: test.info().outputPath(`queue-${theme.toLowerCase()}.png`),
            scale: "css",
          });
        }
        await page.reload();
        await expect(pending).toBeVisible({ timeout: 60_000 });
        await expect(row).toBeVisible();
        await row.locator("summary").click();
        await expect(row.locator("pre")).toHaveText(editedText);
        await row.locator("summary").click();
        if (desktopApp) {
          const window = await desktopApp.browserWindow(page);
          await window.evaluate((window) =>
            window.webContents.setZoomFactor(2),
          );
          await expect(input).toBeInViewport();
          await expect(row).toBeInViewport();
          await row.hover();
          await row
            .getByRole("button", { name: "Edit", exact: true })
            .click({ trial: true });
          await window.evaluate((window) => {
            window.webContents.setZoomFactor(1);
            window.setContentSize(720, 480);
          });
        } else {
          await page.setViewportSize({ width: 720, height: 480 });
        }
        await expect(input).toBeInViewport();
        await expect(
          page
            .locator("[data-queued-prompt-id]")
            .filter({ hasText: composerText }),
        ).toBeInViewport();
        await page.screenshot({
          path: test.info().outputPath("queue-placements.png"),
          scale: "css",
        });
        if (!isDeployedTarget()) {
          // Stop must persist the queue hold, including after navigation.
          const heldRequest = page.waitForResponse((response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname.endsWith(`/sessions/${sessionId}/prompts/hold`),
          );
          await page.getByRole("button", { name: "Stop", exact: true }).click();
          expect((await heldRequest).ok()).toBe(true);
          await page.reload();
          await expect(pending).toBeVisible({ timeout: 60_000 });
          await expect(page.getByText("Thinking", { exact: true })).toHaveCount(0);
          const held = await api<{ prompts: Array<{ prompt_id: string; state: string; reason: string }> }>(
            auth.access_token, "GET", `/projects/${project.id}/sessions/${sessionId}/prompts`,
          );
          expect(held.prompts.length).toBeGreaterThan(0);
          expect(held.prompts.every((prompt) => prompt.state === "waiting" && prompt.reason === "held")).toBe(true);
          await runDatabaseSql(
            "UPDATE kortix.session_lifecycle_commands SET status = 'dead_lettered', last_error = 'delivery outcome: pending' WHERE command_id = $1",
            [held.prompts[0].prompt_id], databaseUrl,
          );
          await page.reload();
          await expect(page.getByText(/the session was not ready in time/)).toBeVisible({ timeout: 60_000 });
          await expect(page.getByText("Thinking", { exact: true })).toHaveCount(0);
          bootSessionId = await createDatabaseSession(loadEnv(), {
            projectId: project.id,
            accountId: accounts[0].account_id,
            userId: user.id,
          });
          await api(
            auth.access_token,
            "POST",
            `/projects/${project.id}/sessions/${bootSessionId}/prompts`,
            {
              client_message_id: `start_${bootSessionId}`,
              message_id: `msg_${(Date.now() * 0x1000).toString(16).slice(-12)}AbCdEfGhIjKlMn`,
              parts: [{ type: "text", text: "First prompt still starting" }],
              placement: "transcript",
            },
            202,
          );
          await page.goto(
            `${baseURL}/projects/${project.id}/sessions/${bootSessionId}`,
          );
          await expect(input).toBeVisible({ timeout: 30_000 });
          await expect(
            page
              .getByRole("paragraph")
              .getByText("First prompt still starting", { exact: true }),
          ).toBeVisible();
          await expect(page.getByText("Thinking", { exact: true })).toHaveCount(0);
          await page.reload();
          await expect(input).toBeVisible({ timeout: 30_000 });
          await expect(page.getByText("Thinking", { exact: true })).toHaveCount(0);
          await expect(
            page
              .getByRole("paragraph")
              .getByText("First prompt still starting", { exact: true }),
          ).toBeVisible();
        }
      } finally {
        if (project && bootSessionId)
          await api(
            auth.access_token,
            "DELETE",
            `/projects/${project.id}/sessions/${bootSessionId}`,
          ).catch(() => undefined);
        if (project && sessionId)
          await api(
            auth.access_token,
            "DELETE",
            `/projects/${project.id}/sessions/${sessionId}`,
          ).catch(() => undefined);
        await project?.dispose();
        await deleteAuthUser(user.id, authOptions);
      }
    });

    test("a frame without product navigation keeps a way back", async ({
      page,
      baseURL,
      desktopApp,
    }) => {
      test.setTimeout(180_000);
      await page.addInitScript(() =>
        Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }),
      );
      const email = `e2e-desktop-back-${randomUUID()}@example.test`;
      const user = await createAuthUser(email, authOptions);
      const session = await signIn(email, authOptions);
      try {
        // No request_id: the OAuth consent page resolves to a status screen
        // with no action. The desktop shell has no browser toolbar, so before
        // the frame drew Back this screen was a dead end there.
        const deadEnd = `${baseURL}/oauth/authorize`;
        const heading = (target: typeof page) =>
          target.getByRole("heading", {
            name: "Invalid authorization request",
          });
        await installBrowserSessionDirect(page, session, deadEnd, authOptions);
        await expect(heading(page)).toBeVisible({ timeout: 60_000 });
        const back = page.getByRole("button", { name: "Back", exact: true });
        if (!desktop) {
          // The web keeps the browser's own Back. The frame draws none.
          await expect(back).toHaveCount(0);
          return;
        }
        await expect(back).toBeVisible();
        const box = await back.boundingBox();
        expect(
          box!.x,
          "Back must clear the macOS traffic lights",
        ).toBeGreaterThanOrEqual(62);
        expect(
          box!.y + box!.height,
          "Back must sit inside the title-bar band",
        ).toBeLessThanOrEqual(43);
        // installBrowserSessionDirect lands on /favicon.png first, so an
        // in-app entry is behind the dead end and Back is history.back().
        await back.click();
        await expect(page).not.toHaveURL(/\/oauth\/authorize/);
        if (desktopApp) return;
        // A window opened straight onto the dead end has no in-app entry
        // behind it (about:blank is another origin), so Back goes home.
        const fresh = await page.context().newPage();
        try {
          await fresh.goto(deadEnd);
          await expect(heading(fresh)).toBeVisible({ timeout: 60_000 });
          await fresh
            .getByRole("button", { name: "Back", exact: true })
            .click();
          await expect(fresh).not.toHaveURL(/\/oauth\/authorize/, {
            timeout: 60_000,
          });
        } finally {
          await fresh.close();
        }
      } finally {
        await deleteAuthUser(user.id, authOptions);
      }
    });
  });
}
