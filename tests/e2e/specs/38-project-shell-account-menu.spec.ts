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
import { dismissOnboarding, dismissWelcomeCard, selectAccountForUi } from '../helpers/ui';

/**
 * KRTX-1810 + KRTX-1975: inside a project the shell had no signed-in user
 * control — the "Logged in as" menu existed only on /projects and /new — and
 * the Settings dialog reachable by URL carried the project's name in its
 * accessible title while showing only personal settings. The account menu
 * lives in the project sidebar's switcher now, and the dialog it opens is
 * titled "Settings", not "Settings — <project>".
 */

const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://localhost:13740',
  password: 'E2eProjectShellAccount123!',
};
const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role?: string;
}

/** The account a fresh user owns (spec 45's rule). */
const ownedAccount = (accounts: AccountSummary[]) => {
  const own = accounts.find(
    (a) => a.personal_account || a.is_primary_owner || a.account_role === 'owner',
  );
  if (!own) throw new Error('the seeded user owns no account');
  return own.account_id;
};

test.describe('38 — The project shell knows who you are', () => {
  test('the switcher menu opens on the identity, and its Settings row opens the personal one', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const env = loadEnv();
    if (!env.databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
    const runId = Date.now().toString(36);
    const email = `e2e-shell-account-${runId}@example.test`;
    const projectName = `Shell ${runId}`;
    const user = await createAuthUser(email, authOptions);
    let projectId: string | null = null;

    try {
      const session = await signIn(email, authOptions);
      const account = ownedAccount(await api<AccountSummary[]>(session.access_token, 'GET', '/accounts'));
      const project = await createDatabaseProject(env, {
        accountId: account,
        userId: user.id,
        name: projectName,
      });
      projectId = project.id;

      await installBrowserSessionDirect(page, session, `/projects/${project.id}`, authOptions);
      await selectAccountForUi(page, account);
      await page.goto(`/projects/${project.id}`, { waitUntil: 'domcontentloaded' });
      await dismissOnboarding(page);
      await dismissWelcomeCard(page);
      await expect(page).toHaveURL(new RegExp(`/projects/${project.id}`));

      await test.step('the mobile drawer has a reachable close control', async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        const toggle = page.getByRole('button', { name: 'Open sidebar' });
        await toggle.click();
        const drawer = page.getByRole('dialog', { name: 'Sidebar', exact: true });
        await expect(drawer).toBeVisible();
        await expect(drawer.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
        await drawer.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(drawer).not.toBeVisible();
        await expect(toggle).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
        await toggle.click();
        await drawer.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(drawer).not.toBeVisible();
        await page.setViewportSize({ width: 1280, height: 900 });
      });

      await test.step('the shell opens an account menu on the signed-in identity', async () => {
        await page.getByRole('button', { name: 'Switch project' }).click();
        const menu = page.getByRole('menu');
        await expect(menu.getByText('Logged in as')).toBeVisible();
        await expect(menu.getByText(email)).toBeVisible();
        await expect(menu.getByRole('menuitem', { name: 'Log out' })).toBeVisible();
      });

      await test.step('its Settings row opens the personal settings dialog, untitled by the project', async () => {
        await page.getByRole('menuitem', { name: 'Settings' }).click();
        await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible({
          timeout: 30_000,
        });
        await expect(page.getByRole('dialog', { name: `Settings — ${projectName}` })).toHaveCount(0);
      });
    } finally {
      if (projectId) await deleteDatabaseProject(env, projectId).catch(() => undefined);
      await deleteAuthUser(user.id, authOptions).catch(() => undefined);
    }
  });
});
