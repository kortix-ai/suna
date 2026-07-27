import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { authHeaders, createApiJsonClient } from "../helpers/http";
import {
  type AuthSession,
  createAuthUser,
  deleteAuthUser,
  installBrowserSession,
  signIn,
} from "../helpers/session-auth";

const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const supabaseUrl = process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321";
const password = "E2eNangoGitHub123!";
const envFiles = ["apps/api/.env.local", "apps/web/.env.local"];
const authOptions = { supabaseUrl, password, envFiles };
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  name: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role: "owner" | "admin" | "member";
}

interface Installation {
  account_id: string;
  installation_row_id: string | null;
  installed: boolean;
  configured: boolean;
  requires_installation: boolean;
  install_url: string | null;
  installation_id: string | null;
  owner_login: string | null;
  owner_type: string | null;
  repository_selection: string | null;
  permissions: Record<string, unknown>;
  installation_url: string | null;
  updated_at: string | null;
  connection_id: string | null;
  connection_provider: "nango" | null;
  connection_status:
    "connected" | "needs_reconnect" | "error" | "disconnected" | null;
  reconnect_required: boolean;
}

interface InstallationsResponse extends Installation {
  installations: Installation[];
}

function emptyInstallations(accountId: string): InstallationsResponse {
  return {
    account_id: accountId,
    installation_row_id: null,
    installed: false,
    configured: true,
    requires_installation: true,
    install_url: null,
    installation_id: null,
    owner_login: null,
    owner_type: null,
    repository_selection: null,
    permissions: {},
    installation_url: null,
    updated_at: null,
    connection_id: null,
    connection_provider: null,
    connection_status: null,
    reconnect_required: false,
    installations: [],
  };
}

function connectedInstallation(
  accountId: string,
  input: {
    installationId: string;
    connectionId: string;
    ownerLogin: string;
    ownerType: "User" | "Organization";
  },
): Installation {
  return {
    account_id: accountId,
    installation_row_id: randomUUID(),
    installed: true,
    configured: true,
    requires_installation: false,
    install_url: null,
    installation_id: input.installationId,
    owner_login: input.ownerLogin,
    owner_type: input.ownerType,
    repository_selection: "all",
    permissions: { contents: "write", metadata: "read" },
    installation_url: `https://github.com/settings/installations/${input.installationId}`,
    updated_at: new Date().toISOString(),
    connection_id: input.connectionId,
    connection_provider: "nango",
    connection_status: "connected",
    reconnect_required: false,
  };
}

function installationsResponse(
  accountId: string,
  installations: Installation[],
): InstallationsResponse {
  const first = installations[0];
  return {
    ...(first ?? emptyInstallations(accountId)),
    installations,
  };
}

async function visibleBoxes(locator: Locator) {
  const boxes: Array<{
    index: number;
    label: string;
    tag: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }> = [];
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const box = await item.boundingBox();
    if (box) {
      const metadata = await item.evaluate((element) => ({
        label:
          element.getAttribute("aria-label") ||
          (element.textContent ?? "").replace(/\s+/g, " ").trim(),
        tag: element.tagName.toLowerCase(),
      }));
      boxes.push({ index, ...metadata, ...box });
    }
  }
  return boxes;
}

async function expectNoControlOverlap(scope: Locator) {
  const controls = scope.locator(
    'button, [role="button"]:not(button), input:not([type="hidden"]), [role="combobox"]:not(select)',
  );
  const boxes = await visibleBoxes(controls);
  const overlaps: Array<{
    left: Pick<(typeof boxes)[number], "index" | "label" | "tag">;
    right: Pick<(typeof boxes)[number], "index" | "label" | "tag">;
  }> = [];
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      const a = boxes[left]!;
      const b = boxes[right]!;
      const overlapWidth =
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapHeight =
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (overlapWidth > 2 && overlapHeight > 2) {
        overlaps.push({
          left: { index: a.index, label: a.label, tag: a.tag },
          right: { index: b.index, label: b.label, tag: b.tag },
        });
      }
    }
  }
  expect(overlaps).toEqual([]);

  const scopeBox = await scope.boundingBox();
  expect(scopeBox).not.toBeNull();
  const horizontalOverflow = boxes
    .filter(
      (box) =>
        box.x < scopeBox!.x - 1 ||
        box.x + box.width > scopeBox!.x + scopeBox!.width + 1,
    )
    .map((box) => box.index);
  expect(horizontalOverflow).toEqual([]);
}

async function sendNangoEvent(page: Page, data: Record<string, unknown>) {
  await page.evaluate((eventData) => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://connect.nango.dev",
        data: eventData,
      }),
    );
  }, data);
}

test.describe("GitHub Nango Connect", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  let userId = "";
  let accountId = "";
  let session: AuthSession;

  test.beforeAll(async () => {
    const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const email = `e2e-nango-github-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    userId = user.id;
    session = await signIn(email, authOptions);
    const accounts = await api<AccountSummary[]>(
      session.access_token,
      "GET",
      "/accounts",
    );
    const account = accounts.find(
      (item) =>
        item.personal_account ||
        item.is_primary_owner ||
        item.account_role === "owner",
    );
    if (!account) throw new Error("The test user has no writable account.");
    accountId = account.account_id;
  });

  test.afterAll(async () => {
    if (userId) {
      await deleteAuthUser(userId, {
        supabaseUrl,
        envFiles,
      });
    }
  });

  test("password-authenticated account opens the live Nango UI and hands off to GitHub", async ({
    page,
  }, testInfo) => {
    const exposedSecretRequests: string[] = [];
    const legacyRequests: string[] = [];
    const nangoApiKey = process.env.NANGO_API_KEY;

    page.on("request", (request) => {
      const serialized = JSON.stringify({
        headers: request.headers(),
        body: request.postData(),
      });
      if (nangoApiKey && serialized.includes(nangoApiKey)) {
        exposedSecretRequests.push(request.url());
      }
      if (
        serialized.includes("github_user_token") ||
        request.url().includes("/github/installations/linkable") ||
        request.url().includes("/auth/github-connect")
      ) {
        legacyRequests.push(request.url());
      }
    });

    await installBrowserSession(
      page,
      session,
      `/accounts/${accountId}?tab=git`,
      password,
    );
    await expect(
      page.getByText("GitHub connections", { exact: true }),
    ).toBeVisible({
      timeout: 30_000,
    });

    const before = await api<InstallationsResponse>(
      session.access_token,
      "GET",
      `/projects/github/installations?account_id=${accountId}`,
    );
    const sessionResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/projects/github/connect-session") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Add account" }).click();
    const sessionResponse = await sessionResponsePromise;
    expect(sessionResponse.status()).toBe(200);
    expect(sessionResponse.request().postDataJSON()).toEqual({
      account_id: accountId,
    });

    const iframe = page.locator("#connect-ui");
    await expect(iframe).toBeVisible({ timeout: 30_000 });
    await expect(iframe).toHaveAttribute(
      "src",
      /^https:\/\/connect\.nango\.dev\//,
    );
    const connectFrame = page.frameLocator("#connect-ui");
    await expect(connectFrame.getByText(/GitHub/i).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({
      path: testInfo.outputPath("nango-connect-desktop.png"),
      fullPage: true,
    });

    const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
    const connectButton = connectFrame
      .getByRole("button", { name: /Connect|GitHub/i })
      .last();
    await expect(connectButton).toBeVisible({ timeout: 30_000 });
    await connectButton.click();
    const popup = await popupPromise;
    await popup.waitForURL((url) => url.hostname === "github.com", {
      timeout: 30_000,
    });
    expect(new URL(popup.url()).hostname).toBe("github.com");
    await popup.close();

    const refreshPromise = page.waitForResponse(
      (response) =>
        response.url().includes("/v1/projects/github/installations?") &&
        response.request().method() === "GET",
    );
    await sendNangoEvent(page, { type: "close" });
    await refreshPromise;
    await expect(iframe).toHaveCount(0);

    const after = await api<InstallationsResponse>(
      session.access_token,
      "GET",
      `/projects/github/installations?account_id=${accountId}`,
    );
    expect(after.installations.map((item) => item.installation_id)).toEqual(
      before.installations.map((item) => item.installation_id),
    );
    expect(exposedSecretRequests).toEqual([]);
    expect(legacyRequests).toEqual([]);
  });

  test("project import returns to the picker after Nango reconciliation on desktop and mobile", async ({
    page,
  }, testInfo) => {
    const personal = connectedInstallation(accountId, {
      installationId: "73001",
      connectionId: "connection-personal",
      ownerLogin: "nango-personal",
      ownerType: "User",
    });
    const organization = connectedInstallation(accountId, {
      installationId: "73002",
      connectionId: "connection-organization",
      ownerLogin: "nango-organization",
      ownerType: "Organization",
    });
    let connected = false;

    await page.route(
      "**/v1/projects/github/installations?**",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            connected
              ? installationsResponse(accountId, [personal, organization])
              : emptyInstallations(accountId),
          ),
        });
      },
    );
    await page.route("**/v1/projects/github/connect-session", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ account_id: accountId });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          token: "test-connect-session-token",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          connect_link: "https://connect.nango.dev/test",
        }),
      });
    });
    await page.route(
      "**/v1/projects/github/installations/73001/refresh",
      async (route) => {
        expect(route.request().postDataJSON()).toEqual({
          account_id: accountId,
        });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(personal),
        });
      },
    );
    await page.route("**/v1/projects/github/repositories?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          account_id: accountId,
          installation_id: "73001",
          owner_login: "nango-personal",
          repositories: [
            {
              id: "991",
              name: "nango-example",
              full_name: "nango-personal/nango-example",
              private: true,
              html_url: "https://github.com/nango-personal/nango-example",
              clone_url: "https://github.com/nango-personal/nango-example.git",
              ssh_url: "git@github.com:nango-personal/nango-example.git",
              default_branch: "main",
              description: "Nango connection browser proof",
            },
          ],
        }),
      });
    });

    await installBrowserSession(page, session, "/projects", password);
    await page
      .getByRole("button", { name: /New project|Add new project/i })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /Use my own GitHub/i }).click();
    await dialog.getByRole("tab", { name: /Import from GitHub/i }).click();
    await expect(
      dialog.getByRole("button", { name: "Connect GitHub" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Connect GitHub" }).click();
    await expect(page.locator("#connect-ui")).toBeVisible();

    connected = true;
    await sendNangoEvent(page, {
      type: "connect",
      payload: {
        providerConfigKey: "github-app-oauth",
        connectionId: personal.connection_id,
      },
    });

    await expect(page.locator("#connect-ui")).toHaveCount(0);
    const accountSelect = dialog.getByRole("combobox").first();
    await expect(accountSelect).toContainText(
      "Personal · github.com/nango-personal",
      {
        timeout: 30_000,
      },
    );
    const repositorySelect = dialog.getByRole("combobox").nth(1);
    await repositorySelect.click();
    await expect(
      page.getByText("nango-personal/nango-example", { exact: true }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await page.keyboard.press("Escape");

    await accountSelect.click();
    await expect(
      page
        .getByRole("option", {
          name: /Organization · github\.com\/nango-organization/,
        })
        .first(),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await expectNoControlOverlap(dialog);
    await page.screenshot({
      path: testInfo.outputPath("github-picker-desktop.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog).toBeVisible();
    await expectNoControlOverlap(dialog);
    await page.screenshot({
      path: testInfo.outputPath("github-picker-mobile.png"),
      fullPage: true,
    });
  });
});
