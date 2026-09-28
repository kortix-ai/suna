import { expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import {
  configurePreviousRepositorySession,
  createDatabaseSession,
} from '../../src/fixtures/database-project';
import { seedSessionTranscript } from '../../src/fixtures/session-transcript';
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

/**
 * A session created before a repository replacement is an ORDINARY session.
 * It starts, it receives the project's current config release, built from the
 * current repository's tip, and it converges. The API refuses nothing for it,
 * and the route has no compatibility mode to flip into.
 *
 * One thing about it is still true, and it is physical: the clone on its disk
 * came from the old repository. A push without a rebase can therefore carry
 * unrelated history, and the Git proxy refuses the new repository's objects to
 * this session's token. The header notice says exactly that, and "Update to
 * latest" hands the rebase prompt to the agent
 * (apps/web/src/features/session/previous-repository-session.tsx).
 *
 * This journey proves the browser half: the session opens with its transcript,
 * the notice renders, the update prompt reaches the chat, and the dismissal is
 * per viewer. The API half belongs to the REST flows.
 */

const api = createApiJsonClient(process.env.E2E_API_URL ?? 'http://localhost:8008/v1');
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321',
  password: 'PreviousRepository123!',
};

test('31 — a previous-repository session opens and sends the update prompt', async ({
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
    // The project carries `generation-current`, the session `generation-previous`.
    // `preserveRuntime` leaves the session's old sandbox row behind in `error`,
    // which is what a stopped previous-repository session looks like in the
    // database. That row must not turn the surface into a failure card.
    await configurePreviousRepositorySession(env, {
      projectId: project.id,
      sessionId,
      accountId,
      preserveRuntime: true,
    });
    const transcript = await seedSessionTranscript(env, {
      projectId: project.id,
      accountId,
      sessionId,
      ensureSandbox: false,
    });
    await api(auth.access_token, 'PATCH', `/projects/${project.id}/features`, {
      feature: 'session_transcript_history',
      enabled: true,
    });

    const route = `/projects/${project.id}/sessions/${sessionId}`;
    await installBrowserSessionDirect(page, auth, route, authOptions);
    await selectAccountForUi(page, accountId);
    await dismissOnboarding(page);

    // The local profile provisions no sandbox, so this journey answers `/start`
    // itself. The answer is the ordinary readiness payload: `/start` no longer
    // refuses a session created before a repository replacement. Every query is
    // recorded, to read back what the UI asked for.
    let startRequests = 0;
    const repositoryModes: Array<string | null> = [];
    await page.route(`**/sessions/${sessionId}/start*`, async (requestRoute) => {
      const url = new URL(requestRoute.request().url());
      startRequests += 1;
      repositoryModes.push(url.searchParams.get('repository_mode'));
      await requestRoute.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          stage: 'starting',
          agent_name: 'default',
          retriable: true,
          sandbox: null,
          opencode_session_id: transcript.root,
          runtime_transport: 'rest',
        }),
      });
    });

    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await dismissWelcomeCard(page);
    await expect.poll(() => startRequests).toBeGreaterThan(0);
    // The UI sends no `repository_mode`. The parameter is telemetry on the API
    // (apps/api/src/projects/routes/r8.ts) and nothing else: it is no longer a
    // recovery path, because `/start` has no refusal left to recover from.
    expect(repositoryModes).toEqual([null]);
    await expect(page.getByText('Show my saved conversation.', { exact: true })).toBeVisible();
    await expect(
      page.getByText('This reply is stored in the database.', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'The project changed after this session started. Update it to keep working on the latest version.',
        { exact: true },
      ),
    ).toBeVisible();
    const notice = page.getByRole('status', { name: 'This session is out of date' });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('button', { name: 'Update to latest' })).toBeEnabled();
    await expect(notice.getByRole('button', { name: 'Dismiss' })).toBeVisible();
    // Exactly two controls. The notice offers no recovery path, because the
    // session needs none: the buttons that resumed a frozen workspace or
    // started a replacement session are gone with the policy that needed them.
    await expect(notice.getByRole('button')).toHaveCount(2);
    // The session paints its chat, not the provider-failure card.
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy prompt' })).toHaveCount(0);

    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('previous-repository-session.png'),
      fullPage: true,
    });

    await page.setViewportSize({ width: 720, height: 480 });
    await expect(page.getByText('Show my saved conversation.', { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        'The project changed after this session started. Update it to keep working on the latest version.',
        { exact: true },
      ),
    ).toBeVisible();
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('previous-repository-session-720x480.png'),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expect(page.getByText('Show my saved conversation.', { exact: true })).toBeVisible();
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('previous-repository-session-dark-720x480.png'),
      fullPage: true,
    });

    // The X hides the notice for this viewer, and the dismissal survives a reload.
    await notice.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice).toHaveCount(0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Show my saved conversation.', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('status', { name: 'This session is out of date' }),
    ).toHaveCount(0);

    // "Update to latest" hands the repository-update prompt to this session's chat.
    await page.evaluate(() => {
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith('kortix:previous-repository-notice-dismissed:')) {
          window.localStorage.removeItem(key);
        }
      }
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const reshown = page.getByRole('status', { name: 'This session is out of date' });
    await expect(reshown).toBeVisible();
    await reshown.getByRole('button', { name: 'Update to latest' }).click();
    await expect(page.getByText('Update started in this session', { exact: true })).toBeVisible();
    await expect(reshown).toHaveCount(0);
    await expect(
      page.getByText("This project's repository was replaced.", { exact: false }).first(),
    ).toBeVisible();
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('previous-repository-session-update-sent.png'),
    });
  } finally {
    await project?.dispose();
    await deleteAuthUser(owner.id, authOptions);
  }
});
