import { expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject, setDatabaseEnterpriseDemo } from '../../src/fixtures/database-project';
import { createApiJsonClient } from '../helpers/http';
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

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
    let groupId: string | null = null;
    let accountId: string | null = null;
    const pageErrors: string[] = [];
    const appsServerErrors: string[] = [];
    const appsCreateRequests: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (response) => {
      // The database-only project's repo_url is `ke2e.invalid`, so the App
      // Access dialog's kortix.yaml read answers its documented 503 and the
      // dialog shows the reason inline (`app-access.tsx`). Any other 5xx fails.
      const unreadableManifest =
        response.status() === 503 &&
        response.request().method() === 'GET' &&
        /\/apps\/[0-9a-f-]+\/agents$/.test(new URL(response.url()).pathname);
      if (
        !unreadableManifest &&
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
      accountId = account.account_id;
      await setDatabaseEnterpriseDemo(env, accountId, true);
      const group = await api<{ group_id: string }>(session.access_token, 'POST', `/accounts/${accountId}/iam/groups`, { name: `Apps subjects ${runId}` }, 201);
      groupId = group.group_id;

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

      // Apps is internal-only (catalogHidden): the gate names no toggle and
      // links nowhere, because Settings → Feature flags does not list it.
      await expect(page.getByText('Contact Kortix to enable it.', { exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Feature flags' })).toHaveCount(0);
      // Kortix enables it per project through the same PATCH.
      await api(
        session.access_token,
        'PATCH',
        `/projects/${project.id}/features`,
        { feature: 'apps', enabled: true },
        200,
      );
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
      } else if (env.target === 'custom') {
        const originSuffix = new URL(env.baseUrl).hostname.split('.').slice(1).join('.');
        expect(seededUrl.hostname).toMatch(
          new RegExp(`^preview-.+\\.apps\\.${escapeRe(originSuffix)}$`),
        );
      } else {
        const environmentPrefix = process.env.KE2E_TARGET === 'preview' ? 'preview' : env.target;
        const appsDomain = process.env.E2E_APPS_BASE_DOMAIN || 'apps.kortix.com';
        expect(seededUrl.hostname).toMatch(
          new RegExp(`^${environmentPrefix}-${escapeRe(seeded.slug)}-[a-z0-9]+\\.${escapeRe(appsDomain)}$`),
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
      // The hostname is NOT on the tile. Every App's URL is the same
      // `<generated-key>.apps.<domain>` shape, so a column of them differs only
      // in a token nobody reads — a third of the caption spent on noise. It
      // moved to the control that opens the App, asserted below.
      await expect(seededCard.getByText(seededUrl.host, { exact: true })).toHaveCount(0);
      // Never deployed, so it must not claim to be running.
      await expect(seededCard.getByText('Not deployed', { exact: true })).toBeVisible();

      // Density updates the mounted subscriber, survives remount, and accepts
      // other-tab events before a local selection takes precedence.
      const comfortable = page.getByRole('button', { name: 'Comfortable — up to 3 per row' });
      const compact = page.getByRole('button', { name: 'Compact — up to 4 per row' });
      await expect(comfortable).toHaveAttribute('aria-pressed', 'true');
      await page.evaluate(() => {
        localStorage.setItem('kortix.apps.grid-columns', '4');
        window.dispatchEvent(new StorageEvent('storage', { key: 'kortix.apps.grid-columns' }));
      });
      await expect(compact).toHaveAttribute('aria-pressed', 'true');
      await comfortable.click();
      await expect(comfortable).toHaveAttribute('aria-pressed', 'true');
      expect(await page.evaluate(() => localStorage.getItem('kortix.apps.grid-columns'))).toBe('3');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(comfortable).toHaveAttribute('aria-pressed', 'true');
      // Block writes in this document only. The selected density still wins,
      // even though persistence failed.
      await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === 'kortix.apps.grid-columns') throw new DOMException('Blocked', 'SecurityError');
          return original.call(this, key, value);
        };
      });
      await compact.click();
      await expect(compact).toHaveAttribute('aria-pressed', 'true');
      expect(await page.evaluate(() => localStorage.getItem('kortix.apps.grid-columns'))).toBe('3');

      // Opening an App happens IN PLACE — no new tab, no navigation.
      await seededCard.click();
      const appModal = page.getByRole('dialog', { name: 'Seed App App' });
      await expect(appModal).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/apps`));
      await expect(
        appModal.getByRole('button', { name: 'Put this App to sleep' }),
      ).toBeDisabled();
      // …and this is where the URL went: the control that opens the App names
      // the host it will open, so the tile can stay a picture of the App.
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

      // Versions is independent of either exclusive overlay.
      await appModal.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Who can open this' }).click();
      const accessModal = page.getByRole('dialog', { name: 'App access', exact: true });
      await expect(accessModal).toBeVisible();
      await expect(page.getByRole('alertdialog', { name: 'Delete App', exact: true })).toHaveCount(0);
      await accessModal.getByRole('radio', { name: /Public/ }).click();
      // Hold the actual mutation so pending UI is observable, then fail it.
      let releaseAccess: () => void = () => {};
      const accessGate = new Promise<void>((resolve) => { releaseAccess = resolve; });
      const accessPath = `**/projects/${project.id}/apps/${seeded.app_id}/access`;
      await page.route(accessPath, async (route) => {
        if (route.request().method() !== 'PATCH') return route.continue();
        expect(route.request().postDataJSON()).toEqual({ mode: 'public' });
        await accessGate;
        await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Characterized access failure' }) });
      });
      await accessModal.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(accessModal.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
      await expect(accessModal.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
      releaseAccess();
      await expect(page.getByText('Characterized access failure', { exact: true })).toBeVisible();
      await expect(accessModal.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
      await expect(accessModal).toBeVisible();
      await page.unroute(accessPath);
      const savedAccess = page.waitForResponse((response) => response.url().endsWith(`/apps/${seeded.app_id}/access`) && response.request().method() === 'PATCH');
      await accessModal.getByRole('button', { name: 'Save', exact: true }).click();
      expect((await savedAccess).status()).toBe(200);
      await expect(page.getByText('App access updated', { exact: true })).toBeVisible();
      await expect(accessModal).toBeHidden();
      await expect(appModal.getByText('No deployments yet.')).toBeVisible();
      for (const scenario of [
        { mode: 'restricted', label: 'Select members', scope: 'api', scopeLabel: 'Acts as them in Kortix', password: '' },
        { mode: 'password', label: 'Password', scope: 'identity', scopeLabel: '', password: 'SyntheticPassword123!' },
        { mode: 'project', label: 'Whole team', scope: 'off', scopeLabel: 'Shares nothing', password: '' },
      ]) {
        // Existing project owner is a real subject; preload its selection to
        // characterize payload preservation without depending on picker search.
        await api(session.access_token, 'PATCH', `/projects/${project.id}/apps/${seeded.app_id}/access`, {
          mode: 'restricted', member_ids: [user.id], group_ids: [group.group_id], viewer_token_scope: 'identity',
        });
        await appModal.getByRole('button', { name: 'Close', exact: true }).click();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await seededCard.click();
        await appModal.getByRole('button', { name: 'More actions' }).click();
        await page.getByRole('menuitem', { name: 'Who can open this' }).click();
        await accessModal.getByRole('radio', { name: new RegExp(`^${scenario.label}`) }).click();
        if (scenario.password) {
          await expect(accessModal.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
          await accessModal.locator('#app-access-password').fill(scenario.password);
        } else await accessModal.getByRole('radio', { name: new RegExp(`^${scenario.scopeLabel}`) }).click();
        const payload = page.waitForRequest((request) => request.method() === 'PATCH' && request.url().endsWith(`/apps/${seeded.app_id}/access`));
        await accessModal.getByRole('button', { name: 'Save', exact: true }).click();
        expect((await payload).postDataJSON()).toEqual({
          mode: scenario.mode,
          ...(scenario.mode === 'restricted' ? { member_ids: [user.id], group_ids: [group.group_id] } : {}),
          ...(scenario.password ? { password: scenario.password } : { viewer_token_scope: scenario.scope }),
        });
        await expect(accessModal).toBeHidden();
        await expect(appModal).toBeVisible();
        await expect(appModal.getByText('No deployments yet.')).toBeHidden();
      }
      await appModal.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Earlier versions' }).click();
      await expect(appModal.getByText('No deployments yet.')).toBeVisible();
      await appModal.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Delete App', exact: true }).click();
      const deleteModal = page.getByRole('alertdialog', { name: 'Delete App', exact: true });
      await expect(deleteModal).toBeVisible();
      await expect(accessModal).toHaveCount(0);
      await deleteModal.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(deleteModal).toBeHidden();
      await expect(appModal.getByText('No deployments yet.')).toBeVisible();
      await appModal.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Hide earlier versions' }).click();
      await expect(appModal.getByText('No deployments yet.')).toBeHidden();

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

      // Exercise deployed-only controls with deterministic network fixtures;
      // no cloud runtime is provisioned by this browser characterization.
      // `/v1/` keeps the glob on the API: `**/projects/<id>/apps` also matches
      // the Apps PAGE URL, so the reload below got the fixture JSON as its document.
      const appApi = `**/v1/projects/${project.id}/apps`;
      const liveApp = { ...seeded, active_deployment_id: 'deployment-current', desired_state: 'running' };
      let activeDeployment = 'deployment-current';
      await page.route(appApi, (route) => route.request().method() === 'GET'
        ? route.fulfill({ json: { apps: [{ ...liveApp, active_deployment_id: activeDeployment }] } }) : route.continue());
      await page.route(`${appApi}/${seeded.app_id}/deployments`, (route) => route.fulfill({ json: {
        deployments: [2, 1].map((version) => ({ deployment_id: version === 2 ? 'deployment-current' : 'deployment-old', app_id: seeded.app_id, version, status: 'ready', created_at: '2026-01-01T00:00:00Z' })),
      } }));
      const previewUrl = new URL('/synthetic-app-preview', page.url()).href;
      await page.route(previewUrl, () => {});
      await page.route(`${appApi}/${seeded.app_id}/access-session`, (route) => route.fulfill({ json: { url: previewUrl, expires_at: '2099-01-01T00:00:00Z' } }));
      await page.reload({ waitUntil: 'domcontentloaded' });
      const thumbnail = seededCard.getByTestId('app-live-preview');
      await expect(thumbnail).toBeVisible();
      // The synthetic preview shares the page origin, so the frame keeps an
      // opaque origin: scripts run, `allow-same-origin` does not.
      await expect(thumbnail).toHaveAttribute('sandbox', /allow-scripts/);
      await expect(thumbnail).not.toHaveAttribute('sandbox', /allow-same-origin/);
      const scaleMatchesTile = () => thumbnail.evaluate((frame) => {
        const tile = frame.parentElement;
        if (!tile) throw new Error('preview has no tile');
        return Math.abs(new DOMMatrix(getComputedStyle(frame).transform).a - tile.getBoundingClientRect().width / 1280) < 0.001;
      });
      await expect.poll(scaleMatchesTile).toBe(true);
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect.poll(scaleMatchesTile).toBe(true);
      await seededCard.click();
      const modalFrame = appModal.getByTestId('app-live-preview');
      // No `error` step: an iframe never fires `error` for a failed load, and
      // React 19 attaches only `load` to an iframe, so the failed overlay (unit
      // tested in app-preview.test.tsx) cannot be reached from a browser.
      await expect(appModal.getByText('Loading preview', { exact: true })).toBeVisible();
      await modalFrame.dispatchEvent('load');
      await expect(appModal.getByText('Loading preview', { exact: true })).toBeHidden();
      await appModal.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Earlier versions' }).click();
      for (const action of ['stop', 'start', 'rollback'] as const) {
        const control = action === 'rollback' ? appModal.getByRole('button', { name: 'Restore', exact: true })
          : appModal.getByRole('button', { name: action === 'stop' ? 'Put this App to sleep' : 'Wake this App up' });
        const path = `${appApi}/${seeded.app_id}/${action}`;
        for (const failed of [true, false]) {
          let release: () => void = () => {};
          const gate = new Promise<void>((resolve) => { release = resolve; });
          await page.route(path, async (route) => {
            expect(route.request().postDataJSON()).toEqual(action === 'rollback' ? { deployment_id: 'deployment-old' } : {});
            await gate;
            if (failed) return route.fulfill({ status: 400, json: { error: `${action} characterization failure` } });
            if (action === 'rollback') activeDeployment = 'deployment-old';
            else liveApp.desired_state = action === 'stop' ? 'stopped' : 'running';
            await route.fulfill({ json: liveApp });
          });
          await control.click();
          await expect(control).toBeDisabled();
          release();
          // A failed mutation reaches the global handler, which prefixes the
          // message ("Failed to perform action: ..."), so match by substring.
          await expect((failed ? page.getByText(`${action} characterization failure`)
            : page.getByText(action === 'rollback' ? 'Rolled back to version 1' : `Seed App ${action === 'stop' ? 'suspended' : 'is ready'}`, { exact: true })).first()).toBeVisible();
          await page.unroute(path);
          await expect(appModal).toBeVisible();
          await expect(appModal.getByText('v2', { exact: true })).toBeVisible();
          if (failed) await expect(control).toBeEnabled();
        }
      }
      await appModal.getByRole('button', { name: 'Close', exact: true }).click();
      // Deny only Apps write/deploy probes, leaving project navigation intact.
      await page.route('**/effective?*', async (route) => {
        if (route.request().method() === 'OPTIONS') return route.fallback();
        const response = await route.fetch();
        const body = await response.json();
        if (['project.app.write', 'project.app.deploy'].includes(new URL(route.request().url()).searchParams.get('action') ?? '')) body.allowed = false;
        await route.fulfill({ response, json: body });
      });
      await page.route('**/effective:batch', async (route) => {
        if (route.request().method() === 'OPTIONS') return route.fallback();
        const response = await route.fetch();
        const body = await response.json();
        body.results = body.results.map((result: { action: string; allowed: boolean }) => ['project.app.write', 'project.app.deploy'].includes(result.action) ? { ...result, allowed: false } : result);
        await route.fulfill({ response, json: body });
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await seededCard.click();
      await expect(appModal.getByRole('button', { name: 'Put this App to sleep' })).toHaveCount(0);
      await expect(appModal.getByRole('button', { name: 'Wake this App up' })).toHaveCount(0);
      await appModal.getByRole('button', { name: 'More actions' }).click();
      await expect(page.getByRole('menuitem', { name: 'Who can open this' })).toHaveCount(0);
      await expect(page.getByRole('menuitem', { name: 'Delete App', exact: true })).toHaveCount(0);
      await page.getByRole('menuitem', { name: 'Earlier versions' }).click();
      await expect(appModal.getByText('v2', { exact: true })).toBeVisible();
      await expect(appModal.getByRole('button', { name: 'Restore', exact: true })).toHaveCount(0);
      await appModal.getByRole('button', { name: 'Close', exact: true }).click();
      await page.unroute('**/effective?*');
      await page.unroute('**/effective:batch');
      await page.unroute(appApi);
      await page.unroute(`${appApi}/${seeded.app_id}/deployments`);
      await page.unroute(`${appApi}/${seeded.app_id}/access-session`);
      await page.unroute(previewUrl);
      await page.reload({ waitUntil: 'domcontentloaded' });

      // Delete failure keeps the confirmation and parent open; success closes
      // both and removes the card from the refetched index.
      await seededCard.click();
      await appModal.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Delete App', exact: true }).click();
      let releaseDelete: () => void = () => {};
      const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
      const appPath = `**/v1/projects/${project.id}/apps/${seeded.app_id}`;
      await page.route(appPath, async (route) => {
        if (route.request().method() !== 'DELETE') return route.continue();
        await deleteGate;
        await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Characterized delete failure' }) });
      });
      await deleteModal.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(deleteModal.getByRole('button', { name: 'Delete…', exact: true })).toBeDisabled();
      await expect(deleteModal.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
      releaseDelete();
      await expect(page.getByText('Characterized delete failure').first()).toBeVisible();
      await expect(deleteModal.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
      await expect(deleteModal).toBeVisible();
      await page.unroute(appPath);
      const deleted = page.waitForResponse((response) => response.url().endsWith(`/apps/${seeded.app_id}`) && response.request().method() === 'DELETE');
      await deleteModal.getByRole('button', { name: 'Delete', exact: true }).click();
      expect((await deleted).status()).toBe(200);
      await expect(page.getByText('Seed App deleted', { exact: true })).toBeVisible();
      await expect(deleteModal).toBeHidden();
      await expect(appModal).toBeHidden();
      await expect(seededCard).toHaveCount(0);

      expect(pageErrors).toEqual([]);
      expect(appsServerErrors).toEqual([]);
      expect(appsCreateRequests).toEqual([]);
    } finally {
      if (projectId) await deleteDatabaseProject(env, projectId).catch(() => {});
      if (groupId && accountId) await api(session.access_token, 'DELETE', `/accounts/${accountId}/iam/groups/${groupId}`).catch(() => {});
      await deleteAuthUser(user.id, authOptions).catch(() => {});
    }
  });
});
