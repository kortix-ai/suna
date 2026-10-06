import { expect, test } from "@playwright/test";

import { loadEnv } from "../../src/core/env";
import {
  localCaptureStore,
  syntheticMachineKey,
  uploadCaptureObjects,
  vendoredDevice,
} from "../../src/fixtures/capture";
import {
  createDatabaseProject,
  deleteDatabaseProject,
} from "../../src/fixtures/database-project";
import { createApiJsonClient } from "../helpers/http";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import { dismissOnboarding, selectAccountForUi } from "../helpers/ui";

const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const supabaseUrl = process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321";
const databaseUrl =
  process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const authOptions = { supabaseUrl, password: "E2eCaptureUi123!" };
const api = createApiJsonClient(apiBase);

/** A device's anonymous call (the RFC 8628 sign-in): no Authorization header. */
async function anon<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

test.describe("38 — Capture UI", () => {
  test("Kortix Capture at /capture/[accountId]: off until switched on; devices, the device timeline (run jump, search), overview, workflows and settings", async ({
    page,
  }) => {
    test.skip(!databaseUrl, "KE2E_DATABASE_URL is required");
    test.setTimeout(240_000);

    const runId = Date.now().toString(36);
    const email = `e2e-capture-ui-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    const env = loadEnv();
    let projectId: string | null = null;
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    try {
      const accounts = await api<
        Array<{ account_id: string; personal_account?: boolean }>
      >(session.access_token, "GET", "/accounts");
      const accountId = (accounts.find((a) => a.personal_account) ??
        accounts[0])!.account_id;
      const project = await createDatabaseProject(env, {
        accountId,
        userId: user.id,
        name: `Capture UI ${runId}`,
      });
      projectId = project.id;

      // Kortix Capture off for the account: its own area (no project sidebar) offers the
      // switch to the account owner, and reads no Capture data before it is on.
      const captureRequests: string[] = [];
      page.on("request", (request) => {
        // The workspace read (`/capture`, the switch) is allowed; no Capture data request is.
        if (request.url().includes(`/v1/accounts/${accountId}/capture/`))
          captureRequests.push(request.url());
      });
      await installBrowserSessionDirect(
        page,
        session,
        "/favicon.png",
        authOptions,
      );
      await selectAccountForUi(page, accountId);
      await page.goto(`/capture/${accountId}`, {
        waitUntil: "domcontentloaded",
      });
      await dismissOnboarding(page);
      await expect(
        page.getByText("Kortix Capture is off for", { exact: false }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByRole("link", { name: "Customize", exact: true }),
      ).toHaveCount(0);
      expect(captureRequests).toEqual([]);
      const switched = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/v1/accounts/${accountId}/capture`) &&
          r.request().method() === "PATCH",
      );
      await page
        .getByRole("button", { name: "Turn on Kortix Capture" })
        .click();
      expect((await switched).status()).toBe(200);
      await expect(
        page
          .getByRole("navigation", { name: "Kortix Capture" })
          .getByRole("link", { name: "Devices" }),
      ).toBeVisible({ timeout: 30_000 });

      // Capture on for the account; one device signs in and uploads the vendored day of the Kortix Capture format.
      await api(
        session.access_token,
        "PUT",
        `/accounts/${accountId}/capture/policy`,
        { policy: { layers: { screen: true, actions: true, audio: true } } },
      );
      const machineKey = syntheticMachineKey(`capture-ui-${runId}`);
      const started = await anon<{ device_code: string; user_code: string }>(
        "/capture/device/authorize",
        {
          client_id: "kortix-capture",
          device: {
            device_id: "",
            machine_key_sha256: machineKey,
            hostname: "fixture-host.local",
            computer_name: "Fixture Computer",
            os: "macos",
            os_version: "26.0",
            arch: "aarch64",
            app_version: "0.1.0",
          },
        },
      );
      await api(
        session.access_token,
        "POST",
        `/capture/device/grants/${started.user_code}/approve`,
        { account_id: accountId },
      );
      const device = await anon<{ device_id: string; prefix: string }>(
        "/capture/device/token",
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: started.device_code,
          client_id: "kortix-capture",
        },
      );
      const day = vendoredDevice({
        prefix: device.prefix,
        deviceId: device.device_id,
        machineKeySha256: machineKey,
      });
      await uploadCaptureObjects(await localCaptureStore(), day.objects);
      await api(
        session.access_token,
        "POST",
        `/accounts/${accountId}/capture/devices/${device.device_id}/sync`,
        {},
      );
      await expect
        .poll(
          async () =>
            (
              await api<{ chunks: unknown[] }>(
                session.access_token,
                "GET",
                `/accounts/${accountId}/capture/timeline?day=${day.day}`,
              )
            ).chunks.length,
          { timeout: 60_000 },
        )
        .toBe(day.expected.chunks);

      // Devices lists the computer with its live status; its row opens the timeline
      // at the newest recorded moment.
      await page.goto(`/capture/${accountId}/devices`, {
        waitUntil: "domcontentloaded",
      });
      const row = page.getByRole("row").filter({ hasText: "Fixture Computer" });
      await expect(row).toBeVisible({ timeout: 60_000 });
      await expect(row).toContainText("Recording");
      const daysRead = page.waitForResponse(
        (r) =>
          r.url().includes(`/v1/accounts/${accountId}/capture/days?tz=`) &&
          r.status() === 200,
      );
      await row.getByRole("link", { name: /Fixture Computer/ }).click();
      await expect(page).toHaveURL(
        new RegExp(`/capture/${accountId}/devices/${device.device_id}`),
      );
      await daysRead;
      const track = page.getByRole("slider", {
        name: "Moment on the timeline",
      });
      await expect(track).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(async () => Number(await track.getAttribute("aria-valuenow")))
        .toBe(day.endMs);
      await expect(page.getByLabel(/^Screen recording of /)).toBeVisible({
        timeout: 30_000,
      });

      // Cmd/Ctrl+Left moves the playhead back to the start of the app run under it.
      await track.focus();
      await page.keyboard.press("ControlOrMeta+ArrowLeft");
      await expect
        .poll(async () => Number(await track.getAttribute("aria-valuenow")))
        .toBeLessThan(day.endMs);

      // Search ("/"): one screen hit; picking it moves the playhead and closes the results.
      await track.focus();
      await page.keyboard.press("/");
      const searched = page.waitForResponse((r) =>
        r.url().includes("/capture/search?q=%22incident+review%22"),
      );
      await page
        .getByRole("textbox", { name: "Search this device" })
        .fill('"incident review"');
      expect((await searched).status()).toBe(200);
      const hit = page
        .getByRole("list", { name: "Search results" })
        .getByRole("button")
        .first();
      await expect(hit).toContainText("Editor");
      await hit.click();
      await expect(
        page.getByRole("list", { name: "Search results" }),
      ).toHaveCount(0);
      await expect(page).toHaveURL(/at=/);

      // Overview and Workflows read the intelligence contract; nothing is clustered yet.
      const overviewRead = page.waitForResponse(
        (r) =>
          r.url().includes(`/v1/accounts/${accountId}/capture/overview`) &&
          r.request().method() === "GET",
      );
      await page
        .getByRole("navigation", { name: "Kortix Capture" })
        .getByRole("link", { name: "Overview" })
        .click();
      expect((await overviewRead).status()).toBe(200);
      await expect(
        page.getByRole("heading", { name: "Overview" }),
      ).toBeVisible();
      await expect(page.getByText("Hours recorded")).toBeVisible();
      await page
        .getByRole("navigation", { name: "Kortix Capture" })
        .getByRole("link", { name: "Workflows" })
        .click();
      await expect(
        page.getByRole("heading", { name: "Workflows" }),
      ).toBeVisible({
        timeout: 30_000,
      });
      // No Ask in Kortix Capture: agents read it through the Kortix MCP server.
      await expect(
        page
          .getByRole("navigation", { name: "Kortix Capture" })
          .getByRole("link", { name: "Ask" }),
      ).toHaveCount(0);

      // Settings (Capture admins): turning audio off writes the policy and reads back.
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await expect(page).toHaveURL(
        new RegExp(`/capture/${accountId}/settings`),
      );
      await page.getByRole("switch", { name: "Audio" }).click();
      const put = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/v1/accounts/${accountId}/capture/policy`) &&
          r.request().method() === "PUT",
      );
      await page.getByRole("button", { name: "Save policy" }).click();
      expect((await put).status()).toBe(200);
      const policy = await api<{ policy: { layers: { audio: boolean } } }>(
        session.access_token,
        "GET",
        `/accounts/${accountId}/capture/policy`,
      );
      expect(policy.policy.layers.audio).toBe(false);

      expect(pageErrors).toEqual([]);
    } finally {
      if (projectId)
        await deleteDatabaseProject(env, projectId).catch(() => undefined);
      await deleteAuthUser(user.id, authOptions);
    }
  });
});
