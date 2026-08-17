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
const appsBaseDomain = process.env.E2E_APPS_BASE_DOMAIN || 'apps.kortix.com';
const appsEnvironment = process.env.E2E_APPS_ENVIRONMENT;
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
  test('gates Apps on its flag and completes App create, read, update, and confirmed delete', async ({
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
      // Apps is a STABLE flag: still opt-in per project, but no surface calls
      // it experimental any more.
      await expect(page.getByRole('main').getByText('Experimental', { exact: true })).toHaveCount(0);
      // The gate screen never self-enables: it points at Settings →
      // Feature flags and there is no Enable button on the feature's own page.
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

      await expect(page.getByRole('button', { name: 'New App' })).toBeVisible();
      await page.getByRole('button', { name: 'New App' }).click();
      const createDialog = page.getByRole('dialog', { name: 'Create App' });
      await expect(createDialog).toBeVisible();
      await createDialog.getByLabel('Name').fill('UI App');
      await createDialog.getByLabel('Slug').fill(`ui-${runId}`);
      await createDialog.getByLabel('CPU cores').fill('2');
      await createDialog.getByLabel('Memory (GB)').fill('4');
      await createDialog.getByLabel('Disk (GB)').fill('20');
      await createDialog.getByLabel('Idle timeout (seconds)').fill('600');
      await createDialog.getByLabel('Monthly budget (USD)').fill('25');
      const createRequest = page.waitForRequest(
        (request) => request.method() === 'POST' &&
          request.url().endsWith(`/v1/projects/${project.id}/apps`),
      );
      const createResponse = page.waitForResponse(
        (response) => response.request().method() === 'POST' &&
          response.url().endsWith(`/v1/projects/${project.id}/apps`),
      );
      await createDialog.getByRole('button', { name: 'Create App' }).click();
      expect((await createRequest).postDataJSON()).toEqual({
        name: 'UI App', slug: `ui-${runId}`, cpu: 2, memory_gb: 4, disk_gb: 20,
        idle_timeout_seconds: 600, monthly_budget_usd: 25,
      });
      const createdResponse = await createResponse;
      expect(createdResponse.status()).toBe(201);
      const created = (await createdResponse.json()) as AppResponse;
      const createdUrl = new URL(created.url);
      if (env.target === 'local') {
        expect(createdUrl.hostname).toMatch(/\.apps\.localhost$/);
      } else {
        const environmentPrefix = appsEnvironment || (env.target === 'prod' ? 'prod' : env.target);
        const hostnameSuffix = `.${appsBaseDomain}`;
        expect(createdUrl.hostname.endsWith(hostnameSuffix)).toBe(true);
        const deploymentHostname = createdUrl.hostname.slice(0, -hostnameSuffix.length);
        expect(deploymentHostname.startsWith(`${environmentPrefix}-`)).toBe(true);
        expect(deploymentHostname.length).toBeGreaterThan(environmentPrefix.length + 1);
      }
      await expect(createDialog).toBeHidden();
      await expect(page.getByText('UI App', { exact: true })).toBeVisible();
      await expect(page.getByText('Deploy from a terminal', { exact: true })).toBeVisible();
      await expect(page.getByText('kortix apps deploy .', { exact: true })).toBeVisible();

      // The card is ONE control now: the live preview is its hero and every
      // action moved into the detail modal, so there are no nested hit areas.
      // Same assertions as before — they just live where the controls do.
      const createdCard = page.getByRole('button', { name: 'Open UI App' });
      await expect(createdCard).toBeVisible();
      await expect(createdCard.getByText(created.url, { exact: true })).toBeVisible();
      await expect(createdCard.getByText('Deploy to see a live preview.')).toBeVisible();
      // Never deployed, so it must not claim to be running.
      await expect(createdCard.getByText('Not deployed', { exact: true })).toBeVisible();

      // Opening an App happens IN PLACE — no new tab, no navigation.
      await createdCard.click();
      let appModal = page.getByRole('dialog', { name: 'UI App App' });
      await expect(appModal).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/apps`));
      await expect(appModal.getByRole('button', { name: 'Suspend App' })).toBeDisabled();
      await expect(appModal.getByRole('link', { name: 'Open in a new tab' })).toBeVisible();
      await expect(appModal.getByRole('button', { name: 'Edit App' })).toBeVisible();
      await expect(appModal.getByRole('button', { name: 'Delete App' })).toBeVisible();

      await appModal.getByRole('button', { name: 'Edit App' }).click();
      const editDialog = page.getByRole('dialog', { name: 'Edit App' });
      await editDialog.getByLabel('Name').fill('Updated App');
      await editDialog.getByLabel('CPU cores').fill('1');
      await editDialog.getByLabel('Memory (GB)').fill('2');
      await editDialog.getByLabel('Disk (GB)').fill('10');
      await editDialog.getByLabel('Idle timeout (seconds)').fill('300');
      await editDialog.getByLabel('Monthly budget (USD)').fill('40');
      const updateRequest = page.waitForRequest(
        (request) => request.method() === 'PATCH' &&
          request.url().endsWith(`/v1/projects/${project.id}/apps/${created.app_id}`),
      );
      const updateResponse = page.waitForResponse(
        (response) => response.request().method() === 'PATCH' &&
          response.url().endsWith(`/v1/projects/${project.id}/apps/${created.app_id}`),
      );
      await editDialog.getByRole('button', { name: 'Save changes' }).click();
      expect((await updateRequest).postDataJSON()).toEqual({
        name: 'Updated App', cpu: 1, memory_gb: 2, disk_gb: 10,
        idle_timeout_seconds: 300, monthly_budget_usd: 40,
      });
      expect((await updateResponse).status()).toBe(200);
      await expect(editDialog).toBeHidden();
      appModal = page.getByRole('dialog', { name: 'Updated App App' });
      await expect(appModal).toBeVisible();

      await appModal.getByRole('button', { name: 'Show versions' }).click();
      await expect(appModal.getByText('No deployments yet.')).toBeVisible();

      const copy = appModal.getByRole('button', { name: 'Copy code' });
      await copy.click();
      await expect(appModal.getByRole('button', { name: 'Copied' })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(`kortix apps deploy . --app ${created.app_id}`);

      await appModal.getByRole('button', { name: 'Close' }).click();
      await expect(appModal).toBeHidden();

      await page.evaluate(() => localStorage.setItem('theme', 'light'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveClass(/light/);
      await expect(page.getByText('Updated App', { exact: true })).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath('apps-light.png'),
        fullPage: true,
      });

      await page.evaluate(() => localStorage.setItem('theme', 'dark'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveClass(/dark/);
      await expect(page.getByText('Updated App', { exact: true })).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath('apps-dark.png'),
        fullPage: true,
      });

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'New App' })).toBeVisible();
      await expect(page.getByText('Updated App', { exact: true })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath('apps-narrow-dark.png'),
        fullPage: true,
      });

      await page.getByRole('button', { name: 'Open Updated App' }).click();
      appModal = page.getByRole('dialog', { name: 'Updated App App' });
      const deleteRequest = page.waitForRequest(
        (request) => request.method() === 'DELETE' &&
          request.url().endsWith(`/v1/projects/${project.id}/apps/${created.app_id}`),
      );
      const deleteResponse = page.waitForResponse(
        (response) => response.request().method() === 'DELETE' &&
          response.url().endsWith(`/v1/projects/${project.id}/apps/${created.app_id}`),
      );
      await appModal.getByRole('button', { name: 'Delete App' }).click();
      const confirm = page.getByRole('alertdialog', { name: 'Delete App' });
      await confirm.getByRole('button', { name: 'Delete' }).click();
      await deleteRequest;
      expect((await deleteResponse).status()).toBe(200);
      await expect(appModal).toBeHidden();
      await expect(page.getByText('Updated App', { exact: true })).toHaveCount(0);
      await expect(page.getByText('No Apps deployed', { exact: true })).toBeVisible();

      expect(pageErrors).toEqual([]);
      expect(appsServerErrors).toEqual([]);
      expect(appsCreateRequests).toHaveLength(1);
    } finally {
      if (projectId) await deleteDatabaseProject(env, projectId).catch(() => {});
      await deleteAuthUser(user.id, authOptions).catch(() => {});
    }
  });
});
