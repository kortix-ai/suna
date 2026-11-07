import { expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';
import { createApiJsonClient } from '../helpers/http';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';
import { ensureOwnedAccount } from '../helpers/accounts';

/**
 * One Settings panel per workspace (design.md §3.2 C7): one rail, no tab bar
 * above it, the sections in the registry's order, and every old link landing
 * on the section that owns it now.
 */

const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://localhost:13740',
  password: 'E2eWorkspaceSettings123!',
};
const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const api = createApiJsonClient(apiBase);

test.describe('58 — Workspace settings is one panel', () => {
  test('the rail lists the sections top to bottom, and old links land on their section', async ({ page }) => {
    test.setTimeout(240_000);
    const env = loadEnv();
    if (!env.databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
    const runId = Date.now().toString(36);
    const email = `e2e-ws-settings-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    let projectId: string | null = null;

    try {
      const session = await signIn(email, authOptions);
      const account = await ensureOwnedAccount(api, session.access_token);
      const project = await createDatabaseProject(env, { accountId: account, userId: user.id, name: `Panel ${runId}` });
      projectId = project.id;
      await installBrowserSessionDirect(page, session, `/workspaces/${project.id}`, authOptions);
      await selectAccountForUi(page, account);
      await page.goto(`/workspaces/${project.id}`, { waitUntil: 'domcontentloaded' });
      await dismissOnboarding(page);

      await test.step('/admin opens General inside one rail, with no tab bar above it', async () => {
        await page.goto(`/workspaces/${project.id}/admin`, { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(new RegExp(`/workspaces/${project.id}/admin/general`), { timeout: 60_000 });
        const rail = page.getByRole('navigation', { name: 'Workspace settings' });
        await expect(rail.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
        // The rail is the only navigation: no Customize tab bar over the panel.
        await expect(page.getByRole('tab', { name: 'Agents', exact: true })).toHaveCount(0);
      });

      await test.step('the rail groups and their first rows follow the registry', async () => {
        const rail = page.getByRole('navigation', { name: 'Workspace settings' });
        const groups = await rail.getByRole('tablist').evaluateAll((lists) =>
          lists.map((list) => list.getAttribute('aria-label')),
        );
        expect(groups.slice(0, 3)).toEqual(['Workspace', 'Library', 'People']);
        expect(groups.at(-1)).toBe('Support');
        const workspaceRows = await rail.getByRole('tablist', { name: 'Workspace' }).getByRole('tab').allInnerTexts();
        expect(workspaceRows.slice(0, 2).map((row) => row.trim())).toEqual(['General', 'Security']);
        const peopleRows = (await rail.getByRole('tablist', { name: 'People' }).getByRole('tab').allInnerTexts()).map(
          (row) => row.trim(),
        );
        expect(peopleRows[0]).toBe('Members');
        // Access merged into Members.
        expect(peopleRows).not.toContain('Access');
      });

      await test.step('General holds the workspace ID and the Danger zone; Security holds MFA', async () => {
        await expect(page.getByText('Workspace ID', { exact: true })).toBeVisible();
        await expect(page.getByText(project.id)).toBeVisible();
        await expect(page.getByRole('button', { name: 'Delete workspace' })).toBeVisible();
        await page.goto(`/workspaces/${project.id}/admin/security`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('switch', { name: 'Require two-factor authentication' })).toBeVisible({ timeout: 60_000 });
      });

      await test.step('old links land on the section that owns them now', async () => {
        const cases: Array<[string, string]> = [
          [`/workspaces/${project.id}/admin/access`, `/workspaces/${project.id}/admin/members`],
          [`/workspaces/${project.id}/members`, `/workspaces/${project.id}/admin/members`],
          [`/workspaces/${project.id}?accountId=${account}&accountTab=settings`, `/workspaces/${project.id}/admin/security`],
          [`/workspaces/${project.id}/admin/loops`, `/workspaces/${project.id}/admin/triggers`],
        ];
        for (const [from, to] of cases) {
          await page.goto(from, { waitUntil: 'domcontentloaded' });
          await expect(page).toHaveURL(new RegExp(`${to.replace(/[?]/g, '\\?')}$`), { timeout: 60_000 });
        }
      });

      await test.step('the workspace menu opens Members with the invite form', async () => {
        await page.goto(`/workspaces/${project.id}`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: 'Switch workspace' }).click();
        await page.getByRole('menuitem', { name: /Invite people to/ }).click();
        await expect(page).toHaveURL(new RegExp(`/workspaces/${project.id}/admin/members\\?invite=1`), { timeout: 60_000 });
        await expect(page.getByText(`Invite people to Panel ${runId}`).first()).toBeVisible({ timeout: 60_000 });
        await expect(page.getByRole('combobox', { name: 'Role' }).last()).toContainText('Member');
      });
    } finally {
      if (projectId) await deleteDatabaseProject(env, projectId).catch(() => undefined);
      await deleteAuthUser(user.id, authOptions).catch(() => undefined);
    }
  });
});
