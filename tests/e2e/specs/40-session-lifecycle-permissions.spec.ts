import { type Page, expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseSession } from '../../src/fixtures/database-project';
import { seedSessionTranscript } from '../../src/fixtures/session-transcript';
import { runDatabaseSql } from '../helpers/database';
import { createApiJsonClient } from '../helpers/http';
import { type ManifestProject, createManifestProject } from '../helpers/manifest-project';
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

/**
 * Restart, Stop and Delete belong to the session owner or a project manager:
 * the server answers anyone else 403 (`can_manage_lifecycle`). A project member
 * who could open a teammate's session still saw Restart in the session menu and
 * the sidebar, Restart, Stop and Delete in the sessions list, and a Restart
 * button on the stopped banner — and every one of them failed with a 403 toast.
 * Each surface now follows the verdict. The owner, on the same session, keeps
 * every action.
 *
 * A stopped session with a saved conversation is not a dead end (#9682): the
 * conversation stays, the composer stays live, and its notice says the next
 * message wakes the computer. That is true for a member too: `/start` needs
 * only read access. So the restart notice belongs to a stopped session with
 * nothing to read. There the card says who can restart.
 */

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
  password: 'E2eLifecyclePermissions123!',
};
const api = createApiJsonClient(apiBase);

const TITLE = 'Lifecycle permissions';
const SAVED_REPLY = 'This reply is stored in the database.';
const OWNER_ONLY = 'Only the session owner or a project manager can restart this session.';
// The SDK's `SESSION_NOTICE.idle`: one wording on web and mobile.
const ASLEEP = "This session's computer is asleep. Your next message wakes it up and is delivered.";
const STOPPED = 'This session is stopped';

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
}

/**
 * Open the session page with its computer released: `/start` answers stopped.
 * `ready` is the text the page shows once it is open.
 */
async function openStoppedSession(
  page: Page,
  input: { projectId: string; sessionId: string; accountId: string },
  auth: Awaited<ReturnType<typeof signIn>>,
  ready = SAVED_REPLY,
) {
  await page.addInitScript(() => localStorage.setItem('kortix:marko-welcome-dismissed', '1'));
  await page.route(`**/sessions/${input.sessionId}/start*`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 200,
      json: {
        stage: 'stopped',
        agent_name: 'kortix',
        retriable: false,
        sandbox: null,
        opencode_session_id: `ses_${input.sessionId.replaceAll('-', '')}`,
        failure: null,
      },
    });
  });
  await installBrowserSessionDirect(page, auth, `/projects/${input.projectId}`, authOptions);
  await selectAccountForUi(page, input.accountId);
  await page.goto(`/projects/${input.projectId}/sessions/${input.sessionId}`, {
    waitUntil: 'commit',
  });
  await dismissOnboarding(page);
  await expect(page.getByText(ready, { exact: true })).toBeVisible({ timeout: 120_000 });
}

/** The session menu's item names, read with the menu open. */
async function sessionMenuItems(page: Page): Promise<string[]> {
  await page.getByRole('button', { name: 'Session actions', exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /session ID/i })).toBeVisible();
  const items = (await menu.getByRole('menuitem').allInnerTexts()).map((text) => text.trim());
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  return items;
}

/** The item names of a row menu opened by its "Actions for <title>" button. */
async function rowMenuItems(
  page: Page,
  trigger = page.getByRole('button', { name: `Actions for ${TITLE}`, exact: true }),
) {
  // A row shows its actions button on hover, in place of the owner's avatar.
  await trigger.hover({ force: true });
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /Who has access|Share/ })).toBeVisible();
  const items = (await menu.getByRole('menuitem').allInnerTexts()).map((text) => text.trim());
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  return items;
}

test('40 — a member sees no session lifecycle action the server would refuse', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(300_000);
  const env = loadEnv();
  if (!env.databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
  const runId = Date.now().toString(36);
  const ownerEmail = `e2e-lifecycle-owner-${runId}@example.test`;
  const memberEmail = `e2e-lifecycle-member-${runId}@example.test`;
  const owner = await createAuthUser(ownerEmail, authOptions);
  const member = await createAuthUser(memberEmail, authOptions);
  let project: ManifestProject | undefined;

  try {
    const ownerAuth = await signIn(ownerEmail, authOptions);
    const accounts = await api<AccountSummary[]>(ownerAuth.access_token, 'GET', '/accounts');
    const accountId = (accounts.find((item) => item.personal_account) ?? accounts[0]).account_id;
    project = await createManifestProject({
      api,
      accessToken: ownerAuth.access_token,
      accountId,
      userId: owner.id,
      name: `Lifecycle permissions ${runId}`,
      databaseUrl: env.databaseUrl,
    });
    const projectId = project.id;
    // A plain member of the account and of the project, as journey 38 adds one.
    await api(
      ownerAuth.access_token,
      'POST',
      `/accounts/${accountId}/members`,
      { email: memberEmail, role: 'member' },
      201,
    );
    await api(ownerAuth.access_token, 'PUT', `/projects/${projectId}/access/${member.id}`, {
      role: 'member',
    });

    // The owner's session, open to the project, stopped, with a saved conversation.
    const sessionId = await createDatabaseSession(env, {
      projectId,
      accountId,
      userId: owner.id,
      visibility: 'project',
    });
    await seedSessionTranscript(env, { projectId, accountId, sessionId, log: { bearer: ownerAuth.access_token } });
    await runDatabaseSql(
      "UPDATE kortix.project_sessions SET agent_name='kortix' WHERE session_id=$1",
      [sessionId],
      env.databaseUrl,
    );
    await api(ownerAuth.access_token, 'PATCH', `/projects/${projectId}/sessions/${sessionId}`, {
      name: TITLE,
    });
    const memberAuth = await signIn(memberEmail, authOptions);

    await test.step('the server gives the member no lifecycle right on this session', async () => {
      const asMember = await api<{ can_manage_lifecycle?: boolean }>(
        memberAuth.access_token,
        'GET',
        `/projects/${projectId}/sessions/${sessionId}`,
      );
      expect(asMember.can_manage_lifecycle).toBe(false);
      await api(
        memberAuth.access_token,
        'POST',
        `/projects/${projectId}/sessions/${sessionId}/restart`,
        {},
        403,
      );
    });

    const lifecycleRequests: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (/\/sessions\/[^/]+\/(restart|stop)$/.test(path) || request.method() === 'DELETE') {
        lifecycleRequests.push(`${request.method()} ${path}`);
      }
    });
    await openStoppedSession(page, { projectId, sessionId, accountId }, memberAuth);

    await test.step('the stopped conversation keeps a live composer that says the next message wakes it, with no Restart button', async () => {
      await expect(page.getByText(ASLEEP, { exact: true })).toBeVisible();
      await expect(page.locator('[data-session-notice-banner]')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /restart/i })).toHaveCount(0);
    });

    await test.step('the session menu offers no Restart, Reload, Stop or Delete', async () => {
      const items = await sessionMenuItems(page);
      for (const action of ['Restart', 'Reload config', 'Stop', 'Delete']) {
        expect(items).not.toContain(action);
      }
    });

    await test.step('the sidebar row offers no Restart or Delete', async () => {
      const items = await rowMenuItems(page);
      for (const action of ['Restart', 'Stop', 'Delete']) {
        expect(items).not.toContain(action);
      }
    });

    await test.step('the sessions list row offers no Restart, Stop or Delete', async () => {
      await page.goto(`/projects/${projectId}/sessions`, { waitUntil: 'commit' });
      // The list row is the disclosure "Show details for <title>"; its actions
      // button sits inside it (the sidebar row has the same button name).
      const row = page.getByRole('button', { name: `Show details for ${TITLE}`, exact: true });
      await expect(row).toBeVisible({ timeout: 60_000 });
      const trigger = row.getByRole('button', { name: `Actions for ${TITLE}`, exact: true });
      const items = await rowMenuItems(page, trigger);
      for (const action of ['Restart', 'Stop', 'Delete']) {
        expect(items).not.toContain(action);
      }
      await testInfo.attach('member-sessions-list', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    });

    // The owner's second session, open to the project, stopped, never prompted.
    const emptySessionId = await createDatabaseSession(env, {
      projectId,
      accountId,
      userId: owner.id,
      visibility: 'project',
    });
    await runDatabaseSql(
      "UPDATE kortix.project_sessions SET agent_name='kortix' WHERE session_id=$1",
      [emptySessionId],
      env.databaseUrl,
    );
    const emptySession = { projectId, sessionId: emptySessionId, accountId };

    await test.step('a stopped session with nothing to read says who can restart, with no Restart button', async () => {
      await openStoppedSession(page, emptySession, memberAuth, STOPPED);
      await expect(page.getByText(OWNER_ONLY, { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /restart/i })).toHaveCount(0);
    });
    expect(lifecycleRequests).toEqual([]);

    await test.step('the owner keeps Restart and Delete on the same sessions', async () => {
      const ownerContext = await browser.newContext();
      try {
        const ownerPage = await ownerContext.newPage();
        await openStoppedSession(ownerPage, emptySession, ownerAuth, STOPPED);
        await expect(ownerPage.getByRole('button', { name: 'Restart session', exact: true })).toBeVisible();
        await expect(ownerPage.getByText(OWNER_ONLY, { exact: true })).toHaveCount(0);
        await openStoppedSession(ownerPage, { projectId, sessionId, accountId }, ownerAuth);
        const items = await sessionMenuItems(ownerPage);
        expect(items).toEqual(expect.arrayContaining(['Restart', 'Delete']));
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
