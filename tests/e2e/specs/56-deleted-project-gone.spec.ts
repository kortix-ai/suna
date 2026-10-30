import { expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';
import { createApiJsonClient } from '../helpers/http';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

// KRTX-2760: a cached shell must not navigate away when its detail refetch 404s.
test('56 — a deleted remembered project shows the gone page on every visit @local-only', async ({ page }) => {
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
    const accounts = await api<Array<{ account_id: string; personal_account?: boolean; is_primary_owner?: boolean }>>(
      session.access_token, 'GET', '/accounts',
    );
    const account = accounts.find((entry) => entry.personal_account || entry.is_primary_owner);
    if (!account) throw new Error('Synthetic owner has no account');
    const project = await createDatabaseProject(env, { accountId: account.account_id, userId: user.id, name: 'Delete journey' });
    projectId = project.id;
    await installBrowserSessionDirect(page, session, `/projects/${project.id}`, authOptions);
    await selectAccountForUi(page, account.account_id);
    await page.goto(`/projects/${project.id}`);
    await dismissOnboarding(page);
    await expect.poll(async () => (await page.context().cookies()).find((cookie) => cookie.name === 'kortix_last_project')?.value)
      .toBe(encodeURIComponent(`${user.id}:${project.id}`));
    // Leaving flushes the device cache, just as a CLI delete outside the page does.
    await page.goto('/projects');
    await api(session.access_token, 'DELETE', `/projects/${project.id}`);
    await api(session.access_token, 'GET', `/projects/${project.id}`, undefined, 404);
    // Reproduce the race: the shell detail returns before the access boundary's
    // bare-project refetch. Responses remain real; only their order is controlled.
    await page.route(`**/v1/projects/${project.id}`, async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      await route.fulfill({ response });
    });
    for (let visit = 0; visit < 2; visit++) {
      await page.goto(`/projects/${project.id}`);
      await expect(page.getByRole('heading', { name: 'This project is gone.' })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
      await expect(page.getByRole('link', { name: 'Back to projects' })).toBeVisible();
      await expect.poll(async () => (await page.context().cookies()).find((cookie) => cookie.name === 'kortix_last_project')?.value)
        .not.toBe(encodeURIComponent(`${user.id}:${project.id}`));
    }
  } finally {
    if (projectId) await deleteDatabaseProject(env, projectId);
    await deleteAuthUser(user.id, authOptions);
  }
});
