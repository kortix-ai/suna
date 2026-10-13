import { expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseSession } from '../../src/fixtures/database-project';
import { runDatabaseSql } from '../helpers/database';
import { createApiJsonClient } from '../helpers/http';
import { type ManifestProject, createManifestProject, isDeployedTarget } from '../helpers/manifest-project';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

/**
 * KRTX-1739: a session whose agent waits on a question reads "Needs you" in
 * the sidebar and on the Sessions page. Before, the lists read only the review
 * inbox, so such a session read its lifecycle word and nobody saw the ask.
 *
 * The lists now fold GET .../approvals/needs-input (open agent questions and
 * connector approvals) into each row's status. Once the question closes, the
 * row reads its lifecycle word again.
 *
 * Local only: the stored question is written straight into the database.
 */

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
  password: 'E2eNeedsYouQuestion123!',
};
const api = createApiJsonClient(apiBase);
const ASKING = 'Deploy the billing service';
const QUIET = 'Rename the settings page';

test('49 — a session whose agent waits on a question reads Needs you', { tag: '@local-only' }, async ({ page }) => {
  test.skip(isDeployedTarget(), 'local stack only: writes the stored question into the database');
  test.setTimeout(180_000);
  const env = loadEnv();
  if (!env.databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
  const email = `e2e-needs-you-${Date.now().toString(36)}@example.test`;
  const user = await createAuthUser(email, authOptions);
  let project: ManifestProject | undefined;

  try {
    const auth = await signIn(email, authOptions);
    const accounts = await api<{ account_id: string; personal_account?: boolean }[]>(
      auth.access_token,
      'GET',
      '/accounts',
    );
    const accountId = (accounts.find((a) => a.personal_account) ?? accounts[0]).account_id;
    project = await createManifestProject({
      api,
      accessToken: auth.access_token,
      accountId,
      userId: user.id,
      name: `Needs you question ${Date.now().toString(36)}`,
      databaseUrl: env.databaseUrl,
    });
    const projectId = project.id;
    const asking = await createDatabaseSession(env, { projectId, accountId, userId: user.id });
    const quiet = await createDatabaseSession(env, { projectId, accountId, userId: user.id });
    await api(auth.access_token, 'PATCH', `/projects/${projectId}/sessions/${asking}`, { name: ASKING });
    await api(auth.access_token, 'PATCH', `/projects/${projectId}/sessions/${quiet}`, { name: QUIET });
    // What POST /turn-question stores when the agent asks.
    await runDatabaseSql(
      `INSERT INTO kortix.session_pending_questions (account_id, project_id, session_id, request_id, questions)
       VALUES ($1::uuid, $2::uuid, $3, 'que_e2e_49', $4::jsonb)`,
      [
        accountId,
        projectId,
        asking,
        JSON.stringify([{ question: 'Which region?', header: 'Region', options: [], multiple: false, custom: true }]),
      ],
      env.databaseUrl,
    );

    const needsInputPath = `/v1/projects/${projectId}/approvals/needs-input`;
    const needsInputRead = () =>
      page.waitForResponse((response) => new URL(response.url()).pathname === needsInputPath && response.ok());
    const firstNeedsInput = needsInputRead();
    await installBrowserSessionDirect(page, auth, `/projects/${projectId}`, authOptions);
    await selectAccountForUi(page, accountId);
    await dismissOnboarding(page);
    const rowLink = (sessionId: string) => page.locator(`a[href$="/sessions/${sessionId}"]`).first();
    // A Sessions page row's disclosure trigger ("Show details for <title>") holds
    // the status tile, labelled with the status word.
    const sessionsPageRow = (title: string) => page.locator(`[aria-label="Show details for ${title}"]`);
    const sessionsPageTile = (title: string) => sessionsPageRow(title).locator('[aria-label="Needs you"]');

    await test.step('GET needs-input lists the session, and its sidebar row reads Needs you', async () => {
      const body = (await (await firstNeedsInput).json()) as { sessions: Record<string, number> };
      expect(body.sessions[asking]).toBe(1);
      expect(body.sessions[quiet]).toBeUndefined();
      await expect(rowLink(asking)).toHaveAccessibleDescription(/Needs you/, { timeout: 30_000 });
      await expect(rowLink(quiet)).not.toHaveAccessibleDescription(/Needs you/);
    });

    await test.step('the Sessions page row of that session reads Needs you, and only that row', async () => {
      await page.goto(`/projects/${projectId}/sessions`, { waitUntil: 'domcontentloaded' });
      await expect(sessionsPageRow(ASKING)).toBeVisible({ timeout: 60_000 });
      await expect(sessionsPageRow(QUIET)).toBeVisible();
      await expect(sessionsPageTile(ASKING)).toBeVisible({ timeout: 30_000 });
      await expect(sessionsPageTile(QUIET)).toHaveCount(0);
    });

    await test.step('once the question closes, neither list reads Needs you', async () => {
      await runDatabaseSql(
        `UPDATE kortix.session_pending_questions SET answered_at = now() WHERE session_id = $1`,
        [asking],
        env.databaseUrl,
      );
      const afterClose = needsInputRead();
      await page.reload({ waitUntil: 'domcontentloaded' });
      const body = (await (await afterClose).json()) as { sessions: Record<string, number> };
      expect(body.sessions[asking]).toBeUndefined();
      await expect(sessionsPageRow(ASKING)).toBeVisible({ timeout: 60_000 });
      await expect(sessionsPageTile(ASKING)).toHaveCount(0, { timeout: 30_000 });
      await expect(rowLink(asking)).not.toHaveAccessibleDescription(/Needs you/, { timeout: 30_000 });
    });
  } finally {
    await project?.dispose().catch(() => undefined);
    await deleteAuthUser(user.id, authOptions).catch(() => undefined);
  }
});
