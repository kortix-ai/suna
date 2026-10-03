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

test.describe("38 — Capture UI", () => {
  test("gates on the flag; a recorded day plays, searches, saves a range; devices and the policy read back", async ({
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

      // Flag off: no sidebar entry, and the area answers 404 without a capture request.
      const captureRequests: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes(`/v1/projects/${projectId}/capture/`))
          captureRequests.push(request.url());
      });
      await installBrowserSessionDirect(
        page,
        session,
        "/favicon.png",
        authOptions,
      );
      await selectAccountForUi(page, accountId);
      await page.goto(`/projects/${projectId}/capture`, {
        waitUntil: "domcontentloaded",
      });
      await dismissOnboarding(page);
      await expect(page.getByText("404")).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByRole("link", { name: "Capture", exact: true }),
      ).toHaveCount(0);
      expect(captureRequests).toEqual([]);

      // Flag on; one device signs in and uploads the vendored day of the Kortix Capture format.
      await api(
        session.access_token,
        "PATCH",
        `/projects/${projectId}/features`,
        { feature: "capture", enabled: true },
      );
      await api(
        session.access_token,
        "PUT",
        `/projects/${projectId}/capture/policy`,
        { policy: { layers: { screen: true, actions: true, audio: true } } },
      );
      const machineKey = syntheticMachineKey(`capture-ui-${runId}`);
      const started = await api<{ device_code: string; user_code: string }>(
        null,
        "POST",
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
        { project_id: projectId },
      );
      const device = await api<{ device_id: string; prefix: string }>(
        null,
        "POST",
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
        `/projects/${projectId}/capture/devices/${device.device_id}/sync`,
        {},
      );
      await expect
        .poll(
          async () =>
            (
              await api<{ chunks: unknown[] }>(
                session.access_token,
                "GET",
                `/projects/${projectId}/capture/timeline?day=${day.day}`,
              )
            ).chunks.length,
          { timeout: 60_000 },
        )
        .toBe(day.expected.chunks);

      // The sidebar entry opens the timeline on the newest recorded day, at its last moment.
      await page.goto(`/projects/${projectId}`, {
        waitUntil: "domcontentloaded",
      });
      const nav = page.getByRole("link", { name: "Capture", exact: true });
      await expect(nav).toBeVisible({ timeout: 60_000 });
      const daysRead = page.waitForResponse(
        (r) =>
          r.url().includes(`/v1/projects/${projectId}/capture/days?tz=`) &&
          r.status() === 200,
      );
      await nav.click();
      await expect(page).toHaveURL(
        new RegExp(`/projects/${projectId}/capture$`),
      );
      await daysRead;
      for (const tab of [
        "Timeline",
        "Ask",
        "Ranges",
        "Devices",
        "People",
        "Settings",
      ]) {
        await expect(
          page.getByRole("tab", { name: tab, exact: true }),
        ).toBeVisible();
      }
      const track = page.getByRole("slider", {
        name: "Moment on the timeline",
      });
      await expect(track).toBeVisible({ timeout: 30_000 });
      expect(Number(await track.getAttribute("aria-valuenow"))).toBe(day.endMs);
      await expect(page.locator("video")).toHaveCount(1);

      // Search: one screen hit; picking it moves the moment and clears the search.
      const searched = page.waitForResponse((r) =>
        r.url().includes("/capture/search?q=%22incident+review%22"),
      );
      await page
        .getByRole("searchbox", { name: "Search the timeline" })
        .fill('"incident review"');
      expect((await searched).status()).toBe(200);
      const hit = page
        .getByRole("list", { name: "Search results" })
        .getByRole("button")
        .first();
      await expect(hit).toContainText("Editor");
      await hit.click();
      await expect(track).toBeVisible();
      await expect(page).toHaveURL(/at=/);

      // Save range: the POST carries the span, and the range page opens with its three tabs.
      await page.getByRole("button", { name: "Save range" }).click();
      await page.getByLabel("Name").fill("Incident review");
      const saved = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/v1/projects/${projectId}/capture/ranges`) &&
          r.request().method() === "POST",
      );
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Save range" })
        .click();
      const savedResponse = await saved;
      expect(savedResponse.status()).toBe(201);
      expect(savedResponse.request().postDataJSON()).toMatchObject({
        title: "Incident review",
      });
      await expect(page).toHaveURL(
        new RegExp(`/capture/ranges/${(await savedResponse.json()).range_id}`),
      );
      for (const tab of ["Steps", "Transcript", "Summary"])
        await expect(page.getByRole("tab", { name: tab })).toBeVisible();

      // Devices: one row, live.
      await page.getByRole("tab", { name: "Devices", exact: true }).click();
      const row = page.getByRole("row", { name: /Fixture Computer/ });
      await expect(row).toBeVisible();
      await expect(row).toContainText("Recording");

      // Settings: turning audio off writes the policy and reads back.
      await page.getByRole("tab", { name: "Settings", exact: true }).click();
      await page.getByRole("switch", { name: "Audio" }).click();
      const put = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/v1/projects/${projectId}/capture/policy`) &&
          r.request().method() === "PUT",
      );
      await page.getByRole("button", { name: "Save policy" }).click();
      expect((await put).status()).toBe(200);
      const policy = await api<{ policy: { layers: { audio: boolean } } }>(
        session.access_token,
        "GET",
        `/projects/${projectId}/capture/policy`,
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
