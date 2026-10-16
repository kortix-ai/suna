import { type Page, type Request, expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseSession } from '../../src/fixtures/database-project';
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
 * KRTX-2418: a person pins a session to the top of the sidebar and archives a
 * finished one out of it, without deleting it. The archive lives on the
 * sessions page, reached from the sidebar's session menu, and a session comes
 * back from it with Unarchive. Every control sends the request it names.
 */

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
  password: 'E2ePinArchive123!',
};
const api = createApiJsonClient(apiBase);

const PIN_TITLE = 'Pinned research';
const ARCHIVE_TITLE = 'Finished import';

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
}

/** Open a sidebar row's menu and choose one item. */
async function chooseRowAction(page: Page, title: string, item: string) {
  const trigger = page.getByRole('button', { name: `Actions for ${title}`, exact: true }).first();
  await trigger.hover({ force: true });
  await trigger.click();
  await page.getByRole('menu').getByRole('menuitem', { name: item, exact: true }).click();
}

/** The next PUT to this session's pin or archive route, and its JSON body. */
function listStateRequest(page: Page, sessionId: string, route: 'pin' | 'archive') {
  return page.waitForRequest(
    (request: Request) =>
      request.method() === 'PUT' && new URL(request.url()).pathname.endsWith(`/sessions/${sessionId}/${route}`),
  );
}

test('52 — a person pins a session to the top and archives one out of the list', async ({ page }) => {
  test.setTimeout(300_000);
  const env = loadEnv();
  if (!env.databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
  const runId = Date.now().toString(36);
  const email = `e2e-pin-archive-${runId}@example.test`;
  const user = await createAuthUser(email, authOptions);
  let project: ManifestProject | undefined;

  try {
    const auth = await signIn(email, authOptions);
    const accounts = await api<AccountSummary[]>(auth.access_token, 'GET', '/accounts');
    const accountId = (accounts.find((item) => item.personal_account) ?? accounts[0]).account_id;
    project = await createManifestProject({
      api,
      accessToken: auth.access_token,
      accountId,
      userId: user.id,
      name: `Pin and archive ${runId}`,
      databaseUrl: env.databaseUrl,
    });
    const projectId = project.id;
    const seed = async (title: string) => {
      const sessionId = await createDatabaseSession(env, { projectId, accountId, userId: user.id });
      await api(auth.access_token, 'PATCH', `/projects/${projectId}/sessions/${sessionId}`, { name: title });
      return sessionId;
    };
    const pinId = await seed(PIN_TITLE);
    const archiveId = await seed(ARCHIVE_TITLE);

    // The welcome card sits where the toasts appear.
    await page.addInitScript(() => localStorage.setItem('kortix:marko-welcome-dismissed', '1'));
    await installBrowserSessionDirect(page, auth, `/projects/${projectId}`, authOptions);
    await selectAccountForUi(page, accountId);
    await dismissOnboarding(page);
    const sidebarRow = (title: string) => page.getByRole('button', { name: `Actions for ${title}`, exact: true });
    await expect(sidebarRow(PIN_TITLE)).toHaveCount(1, { timeout: 60_000 });
    await expect(sidebarRow(ARCHIVE_TITLE)).toHaveCount(1);

    await test.step('Pin session sends {pinned:true}; the row moves under Pinned, listed once', async () => {
      const sent = listStateRequest(page, pinId, 'pin');
      await chooseRowAction(page, PIN_TITLE, 'Pin session');
      const request = await sent;
      expect(request.postDataJSON()).toEqual({ pinned: true });
      expect((await request.response())?.status()).toBe(200);
      await expect(page.getByText('Session pinned', { exact: true })).toBeVisible();
      await expect(page.getByText('Pinned', { exact: true }).first()).toBeVisible();
      await expect(sidebarRow(PIN_TITLE)).toHaveCount(1);
    });

    await test.step('Archive session sends {archived:true}; the row leaves; Undo brings it back', async () => {
      const sent = listStateRequest(page, archiveId, 'archive');
      await chooseRowAction(page, ARCHIVE_TITLE, 'Archive session');
      expect((await sent).postDataJSON()).toEqual({ archived: true });
      await expect(sidebarRow(ARCHIVE_TITLE)).toHaveCount(0);
      const undone = listStateRequest(page, archiveId, 'archive');
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      expect((await undone).postDataJSON()).toEqual({ archived: false });
      await expect(sidebarRow(ARCHIVE_TITLE)).toHaveCount(1, { timeout: 30_000 });
      const again = listStateRequest(page, archiveId, 'archive');
      await chooseRowAction(page, ARCHIVE_TITLE, 'Archive session');
      expect((await again).postDataJSON()).toEqual({ archived: true });
      await expect(sidebarRow(ARCHIVE_TITLE)).toHaveCount(0);
    });

    await test.step('the sidebar menu opens the archive on the sessions page', async () => {
      await page.getByRole('button', { name: 'Session view options', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Archived sessions', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/sessions\\?view=archived`));
      await expect(page.getByRole('tab', { name: 'Archived', exact: true })).toHaveAttribute('aria-selected', 'true', {
        timeout: 60_000,
      });
      const archivedRow = page.getByRole('button', { name: `Show details for ${ARCHIVE_TITLE}`, exact: true });
      await expect(archivedRow).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('button', { name: `Show details for ${PIN_TITLE}`, exact: true })).toHaveCount(0);
    });

    await test.step('Unarchive session sends {archived:false}; the archive is empty and says so', async () => {
      const archivedRow = page.getByRole('button', { name: `Show details for ${ARCHIVE_TITLE}`, exact: true });
      const trigger = archivedRow.getByRole('button', { name: `Actions for ${ARCHIVE_TITLE}`, exact: true });
      const sent = listStateRequest(page, archiveId, 'archive');
      await trigger.hover({ force: true });
      await trigger.click();
      await page.getByRole('menu').getByRole('menuitem', { name: 'Unarchive session', exact: true }).click();
      expect((await sent).postDataJSON()).toEqual({ archived: false });
      await expect(page.getByText('Sessions you archive will show up here.', { exact: true })).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step('the All tab lists both again, the pinned one with its mark', async () => {
      await page.getByRole('tab', { name: 'All', exact: true }).click();
      const pinnedRow = page.getByRole('button', { name: `Show details for ${PIN_TITLE}`, exact: true });
      await expect(pinnedRow).toBeVisible({ timeout: 30_000 });
      await expect(pinnedRow.getByRole('img', { name: 'Pinned', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: `Show details for ${ARCHIVE_TITLE}`, exact: true })).toBeVisible();
    });
  } finally {
    await project?.dispose().catch(() => undefined);
    await deleteAuthUser(user.id, authOptions).catch(() => {});
  }
});
