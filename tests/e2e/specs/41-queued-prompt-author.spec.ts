import { randomUUID } from "node:crypto";
import { type Page, expect, test } from "@playwright/test";

import { loadEnv } from "../../src/core/env";
import {
  createDatabaseSession,
  seedDatabaseRunningFirstPrompt,
} from "../../src/fixtures/database-project";
import { mintWireMessageId } from "../../src/fixtures/session-run";
import { createApiJsonClient } from "../helpers/http";
import { createManifestProject, fundAccount, type ManifestProject } from "../helpers/manifest-project";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import { dismissOnboarding, dismissWelcomeCard } from "../helpers/ui";

/**
 * A queued prompt runs as its author: the drain binds the session credential
 * to the member who sent it. Any member who could open a shared session could
 * edit, send now or remove another member's queued prompt, and Up in an empty
 * composer opened the newest row of ANY author for an edit. Now only the
 * author is offered Edit, Up, Retry and Stop and send; other members' rows say
 * who may change them; a session manager may still remove them (KRTX-1712).
 */

const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321",
  password: "E2eQueuedPromptAuthor123!",
};
const api = createApiJsonClient(apiBase);

const AGENT = "kortix";
const MEMBER_ROW = "Summarize the open pull requests";
const OWNER_ROW = "Draft the release notes";
const NOT_YOURS = "Sent by another member. Only they can edit or send it.";

type ListedPrompt = { prompt_id: string; full_text: string; state: string };

async function openSession(
  page: Page,
  input: { projectId: string; sessionId: string },
  auth: Awaited<ReturnType<typeof signIn>>,
) {
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    // The computer stays in boot for the whole journey: the session page is
    // the instant shell, whose queue list is the one under test.
    if (path === `/v1/projects/${input.projectId}/sessions/${input.sessionId}/start`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          stage: "provisioning",
          agent_name: AGENT,
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
  await installBrowserSessionDirect(
    page,
    auth,
    `/projects/${input.projectId}/sessions/${input.sessionId}`,
    authOptions,
  );
  await dismissOnboarding(page);
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible({ timeout: 60_000 });
  await dismissWelcomeCard(page);
}

test("41 — only a queued prompt's author edits or sends it", async ({ page, browser }, testInfo) => {
  test.setTimeout(240_000);
  const env = loadEnv();
  if (!env.databaseUrl) throw new Error("KE2E_DATABASE_URL is required");
  const runId = randomUUID();
  const owner = await createAuthUser(`e2e-queue-author-owner-${runId}@example.test`, authOptions);
  const member = await createAuthUser(`e2e-queue-author-member-${runId}@example.test`, authOptions);
  let project: ManifestProject | undefined;

  try {
    const ownerAuth = await signIn(owner.email!, authOptions);
    const accounts = await api<{ account_id: string; personal_account?: boolean }[]>(
      ownerAuth.access_token,
      "GET",
      "/accounts",
    );
    const accountId = (accounts.find((item) => item.personal_account) ?? accounts[0]).account_id;
    await fundAccount(env.databaseUrl, accountId);
    project = await createManifestProject({
      api,
      accessToken: ownerAuth.access_token,
      accountId,
      userId: owner.id,
      name: `Queued prompt author ${Date.now()}`,
      databaseUrl: env.databaseUrl,
    });
    const projectId = project.id;
    // A plain member of the account and the project, granted the agent the
    // session runs (members run only the agents granted to them).
    await api(ownerAuth.access_token, "POST", `/accounts/${accountId}/members`, { email: member.email, role: "member" }, 201);
    await api(ownerAuth.access_token, "PUT", `/projects/${projectId}/access/${member.id}`, { role: "member" });
    await api(ownerAuth.access_token, "POST", `/accounts/${accountId}/iam/assignments`, {
      principal_type: "user",
      principal_id: member.id,
      role_key: "agent-user",
      scope_type: "project",
      scope_id: projectId,
      object_type: "agent",
      object_id: AGENT,
    }, 201);
    const memberAuth = await signIn(member.email!, authOptions);

    // The owner's session, open to the project, with its first prompt on its
    // way: every prompt sent afterwards waits behind it and no computer boots.
    const sessionId = await createDatabaseSession(env, {
      projectId,
      accountId,
      userId: owner.id,
      visibility: "project",
    });
    await seedDatabaseRunningFirstPrompt(env, { projectId, sessionId, accountId, userId: owner.id });
    const promptsPath = `/projects/${projectId}/sessions/${sessionId}/prompts`;
    const queue = (token: string, text: string) =>
      api<{ prompt_id: string }>(token, "POST", promptsPath, {
        client_message_id: randomUUID(),
        message_id: mintWireMessageId(),
        remint_on_delivery: false,
        parts: [{ type: "text", text }],
        placement: "composer",
        delivery: "queue",
        overrides: { agent: AGENT },
      }, 202);
    // The member's row first, the owner's last: Up opens the newest row the
    // viewer may edit, so an Up that ignored the author would open the owner's.
    const memberPrompt = (await queue(memberAuth.access_token, MEMBER_ROW)).prompt_id;
    const ownerPrompt = (await queue(ownerAuth.access_token, OWNER_ROW)).prompt_id;
    await expect
      .poll(
        async () =>
          (await api<{ prompts: ListedPrompt[] }>(ownerAuth.access_token, "GET", promptsPath)).prompts
            .filter((p) => p.prompt_id === memberPrompt || p.prompt_id === ownerPrompt)
            .map((p) => p.state)
            .sort(),
        { timeout: 30_000 },
      )
      .toEqual(["waiting", "waiting"]);

    // Every write the member's page sends to a prompt.
    const writes: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith(`/v1${promptsPath}/`) && request.method() !== "GET") {
        writes.push(`${request.method()} ${path}`);
      }
    });
    await openSession(page, { projectId, sessionId }, memberAuth);
    const rows = page.locator("[data-queued-prompt-id]");
    const ownerRow = rows.filter({ hasText: OWNER_ROW });
    const memberRow = rows.filter({ hasText: MEMBER_ROW });
    await expect(ownerRow).toHaveCount(1, { timeout: 30_000 });
    await expect(memberRow).toHaveCount(1);

    await test.step("the owner's row says who may change it and offers the member nothing", async () => {
      await expect(ownerRow.locator('[data-queued-author="other"]')).toHaveText(NOT_YOURS);
      await ownerRow.hover();
      await expect(ownerRow.getByRole("button")).toHaveCount(0);
      await expect(memberRow.locator('[data-queued-author="other"]')).toHaveCount(0);
      await memberRow.hover();
      await expect(memberRow.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
      await testInfo.attach("member-view", { body: await page.screenshot(), contentType: "image/png" });
    });

    await test.step("Up in the empty composer opens the member's own row, never the owner's", async () => {
      const input = page.getByRole("textbox", { name: "Message input" });
      await input.click();
      await input.press("ArrowUp");
      await expect(page.locator("[data-queued-editing]")).toContainText(MEMBER_ROW);
      await expect(input).toHaveText(MEMBER_ROW);
      // The owner's row keeps its slot, untouched.
      await expect(ownerRow).toHaveCount(1);
      await input.press("Escape");
    });
    expect(writes.filter((write) => write.includes(ownerPrompt))).toEqual([]);

    await test.step("the owner edits their own row and may remove the member's, not edit it", async () => {
      const ownerContext = await browser.newContext();
      try {
        const ownerPage = await ownerContext.newPage();
        await openSession(ownerPage, { projectId, sessionId }, ownerAuth);
        const own = ownerPage.locator("[data-queued-prompt-id]").filter({ hasText: OWNER_ROW });
        const theirs = ownerPage.locator("[data-queued-prompt-id]").filter({ hasText: MEMBER_ROW });
        await expect(own).toHaveCount(1, { timeout: 30_000 });
        await own.hover();
        await expect(own.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
        await expect(theirs.locator('[data-queued-author="other"]')).toHaveText(NOT_YOURS);
        await theirs.hover();
        await expect(theirs.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
        await expect(theirs.getByRole("button", { name: "Remove from queue", exact: true })).toBeVisible();
        await testInfo.attach("owner-view", { body: await ownerPage.screenshot(), contentType: "image/png" });
      } finally {
        await ownerContext.close();
      }
    });
  } finally {
    await project?.dispose().catch(() => undefined);
    await deleteAuthUser(member.id, authOptions).catch(() => undefined);
    await deleteAuthUser(owner.id, authOptions).catch(() => undefined);
  }
});
