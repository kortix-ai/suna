import { test, expect } from '@playwright/test';
import { apiBase, loginToDashboard, ownerEmail, ownerPassword } from '../helpers/auth';

test.describe('06 — Files explorer scope isolation', () => {
  test.setTimeout(300_000);

  test('project files tab does not overwrite the global /files explorer root', async ({ page }) => {
    const bootstrapRes = await page.request.post(`${apiBase}/setup/bootstrap-owner`, {
      data: { email: ownerEmail, password: ownerPassword },
    });
    expect(bootstrapRes.ok()).toBeTruthy();

    await loginToDashboard(page);

    const projectsTab = page.getByRole('button', { name: 'Projects' });
    await expect(projectsTab).toBeVisible({ timeout: 30_000 });
    await projectsTab.click();

    const projectViewButton = page.getByRole('button', { name: 'View' }).first();
    await expect(projectViewButton).toBeVisible({ timeout: 30_000 });
    await projectViewButton.click();

    await expect(page).toHaveURL(/\/projects\//, { timeout: 30_000 });

    const filesTab = page.getByRole('button', { name: 'Files' });
    await expect(filesTab).toBeVisible({ timeout: 30_000 });
    await filesTab.click();

    await expect(page.getByRole('button', { name: /Open in editor/i })).toBeVisible({ timeout: 30_000 });

    await page.goto('/files');
    await expect(page).toHaveURL(/\/files$/, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: /\/workspace/i })).toBeVisible({ timeout: 30_000 });
  });
});
