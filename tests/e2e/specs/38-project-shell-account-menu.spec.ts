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
import { ensureOwnedAccount } from '../helpers/accounts';

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



test.describe('38 — The project shell knows who you are', () => {
  test('the workspace menu opens on the workspace, and its Preferences row opens the personal settings', async ({
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
      const account = await ensureOwnedAccount(api, session.access_token);
      const project = await createDatabaseProject(env, {
        accountId: account,
        userId: user.id,
        name: projectName,
      });
      projectId = project.id;

      await installBrowserSessionDirect(page, session, `/workspaces/${project.id}`, authOptions);
      await selectAccountForUi(page, account);
      await page.goto(`/workspaces/${project.id}`, { waitUntil: 'domcontentloaded' });
      await dismissOnboarding(page);
      await dismissWelcomeCard(page);
      await expect(page).toHaveURL(new RegExp(`/workspaces/${project.id}`));

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

      await test.step('the workspace menu leads with the workspace and its actions, then the person', async () => {
        await page.getByRole('button', { name: 'Switch workspace' }).click();
        const menu = page.getByRole('menu');
        // Header: the workspace and the caller's one role.
        await expect(menu.getByTestId('workspace-menu-header')).toContainText(projectName);
        await expect(menu.getByTestId('workspace-menu-header')).toContainText('Owner');
        const rows = await menu.getByRole('menuitem').allInnerTexts();
        const order = ['Invite people to', 'Workspace settings', 'Switch workspace', 'Preferences', 'Log out'].map((label) =>
          rows.findIndex((row) => row.startsWith(label)),
        );
        expect(order.every((index) => index >= 0)).toBe(true);
        expect([...order].sort((x, y) => x - y)).toEqual(order);
        // Log out names the session it ends; no row is a bare "Settings".
        await expect(menu.getByRole('menuitem', { name: /Log out/ })).toContainText(email);
        expect(rows.some((row) => row.trim() === 'Settings')).toBe(false);
      });

      await test.step('Preferences opens the personal settings dialog, untitled by the workspace', async () => {
        await page.getByRole('menuitem', { name: /Preferences/ }).click();
        await expect(page.getByRole('dialog', { name: 'Preferences', exact: true })).toBeVisible({
          timeout: 30_000,
        });
        await expect(page.getByRole('dialog', { name: `Preferences — ${projectName}` })).toHaveCount(0);
      });
    } finally {
      if (projectId) await deleteDatabaseProject(env, projectId).catch(() => undefined);
      await deleteAuthUser(user.id, authOptions).catch(() => undefined);
    }
  });
});
