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
          name: "Switch workspace",
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
          .getByRole("link", { name: /Kortix/i })
          .last()
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
        }
      } finally {
        await project?.dispose();
        await deleteAuthUser(user.id, authOptions);
      }
    });
  });
}
