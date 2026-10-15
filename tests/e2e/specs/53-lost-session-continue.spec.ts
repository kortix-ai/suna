import { type Page, expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseSession } from '../../src/fixtures/database-project';
import { seedSessionTranscript } from '../../src/fixtures/session-transcript';
import { queryDatabaseRows, runDatabaseSql } from '../helpers/database';
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
 * KRTX-2419: a lost session (the provider removed its computer) with a saved
 * conversation offers Continue beside Delete. Continue sends `POST …/recover`;
 * the server retires the lost row so the next `/start` boots a new computer
 * that restores the conversation, and the page leaves the lost banner for the
 * boot loader. A refusal keeps the banner and names the reason. `/start` is
 * stubbed: the local profile boots no box.
 */

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
  password: 'E2eLostSession123!',
};
const api = createApiJsonClient(apiBase);
const SAVED_REPLY = 'This reply is stored in the database.';

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
}

/** Open the session page with `/start` answering lost until a recover succeeds. */
async function openLostSession(page: Page, projectId: string, sessionId: string) {
  let recovered = false;
  page.on('response', (response) => {
    if (response.request().method() === 'POST' && response.url().endsWith(`/sessions/${sessionId}/recover`) && response.status() === 200) {
      recovered = true;
    }
  });
  await page.route(`**/sessions/${sessionId}/start*`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 200,
      json: recovered
        ? { stage: 'provisioning', retriable: true, sandbox: null, runtime_session_id: null, opencode_session_id: null, reason: null }
        : {
            stage: 'failed',
            agent_name: 'kortix',
            retriable: false,
            reason: 'runtime_identity_unavailable',
            sandbox: {
              sandbox_id: sessionId,
              status: 'stopped',
              provider: 'daytona',
              external_id: sessionId,
              metadata: { runtimeIdentityState: 'unavailable' },
            },
            opencode_session_id: `ses_${sessionId.replaceAll('-', '')}`,
            failure: null,
          },
    });
  });
  await page.goto(`/projects/${projectId}/sessions/${sessionId}`, { waitUntil: 'commit' });
  await dismissOnboarding(page);
  await expect(page.getByText(SAVED_REPLY, { exact: true })).toBeVisible({ timeout: 120_000 });
}

test('53 — a lost session with a saved conversation continues on a new computer', async ({ page }) => {
  test.setTimeout(300_000);
  const env = loadEnv();
  if (!env.databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
  const runId = Date.now().toString(36);
  const email = `e2e-lost-session-${runId}@example.test`;
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
      name: `Lost session ${runId}`,
      databaseUrl: env.databaseUrl,
    });
    const projectId = project.id;
    /** A session whose computer the provider lost, with its saved conversation. */
    const lostSession = async (confirmed: boolean) => {
      const sessionId = await createDatabaseSession(env, { projectId, accountId, userId: user.id });
      await seedSessionTranscript(env, { projectId, accountId, sessionId });
      await runDatabaseSql(
        `UPDATE kortix.session_sandboxes SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'runtimeIdentityState', 'unavailable', 'preservedExternalId', external_id)
           || CASE WHEN $2 THEN jsonb_build_object('providerRemovedAt', now()::text) ELSE '{}'::jsonb END
         WHERE session_id = $1`,
        [sessionId, confirmed],
        env.databaseUrl,
      );
      return sessionId;
    };
    const pendingId = await lostSession(false);
    const lostId = await lostSession(true);

    await page.addInitScript(() => localStorage.setItem('kortix:marko-welcome-dismissed', '1'));
    await installBrowserSessionDirect(page, auth, `/projects/${projectId}`, authOptions);
    await selectAccountForUi(page, accountId);

    await test.step('a refused Continue keeps the lost banner and names the reason', async () => {
      await openLostSession(page, projectId, pendingId);
      await expect(page.getByText("This session's computer was lost", { exact: true })).toBeVisible({ timeout: 60_000 });
      const sent = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/sessions/${pendingId}/recover`));
      await page.getByRole('button', { name: 'Continue session', exact: true }).click();
      expect((await sent).status()).toBe(409);
      await expect(page.getByText('The lost computer is still being removed. Try again in a minute.').first()).toBeVisible();
      await expect(page.getByText("This session's computer was lost", { exact: true })).toBeVisible();
      const [row] = await queryDatabaseRows<{ external_id: string | null }>(
        'SELECT external_id FROM kortix.session_sandboxes WHERE session_id = $1',
        [pendingId],
        env.databaseUrl,
      );
      expect(row?.external_id).toBe(pendingId);
    });

    await test.step('the lost banner offers Continue and Delete; Continue sends POST /recover and the page boots a new computer', async () => {
      await openLostSession(page, projectId, lostId);
      const title = page.getByText("This session's computer was lost", { exact: true });
      await expect(title).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('button', { name: 'Delete session', exact: true })).toBeVisible();
      const sent = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/sessions/${lostId}/recover`));
      await page.getByRole('button', { name: 'Continue session', exact: true }).click();
      const request = await sent;
      expect((await request.response())?.status()).toBe(200);
      await expect(title).toHaveCount(0, { timeout: 30_000 });
      const [row] = await queryDatabaseRows<{ external_id: string | null; retired: string | null; recovered: string | null }>(
        `SELECT s.external_id, s.metadata->>'ephemeralRetiredExternalId' AS retired, p.metadata->>'lostRecoveredAt' AS recovered
           FROM kortix.session_sandboxes s JOIN kortix.project_sessions p USING (session_id) WHERE s.session_id = $1`,
        [lostId],
        env.databaseUrl,
      );
      expect(row).toMatchObject({ external_id: null, retired: lostId });
      expect(row?.recovered).toBeTruthy();
    });
  } finally {
    await project?.dispose().catch(() => undefined);
    await deleteAuthUser(user.id, authOptions).catch(() => undefined);
  }
});
