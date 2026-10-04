import { expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';
import { createApiJsonClient } from '../helpers/http';
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const databaseUrl = process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const password = 'E2eReviewRisk123!';
const authOptions = { supabaseUrl, password };
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role: string;
}

// KRTX-603: a workspace member called the "Medium risk" / "High risk" chips
// noise. The item keeps its `risk` field (bulk approve still skips risky
// actions); the Review Center just never prints it.
test.describe('35 — Review Center shows no risk label', () => {
  test('a high-risk item renders in the list and detail without a risk label', async ({
    page,
  }) => {
    test.skip(!databaseUrl, 'KE2E_DATABASE_URL is required');
    test.setTimeout(120_000);

    const runId = Date.now().toString(36);
    const email = `e2e-review-risk-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    const env = loadEnv();
    let projectId: string | null = null;

    try {
      const accounts = await api<AccountSummary[]>(session.access_token, 'GET', '/accounts');
      const account = accounts.find(
        (item) => item.personal_account || item.is_primary_owner || item.account_role === 'owner',
      );
      if (!account) throw new Error('test user has no personal account');

      const project = await createDatabaseProject(env, {
        accountId: account.account_id,
        userId: user.id,
        name: `Review risk ${runId}`,
      });
      projectId = project.id;

      const title = `Ship the report ${runId}`;
      const item = await api<{ risk: string }>(
        session.access_token,
        'POST',
        `/projects/${project.id}/review/items`,
        { kind: 'output', title, summary: 'Quarterly numbers', risk: 'high', agent: 'Kortix' },
        201,
      );
      expect(item.risk).toBe('high');

      await installBrowserSessionDirect(page, session, '/favicon.png', authOptions);
      await selectAccountForUi(page, account.account_id);
      await page.goto(`/projects/${project.id}/review`, { waitUntil: 'domcontentloaded' });
      await dismissOnboarding(page);

      const main = page.getByRole('main');
      const row = main.getByRole('button', { name: new RegExp(`^${title}`) });
      await expect(row).toBeVisible({ timeout: 60_000 });
      await expect(main.getByText(/\b(low|medium|high) risk\b/i)).toHaveCount(0);

      await row.click();
      await expect(main.getByRole('heading', { name: title })).toBeVisible();
      await expect(main.getByText(/\b(low|medium|high) risk\b/i)).toHaveCount(0);
    } finally {
      if (projectId) await deleteDatabaseProject(env, projectId).catch(() => {});
      await deleteAuthUser(user.id, authOptions).catch(() => {});
    }
  });
});
