import { randomUUID } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";

import { loadEnv } from "../../src/core/env";
import { createDatabaseSession } from "../../src/fixtures/database-project";
import { runDatabaseSql } from "../helpers/database";
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
import { dismissOnboarding, dismissWelcomeCard } from "../helpers/ui";

/**
 * KRTX-1729: while the person is here, the composer says how long their
 * presence keeps the session's sandbox on, and, at the 2-hour limit, when it
 * stops. The server computes the window (`awake_until`, `awake_cap_at` on
 * PUT …/presence; `integration-session-presence.test.ts` proves it on a real
 * database). This journey answers the presence PUT with a running sandbox's
 * window and checks what the page shows.
 *
 * Local only: the session is a saved conversation with no sandbox, and `/start`
 * answers as a running one does.
 */

const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321",
  password: "E2eSandboxAwake123!",
};
const api = createApiJsonClient(apiBase);
const MINUTE = 60_000;

type AwakeWindow = { awake_until: string | null; awake_cap_at: string | null };

/** A stopped session with one saved exchange: the composer renders without a sandbox. */
async function seedSavedSession(
  projectId: string,
  accountId: string,
  userId: string,
  databaseUrl: string,
): Promise<string> {
  const sessionId = await createDatabaseSession(loadEnv(), { projectId, accountId, userId });
  const rootId = `ses_${sessionId.replaceAll("-", "")}`;
  const at = Date.now() - MINUTE;
  await runDatabaseSql(
    "UPDATE kortix.project_sessions SET status = 'stopped', opencode_session_id = $2, sandbox_id = $1, sandbox_url = 'http://127.0.0.1:1' WHERE session_id = $1",
    [sessionId, rootId],
    databaseUrl,
  );
  await runDatabaseSql(
    "INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status, external_id, base_url) VALUES ($1::uuid,$1,$2,$3,'stopped',$1,'http://127.0.0.1:1')",
    [sessionId, accountId, projectId],
    databaseUrl,
  );
  await runDatabaseSql(
    "INSERT INTO kortix.session_transcript_mirrors (session_id, project_id, account_id, opencode_session_id, head_complete) VALUES ($1,$2,$3,$4,true)",
    [sessionId, projectId, accountId, rootId],
    databaseUrl,
  );
  for (const role of ["user", "assistant"] as const) {
    const id = role === "user" ? "msg_000000000000000000000001" : "msg_000000000000000000000002";
    const info = {
      id,
      sessionID: rootId,
      role,
      agent: "kortix",
      time: { created: at, ...(role === "assistant" ? { completed: at + 1 } : {}) },
      ...(role === "user"
        ? { model: { providerID: "kortix", modelID: "openai/gpt-5.5" } }
        : {
            parentID: "msg_000000000000000000000001",
            providerID: "kortix",
            modelID: "openai/gpt-5.5",
            mode: "build",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
            path: { cwd: "/workspace", root: "/workspace" },
          }),
    };
    const parts = [
      {
        id: `prt_awake_${role}`,
        sessionID: rootId,
        messageID: id,
        type: "text",
        text: role === "user" ? "Summarize the release notes" : "Here is the summary.",
      },
    ];
    await runDatabaseSql(
      "INSERT INTO kortix.session_transcript_messages (session_id, message_id, opencode_session_id, role, message_created_at, info, parts) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [sessionId, id, rootId, role, new Date(at), JSON.stringify(info), JSON.stringify(parts)],
      databaseUrl,
    );
  }
  return sessionId;
}

/** Answer every presence PUT of the session with the window `next()` returns. */
async function answerPresence(page: Page, sessionId: string, next: () => AwakeWindow) {
  await page.route(`**/sessions/${sessionId}/presence`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, ...next() }),
    }),
  );
}

/** The session reads as running: a saved conversation has no sandbox to wake. */
async function answerStartReady(page: Page, projectId: string, accountId: string, sessionId: string) {
  const rootId = `ses_${sessionId.replaceAll("-", "")}`;
  const at = new Date().toISOString();
  await page.route(`**/sessions/${sessionId}/start?*`, (route) =>
    route.fulfill({
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
          project_id: projectId,
          account_id: accountId,
          provider: "daytona",
          external_id: sessionId,
          base_url: "http://127.0.0.1:1",
          status: "active",
          config: {},
          metadata: {},
          last_used_at: null,
          created_at: at,
          updated_at: at,
        },
      }),
    }),
  );
}

/** Hide the page, then show it: the SDK reports absent, then present again. */
async function leaveAndComeBack(page: Page) {
  for (const hidden of [true, false]) {
    await page.evaluate((value) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (value ? "hidden" : "visible"),
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  }
  await page.mouse.move(200, 200);
  await page.mouse.move(240, 260);
}

test("49 — the composer says how long the sandbox stays on while you are here", async ({ page }) => {
  test.skip(isDeployedTarget(), "local stack only: seeds a saved conversation");
  test.setTimeout(180_000);
  const databaseUrl = loadEnv().databaseUrl;
  if (!databaseUrl) throw new Error("KE2E_DATABASE_URL is required");
  const user = await createAuthUser(`e2e-sandbox-awake-${randomUUID()}@example.test`, authOptions);
  let project: ManifestProject | undefined;

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
      name: `Sandbox awake ${Date.now()}`,
      databaseUrl,
    });
    const sessionId = await seedSavedSession(project.id, accountId, user.id, databaseUrl);

    let window: AwakeWindow = {
      awake_until: new Date(Date.now() + 15 * MINUTE).toISOString(),
      awake_cap_at: new Date(Date.now() + 100 * MINUTE).toISOString(),
    };
    await answerStartReady(page, project.id, accountId, sessionId);
    await answerPresence(page, sessionId, () => window);
    await installBrowserSessionDirect(page, auth, `/projects/${project.id}/sessions/${sessionId}`, authOptions);
    await dismissOnboarding(page);
    await dismissWelcomeCard(page);
    await expect(page.getByText("Here is the summary.")).toBeVisible({ timeout: 60_000 });
    // Presence counts only a person who used the page in the last 10 minutes.
    await page.mouse.move(200, 200);
    await page.mouse.move(240, 260);

    await test.step("a present person sees how long the sandbox stays on", async () => {
      await expect(page.getByText(/^Sandbox stays on while you're here · up to 1 h (39|40) min$/)).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("at the 2-hour limit the line says when the sandbox stops", async () => {
      const stopAt = new Date(Date.now() + 10 * MINUTE).toISOString();
      window = { awake_until: stopAt, awake_cap_at: stopAt };
      await leaveAndComeBack(page);
      await expect(
        page.getByText(/^Sandbox stops in (9|10) min\. Send a message to keep it on\.$/),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/Sandbox stays on while you're here/)).toHaveCount(0);
    });

    await test.step("a window from a viewer or a stopped sandbox hides the line", async () => {
      window = { awake_until: null, awake_cap_at: null };
      await leaveAndComeBack(page);
      await expect(page.getByText(/^Sandbox (stays on|stops in)/)).toHaveCount(0, { timeout: 30_000 });
    });
  } finally {
    await project?.dispose().catch(() => undefined);
    await deleteAuthUser(user.id, authOptions).catch(() => undefined);
  }
});
