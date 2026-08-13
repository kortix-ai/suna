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
import {
  dismissOnboarding,
  featureFlagRow,
  selectAccountForUi,
  settingsPanel,
} from '../helpers/ui';

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const databaseUrl = process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const password = 'E2eAppsUi123!';
const authOptions = { supabaseUrl, password };
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role: string;
}

interface AppResponse {
  app_id: string;
  name: string;
  slug: string;
  url: string;
  desired_state: string;
}

test.describe('18 — Kortix Apps UI', () => {
  test('shows experimental Apps, enables it in place, and renders a read-only deployment index', async ({
    context,
    page,
  }, testInfo) => {
    test.skip(!databaseUrl, 'KE2E_DATABASE_URL is required');
    test.setTimeout(180_000);

    const runId = Date.now().toString(36);
    const email = `e2e-apps-ui-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    const env = loadEnv();
    let projectId: string | null = null;
    const pageErrors: string[] = [];
    const appsServerErrors: string[] = [];
    const appsCreateRequests: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (response) => {
      if (
        response.status() >= 500 &&
        response.url().includes('/v1/projects/') &&
        response.url().includes('/apps')
      ) {
        appsServerErrors.push(
          `${response.status()} ${response.request().method()} ${response.url()}`,
        );
      }
    });
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith(`/v1/projects/${projectId}/apps`)) {
        appsCreateRequests.push(request.url());
      }
    });

    try {
      const accounts = await api<AccountSummary[]>(session.access_token, 'GET', '/accounts');
      const account = accounts.find(
        (item) => item.personal_account || item.is_primary_owner || item.account_role === 'owner',
      );
      expect(account).toBeTruthy();
      if (!account) throw new Error('test user has no personal account');

      const project = await createDatabaseProject(env, {
        accountId: account.account_id,
        userId: user.id,
        name: `Apps UI ${runId}`,
        appsEnabled: false,
      });
      projectId = project.id;

      await api<Record<string, unknown>>(
        session.access_token,
        'POST',
        `/projects/${project.id}/apps`,
        { slug: `blocked-${runId}`, name: 'Blocked App' },
        403,
      );
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await installBrowserSessionDirect(page, session, '/favicon.png', authOptions);
      await selectAccountForUi(page, account.account_id);

      const disabledAppRequests: string[] = [];
      const recordDisabledRequest = (request: {
        method(): string;
        url(): string;
      }) => {
        if (
          request.method() === 'GET' &&
          request.url().endsWith(`/v1/projects/${project.id}/apps`)
        ) {
          disabledAppRequests.push(request.url());
        }
      };
      page.on('request', recordDisabledRequest);
      await page.goto(`/projects/${project.id}/apps`, {
        waitUntil: 'domcontentloaded',
      });
      await dismissOnboarding(page);
      await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible();
      await expect(page.getByRole('main').getByText('Experimental', { exact: true })).toBeVisible();
      // The gate screen never self-enables: it points at Settings →
      // Experimental and there is no Enable button on the feature's own page.
      await expect(page.getByText('is off for this project')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Enable Apps' })).toHaveCount(0);
      expect(disabledAppRequests).toEqual([]);
      page.off('request', recordDisabledRequest);

      // Enable through the flag list — the only activation path. The gate
      // screen's "Feature flags" button opens the settings panel straight on
      // the Experimental tab (`feature-gate-screen.tsx:53`,
      // `openSettings('experimental')`).
      await page.getByRole('button', { name: 'Feature flags' }).click();
      const panel = settingsPanel(page);
      await expect(panel.getByRole('tabpanel', { name: 'Experimental' })).toBeVisible({
        timeout: 30_000,
      });
      const enabledRequest = page.waitForRequest(
        (request) =>
          request.method() === 'PATCH' &&
          request.url().endsWith(`/v1/projects/${project.id}/features`),
      );
      const enabledResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          response.url().endsWith(`/v1/projects/${project.id}/features`),
      );
      // `Apps` is the registry's display name for the flag
      // (apps/api/src/feature-flags/registry.ts:212).
      await featureFlagRow(panel, page, 'Apps').getByRole('switch').click();
      expect((await enabledRequest).postDataJSON()).toEqual({
        feature: 'apps',
        enabled: true,
      });
      expect((await enabledResponse).status()).toBe(200);
      await page.getByRole('button', { name: 'Back to workspace' }).click();
      await page.goto(`/projects/${project.id}/apps`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByText('No Apps deployed', { exact: true })).toBeVisible();

      const seeded = await api<AppResponse>(
        session.access_token,
        'POST',
        `/projects/${project.id}/apps`,
        { slug: `seed-${runId}`, name: 'Seed App' },
        201,
      );
      const seededUrl = new URL(seeded.url);
      if (env.target === 'local') {
        expect(seededUrl.hostname).toMatch(/\.apps\.localhost$/);
      } else {
        const environmentPrefix = env.target === 'prod' ? 'prod' : env.target;
        expect(seededUrl.hostname).toMatch(
          new RegExp(`^${environmentPrefix}-.+\\.apps\\.kortix\\.com$`),
        );
      }

      const listResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          response.url().endsWith(`/v1/projects/${project.id}/apps`),
      );
      await page.goto(`/projects/${project.id}/apps`, {
        waitUntil: 'domcontentloaded',
      });
      expect((await listResponse).status()).toBe(200);

      // First-run onboarding can remount after the feature mutation.
      await dismissOnboarding(page);

      await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible();
      await expect(page.getByText('Seed App', { exact: true })).toBeVisible();
      await expect(page.getByText('Deploy from a terminal', { exact: true })).toBeVisible();
      await expect(page.getByRole('main').getByText('Experimental', { exact: true })).toBeVisible();
      await expect(page.getByText('kortix apps deploy .', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'New App' })).toHaveCount(0);
      await expect(page.getByRole('dialog', { name: 'Create App' })).toHaveCount(0);

      const seededRow = page.getByRole('listitem', {
        name: 'Seed App App',
      });
      await expect(seededRow).toBeVisible();
      await expect(seededRow.getByText(seeded.url, { exact: true })).toBeVisible();
      await expect(seededRow.getByRole('button', { name: 'Suspend App' })).toBeDisabled();
      await expect(seededRow.getByText('Deploy to see a live preview.')).toBeVisible();

      const copy = seededRow.getByRole('button', { name: 'Copy code' });
      await copy.click();
      await expect(seededRow.getByRole('button', { name: 'Copied' })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(`kortix apps deploy . --app ${seeded.app_id}`);

      await seededRow.getByRole('button', { name: 'Show versions' }).click();
      await expect(seededRow.getByText('No deployments yet.')).toBeVisible();

      await page.evaluate(() => localStorage.setItem('theme', 'light'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveClass(/light/);
      await expect(page.getByText('Seed App', { exact: true })).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath('apps-light.png'),
        fullPage: true,
      });

      await page.evaluate(() => localStorage.setItem('theme', 'dark'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveClass(/dark/);
      await expect(page.getByText('Seed App', { exact: true })).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath('apps-dark.png'),
        fullPage: true,
      });

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'New App' })).toHaveCount(0);
      await expect(page.getByText('Seed App', { exact: true })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath('apps-narrow-dark.png'),
        fullPage: true,
      });

      expect(pageErrors).toEqual([]);
      expect(appsServerErrors).toEqual([]);
      expect(appsCreateRequests).toEqual([]);
    } finally {
      if (projectId) await deleteDatabaseProject(env, projectId).catch(() => {});
      await deleteAuthUser(user.id, authOptions).catch(() => {});
    }
  });
});
