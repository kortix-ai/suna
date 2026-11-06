import { expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';
import { createApiJsonClient } from '../helpers/http';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';
import { ensureOwnedAccount } from '../helpers/accounts';

// KRTX-2760: a cached shell must not open a deleted workspace. Since K2 the
// owner sees it as deleting, with Restore, until it is erased.
test('56 — a deleted remembered workspace shows its owner the restore page on every visit @local-only', async ({ page }) => {
  const env = loadEnv();
  const authOptions = {
    supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
    password: 'E2eDeletedProject123!',
  };
  const email = `e2e-deleted-project-${Date.now()}@example.test`;
  const user = await createAuthUser(email, authOptions);
  const api = createApiJsonClient(env.apiUrl);
  let projectId: string | undefined;
  try {
    const session = await signIn(email, authOptions);
    const account = { account_id: await ensureOwnedAccount(api, session.access_token) };
    const project = await createDatabaseProject(env, { accountId: account.account_id, userId: user.id, name: 'Delete journey' });
    projectId = project.id;
    await installBrowserSessionDirect(page, session, `/workspaces/${project.id}`, authOptions);
    await selectAccountForUi(page, account.account_id);
    await page.goto(`/workspaces/${project.id}`);
    await dismissOnboarding(page);
    await expect.poll(async () => (await page.context().cookies()).find((cookie) => cookie.name === 'kortix_last_project')?.value)
      .toBe(encodeURIComponent(`${user.id}:${project.id}`));
    // Leaving flushes the device cache, just as a CLI delete outside the page does.
    await page.goto('/workspaces');
    await api(session.access_token, 'DELETE', `/projects/${project.id}`);
    await api(session.access_token, 'GET', `/projects/${project.id}`, undefined, 404);
    // K2: the workspace is closed, not gone, for its owner until it is erased.
    // The owner's canonical read serves it as `deleting`; the shell opens
    // nothing on it and offers Restore, on every visit.
    const served = await api(session.access_token, 'GET', `/workspaces/${project.id}`);
    expect((served as { state?: string }).state).toBe('deleting');
    for (let visit = 0; visit < 2; visit++) {
      await page.goto(`/workspaces/${project.id}`);
      await expect(page.getByRole('heading', { name: 'Delete journey is being deleted.' })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/workspaces/${project.id}$`));
      await expect(page.getByRole('button', { name: 'Restore workspace' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Back to workspaces' })).toBeVisible();
      await expect.poll(async () => (await page.context().cookies()).find((cookie) => cookie.name === 'kortix_last_project')?.value)
        .not.toBe(encodeURIComponent(`${user.id}:${project.id}`));
    }
  } finally {
    if (projectId) await deleteDatabaseProject(env, projectId);
    await deleteAuthUser(user.id, authOptions);
  }
});
