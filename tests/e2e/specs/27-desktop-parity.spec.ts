import {
  expect,
  test as browserTest,
  _electron,
  type Locator,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  request as requestHttp,
  type Server as HttpServer,
} from "node:http";
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
  SESSION_READY_TIMEOUT_MS,
  waitForSessionReady,
} from "../helpers/session-ready";
import {
  dismissOnboarding,
  dismissWelcomeCard,
  selectAccountForUi,
} from "../helpers/ui";

const desktopRoot = fileURLToPath(
  new URL("../../../apps/desktop-electron", import.meta.url),
);
const requireDesktop = createRequire(join(desktopRoot, "package.json"));

async function launchDesktop(baseURL: string, profile: string) {
  const app = await _electron.launch({
    executablePath: requireDesktop("electron"),
    args: [desktopRoot],
    env: {
      ...process.env,
      KORTIX_DESKTOP_USER_DATA: profile,
      KORTIX_DESKTOP_URL: `${baseURL}/projects`,
    },
  });
  await expect
    .poll(
      () => app.windows().some((window) => window.url().startsWith(baseURL)),
      { timeout: 120_000 },
    )
    .toBe(true);
  return app;
}

async function startBasicProxy(baseURL: string) {
  const origin = new URL(baseURL);
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
    throw new Error("The desktop proxy test requires a loopback HTTP origin");
  }
  const expected = `Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`;
  let challenges = 0;
  let authorizedRequests = 0;
  const server: HttpServer = createServer((incoming, outgoing) => {
    if (incoming.headers["proxy-authorization"] !== expected) {
      challenges += 1;
      outgoing.writeHead(407, {
        "Content-Type": "text/plain; charset=utf-8",
        "Proxy-Authenticate": 'Basic realm="Kortix proxy test"',
      });
      outgoing.end("Proxy authentication required");
      return;
    }

    authorizedRequests += 1;
    let target: URL;
    try {
      target = new URL(incoming.url || "");
    } catch {
      outgoing.writeHead(400).end("Invalid proxy target");
      return;
    }
    if (target.origin !== origin.origin) {
      outgoing.writeHead(403).end("Proxy target not allowed");
      return;
    }
    const headers = { ...incoming.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = requestHttp(
      {
        hostname: origin.hostname,
        port: Number(origin.port || 80),
        path: `${target.pathname}${target.search}`,
        method: incoming.method,
        headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode || 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", (error) => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end(String(error.message || error));
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Basic proxy did not bind to a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    stats: () => ({ challenges, authorizedRequests }),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const test = browserTest.extend<{ desktopApp: ElectronApplication | null }>({
  desktopApp: async ({ baseURL }, use) => {
    if (process.env.E2E_DESKTOP_NATIVE !== "1") return use(null);
    const profile = await mkdtemp(join(tmpdir(), "kortix-desktop-parity-"));
    let app: ElectronApplication | undefined;
    try {
      app = await launchDesktop(baseURL!, profile);
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
/** Stop and Thinking read one busy value: exactly one row while Stop shows, none otherwise. */
async function expectThinkingMatchesStop(page: Page) {
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  const rows = page.getByTestId("session-busy-indicator");
  await expect
    .poll(async () => {
      const stopVisible = await stop.isVisible();
      return (await rows.count()) === (stopVisible ? 1 : 0);
    })
    .toBe(true);
}

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

    test("settings and account exits use the correct host alignment", async ({
      page,
      baseURL,
      desktopApp,
    }) => {
      test.setTimeout(120_000);
      if (desktopApp) {
        const window = await desktopApp.browserWindow(page);
        await window.evaluate((nativeWindow) => nativeWindow.setContentSize(1100, 700));
      } else {
        await page.setViewportSize({ width: 1100, height: 700 });
      }
      const databaseUrl =
        process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
      if (!databaseUrl)
        throw new Error("Desktop parity requires the configured test database");
      // The macOS row rule keys on `data-desktop-platform`, which the app reads
      // from `navigator.platform`, not from the user agent. Pin it, or a Linux
      // CI runner renders the Linux desktop layout and the row stays left.
      await page.addInitScript(() =>
        Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }),
      );
      const email = `e2e-desktop-exit-${randomUUID()}@example.test`;
      const user = await createAuthUser(email, authOptions);
      const session = await signIn(email, authOptions);
      let project: ManifestProject | undefined;
      try {
        const accounts = await api<{ account_id: string }[]>(
          session.access_token,
          "GET",
          "/accounts",
        );
        project = await createManifestProject({
          api,
          accessToken: session.access_token,
          accountId: accounts[0].account_id,
          userId: user.id,
          name: "Desktop exit alignment",
          databaseUrl,
        });
        await installBrowserSessionDirect(
          page,
          session,
          `${baseURL}/projects/${project.id}`,
          authOptions,
        );
        await selectAccountForUi(page, accounts[0].account_id);
        await dismissOnboarding(page);
        // Mod+, is bound by `SettingsPanel`, which `ProjectShell` mounts only
        // after auth hydrates (until then the shell renders an empty div). A
        // keystroke sent before that has no listener. The local stack hydrates
        // before `dismissOnboarding` returns; a deployed origin does not, so
        // this step failed 4 of 4 attempts on staging and on the #7579 preview
        // while passing locally. Wait for the shell's own sidebar, then press
        // until the effect has bound — the dialog must still come from Mod+,.
        await expect(
          page.getByRole("button", { name: "Switch project", exact: true }),
        ).toBeVisible({ timeout: 60_000 });
        const settings = page.getByRole("dialog");
        await expect(async () => {
          await page.keyboard.press("Meta+,");
          await expect(settings).toBeVisible({ timeout: 2_000 });
        }).toPass({ timeout: 45_000 });
        const settingsRow = settings.locator(".kx-overlay-sidebar-titlebar");
        const settingsBack = settingsRow.getByRole("button", { name: /Back to app/i });
        await expect(settingsBack).toBeVisible();
        expect(
          await settingsRow.evaluate((row) => getComputedStyle(row).justifyContent),
        ).toBe(desktop ? "flex-end" : "flex-start");
        if (!desktop) {
          const rowBox = (await settingsRow.boundingBox())!;
          const backBox = (await settingsBack.boundingBox())!;
          expect(backBox.x - rowBox.x).toBeLessThan(24);
        }
        await settingsBack.click();

        await page.goto(
          `${baseURL}/projects/${project.id}?accountId=${accounts[0].account_id}`,
        );
        const hub = page.getByRole("dialog");
        await expect(hub).toBeVisible();
        const hubRow = hub.locator(".kx-overlay-sidebar-titlebar");
        const back = hubRow.getByRole("button", { name: /Back to app/i });
        const search = hubRow.getByRole("button", { name: /Search/i });
        await expect(back).toBeVisible();
        await expect(search).toBeVisible();
        expect(
          await hubRow.evaluate((row) => getComputedStyle(row).justifyContent),
        ).toBe(desktop ? "flex-end" : "space-between");
        const backBox = (await back.boundingBox())!;
        const searchBox = (await search.boundingBox())!;
        expect(backBox.x + backBox.width).toBeLessThan(searchBox.x);
        if (!desktop) {
          const rowBox = (await hubRow.boundingBox())!;
          expect(backBox.x - rowBox.x).toBeLessThan(24);
        }
        await back.click();
        await expect(hub).not.toBeVisible();
      } finally {
        await project?.dispose();
        await deleteAuthUser(user.id, authOptions);
      }
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
      let pooledResource: { accountId: string; secretId: string } | undefined;
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
        // The project shell navigates and owns the band's corner, so the
        // window's Back (root layout) steps aside on every project view.
        await expect(
          page.getByRole("button", { name: "Back", exact: true }),
        ).toHaveCount(0);
        const box = await switcher.boundingBox();
        expect(
          box!.x,
          "workspace selector must clear native window controls",
        ).toBeGreaterThanOrEqual(desktop ? 62 : 0);
        if (desktop) {
          expect(box!.y, "workspace selector shares the traffic-light row").toBeLessThan(40);
        }
        await switcher.click();
        await expect(
          page.getByRole("menuitem", { name: "Download app", exact: true }),
        ).toHaveCount(desktop ? 0 : 1);
        await page.getByRole("menuitem", { name: /^Settings/ }).click();
        const dialog = page.getByRole("dialog");
        await expect(
          dialog.getByRole("button", { name: "Back to app" }),
        ).toBeVisible();
        const backBox = (await dialog
          .getByRole("button", { name: "Back to app" })
          .boundingBox())!;
        if (desktop) {
          expect(backBox.y, "Back to app shares the traffic-light row").toBeLessThan(40);
          expect(backBox.x, "Back to app clears the native window controls").toBeGreaterThanOrEqual(62);
        }
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
        for (const theme of ["Light", "Dark", "System"]) {
          await dialog
            .getByRole("button", { name: theme, exact: true })
            .click();
          const expectedTheme =
            theme === "System"
              ? (await page.evaluate(
                  () => matchMedia("(prefers-color-scheme: dark)").matches,
                ))
                ? "dark"
                : "light"
              : theme.toLowerCase();
          await expect(page.locator("html")).toHaveClass(
            new RegExp(expectedTheme),
          );
          if (desktopApp) {
            await expect
              .poll(() =>
                desktopApp.evaluate(
                  ({ nativeTheme }) => nativeTheme.themeSource,
                ),
              )
              .toBe(theme.toLowerCase());
          }
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
        // By href, not by a /Kortix/i name: before the agent list renders, the
        // last link matching that name can be the Skills tab, and the click
        // lands on /customize/skills.
        await page
          .locator('a[href$="/customize/agents/kortix"]')
          .first()
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
          "Kortix permissions",
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
        // The capability bar's tab, not the agent editor's "Connectors"
        // section tab of the same name, which does not change the route.
        const connectors = page
          .locator(".kx-titlebar-tabs")
          .getByRole("tab", { name: "Connectors", exact: true });
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
        if (desktopApp) {
          await page
            .getByRole("button", { name: "Collapse sidebar", exact: true })
            .click();
          const edgePeek = page.locator('[data-slot="sidebar-edge-peek"]');
          await expect(edgePeek).toBeVisible();
          await edgePeek.hover();
          await expect(switcher).toBeVisible();
          const peekingSidebar = page.locator(
            '[data-slot="sidebar"][data-peek]',
          );
          const peekHeader = peekingSidebar.locator(
            '[data-slot="sidebar-header"]',
          );
          await expect(peekHeader).toBeVisible();
          const peekPadding = await peekHeader.evaluate((header) => {
            const style = getComputedStyle(header);
            return {
              top: Number.parseFloat(style.paddingTop),
              left: Number.parseFloat(style.paddingLeft),
            };
          });
          expect(peekPadding.top).toBeCloseTo(peekPadding.left, 2);
          await expect(
            page.getByRole("button", { name: "Pin sidebar", exact: true }),
          ).toHaveCount(1);
          await page.mouse.move(1300, 850);
        }
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
          const clickNativeMenu = (id: string) =>
            desktopApp.evaluate(({ Menu, BrowserWindow }, itemId) => {
              const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
              item?.click(
                undefined,
                BrowserWindow.getAllWindows()[0],
                undefined,
              );
            }, id);
          await clickNativeMenu("kx-view-zoom-in");
          await expect
            .poll(() =>
              window.evaluate((window) => window.webContents.getZoomFactor()),
            )
            .toBeGreaterThan(originalZoom);
          await clickNativeMenu("kx-view-actual-size");
          await expect
            .poll(() =>
              window.evaluate((window) => window.webContents.getZoomFactor()),
            )
            .toBe(originalZoom);

          await window.evaluate(async (window) => {
            if (window.isFullScreen()) return;
            await new Promise<void>((resolve) => {
              window.once("enter-full-screen", resolve);
              window.setFullScreen(true);
            });
          });
          await expect(page.locator("html")).toHaveAttribute(
            "data-desktop-fullscreen",
            "true",
          );
          await expect
            .poll(() =>
              page
                .locator("html")
                .evaluate((html) =>
                  getComputedStyle(html)
                    .getPropertyValue("--kx-titlebar-inset")
                    .trim(),
                ),
            )
            .toBe("0px");
          await page.reload();
          await expect(page.locator("html")).toHaveAttribute(
            "data-desktop-fullscreen",
            "true",
          );
          await window.evaluate(async (window) => {
            if (!window.isFullScreen()) return;
            await new Promise<void>((resolve) => {
              window.once("leave-full-screen", resolve);
              window.setFullScreen(false);
            });
          });
          await expect(page.locator("html")).not.toHaveAttribute(
            "data-desktop-fullscreen",
          );

          const windowsBeforePopup = desktopApp.windows().length;
          await page.evaluate(() => {
            window.open("", "connector-auth", "width=520,height=720");
          });
          await expect
            .poll(() => desktopApp.windows().length)
            .toBe(windowsBeforePopup + 1);
          const popup = desktopApp
            .windows()
            .find((candidate) => candidate !== page);
          expect(popup?.url()).toBe("about:blank");
          await popup?.close();

          const menuState = (id: string) =>
            desktopApp.evaluate(({ Menu }, itemId) => {
              const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
              return item
                ? { enabled: item.enabled, accelerator: item.accelerator }
                : null;
            }, id);
          await expect
            .poll(() => menuState("kx-file-new-session"))
            .toMatchObject({
              enabled: true,
              accelerator: "CommandOrControl+N",
            });
          await expect
            .poll(() => menuState("kx-file-close-tab"))
            .toMatchObject({
              enabled: true,
              accelerator: "CommandOrControl+W",
            });
          await clickNativeMenu("kx-app-settings");
          await expect(page.getByRole("dialog")).toBeVisible();
          await page
            .getByRole("dialog")
            .getByRole("button", { name: "Back to app" })
            .click();
          await page
            .getByRole("button", { name: "Open sidebar", exact: true })
            .click();
          await expect(switcher).toBeInViewport();
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

          await resize(720, 480);
          await page.goto(`${baseURL}/projects/${project.id}/settings/repositories`);
          const changeRepository = page.getByRole('button', { name: 'Change', exact: true });
          await expect(changeRepository).toBeVisible();
          await changeRepository.click();
          const repositoryDialog = page.getByRole('dialog', { name: 'Change repository' });
          await expect(repositoryDialog.getByRole('textbox', { name: 'New GitHub repository URL' })).toBeVisible();
          const confirmRepository = repositoryDialog.getByRole('button', { name: 'Change repository', exact: true });
          await expect(confirmRepository).toBeVisible();
          await expect.poll(() => confirmRepository.evaluate((button) => {
            const bounds = button.getBoundingClientRect();
            return bounds.bottom <= window.innerHeight;
          })).toBe(true);
          const cancelRepository = repositoryDialog.getByRole('button', { name: 'Cancel' });
          await expect.poll(() => cancelRepository.evaluate((button) => {
            const bounds = button.getBoundingClientRect();
            const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
            return hit === button || button.contains(hit);
          })).toBe(true);
          await page.screenshot({ path: test.info().outputPath('desktop-repository-change.png'), scale: 'css' });
          await cancelRepository.click();
          await expect(repositoryDialog).toBeHidden();
        }
        for (const feature of ['llm_gateway', 'pooled_provider_secrets']) {
          await api(session.access_token, 'PATCH', `/projects/${project.id}/features`, {
            feature, enabled: true,
          });
        }
        const key = await api<{ secret_id: string }>(
          session.access_token, 'POST', `/accounts/${accountId}/secret-resources`, {
            label: 'Desktop pooled key', provider_id: 'anthropic', name: 'ANTHROPIC_API_KEY',
            value: 'fake-desktop-key', consumer: 'llm_gateway', strategy: 'broker',
          }, 201,
        );
        pooledResource = { accountId, secretId: key.secret_id };
        await resize(720, 480);
        await page.goto(`${baseURL}/projects/${project.id}/customize/models`);
        const providerKeys = page.getByRole('region', { name: 'Anthropic API keys' });
        await expect(providerKeys.getByText('Desktop pooled key')).toBeVisible();
        const welcome = page.getByRole('complementary', { name: 'Welcome from Marko' });
        if (await welcome.isVisible().catch(() => false)) {
          await welcome.getByRole('button', { name: 'Dismiss' }).click();
        }
        await providerKeys.getByRole('button', { name: 'Actions for Desktop pooled key' }).click();
        await expect(page.getByRole('menuitem', { name: 'Manage access' })).toBeVisible();
        await page.keyboard.press('Escape');
        await page.goto(`${baseURL}/projects/${project.id}`);
        await page.getByRole('button', { name: 'Session overrides' }).click();
        await page.getByRole('button', { name: /Provider keys/ }).click();
        await expect(page.getByRole('checkbox', { name: 'Desktop pooled key' })).toBeVisible();
      } finally {
        if (pooledResource) {
          await api(session.access_token, 'DELETE', `/accounts/${pooledResource.accountId}/secret-resources/${pooledResource.secretId}`).catch(() => {});
        }
        await project?.dispose();
        await deleteAuthUser(user.id, authOptions);
      }
    });

    test("Enter and Command+Enter keep distinct pending prompt placements", async ({
      page,
      baseURL,
      desktopApp,
    }) => {
      // A deployed target provisions a real sandbox first (see below).
      test.setTimeout(
        isDeployedTarget() ? 180_000 + SESSION_READY_TIMEOUT_MS : 180_000,
      );
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
      const deliveryFixtureId = randomUUID();
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
          // Stop is enabled only while a turn runs, and the turn starts only
          // once the sandbox is ready. A fresh preview builds the default
          // image for ~9 min first, so a flat 60 s wait on Stop failed 11 of
          // 13 previews with the session still in `provisioning`.
          await waitForSessionReady(api, auth.access_token, project.id, sessionId);
          await expect(page.getByRole("button", { name: "Stop", exact: true }))
            .toBeEnabled({ timeout: 60_000 });
          await expect(input).toBeEmpty();
        } else {
          await expect(
            page.getByText("Previous response", { exact: true }),
          ).toBeVisible();
        }
        await runDatabaseSql(
          `INSERT INTO kortix.session_lifecycle_commands
           (command_id, command_type, source, status, project_id, session_id,
            account_id, actor_user_id, payload, locked_by, locked_until)
           VALUES ($1, 'continue_session', 'ui', 'running', $2, $3, $4, $5,
             $6::jsonb, 'browser-queue-fixture', now() + interval '10 minutes')`,
          [deliveryFixtureId, project.id, sessionId, accounts[0].account_id, user.id,
            JSON.stringify({ text: "Pending delivery fixture", clientMessageId: `msg_${deliveryFixtureId.replaceAll("-", "")}` })],
          databaseUrl,
        );
        const promptRequest = () => page.waitForRequest(
          (request) =>
            request.method() === "POST" &&
            new URL(request.url()).pathname.endsWith(`/sessions/${sessionId}/prompts`),
        );
        const verifySend = async (
          request: Promise<import("@playwright/test").Request>,
          text: string,
          placement: string,
        ) => {
          const sent = await request;
          const outgoing = sent.postDataJSON();
          expect(outgoing.placement).toBe(placement);
          expect(outgoing.parts).toContainEqual(
            expect.objectContaining({ type: "text", text }),
          );
          await expect(input).toBeEmpty();
          expect([200, 202]).toContain((await sent.response())?.status());
        };
        const send = async (text: string, key: string, placement: string, fill = true) => {
          const request = promptRequest();
          if (fill) await input.fill(text);
          await input.press(key);
          await verifySend(request, text, placement);
        };
        const transcriptText = "Enter pending placement";
        const composerText = "Command pending placement";
        const pending = page
          .locator("[data-pending-prompt-id]")
          .filter({ hasText: transcriptText });
        // Keep the first real API acceptance in flight. A second Enter must
        // paint at once. Its POST leaves after the first POST settles: the
        // session's delivery chain keeps POSTs in Enter order, because an idle
        // session admits whichever prompt lands first (`delivery-chain.ts`).
        let releaseAcceptance!: () => void;
        const acceptanceGate = new Promise<void>((resolve) => { releaseAcceptance = resolve; });
        const postOrder: string[] = [];
        const promptsUrl = `**/sessions/${sessionId}/prompts`;
        await page.route(promptsUrl, async (route) => {
          const request = route.request();
          const body = request.postData() ?? "";
          if (request.method() === "POST") {
            postOrder.push(body.includes(transcriptText) ? "transcript" : body.includes(composerText) ? "composer" : "other");
          }
          if (request.method() !== "POST" || !body.includes(transcriptText)) {
            await route.continue();
            return;
          }
          const response = await route.fetch();
          await acceptanceGate;
          await route.fulfill({ response });
        });
        const firstRequest = promptRequest();
        await input.fill(transcriptText);
        await input.press("Enter");
        const firstSend = verifySend(firstRequest, transcriptText, "transcript");
        let nextRequest: Promise<import("@playwright/test").Request> | undefined;
        try {
          await expect(pending).toBeVisible({ timeout: 1_000 });
          await input.fill(composerText);
          nextRequest = page.waitForRequest((request) =>
            request.method() === "POST" && request.url().endsWith(`/sessions/${sessionId}/prompts`) &&
            Boolean(request.postData()?.includes(composerText)), { timeout: 30_000 });
          await input.press("Meta+Enter");
          await expect(page.locator("[data-queued-prompt-id]").filter({ hasText: composerText }))
            .toBeVisible({ timeout: 1_000 });
          // Painted, and still waiting behind the first POST.
          expect(postOrder).toEqual(["transcript"]);
        } finally {
          releaseAcceptance();
          await firstSend;
        }
        expect(nextRequest).toBeDefined();
        expect((await nextRequest!).postDataJSON().placement).toBe("composer");
        // The request event resolves `waitForRequest` before the route handler
        // records the POST, so wait for the handler.
        await expect.poll(() => postOrder).toEqual(["transcript", "composer"]);
        await page.unroute(promptsUrl);
        await expect(pending).toHaveAttribute("data-queue-tone", "pending");
        await expect(pending).not.toContainText(/Quick Queue|Waiting|Sending|Queued/);
        await expectThinkingMatchesStop(page);
        if (!isDeployedTarget()) {
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
        // Edit is IN PLACE: the row stays in the list, its actions replaced by
        // an "Editing" label, until the composer saves it. It used to be taken
        // back out of the queue on click, and a message pulled into the
        // composer was one stray Escape away from never being sent.
        await expect(row).toBeVisible();
        await expect(row).toContainText("Editing");
        await expect(row.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
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
          await expectThinkingMatchesStop(page);
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
          await expectThinkingMatchesStop(page);
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
          await expectThinkingMatchesStop(page);
          await page.reload();
          await expect(input).toBeVisible({ timeout: 30_000 });
          await expectThinkingMatchesStop(page);
          await expect(
            page
              .getByRole("paragraph")
              .getByText("First prompt still starting", { exact: true }),
          ).toBeVisible();

          if (desktopApp) {
            const clickNativeMenu = (id: string) =>
              desktopApp.evaluate(({ Menu, BrowserWindow }, itemId) => {
                const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
                item?.click(
                  undefined,
                  BrowserWindow.getAllWindows()[0],
                  undefined,
                );
              }, id);
            const menuState = (id: string) =>
              desktopApp.evaluate(({ Menu }, itemId) => {
                const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
                return item
                  ? { enabled: item.enabled, accelerator: item.accelerator }
                  : null;
              }, id);
            await clickNativeMenu("kx-file-new-session");
            await expect(page).toHaveURL(
              new RegExp(`/projects/${project.id}(?:\\?|$)`),
              { timeout: 60_000 },
            );
            await page.goto(
              `${baseURL}/projects/${project.id}/customize/connectors`,
            );
            await expect(
              page.getByRole("tab", { name: "Connected", exact: true }),
            ).toBeVisible();
            await expect
              .poll(() => menuState("kx-file-close-tab"))
              .toMatchObject({ enabled: true });
            await clickNativeMenu("kx-file-close-tab");
            await expect(page).toHaveURL(
              new RegExp(`/projects/${project.id}(?:\\?|$)`),
              { timeout: 60_000 },
            );

            await page.goto(`${baseURL}/settings`);
            await expect(page).toHaveURL(/\/settings(?:\?|$)/, {
              timeout: 60_000,
            });
            await expect
              .poll(() => menuState("kx-file-new-session"))
              .toMatchObject({ enabled: false });
            await expect
              .poll(() => menuState("kx-file-close-tab"))
              .toMatchObject({ enabled: false });
            await clickNativeMenu("kx-app-settings");
            await expect(page).toHaveURL(/\/settings(?:\?|$)/, {
              timeout: 60_000,
            });

            const unloadAllowed = (response: number) =>
              desktopApp.evaluate(
                ({ BrowserWindow, dialog }, options) => {
                  const main = BrowserWindow.getAllWindows().find((window) =>
                    window.webContents.getURL().startsWith(options.origin),
                  );
                  if (!main) throw new Error("main window not found");
                  const original = dialog.showMessageBoxSync;
                  let allowed = false;
                  dialog.showMessageBoxSync = () => options.response;
                  try {
                    main.webContents.emit("will-prevent-unload", {
                      preventDefault: () => {
                        allowed = true;
                      },
                    });
                    return allowed;
                  } finally {
                    dialog.showMessageBoxSync = original;
                  }
                },
                { origin: baseURL!, response },
              );
            expect(await unloadAllowed(1)).toBe(false);
            expect(await unloadAllowed(0)).toBe(true);

            await project.dispose();
            project = undefined;
            await desktopApp.evaluate(
              async ({ BrowserWindow, Menu, dialog }, itemId) => {
                const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
                const window = BrowserWindow.getAllWindows()[0];
                const original = dialog.showMessageBoxSync;
                dialog.showMessageBoxSync = () => 0;
                try {
                  await new Promise<void>((resolve, reject) => {
                    const timeout = setTimeout(
                      () => reject(new Error("Native Close Window timed out")),
                      10_000,
                    );
                    window.once("closed", () => {
                      clearTimeout(timeout);
                      resolve();
                    });
                    item?.click(undefined, window, undefined);
                  });
                } finally {
                  dialog.showMessageBoxSync = original;
                }
              },
              "kx-file-close-window",
            );
          }
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
        await runDatabaseSql(
          "DELETE FROM kortix.session_lifecycle_commands WHERE command_id = $1",
          [deliveryFixtureId], databaseUrl,
        );
        await project?.dispose();
        await deleteAuthUser(user.id, authOptions);
      }
    });

    const nativeTest = process.env.E2E_DESKTOP_NATIVE === "1" ? test : null;
    nativeTest?.(
      "connector authorization popup keeps its opener callback",
      async ({ page, desktopApp }) => {
        if (!desktopApp)
          throw new Error("native Electron application is required");
        const windowsBeforePopup = desktopApp.windows().length;
        const hasPopupHandle = await page.evaluate(() => {
          let popup: Window | null = null;
          window.addEventListener("message", (event) => {
            if (event.source !== popup || event.data !== "connector-auth-reply")
              return;
            document.documentElement.dataset.connectorAuthReply = event.data;
          });
          popup = window.open("", "connector-auth", "width=520,height=720");
          return popup !== null;
        });
        expect(hasPopupHandle).toBe(true);
        await expect
          .poll(() => desktopApp.windows().length)
          .toBe(windowsBeforePopup + 1);
        const popup = desktopApp
          .windows()
          .find(
            (candidate) =>
              candidate !== page && candidate.url() === "about:blank",
          );
        if (!popup) throw new Error("connector popup not found");
        try {
          expect(popup.url()).toBe("about:blank");
          expect(await popup.evaluate(() => Boolean(window.opener))).toBe(true);
          await popup.evaluate(() => {
            window.opener?.postMessage("connector-auth-reply", "*");
          });
          await expect(page.locator("html")).toHaveAttribute(
            "data-connector-auth-reply",
            "connector-auth-reply",
          );
        } finally {
          await popup.close();
        }
      },
    );
    nativeTest?.(
      "dock activation recreates the main window with its persisted native state",
      async ({ desktopApp, baseURL }) => {
        if (!desktopApp)
          throw new Error("native Electron application is required");
        test.setTimeout(180_000);

        const restored = await desktopApp.evaluate(
          async ({ BrowserWindow, app, screen }, origin) => {
            const delay = (ms: number) =>
              new Promise((resolve) => setTimeout(resolve, ms));
            const main = BrowserWindow.getAllWindows().find((window) =>
              window.webContents.getURL().startsWith(origin),
            );
            if (!main) throw new Error("main window not found");
            main.minimize();
            await delay(100);
            app.emit("activate");
            for (
              let attempt = 0;
              attempt < 80 && main.isMinimized();
              attempt += 1
            ) {
              await delay(50);
            }
            const restoredFromMinimized =
              !main.isMinimized() && main.isVisible();
            const area = screen.getPrimaryDisplay().workArea;
            const expected = {
              x: area.x + 80,
              y: area.y + 70,
              width: Math.min(980, area.width - 160),
              height: Math.min(680, area.height - 140),
            };
            main.unmaximize();
            main.setBounds(expected);
            await delay(350);
            main.maximize();
            for (
              let attempt = 0;
              attempt < 80 && !main.isMaximized();
              attempt += 1
            ) {
              await delay(50);
            }
            if (!main.isMaximized())
              throw new Error("main window did not maximize");
            await delay(350);

            const popup = new BrowserWindow({ show: false });
            await popup.loadURL("about:blank");
            main.destroy();
            await delay(100);
            app.emit("activate");

            let replacement = BrowserWindow.getAllWindows().find(() => false);
            for (let attempt = 0; attempt < 240; attempt += 1) {
              replacement = BrowserWindow.getAllWindows().find(
                (window) =>
                  window !== popup &&
                  window.webContents.getURL().startsWith(origin),
              );
              if (replacement?.isVisible() && replacement.isMaximized()) break;
              await delay(250);
            }
            if (!replacement)
              throw new Error("replacement main window not found");
            const result = {
              expected,
              normalBounds: replacement.getNormalBounds(),
              maximized: replacement.isMaximized(),
              popupAlive: !popup.isDestroyed(),
              restoredFromMinimized,
            };
            popup.destroy();
            return result;
          },
          baseURL!,
        );

        expect(restored.popupAlive).toBe(true);
        expect(restored.restoredFromMinimized).toBe(true);
        expect(restored.maximized).toBe(true);
        expect(restored.normalBounds).toEqual(restored.expected);
      },
    );

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
        await page.goto(`${baseURL}/dashboard`, { waitUntil: "domcontentloaded" });
        await page.goto(deadEnd, { waitUntil: "domcontentloaded" });
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
        // installBrowserSessionDirect lands on /favicon.png first, so an entry
        // is behind the dead end. The browser steps back onto it. The desktop
        // shell cancels a renderer history.back() into it (not an app path) and
        // steps over it instead, to /auth, which sends a signed-in user on.
        await back.click();
        await expect(page).not.toHaveURL(/\/oauth\/authorize/, {
          timeout: 60_000,
        });
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

    test("Create a project keeps a way back to the project it opened from", async ({
      page,
      baseURL,
      desktopApp,
    }) => {
      test.setTimeout(300_000);
      const databaseUrl =
        process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
      if (!databaseUrl)
        throw new Error("Desktop parity requires the configured test database");
      await page.addInitScript(() =>
        Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }),
      );
      const email = `e2e-desktop-new-${randomUUID()}@example.test`;
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
          name: "Desktop back",
          databaseUrl,
        });
        const projectUrl = `${baseURL}/projects/${project.id}`;
        await installBrowserSessionDirect(
          page,
          session,
          projectUrl,
          authOptions,
        );
        await selectAccountForUi(page, accountId);
        await page.goto(projectUrl);
        await dismissOnboarding(page);

        // The reported soft lock: the switcher opens /new, and /new has no
        // navigation of its own — only an account picker and Log out.
        await page
          .getByRole("button", { name: "Switch project", exact: true })
          .click();
        await page
          .getByRole("menuitem", { name: "Switch Project", exact: true })
          .click();
        await page.getByRole("menuitem", { name: "Create a project…" }).click();
        await expect(page).toHaveURL(/\/new(\?|$)/, { timeout: 60_000 });
        await expect(
          page.getByRole("heading", { name: "Create a project" }),
        ).toBeVisible({ timeout: 60_000 });

        const back = page.getByRole("button", { name: "Back", exact: true });
        if (!desktop) {
          // The web keeps the browser's own Back and draws none.
          await expect(back).toHaveCount(0);
          return;
        }
        await expect(back).toBeVisible();
        const backBox = (await back.boundingBox())!;
        expect(
          backBox.x,
          "Back must clear the macOS traffic lights",
        ).toBeGreaterThanOrEqual(62);
        expect(
          backBox.y + backBox.height,
          "Back must sit inside the title-bar band",
        ).toBeLessThanOrEqual(43);
        // The page's own top row (account picker, Log out) drops below the band.
        const logOut = page.getByRole("button", {
          name: "Log out",
          exact: true,
        });
        await expect(logOut).toBeVisible();
        expect(
          (await logOut.boundingBox())!.y,
          "Log out must sit below the title-bar band",
        ).toBeGreaterThanOrEqual(backBox.y + backBox.height);

        // `/new` has no titlebar owner, so the root strip is its only drag
        // area and covers the whole band (#7568). The strip paints above Back,
        // so it must not take Back's click: Back is the topmost box at its
        // own center.
        const strip = await page
          .locator(".kx-desktop-chrome")
          .evaluate((element) => ({
            bottom: element.getBoundingClientRect().bottom,
            region: getComputedStyle(element).webkitAppRegion,
          }));
        expect(
          strip.bottom,
          "the drag strip must cover the title-bar band",
        ).toBeGreaterThanOrEqual(backBox.y + backBox.height);
        expect(strip.region, "the band must stay a window drag region").toBe(
          "drag",
        );
        expect(
          await back.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            );
            return hit !== null && element.contains(hit);
          }),
          "the drag strip must not cover Back",
        ).toBe(true);

        await back.click();
        await expect(page).toHaveURL(new RegExp(`/projects/${project.id}`), {
          timeout: 60_000,
        });

        if (!desktopApp) {
          // Windows and Linux keep Electron's OS-native frame. The web content
          // must reserve no duplicate control cluster.
          for (const platform of ["Win32", "Linux x86_64"]) {
            const other = await page.context().newPage();
            try {
              await other.addInitScript(
                (value) =>
                  Object.defineProperty(navigator, "platform", {
                    get: () => value,
                  }),
                platform,
              );
              await other.setViewportSize({ width: 1440, height: 900 });
              await other.goto(projectUrl);
              await expect(
                other.getByRole("button", {
                  name: "Switch project",
                  exact: true,
                }),
              ).toBeVisible({ timeout: 60_000 });
              await other.goto(`${baseURL}/new`);
              await expect(
                other.getByRole("heading", { name: "Create a project" }),
              ).toBeVisible({ timeout: 60_000 });
              const otherBack = other.getByRole("button", {
                name: "Back",
                exact: true,
              });
              await expect(otherBack, `${platform}: Back`).toBeVisible();
              const b = (await otherBack.boundingBox())!;
              expect(
                b.x,
                `${platform}: Back starts at the band's left edge`,
              ).toBeLessThan(24);
              expect(
                b.y + b.height,
                `${platform}: Back sits inside the band`,
              ).toBeLessThanOrEqual(42);
              await expect(other.locator(".kx-desktop-controls")).toHaveCount(
                0,
              );
              expect(
                await other
                  .locator("html")
                  .evaluate((html) =>
                    getComputedStyle(html)
                      .getPropertyValue("--kx-titlebar-controls-width")
                      .trim(),
                  ),
                `${platform}: no web-drawn control reservation`,
              ).toBe("0px");
              await otherBack.click();
              await expect(other).toHaveURL(
                new RegExp(`/projects/${project.id}`),
                {
                  timeout: 60_000,
                },
              );
            } finally {
              await other.close();
            }
          }
          return;
        }
        // The mouse side buttons step the same history. Real DOM buttons 3/4
        // through CDP, caught by the preload and resolved by the shell.
        const cdp = await page.context().newCDPSession(page);
        const sideButton = async (button: "back" | "forward") => {
          for (const type of ["mousePressed", "mouseReleased"] as const) {
            await cdp.send("Input.dispatchMouseEvent", {
              type,
              x: 400,
              y: 400,
              button,
              buttons: 0,
              clickCount: 1,
            });
          }
        };
        await sideButton("forward");
        await expect(page).toHaveURL(/\/new(\?|$)/, { timeout: 60_000 });
        await sideButton("back");
        await expect(page).toHaveURL(new RegExp(`/projects/${project.id}`), {
          timeout: 60_000,
        });
        await cdp.detach();

        // The shell's Go menu reaches the same history on any page, including
        // pages the web app does not render.
        const menuItem = (id: string) =>
          desktopApp.evaluate(({ Menu }, itemId) => {
            const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
            return item ? { enabled: item.enabled } : null;
          }, id);
        const clickMenu = (id: string) =>
          desktopApp.evaluate(({ Menu, BrowserWindow }, itemId) => {
            const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
            item?.click(undefined, BrowserWindow.getAllWindows()[0], undefined);
          }, id);
        await expect
          .poll(() => menuItem("kx-go-forward"))
          .toEqual({ enabled: true });
        await clickMenu("kx-go-forward");
        await expect(page).toHaveURL(/\/new(\?|$)/, { timeout: 60_000 });
        await expect
          .poll(() => menuItem("kx-go-back"))
          .toEqual({ enabled: true });
        await clickMenu("kx-go-back");
        await expect(page).toHaveURL(new RegExp(`/projects/${project.id}`), {
          timeout: 60_000,
        });
        await clickMenu("kx-go-home");
        await expect(page).not.toHaveURL(/\/new(\?|$)/, { timeout: 60_000 });
      } finally {
        await project?.dispose();
        await deleteAuthUser(user.id, authOptions);
      }
    });
  });
}

const nativeBrowserTest =
  process.env.E2E_DESKTOP_NATIVE === "1" ? browserTest : null;
nativeBrowserTest?.(
  "27 — desktop parity keeps the collapsed Customize header draggable",
  async ({ baseURL }) => {
    browserTest.setTimeout(120_000);
    const databaseUrl =
      process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
    if (!databaseUrl)
      throw new Error("Desktop drag test requires the configured test database");
    const profile = await mkdtemp(join(tmpdir(), "kortix-desktop-drag-"));
    const email = `e2e-desktop-drag-${randomUUID()}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    let project: ManifestProject | undefined;
    let app: ElectronApplication | undefined;
    try {
      const accounts = await api<{ account_id: string }[]>(
        session.access_token,
        "GET",
        "/accounts",
      );
      project = await createManifestProject({
        api,
        accessToken: session.access_token,
        accountId: accounts[0].account_id,
        userId: user.id,
        name: "Desktop drag region",
        databaseUrl,
      });
      app = await launchDesktop(baseURL!, profile);
      const main = app
        .windows()
        .find((window) => window.url().startsWith(baseURL!));
      if (!main) throw new Error("native main window not found");
      await installBrowserSessionDirect(
        main,
        session,
        `${baseURL}/projects/${project.id}/customize/agents`,
        authOptions,
      );
      await selectAccountForUi(main, accounts[0].account_id);
      await dismissOnboarding(main);
      await main.getByRole("button", { name: "Collapse sidebar" }).click();
      const row = main.locator(
        ".kx-capability-titlebar[data-sidebar-collapsed='true']",
      );
      await expect(row).toBeVisible();
      const dragPoint = () =>
        row.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const y = Math.round(rect.top + rect.height / 2);
          for (let x = Math.round(rect.left + 120); x < rect.right - 8; x += 8) {
            const target = document.elementFromPoint(x, y);
            if (!target || !element.contains(target)) continue;
            if (target.closest("button,a,input,[role='button'],[role='tab']")) continue;
            for (let node: Element | null = target; node && element.contains(node); node = node.parentElement) {
              const region = getComputedStyle(node).webkitAppRegion;
              if (region === "no-drag") break;
              if (region === "drag") return { x, y };
            }
          }
          return null;
        });
      expect(await dragPoint()).not.toBeNull();
      const tab = row.getByRole("tab").first();
      await expect(tab).toBeVisible();
      expect(
        await tab.evaluate((element) => getComputedStyle(element).webkitAppRegion),
      ).toBe("no-drag");
      const nativeWindow = await app.browserWindow(main);
      await nativeWindow.evaluate((window) => window.setContentSize(720, 480));
      await expect.poll(dragPoint).not.toBeNull();
      const opener = main.getByRole("button", { name: "Open sidebar" });
      await opener.hover();
      expect(await dragPoint()).not.toBeNull();
    } finally {
      await app?.close();
      await project?.dispose();
      await deleteAuthUser(user.id, authOptions);
      await rm(profile, { recursive: true, force: true });
    }
  },
);
nativeBrowserTest?.(
  "27 — desktop parity guards reload, Home, close, and quit with an unsaved agent draft",
  async ({ baseURL }) => {
    browserTest.setTimeout(240_000);
    const databaseUrl =
      process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
    if (!databaseUrl)
      throw new Error("Desktop unsaved-edit test requires the test database");
    const profile = await mkdtemp(join(tmpdir(), "kortix-desktop-unsaved-"));
    const email = `e2e-desktop-unsaved-${randomUUID()}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    let project: ManifestProject | undefined;
    let app: ElectronApplication | undefined;
    try {
      const accounts = await api<{ account_id: string }[]>(
        session.access_token,
        "GET",
        "/accounts",
      );
      project = await createManifestProject({
        api,
        accessToken: session.access_token,
        accountId: accounts[0].account_id,
        userId: user.id,
        name: "Desktop unsaved draft",
        databaseUrl,
      });
      app = await launchDesktop(baseURL!, profile);
      const main = app
        .windows()
        .find((window) => window.url().startsWith(baseURL!));
      if (!main) throw new Error("native main window not found");
      // Electron answers the native unload prompt. Prevent Playwright from
      // dismissing a Chromium dialog that Electron already consumed.
      main.on("dialog", () => {});
      const agentUrl = `${baseURL}/projects/${project.id}/customize/agents/kortix`;
      await installBrowserSessionDirect(main, session, agentUrl, authOptions);
      await selectAccountForUi(main, accounts[0].account_id);
      await dismissOnboarding(main);
      await main.goto(agentUrl);
      const description = main.getByRole("textbox", { name: /Description/i });
      await expect(description).toBeVisible({ timeout: 60_000 });
      const original = await description.inputValue();
      const draft = `${original} Unsaved desktop draft`;

      await app.evaluate(({ dialog }) => {
        const state = {
          original: dialog.showMessageBoxSync,
          response: 1,
          calls: [] as string[],
        };
        const shared = globalThis as typeof globalThis & {
          __kortixUnloadProbe?: typeof state;
        };
        shared.__kortixUnloadProbe = state;
        dialog.showMessageBoxSync = (...args) => {
          const options = args.at(-1) as { message: string };
          state.calls.push(options.message);
          return state.response;
        };
      });
      const setResponse = (response: number) =>
        app!.evaluate((_, next) => {
          const shared = globalThis as typeof globalThis & {
            __kortixUnloadProbe?: { response: number };
          };
          if (!shared.__kortixUnloadProbe)
            throw new Error("unload probe missing");
          shared.__kortixUnloadProbe.response = next;
        }, response);
      const calls = () =>
        app!.evaluate(() => {
          const shared = globalThis as typeof globalThis & {
            __kortixUnloadProbe?: { calls: string[] };
          };
          return shared.__kortixUnloadProbe?.calls ?? [];
        });
      const agentState = () =>
        app!.evaluate(async ({ BrowserWindow }, origin) => {
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().startsWith(origin),
          );
          if (!window) throw new Error("main window not found");
          return {
            url: window.webContents.getURL(),
            description: await window.webContents.executeJavaScript(
              "document.querySelector('textarea[aria-label=\"Description\"]')?.value ?? null",
            ),
          };
        }, baseURL!);

      await description.fill(draft);
      await expect(
        main.getByRole("button", { name: /Save/i }).last(),
      ).toBeVisible();
      await main.keyboard.press("Meta+R");
      await expect.poll(async () => (await calls()).length).toBe(1);
      expect(await calls()).toEqual(["Leave this page?"]);
      await expect
        .poll(agentState)
        .toEqual({ url: agentUrl, description: draft });

      await setResponse(0);
      await main.keyboard.press("Meta+R");
      await expect.poll(async () => (await calls()).length).toBe(2);
      await expect(description).toHaveValue(original, { timeout: 60_000 });
      await expect(
        main.getByRole("button", { name: /Save/i }).last(),
      ).toBeHidden();

      await Promise.all([
        main.waitForEvent("domcontentloaded"),
        main.keyboard.press("Meta+R"),
      ]);
      await expect(description).toHaveValue(original);
      expect(await calls()).toHaveLength(2);

      await description.fill(draft);
      await setResponse(1);
      const goHome = () =>
        app!.evaluate(({ BrowserWindow, Menu }) => {
          const item = Menu.getApplicationMenu()?.getMenuItemById("kx-go-home");
          const window = BrowserWindow.getAllWindows()[0];
          if (!item || !window) throw new Error("Home menu unavailable");
          item.click(undefined, window, undefined);
        });
      await goHome();
      await expect.poll(async () => (await calls()).length).toBe(3);
      await expect
        .poll(agentState)
        .toEqual({ url: agentUrl, description: draft });
      await setResponse(0);
      await goHome();
      await expect.poll(async () => (await calls()).length).toBe(4);
      await expect
        .poll(() => new URL(main.url()).pathname, { timeout: 60_000 })
        .toMatch(/^\/projects(?:\/[a-z0-9-]+)?$/);

      await main.goto(agentUrl);
      await expect(description).toBeVisible({ timeout: 60_000 });
      await description.fill(draft);
      await setResponse(1);
      await app.evaluate(({ app }) => {
        setImmediate(() => app.quit());
      });
      await expect.poll(async () => (await calls()).length).toBe(5);
      expect(main.isClosed()).toBe(false);
      await expect
        .poll(agentState)
        .toEqual({ url: agentUrl, description: draft });
      const closeWindow = () =>
        app!.evaluate(({ BrowserWindow }, origin) => {
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().startsWith(origin),
          );
          if (!window) throw new Error("main window not found");
          setImmediate(() => window.close());
        }, baseURL!);
      await setResponse(1);
      await closeWindow();
      await expect.poll(async () => (await calls()).length).toBe(6);
      expect(main.isClosed()).toBe(false);
      await expect
        .poll(agentState)
        .toEqual({ url: agentUrl, description: draft });
      await setResponse(0);
      await closeWindow();
      await expect.poll(async () => (await calls()).length).toBe(7);
      await expect.poll(() => main.isClosed()).toBe(true);

      await app.evaluate(({ app }) => app.emit("activate"));
      await expect
        .poll(() =>
          app!.windows().some((window) => window.url().startsWith(baseURL!)),
        )
        .toBe(true);
      const reopened = app
        .windows()
        .find((window) => window.url().startsWith(baseURL!));
      if (!reopened) throw new Error("reopened main window not found");
      reopened.on("dialog", () => {});
      await installBrowserSessionDirect(
        reopened,
        session,
        agentUrl,
        authOptions,
      );
      await selectAccountForUi(reopened, accounts[0].account_id);
      await dismissOnboarding(reopened);
      await reopened.goto(agentUrl);
      const reopenedDescription = reopened.getByRole("textbox", {
        name: /Description/i,
      });
      await expect(reopenedDescription).toBeVisible({ timeout: 60_000 });
      await reopenedDescription.fill(draft);
      await setResponse(0);
      const process = app.process();
      const appClosed = app.waitForEvent("close", { timeout: 15_000 });
      await app.evaluate(({ app }) => {
        setImmediate(() => app.quit());
      });
      await appClosed;
      expect(process.exitCode).toBe(0);
      app = undefined;
    } finally {
      if (app) {
        await app.evaluate(() => {
          const shared = globalThis as typeof globalThis & {
            __kortixUnloadProbe?: { response: number };
          };
          if (shared.__kortixUnloadProbe)
            shared.__kortixUnloadProbe.response = 0;
        });
        await app.close();
      }
      await project?.dispose();
      await deleteAuthUser(user.id, authOptions);
      await rm(profile, { recursive: true, force: true });
    }
  },
);
nativeBrowserTest?.(
  "27 — desktop parity clears native controls on Apps, Files, account hub, and admin",
  async ({ baseURL }) => {
    browserTest.setTimeout(180_000);
    const databaseUrl =
      process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
    if (!databaseUrl)
      throw new Error("Desktop geometry requires the configured test database");
    const profile = await mkdtemp(join(tmpdir(), "kortix-desktop-geometry-"));
    const email = `e2e-desktop-geometry-${randomUUID()}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    let project: ManifestProject | undefined;
    let app: ElectronApplication | undefined;
    let adminRoleGranted = false;
    try {
      const accounts = await api<{ account_id: string }[]>(
        session.access_token,
        "GET",
        "/accounts",
      );
      project = await createManifestProject({
        api,
        accessToken: session.access_token,
        accountId: accounts[0].account_id,
        userId: user.id,
        name: "Desktop header geometry",
        databaseUrl,
      });
      app = await launchDesktop(baseURL!, profile);
      const main = app
        .windows()
        .find((window) => window.url().startsWith(baseURL!));
      if (!main) throw new Error("native main window not found");
      await installBrowserSessionDirect(
        main,
        session,
        `${baseURL}/projects/${project.id}`,
        authOptions,
      );
      await selectAccountForUi(main, accounts[0].account_id);
      await dismissOnboarding(main);
      const nativeWindow = await app.browserWindow(main);
      await nativeWindow.evaluate((window) => window.setContentSize(1100, 700));
      const currentZoom = () =>
        nativeWindow.evaluate((window) => window.webContents.getZoomFactor());
      const centeredInBand = async (control: Locator) => {
        const box = (await control.boundingBox())!;
        const centerY = (box.y + box.height / 2) * (await currentZoom());
        expect(Math.abs(centerY - 20)).toBeLessThanOrEqual(1);
      };
      const clearsLights = async (control: Locator) => {
        const box = (await control.boundingBox())!;
        expect(box.x * (await currentZoom())).toBeGreaterThanOrEqual(71.5);
      };
      const projectRow = main.locator(".kx-project-sidebar-titlebar");
      await expect(projectRow).toBeVisible();
      const switcher = projectRow.locator("[data-sidebar='menu-button']");
      const projectSearch = projectRow.getByRole("button", { name: /Search/i });
      const projectCollapse = projectRow.getByRole("button", { name: "Collapse sidebar" });
      for (const control of [projectRow, switcher, projectSearch, projectCollapse]) {
        await expect(control).toBeVisible();
        await centeredInBand(control);
      }
      await clearsLights(switcher);
      for (let index = 0; index < 3; index++) await main.keyboard.press("Meta+=");
      await expect.poll(currentZoom).toBeGreaterThan(1.2);
      for (const control of [switcher, projectSearch, projectCollapse]) {
        await centeredInBand(control);
        await clearsLights(control);
      }
      await main.keyboard.press("Meta+0");
      await expect.poll(currentZoom).toBe(0.94);
      await main.getByRole("button", { name: "Collapse sidebar" }).click();

      for (const route of ["apps", "files"] as const) {
        await main.goto(`${baseURL}/projects/${project.id}/${route}`);
        const row = main
          .locator(".kx-titlebar-row[data-sidebar-collapsed='true']")
          .first();
        await expect(row).toBeVisible({ timeout: 60_000 });
        await expect(row).toHaveAttribute("data-sidebar-collapsed", "true");
        await expect
          .poll(
            async () => {
              const box = (await row.boundingBox())!;
              return (box.y + box.height / 2) * (await currentZoom());
            },
            { timeout: 15_000 },
          )
          .toBeCloseTo(20, 0);
        if (route === "apps") {
          await expect
            .poll(
              async () => {
                const box = (await row.locator("h1").boundingBox())!;
                return (box.y + box.height / 2) * (await currentZoom());
              },
              { timeout: 15_000 },
            )
            .toBeCloseTo(20, 0);
        }
        const dragRegion = await row.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const y = Math.round(rect.top + rect.height / 2);
          const appRegion = getComputedStyle(element).webkitAppRegion;
          for (
            let x = Math.round(rect.left + 160);
            x < rect.right - 160;
            x += 16
          ) {
            const target = document.elementFromPoint(x, y);
            if (!target || !element.contains(target)) continue;
            if (target.closest("button,a,input,[role='button'],[role='tab']"))
              continue;
            return { appRegion, emptyPoint: { x, y } };
          }
          throw new Error("no empty drag point in header");
        });
        expect(dragRegion.appRegion).toBe("drag");
        expect(dragRegion.emptyPoint.x).toBeGreaterThan(0);
        const control = row
          .locator("button,a,input,[role='button'],[role='tab']")
          .first();
        await expect(control).toBeVisible();
        expect(
          await control.evaluate(
            (element) => getComputedStyle(element).webkitAppRegion,
          ),
        ).toBe("no-drag");
      }

      await nativeWindow.evaluate(async (window) => {
        await new Promise<void>((resolve) => {
          window.once("enter-full-screen", resolve);
          window.setFullScreen(true);
        });
      });
      await expect(main.locator("html")).toHaveAttribute(
        "data-desktop-fullscreen",
        "true",
      );
      await expect
        .poll(async () =>
          main
            .locator(".kx-titlebar-band-height")
            .first()
            .evaluate((element) => element.getBoundingClientRect().height),
        )
        .toBeGreaterThan(40);
      await nativeWindow.evaluate(async (window) => {
        await new Promise<void>((resolve) => {
          window.once("leave-full-screen", resolve);
          window.setFullScreen(false);
        });
      });
      await expect(main.locator("html")).not.toHaveAttribute(
        "data-desktop-fullscreen",
      );

      await main.goto(
        `${baseURL}/projects/${project.id}?accountId=${accounts[0].account_id}`,
      );
      const hub = main.getByRole("dialog");
      await expect(hub).toBeVisible({ timeout: 60_000 });
      await expect(hub.locator(".kx-titlebar-spacer")).toHaveCount(0);
      const sidebarRow = hub.locator(".kx-overlay-sidebar-titlebar");
      const breadcrumbRow = hub.locator(".kx-account-hub-header");
      await expect(sidebarRow).toBeVisible();
      await expect(breadcrumbRow).toBeVisible();
      await centeredInBand(sidebarRow);
      await centeredInBand(breadcrumbRow);
      await centeredInBand(breadcrumbRow.getByRole("navigation", { name: "breadcrumb" }));
      const back = sidebarRow.getByRole("button", { name: /Back to app/i });
      const search = sidebarRow.getByRole("button", { name: /Search/i });
      const collapse = sidebarRow.getByRole("button", { name: "Toggle Sidebar" });
      for (const control of [back, search, collapse]) {
        await expect(control).toBeVisible();
        await centeredInBand(control);
        await clearsLights(control);
      }
      await search.click();
      await expect(main.locator('[data-slot="command-input"]')).toBeVisible();
      await main.keyboard.press("Escape");
      await collapse.click();
      await expect(breadcrumbRow).toHaveAttribute("data-sidebar-collapsed", "");
      const reopen = breadcrumbRow.getByRole("button", { name: "Toggle Sidebar" });
      const breadcrumb = breadcrumbRow.getByRole("navigation", { name: "breadcrumb" });
      await clearsLights(reopen);
      await centeredInBand(reopen);
      await centeredInBand(breadcrumb);
      const reopenBox = (await reopen.boundingBox())!;
      const breadcrumbBox = (await breadcrumb.boundingBox())!;
      expect(breadcrumbBox.x).toBeGreaterThanOrEqual(reopenBox.x + reopenBox.width);

      for (let index = 0; index < 3; index++) await main.keyboard.press("Meta+=");
      await expect
        .poll(currentZoom)
        .toBeGreaterThan(1.2);
      await clearsLights(reopen);
      await centeredInBand(reopen);
      await centeredInBand(breadcrumb);
      await nativeWindow.evaluate((window) => window.setContentSize(720, 480));
      await expect
        .poll(async () => nativeWindow.evaluate((window) => window.getContentSize()))
        .toEqual([720, 480]);
      await clearsLights(reopen);
      await centeredInBand(reopen);
      await centeredInBand(breadcrumb);
      await nativeWindow.evaluate((window) => window.setContentSize(1100, 700));
      await main.keyboard.press("Meta+0");
      await expect.poll(currentZoom).toBe(0.94);

      await nativeWindow.evaluate(async (window) => {
        await new Promise<void>((resolve) => {
          window.once("enter-full-screen", resolve);
          window.setFullScreen(true);
        });
      });
      await expect(main.locator("html")).toHaveAttribute("data-desktop-fullscreen", "true");
      expect((await reopen.boundingBox())!.x * (await currentZoom())).toBeLessThan(24);
      await nativeWindow.evaluate(async (window) => {
        await new Promise<void>((resolve) => {
          window.once("leave-full-screen", resolve);
          window.setFullScreen(false);
        });
      });
      await expect(main.locator("html")).not.toHaveAttribute("data-desktop-fullscreen");
      await reopen.click();
      await expect(sidebarRow).toBeVisible();
      await back.click();
      await expect(hub).not.toBeVisible();

      await main.keyboard.press("Meta+,");
      const settings = main.getByRole("dialog");
      await expect(settings).toBeVisible();
      await expect(settings.locator(".kx-titlebar-spacer")).toHaveCount(0);
      const settingsBack = settings.getByRole("button", { name: /Back to app/i });
      const settingsBreadcrumb = settings.getByRole("navigation", { name: "breadcrumb" });
      await centeredInBand(settingsBack);
      await centeredInBand(settingsBreadcrumb);
      await clearsLights(settingsBack);
      await nativeWindow.evaluate((window) => window.setContentSize(720, 480));
      for (let index = 0; index < 3; index++) await main.keyboard.press("Meta+=");
      await expect.poll(currentZoom).toBeGreaterThan(1.2);
      const mobileSettingsRow = settings.locator(".kx-settings-mobile-titlebar");
      const mobileSettingsTabsWrapper = mobileSettingsRow
        .locator(".kx-settings-mobile-tabs")
        .first();
      const mobileSettingsTabs = mobileSettingsRow.locator("[data-slot='tabs-list']");
      await expect(mobileSettingsRow).toBeVisible();
      await expect(mobileSettingsTabsWrapper).toBeVisible();
      await expect(mobileSettingsTabs).toBeVisible();
      await centeredInBand(mobileSettingsRow);
      await centeredInBand(mobileSettingsTabsWrapper);
      await centeredInBand(mobileSettingsTabs);
      const mobileRowBox = (await mobileSettingsRow.boundingBox())!;
      const mobileTabsBox = (await mobileSettingsTabs.boundingBox())!;
      expect(mobileTabsBox.y).toBeGreaterThanOrEqual(mobileRowBox.y - 1);
      expect(mobileTabsBox.y + mobileTabsBox.height).toBeLessThanOrEqual(
        mobileRowBox.y + mobileRowBox.height + 1,
      );
      await main.keyboard.press("Meta+0");
      await nativeWindow.evaluate((window) => window.setContentSize(1100, 700));
      await expect(settingsBack).toBeVisible();
      await settingsBack.click();
      await expect(settings).not.toBeVisible();

      await runDatabaseSql(
        `INSERT INTO kortix.platform_user_roles (account_id, role)
         VALUES ($1::uuid, 'super_admin'::kortix.platform_role)
         ON CONFLICT (account_id) DO UPDATE SET role = EXCLUDED.role`,
        [user.id],
        databaseUrl,
      );
      adminRoleGranted = true;
      await main
        .context()
        .addCookies([
          { name: "admin_sidebar_state", value: "false", url: baseURL! },
        ]);
      await main.goto(`${baseURL}/admin`);
      await expect(
        main.getByRole("heading", { name: "Overview" }).first(),
      ).toBeVisible({
        timeout: 60_000,
      });
      const adminRow = main.locator(".kx-titlebar-row").first();
      await expect(adminRow).toHaveAttribute("data-sidebar-collapsed", "");
      const adminToggle = adminRow.getByRole("button").first();
      await expect(adminToggle).toBeVisible();
      const toggleBox = (await adminToggle.boundingBox())!;
      const adminZoom = await currentZoom();
      expect(toggleBox.x * adminZoom).toBeGreaterThanOrEqual(72);
      expect((toggleBox.y + toggleBox.height / 2) * adminZoom).toBeCloseTo(
        20,
        0,
      );
    } finally {
      if (adminRoleGranted)
        await runDatabaseSql(
          "DELETE FROM kortix.platform_user_roles WHERE account_id = $1::uuid",
          [user.id],
          databaseUrl,
        );
      await project?.dispose();
      await deleteAuthUser(user.id, authOptions);
      await app?.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
);
nativeBrowserTest?.(
  "27 — desktop parity restores the native theme before the first window and matches popups",
  async ({ baseURL }) => {
    browserTest.setTimeout(180_000);
    const profile = await mkdtemp(join(tmpdir(), "kortix-desktop-theme-"));
    let app: ElectronApplication | undefined;
    try {
      await writeFile(
        join(profile, "theme.json"),
        JSON.stringify({ theme: "light" }),
        "utf8",
      );
      app = await launchDesktop(baseURL!, profile);
      const main = app
        .windows()
        .find((window) => window.url().startsWith(baseURL!));
      if (!main) throw new Error("native main window not found");

      const launchTheme = await app.evaluate(
        ({ BrowserWindow, nativeTheme }, origin) => {
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().startsWith(origin),
          );
          return {
            source: nativeTheme.themeSource,
            dark: nativeTheme.shouldUseDarkColors,
            background: window?.getBackgroundColor(),
          };
        },
        baseURL!,
      );
      expect(launchTheme).toMatchObject({ source: "light", dark: false });
      expect(launchTheme.background?.toUpperCase().startsWith("#FFFFFF")).toBe(
        true,
      );
      expect(
        await main.evaluate(
          () => matchMedia("(prefers-color-scheme: dark)").matches,
        ),
      ).toBe(false);

      await main.evaluate(() =>
        window.open("", "theme-popup", "width=520,height=720"),
      );
      await expect
        .poll(
          () =>
            app!.windows().filter((window) => window.url() === "about:blank")
              .length,
        )
        .toBe(1);
      const lightPopupBackground = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL() === "about:blank")
          ?.getBackgroundColor(),
      );
      expect(lightPopupBackground?.toUpperCase().startsWith("#FFFFFF")).toBe(
        true,
      );

      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL() === "about:blank")
          ?.close();
      });
      await main.evaluate(() =>
        window.__TAURI__?.core.invoke("set_native_theme", { theme: "dark" }),
      );
      await main.evaluate(() =>
        window.open("", "theme-popup-dark", "width=520,height=720"),
      );
      await expect
        .poll(
          () =>
            app!.windows().filter((window) => window.url() === "about:blank")
              .length,
        )
        .toBe(1);
      const darkPopupBackground = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL() === "about:blank")
          ?.getBackgroundColor(),
      );
      expect(darkPopupBackground?.toUpperCase().startsWith("#0A0A0A")).toBe(
        true,
      );
    } finally {
      await app?.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
);
nativeBrowserTest?.(
  "27 — desktop parity recovers when Supabase authentication does not answer",
  async ({ baseURL }) => {
    browserTest.setTimeout(180_000);
    const databaseUrl =
      process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
    if (!databaseUrl)
      throw new Error("Auth recovery requires the configured test database");
    const profile = await mkdtemp(
      join(tmpdir(), "kortix-desktop-auth-timeout-"),
    );
    const email = `e2e-desktop-auth-timeout-${randomUUID()}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    let project: ManifestProject | undefined;
    let app: ElectronApplication | undefined;
    try {
      const accounts = await api<{ account_id: string }[]>(
        session.access_token,
        "GET",
        "/accounts",
      );
      project = await createManifestProject({
        api,
        accessToken: session.access_token,
        accountId: accounts[0].account_id,
        userId: user.id,
        name: "Desktop auth timeout",
        databaseUrl,
      });
      app = await launchDesktop(baseURL!, profile);
      const main = app
        .windows()
        .find((window) => window.url().startsWith(baseURL!));
      if (!main) throw new Error("native main window not found");

      let blockedUserReads = 0;
      await main.route("**/auth/v1/user", async () => {
        blockedUserReads += 1;
        await new Promise(() => {});
      });
      await installBrowserSessionDirect(
        main,
        session,
        `${baseURL}/projects/${project.id}`,
        authOptions,
      );

      const alert = main
        .getByRole("alert")
        .filter({ hasText: "Authentication is not responding" });
      await expect(alert).toContainText("Authentication is not responding", {
        timeout: 25_000,
      });
      await expect(
        alert.getByRole("button", { name: "Retry", exact: true }),
      ).toBeVisible();
      await expect(
        alert.getByRole("button", { name: "Sign out", exact: true }),
      ).toBeVisible();

      await alert.getByRole("button", { name: "Retry", exact: true }).click();
      await expect
        .poll(() => blockedUserReads, { timeout: 10_000 })
        .toBeGreaterThan(1);
      await alert
        .getByRole("button", { name: "Sign out", exact: true })
        .click();
      await expect(main).toHaveURL(/\/auth(?:\?|$)/, { timeout: 15_000 });
    } finally {
      await project?.dispose();
      await deleteAuthUser(user.id, authOptions);
      await app?.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
);
nativeBrowserTest?.(
  "27 — desktop parity authenticates an HTTP proxy and recovers from cancel",
  async ({ baseURL }) => {
    browserTest.setTimeout(240_000);
    const profile = await mkdtemp(join(tmpdir(), "kortix-desktop-proxy-"));
    const firstProxy = await startBasicProxy(baseURL!);
    const secondProxy = await startBasicProxy(baseURL!);
    let app: ElectronApplication | undefined;
    try {
      app = await launchDesktop(baseURL!, profile);
      const main = app
        .windows()
        .find((window) => window.url().startsWith(baseURL!));
      if (!main) throw new Error("native main window not found");
      const routeThrough = async (proxyRules: string) => {
        await app!.evaluate(async ({ session }, rules) => {
          await session.defaultSession.setProxy({
            proxyRules: rules,
            proxyBypassRules: "<-loopback>",
          });
        }, proxyRules);
        // The proxy challenge aborts the in-flight navigation while Electron
        // opens its modal sign-in window. That abort is the expected signal.
        await main.reload().catch(() => null);
      };
      const authWindow = async () => {
        await expect
          .poll(
            () =>
              app!
                .windows()
                .find((window) => window.url().endsWith("/basic-auth.html"))
                ?.url() || "",
            { timeout: 60_000 },
          )
          .toContain("basic-auth.html");
        const window = app!
          .windows()
          .find((candidate) => candidate.url().endsWith("/basic-auth.html"));
        if (!window) throw new Error("proxy sign-in window not found");
        return window;
      };

      await routeThrough(firstProxy.url);
      let auth = await authWindow();
      await expect(auth.locator("#host")).toHaveText("127.0.0.1");
      await auth.locator("#user").fill("proxy-user");
      await auth.locator("#pass").fill("wrong");
      await auth.locator("#submit").click();

      auth = await authWindow();
      await expect(auth.locator("#error")).toContainText(
        "rejected the username or password",
      );
      await auth.locator("#user").fill("proxy-user");
      await auth.locator("#pass").fill("proxy-pass");
      await auth.locator("#submit").click();
      await expect
        .poll(
          () =>
            app!.windows().some((window) => window.url().startsWith(baseURL!)),
          { timeout: 120_000 },
        )
        .toBe(true);
      expect(firstProxy.stats().challenges).toBeGreaterThanOrEqual(2);
      expect(firstProxy.stats().authorizedRequests).toBeGreaterThan(0);

      await routeThrough(secondProxy.url);
      auth = await authWindow();
      await auth.locator("#cancel").click();
      await expect
        .poll(
          () =>
            app!
              .windows()
              .find((window) => window.url().endsWith("/instance-chooser.html"))
              ?.url() || "",
          { timeout: 60_000 },
        )
        .toContain("instance-chooser.html");
      const chooser = app
        .windows()
        .find((window) => window.url().endsWith("/instance-chooser.html"));
      if (!chooser) throw new Error("proxy recovery window not found");
      await expect(chooser.locator("#title")).toContainText("Can’t reach");
      await expect(chooser.locator("#primary")).toHaveText("Try Again");
      await expect(chooser.locator("#error")).toContainText(
        "Proxy sign-in for 127.0.0.1 was cancelled",
      );
    } finally {
      await app?.close();
      await Promise.allSettled([firstProxy.close(), secondProxy.close()]);
      await rm(profile, { recursive: true, force: true });
    }
  },
);

nativeBrowserTest?.(
  "27 — desktop parity persists window state across a process relaunch",
  async ({ baseURL }) => {
    browserTest.setTimeout(240_000);
    const profile = await mkdtemp(join(tmpdir(), "kortix-desktop-relaunch-"));
    let first: ElectronApplication | undefined;
    let second: ElectronApplication | undefined;
    try {
      first = await launchDesktop(baseURL!, profile);
      const firstPage = first
        .windows()
        .find((window) => window.url().startsWith(baseURL!));
      if (!firstPage) throw new Error("first native page not found");
      await expect(firstPage.locator("html")).toHaveAttribute(
        "data-desktop",
        "true",
      );
      await expect
        .poll(() =>
          first!.evaluate(({ BrowserWindow }, origin) => {
            const main = BrowserWindow.getAllWindows().find((window) =>
              window.webContents.getURL().startsWith(origin),
            );
            return main?.webContents.getZoomFactor() ?? 0;
          }, baseURL!),
        )
        .toBeCloseTo(0.94);
      const initialZoom = await first.evaluate(({ BrowserWindow }, origin) => {
        const main = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().startsWith(origin),
        );
        if (!main) throw new Error("first native main window not found");
        return main.webContents.getZoomFactor();
      }, baseURL!);
      await firstPage.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("kortix-desktop-command", { detail: "zoom-in" }),
        );
      });
      await expect
        .poll(() =>
          first!.evaluate(({ BrowserWindow }, origin) => {
            const main = BrowserWindow.getAllWindows().find((window) =>
              window.webContents.getURL().startsWith(origin),
            );
            return main?.webContents.getZoomFactor() ?? 0;
          }, baseURL!),
        )
        .toBeGreaterThan(initialZoom);
      const expectedZoom = await first.evaluate(({ BrowserWindow }, origin) => {
        const main = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().startsWith(origin),
        );
        if (!main) throw new Error("first native main window not found");
        return main.webContents.getZoomFactor();
      }, baseURL!);
      const expectedBounds = await first.evaluate(
        async ({ BrowserWindow, screen }, origin) => {
          const main = BrowserWindow.getAllWindows().find((window) =>
            window.webContents.getURL().startsWith(origin),
          );
          if (!main) throw new Error("first native main window not found");
          const area = screen.getPrimaryDisplay().workArea;
          const bounds = {
            x: area.x + 90,
            y: area.y + 80,
            width: Math.min(960, area.width - 180),
            height: Math.min(660, area.height - 160),
          };
          main.unmaximize();
          main.setBounds(bounds);
          await new Promise((resolve) => setTimeout(resolve, 350));
          main.maximize();
          await new Promise((resolve) => setTimeout(resolve, 350));
          return bounds;
        },
        baseURL!,
      );
      await first.close();
      first = undefined;

      second = await launchDesktop(baseURL!, profile);
      await expect
        .poll(() =>
          second!.evaluate(({ BrowserWindow }, origin) => {
            const main = BrowserWindow.getAllWindows().find((window) =>
              window.webContents.getURL().startsWith(origin),
            );
            return main?.isMaximized() ?? false;
          }, baseURL!),
        )
        .toBe(true);
      const restored = await second.evaluate(({ BrowserWindow }, origin) => {
        const main = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().startsWith(origin),
        );
        if (!main) throw new Error("restarted native main window not found");
        return {
          maximized: main.isMaximized(),
          normalBounds: main.getNormalBounds(),
          zoom: main.webContents.getZoomFactor(),
        };
      }, baseURL!);
      expect(restored.maximized).toBe(true);
      expect(restored.normalBounds).toEqual(expectedBounds);
      expect(restored.zoom).toBe(expectedZoom);
    } finally {
      await first?.close();
      await second?.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
);
