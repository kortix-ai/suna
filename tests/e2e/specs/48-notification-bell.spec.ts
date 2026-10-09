import { randomUUID } from "node:crypto";
import { type Page, type Request, expect, test } from "@playwright/test";

import { loadEnv } from "../../src/core/env";
import { createDatabaseSession } from "../../src/fixtures/database-project";
import { queryDatabaseRows, runDatabaseSql } from "../helpers/database";
import { createApiJsonClient } from "../helpers/http";
import {
  type ManifestProject,
  createManifestProject,
  isDeployedTarget,
} from "../helpers/manifest-project";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import { dismissOnboarding, dismissWelcomeCard, openSettingsTab } from "../helpers/ui";

/**
 * KRTX-1742: the bell in the project sidebar lists the person's notifications
 * across sessions. A question waits in one session while the person has
 * another open: the badge counts it, the row names it, and choosing the row
 * opens that session and marks the row read. Settings > Notifications shows
 * one Push switch per kind, and a switch saves to the person's record.
 *
 * All of it sits behind the per-project `notification_center` flag, off by
 * default. The first project turns it on through the owner's
 * `PATCH /projects/:id/features`. A second project keeps the default: no bell,
 * no `/v1/notifications` request, and the four per-browser switches in
 * Settings > Notifications, as before the notification center.
 *
 * Local only: the notification row is written straight into the database.
 */

const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321",
  password: "E2eNotificationBell123!",
};
const api = createApiJsonClient(apiBase);

const OPEN_TITLE = "Pricing page copy";
const WAITING_TITLE = "Quarterly report draft";
const QUESTION = "Should the report include the March numbers?";

/** Every session stays in boot: the page under test is the shell around it. */
/** Every request this page sends to `/v1/notifications/*`, as `METHOD path`. */
function recordNotificationRequests(page: Page) {
  const seen: string[] = [];
  const onRequest = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/v1/notifications")) seen.push(`${request.method()} ${path}`);
  };
  page.on("request", onRequest);
  return {
    seen,
    stop: () => page.off("request", onRequest),
  };
}

async function holdSessionsInBoot(page: Page, projectId: string) {
  const start = new RegExp(`^/v1/projects/${projectId}/sessions/[^/]+/start$`);
  await page.route("**/*", async (route) => {
    if (start.test(new URL(route.request().url()).pathname)) {
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
}

test("48 — the bell opens another session's notification and the settings save Push per kind", async ({
  page,
}) => {
  test.skip(isDeployedTarget(), "local stack only: writes the notification row into the database");
  test.setTimeout(180_000);
  const env = loadEnv();
  const databaseUrl = env.databaseUrl;
  if (!databaseUrl) throw new Error("KE2E_DATABASE_URL is required");
  const user = await createAuthUser(`e2e-notification-bell-${randomUUID()}@example.test`, authOptions);
  let project: ManifestProject | undefined;
  let flagOffProject: ManifestProject | undefined;

  try {
    const auth = await signIn(user.email!, authOptions);
    const accounts = await api<{ account_id: string; personal_account?: boolean }[]>(
      auth.access_token,
      "GET",
      "/accounts",
    );
    const accountId = (accounts.find((item) => item.personal_account) ?? accounts[0]).account_id;
    project = await createManifestProject({
      api,
      accessToken: auth.access_token,
      accountId,
      userId: user.id,
      name: `Notification bell ${Date.now()}`,
      databaseUrl,
    });
    const projectId = project.id;
    // Before sign-in: the first page load already reads the flag.
    await api(auth.access_token, "PATCH", `/projects/${projectId}/features`, {
      feature: "notification_center",
      enabled: true,
    });
    const openSessionId = await createDatabaseSession(env, {
      projectId,
      accountId,
      userId: user.id,
      visibility: "project",
    });
    const waitingSessionId = await createDatabaseSession(env, {
      projectId,
      accountId,
      userId: user.id,
      visibility: "project",
    });
    for (const [sessionId, name] of [
      [openSessionId, OPEN_TITLE],
      [waitingSessionId, WAITING_TITLE],
    ] as const) {
      await api(auth.access_token, "PATCH", `/projects/${projectId}/sessions/${sessionId}`, { name });
    }
    const [{ notification_id: notificationId }] = await queryDatabaseRows<{ notification_id: string }>(
      `INSERT INTO kortix.notifications (user_id, account_id, project_id, session_id, kind, title, body)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'question', $5, $6)
       RETURNING notification_id`,
      [user.id, accountId, projectId, waitingSessionId, WAITING_TITLE, QUESTION],
      databaseUrl,
    );

    await holdSessionsInBoot(page, projectId);
    await installBrowserSessionDirect(
      page,
      auth,
      `/projects/${projectId}/sessions/${openSessionId}`,
      authOptions,
    );
    await dismissOnboarding(page);
    await dismissWelcomeCard(page);

    const bell = page.getByRole("button", { name: "Notifications: 1 unread", exact: true });
    // The sidebar lists the same session by title: read the row from the popover.
    const inbox = page.locator('[data-slot="popover-content"]');

    await test.step("the bell counts the question waiting in the other session", async () => {
      await expect(bell).toBeVisible({ timeout: 60_000 });
      await expect(bell).toContainText("1");
    });

    await test.step("the panel lists it with its kind and project", async () => {
      await bell.click();
      const row = inbox.getByRole("link", { name: new RegExp(WAITING_TITLE) });
      await expect(row).toBeVisible();
      await expect(row).toContainText("Question");
      await expect(row).toHaveAttribute("data-unread", "");
      await expect(row).toHaveAttribute("href", `/projects/${projectId}/sessions/${waitingSessionId}`);
    });

    await test.step("choosing the row opens that session and marks the row read", async () => {
      const markRead = page.waitForRequest(
        (request) =>
          request.method() === "POST" && new URL(request.url()).pathname === "/v1/notifications/read",
      );
      await inbox.getByRole("link", { name: new RegExp(WAITING_TITLE) }).click();
      expect((await markRead).postDataJSON()).toEqual({ ids: [notificationId] });
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/sessions/${waitingSessionId}$`));
      await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible();
      await expect
        .poll(async () => {
          const [stored] = await queryDatabaseRows<{ read: boolean }>(
            `SELECT read_at IS NOT NULL AS read FROM kortix.notifications WHERE notification_id = $1::uuid`,
            [notificationId],
            databaseUrl,
          );
          return stored?.read;
        })
        .toBe(true);
    });

    await test.step("Settings > Notifications shows one Push switch per kind, and a switch saves", async () => {
      const panel = await openSettingsTab(page, "Notifications");
      await expect(panel.getByRole("heading", { name: "Notification types", exact: true })).toBeVisible();
      for (const kind of [
        "Turn finished",
        "Turn failed",
        "Question",
        "Permission request",
        "Shared with you",
        "Failure alert",
        "Recovery alert",
      ]) {
        await expect(panel.getByRole("switch", { name: `${kind}: Push`, exact: true })).toBeVisible();
      }
      await expect(panel.getByRole("switch", { name: "Permission request: Email", exact: true })).toHaveCount(0);

      const turnFinished = panel.getByRole("switch", { name: "Turn finished: Push", exact: true });
      await expect(turnFinished).toBeChecked();
      // The response, not the request: the API answers 200 after the row is written.
      const save = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          new URL(response.url()).pathname === "/v1/notifications/preferences",
      );
      await turnFinished.click();
      const saved = await save;
      expect(saved.status()).toBe(200);
      expect(saved.request().postDataJSON()).toEqual({ kinds: { turn_done: { push: false } } });
      await expect(turnFinished).not.toBeChecked();
      await expect
        .poll(async () => {
          const [stored] = await queryDatabaseRows<{ push: boolean | null }>(
            `SELECT (settings -> 'kinds' -> 'turn_done' ->> 'push')::boolean AS push
               FROM kortix.notification_preferences WHERE user_id = $1::uuid`,
            [user.id],
            databaseUrl,
          );
          return stored?.push;
        })
        .toBe(false);
    });

    await test.step("a project with the flag off has no bell, no inbox request, and the four browser switches", async () => {
      flagOffProject = await createManifestProject({
        api,
        accessToken: auth.access_token,
        accountId,
        userId: user.id,
        name: `Notification bell off ${Date.now()}`,
        databaseUrl,
      });
      const offProjectId = flagOffProject.id;
      // "Enable notifications" asks the browser; grant it so the switch turns on.
      await page.context().grantPermissions(["notifications"], {
        origin: new URL(page.url()).origin,
      });
      // Leave the flag-on project first, so none of its requests are counted.
      await page.goto("about:blank");
      const requests = recordNotificationRequests(page);
      const detail = page.waitForResponse(
        (response) => new URL(response.url()).pathname === `/v1/projects/${offProjectId}/detail`,
      );
      await page.goto(`/projects/${offProjectId}`, { waitUntil: "domcontentloaded" });
      await dismissOnboarding(page);
      expect((await detail).status()).toBe(200);
      await expect(page.getByRole("button", { name: /Search/i }).first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("button", { name: /^Notifications/ })).toHaveCount(0);

      const panel = await openSettingsTab(page, "Notifications");
      const enable = panel.getByRole("switch", { name: "Enable notifications", exact: true });
      // The pre-notification-center line: the browser permission, not where Web Push reaches.
      await expect(panel.getByText("Browser permission granted", { exact: true })).toBeVisible();
      if (!(await enable.isChecked())) await enable.click();
      await expect(enable).toBeChecked();
      for (const kind of ["Task completions", "Errors", "Questions", "Permission requests"]) {
        await expect(panel.getByRole("switch", { name: kind, exact: true })).toBeChecked();
      }
      await expect(panel.getByRole("heading", { name: "Notification types", exact: true })).toHaveCount(0);
      await expect(panel.getByRole("switch", { name: "Turn finished: Push", exact: true })).toHaveCount(0);

      requests.stop();
      expect(requests.seen).toEqual([]);
    });
  } finally {
    await runDatabaseSql(
      `DELETE FROM kortix.notifications WHERE user_id = $1::uuid`,
      [user.id],
      databaseUrl,
    ).catch(() => undefined);
    await runDatabaseSql(
      `DELETE FROM kortix.notification_preferences WHERE user_id = $1::uuid`,
      [user.id],
      databaseUrl,
    ).catch(() => undefined);
    await project?.dispose().catch(() => undefined);
    await flagOffProject?.dispose().catch(() => undefined);
    await deleteAuthUser(user.id, authOptions).catch(() => undefined);
  }
});
