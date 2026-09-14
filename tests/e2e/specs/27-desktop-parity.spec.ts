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

import { createApiJsonClient } from "../helpers/http";
import {
  createManifestProject,
  type ManifestProject,
} from "../helpers/manifest-project";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import { dismissOnboarding, selectAccountForUi } from "../helpers/ui";

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
        // The project shell navigates and owns the band's corner, so the
        // window's Back (root layout) steps aside on every project view.
        await expect(
          page.getByRole("button", { name: "Back", exact: true }),
        ).toHaveCount(0);
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
        await page.locator('a[href$="/customize/agents/kortix"]').first().click();
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
        await installBrowserSessionDirect(page, session, projectUrl, authOptions);
        await selectAccountForUi(page, accountId);
        await page.goto(projectUrl);
        await dismissOnboarding(page);

        // The reported soft lock: the switcher opens /new, and /new has no
        // navigation of its own — only an account picker and Log out.
        await page.getByRole("button", { name: "Switch project", exact: true }).click();
        await page.getByRole("menuitem", { name: "Switch Project", exact: true }).click();
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
        expect(backBox.x, "Back must clear the macOS traffic lights").toBeGreaterThanOrEqual(62);
        expect(backBox.y + backBox.height, "Back must sit inside the title-bar band").toBeLessThanOrEqual(43);
        // The page's own top row (account picker, Log out) drops below the band.
        const logOut = page.getByRole("button", { name: "Log out", exact: true });
        await expect(logOut).toBeVisible();
        expect(
          (await logOut.boundingBox())!.y,
          "Log out must sit below the title-bar band",
        ).toBeGreaterThanOrEqual(backBox.y + backBox.height);

        await back.click();
        await expect(page).toHaveURL(new RegExp(`/projects/${project.id}`), {
          timeout: 60_000,
        });

        if (!desktopApp) {
          // Windows and Linux: the window controls sit top-right, so Back takes
          // the band's left edge and the page's top row must clear the 124px
          // control cluster on the right. Same session, same history shape.
          for (const platform of ["Win32", "Linux x86_64"]) {
            const other = await page.context().newPage();
            try {
              await other.addInitScript(
                (value) =>
                  Object.defineProperty(navigator, "platform", { get: () => value }),
                platform,
              );
              await other.setViewportSize({ width: 1440, height: 900 });
              await other.goto(projectUrl);
              await expect(
                other.getByRole("button", { name: "Switch project", exact: true }),
              ).toBeVisible({ timeout: 60_000 });
              await other.goto(`${baseURL}/new`);
              await expect(
                other.getByRole("heading", { name: "Create a project" }),
              ).toBeVisible({ timeout: 60_000 });
              const otherBack = other.getByRole("button", { name: "Back", exact: true });
              await expect(otherBack, `${platform}: Back`).toBeVisible();
              const b = (await otherBack.boundingBox())!;
              expect(b.x, `${platform}: Back starts at the band's left edge`).toBeLessThan(24);
              expect(b.y + b.height, `${platform}: Back sits inside the band`).toBeLessThanOrEqual(42);
              const otherLogOut = other.getByRole("button", { name: "Log out", exact: true });
              const l = (await otherLogOut.boundingBox())!;
              expect(
                l.x + l.width,
                `${platform}: Log out clears the window controls`,
              ).toBeLessThanOrEqual(1440 - 124);
              expect(l.y, `${platform}: Log out sits below Back`).toBeGreaterThanOrEqual(b.y + b.height);
              await otherBack.click();
              await expect(other).toHaveURL(new RegExp(`/projects/${project.id}`), {
                timeout: 60_000,
              });
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
        await expect.poll(() => menuItem("kx-go-forward")).toEqual({ enabled: true });
        await clickMenu("kx-go-forward");
        await expect(page).toHaveURL(/\/new(\?|$)/, { timeout: 60_000 });
        await expect.poll(() => menuItem("kx-go-back")).toEqual({ enabled: true });
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
