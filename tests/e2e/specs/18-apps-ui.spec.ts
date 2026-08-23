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
import { dismissOnboarding, featureFlagRow, selectAccountForUi } from '../helpers/ui';

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';

/** A hostname is full of dots; a raw interpolation into a RegExp would match too much. */
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  test('gates Apps on its flag, enables it in place, and renders a read-only deployment index', async ({
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
      // screen's "Feature flags" row is a real link now
      // (`feature-gate-screen.tsx`), to
      // `/projects/[id]/config?section=feature-flags` — Feature flags
      // graduated out of the Settings overlay's Experimental tab onto the
      // Customize bar's Settings tab, same as every other project-config pane
      // (`settings-tabs.ts` GRADUATED map).
      await page.getByRole('link', { name: 'Feature flags' }).click();
      const panel = page.locator('body');
      await expect(
        page.getByRole('heading', { name: 'Feature flags', exact: true }),
      ).toBeVisible({ timeout: 30_000 });
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
      // No overlay to dismiss any more — Feature flags is a plain page now,
      // so navigating straight to Apps is the whole "leave" step.
      await page.goto(`/projects/${project.id}/apps`, {
        waitUntil: 'domcontentloaded',
      });
      // A feature mutation can leave this client route mounted without starting
      // its newly-enabled query. Reload and require the exact list response
      // before asserting the empty state.
      const emptyListResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          response.url().endsWith(`/v1/projects/${project.id}/apps`),
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      expect((await emptyListResponse).status()).toBe(200);
      await dismissOnboarding(page);
      await expect(page.getByText('No Apps yet', { exact: true })).toBeVisible();

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

      // The page is ALREADY on /projects/:id/apps from the navigation above, so
      // a `goto` to the same URL is a client-router no-op: Next serves it from
      // the router cache and the query cache answers with the pre-seed list, so
      // no second `GET /v1/projects/:id/apps` ever reaches the network. The
      // trace of a failing staging run shows exactly one such request for two
      // navigations, and the wait below then expired at its 30s default. A
      // reload re-runs the document and the client fetch, which is what makes
      // "the index re-reads the API after a deploy" an assertion instead of a
      // race.
      const listResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          response.url().endsWith(`/v1/projects/${project.id}/apps`),
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      expect((await listResponse).status()).toBe(200);

      // First-run onboarding can remount after the feature mutation.
      await dismissOnboarding(page);

      await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible();
      await expect(page.getByText('Seed App', { exact: true })).toBeVisible();
      await expect(page.getByRole('main').getByText('Experimental', { exact: true })).toHaveCount(0);
      // The "Deploy from a terminal" banner is gone. It sat under the grid on
      // every visit repeating a command you need exactly once, and it is the
      // docs link in the header's job. The deploy command still lives where it
      // is actionable — the detail modal's Versions panel, asserted below.
      await expect(page.getByText('Deploy from a terminal')).toHaveCount(0);
      await expect(page.getByText('kortix apps deploy .', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'New App' })).toHaveCount(0);
      await expect(page.getByRole('dialog', { name: 'Create App' })).toHaveCount(0);

      // The card is ONE control now: the live preview is its hero and every
      // action moved into the detail modal, so there are no nested hit areas.
      // Same assertions as before — they just live where the controls do.
      const seededCard = page.getByRole('button', { name: 'Open Seed App' });
      await expect(seededCard).toBeVisible();
      await expect(seededCard.getByText('Deploy to see a live preview.')).toBeVisible();
      // The tile's second line is the App's HOST — `appHost()` strips the
      // scheme and any trailing slash, so it is `seededUrl.host`, never the
      // full `seeded.url`. main asserts the opposite (`toHaveCount(0)`) because
      // a LATER main change moved the hostname off the tile into the Open
      // control's tooltip; that change is not part of this staging backport, so
      // the host is still here. When it lands, flip this back to main's form.
      await expect(seededCard.getByText(seededUrl.host, { exact: true })).toBeVisible();
      // Never deployed, so it must not claim to be running.
      await expect(seededCard.getByText('Not deployed', { exact: true })).toBeVisible();

      // Opening an App happens IN PLACE — no new tab, no navigation.
      await seededCard.click();
      const appModal = page.getByRole('dialog', { name: 'Seed App App' });
      await expect(appModal).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/apps`));
      await expect(
        appModal.getByRole('button', { name: 'Put this App to sleep' }),
      ).toBeDisabled();
      // The Open control also names the host, in its tooltip. On main that is
      // the ONLY place the host appears; here it is the second one, because the
      // tile above still carries it (see the note there).
      const openInNewTab = appModal.getByRole('link', { name: 'Open in a new tab' });
      await expect(openInNewTab).toBeVisible();
      // Containment, not an exact shape: this App has no deployment, so the
      // href is the App's own URL rather than a signed session URL, and the two
      // differ in query and trailing slash. What must hold either way is that
      // the control points at THIS App's host.
      await expect(openInNewTab).toHaveAttribute('href', new RegExp(escapeRe(seededUrl.host)));

      await appModal.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Earlier versions' }).click();
      await expect(appModal.getByText('No deployments yet.')).toBeVisible();

      const copy = appModal.getByRole('button', { name: 'Copy code' });
      await copy.click();
      await expect(appModal.getByRole('button', { name: 'Copied' })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(`kortix apps deploy . --app ${seeded.app_id}`);

      await appModal.getByRole('button', { name: 'Close' }).click();
      await expect(appModal).toBeHidden();

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
