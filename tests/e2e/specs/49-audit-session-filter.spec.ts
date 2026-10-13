import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import {
  createDatabaseProject,
  createDatabaseSession,
  deleteDatabaseProject,
  setDatabaseEnterpriseDemo,
} from '../../src/fixtures/database-project';
import { resolvePersonalAccountId } from '../helpers/accounts';
import { runDatabaseSql } from '../helpers/database';
import { createApiResultClient } from '../helpers/http';
import { isDeployedTarget } from '../helpers/manifest-project';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

/**
 * KRTX-1727: the audit log's Session filter was a Select over the first page
 * (50 rows) of the project's sessions. A session past that page could not be
 * picked, and a session id copied from an event could not be used. The filter
 * now searches the project's sessions on the server and takes a pasted id.
 *
 * Local only: the sessions are written straight into the database.
 */

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
  password: 'E2eAuditSessionFilter123!',
};
const api = createApiResultClient(apiBase);
const OLDER_TITLE = 'Older audited run';
const NEWER_SESSIONS = 60;

test('49 — the audit Session filter finds a session past page one and takes a pasted id', { tag: '@local-only' }, async ({ page }) => {
  test.skip(isDeployedTarget(), 'local stack only: writes sessions straight into the database');
  test.setTimeout(180_000);
  const env = loadEnv();
  if (!env.databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
  const runId = Date.now().toString(36);
  const email = `e2e-audit-session-${runId}@example.test`;
  const user = await createAuthUser(email, authOptions);
  let projectId: string | null = null;

  try {
    const session = await signIn(email, authOptions);
    const accountId = await resolvePersonalAccountId(api, session.access_token);
    // Reading the audit log is an Enterprise entitlement; without it the tab is an upsell.
    await setDatabaseEnterpriseDemo(env, accountId, true);
    const project = await createDatabaseProject(env, { accountId, userId: user.id, name: `Audit sessions ${runId}` });
    projectId = project.id;
    // One session a day old, then 60 newer ones: the old Select listed 50.
    const olderId = await createDatabaseSession(env, {
      projectId,
      accountId,
      userId: user.id,
      metadata: { custom_name: OLDER_TITLE },
    });
    await runDatabaseSql(
      `UPDATE kortix.project_sessions SET updated_at = now() - interval '1 day' WHERE session_id = $1`,
      [olderId],
      env.databaseUrl,
    );
    await runDatabaseSql(
      `INSERT INTO kortix.project_sessions
         (session_id, account_id, project_id, branch_name, created_by, visibility, metadata, initiator_type, initiator_id, updated_at)
       SELECT gen_random_uuid()::text, $1::uuid, $2::uuid, 'session/audit-' || g, $3::uuid,
              'private'::kortix.project_session_visibility, '{}'::jsonb,
              'member'::kortix.project_session_initiator, $3, now() - make_interval(secs => g)
         FROM generate_series(1, $4::int) AS g`,
      [accountId, projectId, user.id, NEWER_SESSIONS],
      env.databaseUrl,
    );
    // An id no session list returns, as a deleted session's would be.
    const pastedId = randomUUID();

    const sessionSearches: URLSearchParams[] = [];
    const auditSessionIds: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/v1/projects/${projectId}/sessions`) sessionSearches.push(url.searchParams);
      if (url.pathname === `/v1/accounts/${accountId}/audit`) {
        auditSessionIds.push(url.searchParams.get('session_id') ?? '');
      }
    });

    await installBrowserSessionDirect(page, session, '/favicon.png', authOptions);
    await selectAccountForUi(page, accountId);
    await page.goto(`/projects/${projectId}?accountId=${accountId}&accountTab=audit`, { waitUntil: 'domcontentloaded' });
    await dismissOnboarding(page);

    const picker = (name: string) => page.getByRole('button', { name, exact: true });
    const searchField = page.getByPlaceholder('Search or paste a session ID');

    await test.step('with no project picked, a pasted session id filters the log', async () => {
      await picker('All sessions').click({ timeout: 60_000 });
      await searchField.fill(pastedId);
      await page.getByRole('option', { name: new RegExp(pastedId) }).click();
      await expect(picker(pastedId)).toBeVisible();
      await expect.poll(() => auditSessionIds.at(-1)).toBe(pastedId);
    });

    await test.step('picking the project clears the session filter', async () => {
      await page.getByRole('combobox').filter({ hasText: 'All projects' }).click();
      await page.getByRole('option', { name: project.name }).click();
      await expect(picker('All sessions')).toBeVisible();
    });

    await test.step('the search finds the session that sits past page one, on the server', async () => {
      await picker('All sessions').click();
      await searchField.fill('Older audited');
      await page.getByRole('option', { name: new RegExp(OLDER_TITLE) }).click();
      await expect(picker(OLDER_TITLE)).toBeVisible();
      await expect.poll(() => auditSessionIds.at(-1)).toBe(olderId);
      const search = sessionSearches.find((params) => params.get('q') === 'Older audited');
      expect(search?.get('scope')).toBe('project');
      expect(search?.get('limit')).toBe('20');
    });
  } finally {
    if (projectId) await deleteDatabaseProject(env, projectId).catch(() => undefined);
    await deleteAuthUser(user.id, authOptions).catch(() => undefined);
  }
});
