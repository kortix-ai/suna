import { expect, test } from '@playwright/test';

import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';
import { loadEnv } from '../../src/core/env';
import { createApiJsonClient } from '../helpers/http';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

/**
 * The project page's "Kortix, now on your phone" promo dialog covers the whole
 * viewport once per browser (`kortix.mobileAppPromo`). Seed the store's own
 * persisted flag before the first navigation — the same state a user's Close
 * click writes — and still close the dialog for real if it is up (storage
 * races lose to a visible dialog).
 */
async function clearMobilePromo(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem('kortix.mobileAppPromo', JSON.stringify({ state: { closed: true }, version: 1 }));
  });
  const promo = page.getByRole('dialog', { name: /now on your phone/i });
  if (await promo.isVisible().catch(() => false)) {
    await promo.getByRole('button', { name: 'Close' }).click();
  }
  await promo.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
}

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const databaseUrl = process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const authOptions = { supabaseUrl, password: 'E2eAccountChip123!' };
const api = createApiJsonClient(apiBase);

/**
 * 52 — the account chip on every authenticated page (KRTX-2145).
 *
 * The top-right account control (identity, profile settings, log out) used to
 * render only on `/new` and the `/projects` selector; inside a project the
 * identity was invisible and profile settings were reachable only through the
 * workspace-switcher menu. The chip is now self-contained and every surface
 * carries it: the project shell floats a corner for chromeless views, the
 * capability headers and the session header embed it in their own top row, and
 * the account-level pages keep the full top bar.
 *
 * Asserted here in a real browser, because the menu renders through a Radix
 * portal no unit harness can reach:
 * - a project page shows the control and its menu holds the Settings row that
 *   lands on `/settings/profile` (the path the enforced-2FA flow needs) and a
 *   Log out row;
 * - a capability page shows exactly one control — its own chip, with the
 *   shell's floating corner stood down by the `:has([data-kx-account-owner])`
 *   rule;
 * - `/new` still shows exactly one (its own top bar).
 *
 * `/admin` is a browser-asserted surface too, in spec 09 — it owns the
 * platform-admin fixture (`runDatabaseSql` + `platform_user_roles`), and its
 * overview step asserts the console's titlebar chip.
 */
test.describe('52 — account chip on every authenticated page', () => {
  test('shows identity, settings and log out on a project page, once per view', async ({ page }) => {
    test.skip(!databaseUrl, 'KE2E_DATABASE_URL is required');
    test.setTimeout(240_000);

    const runId = Date.now().toString(36);
    const email = `e2e-account-chip-${runId}@example.test`;
    const env = loadEnv();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    let projectId: string | null = null;

    try {
      const accounts = await api<Array<{ account_id: string; personal_account?: boolean }>>(
        session.access_token,
        'GET',
        '/accounts',
      );
      const accountId = (accounts.find((a) => a.personal_account) ?? accounts[0])!.account_id;
      const project = await createDatabaseProject(env, {
        accountId,
        userId: user.id,
        name: `Account chip ${runId}`,
      });
      projectId = project.id;

      await installBrowserSessionDirect(page, session, '/favicon.png', authOptions);
      await clearMobilePromo(page);
      await selectAccountForUi(page, accountId);
      await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
      await dismissOnboarding(page);
      await clearMobilePromo(page);

      const chip = page.getByRole('button', { name: `Logged in as ${email}` });

      // A project page (not /new) carries the account control, and the shell
      // renders exactly one — the floating corner.
      await expect(chip).toBeVisible();
      await expect(chip).toHaveCount(1);
      const corner = page.locator('.kx-app-account-corner');
      await expect(corner).toBeVisible();
      await expect(corner.getByRole('button', { name: `Logged in as ${email}` })).toHaveCount(1);

      // The menu holds the rows the issue is about: Settings (a real link to
      // the profile settings the enforced-2FA flow lands in) and Log out.
      await chip.click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'Settings' })).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'Log out' })).toBeVisible();

      // Following Settings lands on the standalone settings route.
      await menu.getByRole('menuitem', { name: 'Settings' }).click();
      await expect(page).toHaveURL(/\/settings\/profile$/);

      // A capability page embeds the chip in its own titlebar row, and the
      // shell's corner stands down — still exactly one account control.
      await page.goto(`/projects/${projectId}/files`, { waitUntil: 'domcontentloaded' });
      await clearMobilePromo(page);
      await expect(page.getByRole('heading', { name: 'Files', exact: true })).toBeVisible();
      await expect(
        page.locator('.kx-titlebar-row').getByRole('button', { name: `Logged in as ${email}` }),
      ).toBeVisible();
      await expect(page.locator('.kx-app-account-corner')).toBeHidden();
      await expect(page.getByRole('button', { name: `Logged in as ${email}` })).toHaveCount(1);

      // `/new` keeps its own top bar — still exactly one control.
      await page.goto('/new', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('button', { name: `Logged in as ${email}` })).toHaveCount(1);
      await expect(page.locator('.kx-app-account-corner')).toHaveCount(0);

      expect(pageErrors).toEqual([]);
    } finally {
      if (projectId) await deleteDatabaseProject(env, projectId).catch(() => {});
      await deleteAuthUser(email, authOptions).catch(() => {});
    }
  });
});
