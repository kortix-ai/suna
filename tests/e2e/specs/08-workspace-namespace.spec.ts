import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseSession } from '../../src/fixtures/database-project';
import { runDatabaseSql, seedDatabaseProject } from '../helpers/database';
import { createApiJsonClient } from '../helpers/http';
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import { dismissOnboarding } from '../helpers/ui';

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const databaseUrl = process.env.DATABASE_URL;
const password = 'E2eWorkspaceNamespace123!';
const api = createApiJsonClient(apiBase);
const authOptions = { supabaseUrl, password };

test.describe('08 — Workspace namespace', () => {
  test('Workspace is canonical while Project URLs remain compatible', async ({ page }) => {
    test.setTimeout(180_000);
    if (!databaseUrl) throw new Error('DATABASE_URL is required');

    const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const email = `e2e-workspace-${runId}@example.test`;
    const workspaceName = `E2E Workspace ${runId}`;
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const apiRequests: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('request', (request) => {
      if (request.url().includes('/v1/')) apiRequests.push(request.url());
    });

    const user = await createAuthUser(email, authOptions);
    let workspaceId: string | null = null;
    try {
      const session = await signIn(email, authOptions);
      await api(session.access_token, 'GET', '/accounts');
      workspaceId = await seedDatabaseProject({
        accountId: user.id,
        userId: user.id,
        name: workspaceName,
        projectRole: 'manager',
      });

      await installBrowserSessionDirect(
        page,
        session,
        `/workspaces/${workspaceId}`,
        authOptions,
      );
      await dismissOnboarding(page);
      await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}$`));
      await expect(page.getByText(workspaceName, { exact: true }).first()).toBeVisible();
      await expect
        .poll(() => apiRequests.some((url) => url.includes(`/v1/workspaces/${workspaceId}`)))
        .toBe(true);

      const bodyCopy = await page.locator('body').innerText();
      expect(bodyCopy).not.toContain('Your projects');
      expect(bodyCopy).not.toContain('Manage your project settings');
      expect(bodyCopy).not.toContain('New project');
      expect(bodyCopy).not.toContain('Recent Projects');

      await page.getByRole('button', { name: /^Settings/i }).click();
      const dialog = page.getByRole('dialog', { name: /Customize/i });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(/Workspace|workspace/);
      await expect(dialog).not.toContainText(/Manage your project settings/i);
      await page.keyboard.press('Escape');

      await page.goto(`/projects/${workspaceId}`, { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}$`));
      await expect(page.getByText(workspaceName, { exact: true }).first()).toBeVisible();

      await page.goto('/projects', { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}$`));

      const sessionId = await createDatabaseSession(loadEnv(), {
        workspaceId,
        accountId: user.id,
        userId: user.id,
      });
      await page.goto(`/projects/${workspaceId}/sessions/${sessionId}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page).toHaveURL(
        new RegExp(`/workspaces/${workspaceId}/sessions/${sessionId}$`),
      );
      await page.waitForTimeout(2_000);

      expect(pageErrors).toEqual([]);
      expect(consoleErrors.filter((message) => message.includes('No queryFn was passed'))).toEqual(
        [],
      );
    } finally {
      if (workspaceId) {
        await runDatabaseSql('delete from kortix.projects where project_id = $1::uuid', [
          workspaceId,
        ]).catch(() => {});
      }
      await deleteAuthUser(user.id, authOptions);
    }
  });
});
