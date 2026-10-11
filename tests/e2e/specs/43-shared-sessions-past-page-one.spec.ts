import { expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseSession } from '../../src/fixtures/database-project';
import { runDatabaseSql } from '../helpers/database';
import { createApiJsonClient } from '../helpers/http';
import { type ManifestProject, createManifestProject, isDeployedTarget } from '../helpers/manifest-project';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

/**
 * KRTX-1727: the session list drops rows the viewer may not see after a
 * bounded scan, so a page can be empty and still carry a cursor. The sidebar
 * hid its Shared section on an empty first page. Here a teammate started 600
 * private sessions after sharing one with the project: the Shared section must
 * still list the shared one.
 *
 * Local only: the 600 sessions are written straight into the database.
 */

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
  password: 'E2eSharedPastPageOne123!',
};
const api = createApiJsonClient(apiBase);
const SHARED_TITLE = 'Older shared plan';
const PRIVATE_SESSIONS = 600;

test('43 — the Shared section lists a session that sits past page one', async ({ page }) => {
  test.skip(isDeployedTarget(), 'local stack only: writes sessions straight into the database');
  test.setTimeout(180_000);
  const env = loadEnv();
  if (!env.databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
  const runId = Date.now().toString(36);
  const emails = {
    owner: `e2e-shared-owner-${runId}@example.test`,
    author: `e2e-shared-author-${runId}@example.test`,
    viewer: `e2e-shared-viewer-${runId}@example.test`,
  };
  const owner = await createAuthUser(emails.owner, authOptions);
  const author = await createAuthUser(emails.author, authOptions);
  const viewer = await createAuthUser(emails.viewer, authOptions);
  let project: ManifestProject | undefined;

  try {
    const ownerAuth = await signIn(emails.owner, authOptions);
    const accounts = await api<{ account_id: string; personal_account?: boolean }[]>(
      ownerAuth.access_token,
      'GET',
      '/accounts',
    );
    const accountId = (accounts.find((a) => a.personal_account) ?? accounts[0]).account_id;
    project = await createManifestProject({
      api,
      accessToken: ownerAuth.access_token,
      accountId,
      userId: owner.id,
      name: `Shared past page one ${runId}`,
      databaseUrl: env.databaseUrl,
    });
    const projectId = project.id;
    for (const [email, user] of [
      [emails.author, author],
      [emails.viewer, viewer],
    ] as const) {
      await api(ownerAuth.access_token, 'POST', `/accounts/${accountId}/members`, { email, role: 'member' }, 201);
      await api(ownerAuth.access_token, 'PUT', `/projects/${projectId}/access/${user.id}`, { role: 'member' });
    }

    // The author shared one session with the project a day ago...
    const sharedId = await createDatabaseSession(env, {
      projectId,
      accountId,
      userId: author.id,
      visibility: 'project',
    });
    const authorAuth = await signIn(emails.author, authOptions);
    await api(authorAuth.access_token, 'PATCH', `/projects/${projectId}/sessions/${sharedId}`, { name: SHARED_TITLE });
    await runDatabaseSql(
      `UPDATE kortix.project_sessions SET updated_at = now() - interval '1 day' WHERE session_id = $1`,
      [sharedId],
      env.databaseUrl,
    );
    // ...then started 600 private ones. The viewer can see none of them, and
    // every one sorts before the shared session.
    await runDatabaseSql(
      `INSERT INTO kortix.project_sessions
         (session_id, account_id, project_id, branch_name, created_by, visibility, metadata, initiator_type, initiator_id, updated_at)
       SELECT gen_random_uuid()::text, $1::uuid, $2::uuid, 'session/bulk-' || g, $3::uuid,
              'private'::kortix.project_session_visibility, '{}'::jsonb,
              'member'::kortix.project_session_initiator, $3, now() - make_interval(secs => g)
         FROM generate_series(1, $4::int) AS g`,
      [accountId, projectId, author.id, PRIVATE_SESSIONS],
      env.databaseUrl,
    );

    const sharedPages: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/v1/projects/${projectId}/sessions` && url.searchParams.get('started_by') === 'others') {
        sharedPages.push(url.searchParams.get('cursor') ?? 'first');
      }
    });

    const viewerAuth = await signIn(emails.viewer, authOptions);
    await installBrowserSessionDirect(page, viewerAuth, `/projects/${projectId}`, authOptions);
    await selectAccountForUi(page, accountId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await dismissOnboarding(page);

    await test.step('the Shared section is there, and lists the shared session', async () => {
      const section = page.getByRole('button', { name: 'Shared', exact: true });
      await expect(section).toBeVisible({ timeout: 60_000 });
      await section.click();
      await expect(page.getByText(SHARED_TITLE, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    });

    await test.step('the list read past the empty first page on its own', async () => {
      expect(sharedPages[0]).toBe('first');
      expect(sharedPages.some((cursor) => cursor !== 'first')).toBe(true);
    });
  } finally {
    await project?.dispose().catch(() => undefined);
    for (const user of [viewer, author, owner]) await deleteAuthUser(user.id, authOptions).catch(() => undefined);
  }
});
