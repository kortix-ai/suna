import { expect, test } from "@playwright/test";

import { resolvePersonalAccountId } from "../helpers/accounts";
import { queryDatabaseRows, runDatabaseSql } from "../helpers/database";
import { createApiJsonClient, createApiResultClient } from "../helpers/http";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";

const supabaseUrl = process.env.E2E_SUPABASE_URL || "http://localhost:13740";
const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const databaseUrl =
  process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const password = "E2eCaptureSearch123!";
const authOptions = { supabaseUrl, password };
const api = createApiJsonClient(apiBase);
const apiResult = createApiResultClient(apiBase);

test.describe("38 — Kortix Capture: settings, search and replay", () => {
  // The owner of an account turns Capture on, turns on one paired computer,
  // and finds what that computer recorded: search, then the frame list of the
  // chunk, then frame stepping. The recorder side is the machine API with
  // synthetic bytes; the REST flow CAP-1 owns the full machine contract.
  test("owner enables capture and a device in Settings, then searches and steps frames", async ({
    page,
  }) => {
    test.skip(!databaseUrl, "KE2E_DATABASE_URL is required");
    test.setTimeout(240_000);

    const email = `e2e-capture-${Date.now().toString(36)}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const phrase = `zebrafish${Date.now().toString(36)}`;

    try {
      const session = await signIn(email, authOptions);
      const token = session.access_token;
      const accountId = await resolvePersonalAccountId(apiResult, token);

      // A machine paired by this user. The device row appears on first config read.
      const createdRes = await fetch(`${apiBase}/tunnel/device-auth`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
        },
        body: JSON.stringify({ machineHostname: "e2e-capture.local" }),
      });
      expect(createdRes.status).toBe(201);
      const created = (await createdRes.json()) as { deviceCode: string; deviceSecret: string };
      const approved = await api<{ tunnelId: string }>(
        token,
        "POST",
        `/tunnel/device-auth/${created.deviceCode}/approve`,
        { name: "E2E laptop", capabilities: [] },
      );
      const poll = await api<{ token: string }>(
        created.deviceSecret,
        "GET",
        `/tunnel/device-auth/${created.deviceCode}/status`,
      );
      const machine = {
        authorization: `Bearer ${poll.token}`,
        "x-tunnel-id": approved.tunnelId,
        "content-type": "application/json",
      };
      await fetch(`${apiBase}/capture/agent/config`, { headers: machine });

      await installBrowserSessionDirect(page, session, "/settings/capture", authOptions);

      await test.step("The owner switches Kortix Capture on and the account stores it", async () => {
        const toggle = page.getByRole("switch", { name: "Kortix Capture" });
        await expect(toggle).toBeVisible({ timeout: 90_000 });
        const put = page.waitForRequest(
          (r) => r.method() === "PUT" && r.url().endsWith(`/accounts/${accountId}/capture/settings`),
        );
        await toggle.click();
        expect((await put).postDataJSON()).toEqual({ enabled: true });
        await expect(toggle).toBeChecked();
        const stored = await api<{ enabled: boolean }>(token, "GET", `/accounts/${accountId}/capture/settings`);
        expect(stored.enabled).toBe(true);
      });

      await test.step("The owner switches the computer on and the device stores it", async () => {
        const toggle = page.getByRole("switch", { name: "Record E2E laptop" });
        await expect(toggle).toBeVisible({ timeout: 30_000 });
        const put = page.waitForRequest(
          (r) => r.method() === "PUT" && /\/capture\/devices\/[0-9a-f-]+$/.test(r.url()),
        );
        await toggle.click();
        expect((await put).postDataJSON()).toEqual({ enabled: true });
        const { devices } = await api<{ devices: Array<{ enabled: boolean; account_id: string }> }>(
          token,
          "GET",
          "/capture/devices",
        );
        expect(devices[0]).toMatchObject({ enabled: true, account_id: accountId });
      });

      await test.step("The machine uploads one chunk of two frames", async () => {
        const video = new Uint8Array(4096).map((_, i) => (i * 7) % 251);
        const start = Date.now() - 10 * 60_000;
        const iso = (s: number) => new Date(start + s * 1000).toISOString();
        const reg = (await (
          await fetch(`${apiBase}/capture/agent/chunks`, {
            method: "POST",
            headers: machine,
            body: JSON.stringify({
              client_uid: "e2e-1",
              started_at: iso(0),
              ended_at: iso(2),
              frame_count: 2,
              width: 1280,
              height: 720,
              codec: "h264",
              video_bytes: video.byteLength,
              video_sha256: await sha256Hex(video),
            }),
          })
        ).json()) as { chunk_id: string; upload: { url: string; headers: Record<string, string> } };
        const put = await fetch(reg.upload.url, { method: "PUT", headers: reg.upload.headers, body: video });
        expect(put.ok).toBe(true);
        const commit = await fetch(`${apiBase}/capture/agent/chunks/${reg.chunk_id}/commit`, {
          method: "POST",
          headers: machine,
          body: JSON.stringify({
            frames: [
              { frame_index: 0, ts: iso(0), app_name: "Mail", window_title: "Inbox", text: `invoice ${phrase} total` },
              { frame_index: 1, ts: iso(1), app_name: "Terminal", window_title: "deploy", text: "rollout failed" },
            ],
          }),
        });
        expect(commit.status).toBe(200);
      });

      await test.step("Search finds the frame and the player steps through the chunk", async () => {
        await page.goto("/capture", { timeout: 120_000 });
        await page.getByRole("searchbox", { name: "Search captures" }).fill(phrase);
        await page.getByRole("button", { name: "Search", exact: true }).click();
        const result = page.getByTestId("capture-result");
        await expect(result).toHaveCount(1, { timeout: 30_000 });
        await expect(result).toContainText("Inbox");
        await expect(result.locator("b")).toHaveText(phrase);
        await result.click();
        await expect(page.getByTestId("capture-frame-position")).toHaveText("Frame 1 of 2", { timeout: 30_000 });
        await expect(page.getByTestId("capture-frame")).toContainText(`invoice ${phrase} total`);
        await page.getByRole("button", { name: "Next frame" }).click();
        await expect(page.getByTestId("capture-frame-position")).toHaveText("Frame 2 of 2");
        await expect(page.getByTestId("capture-frame")).toContainText("rollout failed");
      });
    } finally {
      const rows = await queryDatabaseRows<{ account_id: string }>(
        "select distinct account_id::text from kortix.account_members where user_id = $1::uuid",
        [user.id],
      ).catch(() => []);
      for (const row of rows) {
        await runDatabaseSql("delete from kortix.accounts where account_id = $1::uuid", [
          row.account_id,
        ]).catch(() => {});
      }
      await deleteAuthUser(user.id, authOptions);
    }
  });
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
