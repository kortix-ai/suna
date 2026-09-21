import { expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import {
  configurePreviousRepositorySession,
  createDatabaseSession,
} from '../../src/fixtures/database-project';
import { createApiJsonClient } from '../helpers/http';
import {
  type ManifestProject,
  createManifestProject,
  fundAccount,
} from '../helpers/manifest-project';
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import { dismissOnboarding, dismissWelcomeCard, selectAccountForUi } from '../helpers/ui';

const api = createApiJsonClient(process.env.E2E_API_URL ?? 'http://localhost:8008/v1');
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321',
  password: 'PreviousRepository123!',
};

test('31 — previous repository session offers one explicit preserved-workspace bypass', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const env = loadEnv();
  if (!env.databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
  const email = `previous-repository-${Date.now()}@example.test`;
  const owner = await createAuthUser(email, authOptions);
  const auth = await signIn(email, authOptions);
  let project: ManifestProject | undefined;

  try {
    const accounts = await api<Array<{ account_id: string; personal_account?: boolean }>>(
      auth.access_token,
      'GET',
      '/accounts',
    );
    const accountId = (accounts.find((account) => account.personal_account) ?? accounts[0])
      ?.account_id;
    if (!accountId) throw new Error('owner has no account');

    await fundAccount(env.databaseUrl, accountId);
    project = await createManifestProject({
      api,
      accessToken: auth.access_token,
      databaseUrl: env.databaseUrl,
      accountId,
      userId: owner.id,
      name: 'Previous repository browser test',
    });
    const sessionId = await createDatabaseSession(env, {
      projectId: project.id,
      accountId,
      userId: owner.id,
    });
    await configurePreviousRepositorySession(env, {
      projectId: project.id,
      sessionId,
      accountId,
      preserveRuntime: true,
    });

    const route = `/projects/${project.id}/sessions/${sessionId}`;
    await installBrowserSessionDirect(page, auth, route, authOptions);
    await selectAccountForUi(page, accountId);
    await dismissOnboarding(page);

    let previousModeRequests = 0;
    await page.route(`**/sessions/${sessionId}/start*`, async (requestRoute) => {
      const url = new URL(requestRoute.request().url());
      if (url.searchParams.get('repository_mode') !== 'previous') {
        await requestRoute.continue();
        return;
      }
      previousModeRequests += 1;
      await requestRoute.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          stage: 'starting',
          agent_name: 'default',
          retriable: true,
          sandbox: null,
          opencode_session_id: null,
          runtime_transport: 'rest',
        }),
      });
    });

    await page.goto(route, { waitUntil: 'domcontentloaded' });
    const previousRepositoryTitle = page.getByText('Session uses previous repository', {
      exact: true,
    });
    await expect(previousRepositoryTitle).toBeVisible();
    await dismissWelcomeCard(page);
    await expect(
      page.getByText(
        'This session keeps its previous workspace. You can resume it, but Git fetch, push, and change requests stay disabled.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume previous workspace' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Start new session' })).toHaveAttribute(
      'href',
      `/projects/${project.id}`,
    );
    await expect(page.getByRole('button', { name: 'Delete session' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy prompt' })).toHaveCount(0);

    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('previous-repository-session.png'),
      fullPage: true,
    });

    await page.setViewportSize({ width: 720, height: 480 });
    await expect(previousRepositoryTitle).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume previous workspace' })).toBeVisible();
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('previous-repository-session-720x480.png'),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expect(previousRepositoryTitle).toBeVisible();
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('previous-repository-session-dark-720x480.png'),
      fullPage: true,
    });

    await page.getByRole('button', { name: 'Resume previous workspace' }).click();
    await expect.poll(() => previousModeRequests).toBeGreaterThan(0);
    await expect(previousRepositoryTitle).toHaveCount(0);
  } finally {
    await project?.dispose();
    await deleteAuthUser(owner.id, authOptions);
  }
});
