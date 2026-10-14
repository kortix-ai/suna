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

      // KRTX-2316: the always-mounted sidebar polls the needs-you counts, never
      // the inbox list or the whole change-request history. The one list read
      // allowed is the shell's idle prefetch of the Review tab's first page.
      const reads: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.includes(`/projects/${project.id}/`)) reads.push(url.pathname + url.search);
      });
      const summaryRead = page.waitForResponse(
        (response) => response.url().includes(`/projects/${project.id}/review/summary`),
        { timeout: 60_000 },
      );
      await page.goto(`/projects/${project.id}`, { waitUntil: 'domcontentloaded' });
      await dismissOnboarding(page);
      const summary = await (await summaryRead).json();
      expect(summary).toEqual({ needs_you_total: 1, needs_you_by_session: {} });
      await expect(page.getByRole('link', { name: /Review\s*1/ })).toBeVisible({ timeout: 60_000 });
      const listReads = reads.filter((read) => read.includes('/review/items'));
      expect(listReads.length).toBeLessThanOrEqual(1);
      for (const read of listReads) expect(read).toContain('segment=needs_you');
      expect(reads.filter((read) => read.includes('/change-requests') && read.includes('status=all'))).toEqual([]);

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

  // KRTX-2316: the inbox reads one page of 50 per segment. A segment with more
  // items offers Load more, which reads the next page by its cursor.
  test('a segment past one page shows 50 items, and Load more reads the rest', async ({ page }) => {
    test.skip(!databaseUrl, 'KE2E_DATABASE_URL is required');
    test.setTimeout(180_000);

    const runId = Date.now().toString(36);
    const email = `e2e-review-pages-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    const env = loadEnv();
    let projectId: string | null = null;
    const ITEMS = 55;

    try {
      const accounts = await api<AccountSummary[]>(session.access_token, 'GET', '/accounts');
      const account = accounts.find(
        (item) => item.personal_account || item.is_primary_owner || item.account_role === 'owner',
      );
      if (!account) throw new Error('test user has no personal account');
      const project = await createDatabaseProject(env, {
        accountId: account.account_id,
        userId: user.id,
        name: `Review pages ${runId}`,
      });
      projectId = project.id;

      const titlePrefix = `Inbox page item ${runId}`;
      for (let i = 0; i < ITEMS; i += 1) {
        await api(
          session.access_token,
          'POST',
          `/projects/${project.id}/review/items`,
          { kind: 'output', title: `${titlePrefix} ${String(i).padStart(2, '0')}`, summary: 'Paged', agent: 'Kortix' },
          201,
        );
      }

      await installBrowserSessionDirect(page, session, '/favicon.png', authOptions);
      await selectAccountForUi(page, account.account_id);
      const itemReads: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname === `/v1/projects/${project.id}/review/items`) itemReads.push(url.search);
      });

      await page.goto(`/projects/${project.id}/review`, { waitUntil: 'domcontentloaded' });
      await dismissOnboarding(page);
      const main = page.getByRole('main');
      const rows = main.getByRole('button', { name: new RegExp(`^${titlePrefix} `) });

      await test.step('the first page shows 50 of the 55 items and offers Load more', async () => {
        await expect(rows).toHaveCount(50, { timeout: 60_000 });
        await expect(main.getByRole('button', { name: 'Load more' })).toBeVisible();
        expect(itemReads.every((search) => !search.includes('cursor='))).toBe(true);
      });

      await test.step('Load more reads the next page by its cursor and shows all 55', async () => {
        await main.getByRole('button', { name: 'Load more' }).click();
        await expect(rows).toHaveCount(ITEMS, { timeout: 30_000 });
        expect(itemReads.some((search) => search.includes('cursor='))).toBe(true);
        await expect(main.getByRole('button', { name: 'Load more' })).toHaveCount(0);
      });
    } finally {
      if (projectId) await deleteDatabaseProject(env, projectId).catch(() => {});
      await deleteAuthUser(user.id, authOptions).catch(() => {});
    }
  });
});
