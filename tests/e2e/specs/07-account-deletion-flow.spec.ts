import { expect, test, type Page } from '@playwright/test';
import { apiBase, loginToDashboard, ownerEmail, ownerPassword } from '../helpers/auth';

async function bootstrapOwner(page: Page) {
  const bootstrapRes = await page.request.post(`${apiBase}/setup/bootstrap-owner`, {
    data: { email: ownerEmail, password: ownerPassword },
  });

  if (bootstrapRes.status() === 200) {
    return ownerEmail;
  }

  expect(bootstrapRes.status()).toBe(409);
  const body = await bootstrapRes.json() as { error?: string };
  const existingEmail = body.error?.match(/Owner already exists \(([^)]+)\)/)?.[1];
  expect(existingEmail).toBeTruthy();

  const resetRes = await page.request.post(`${apiBase}/setup/bootstrap-owner`, {
    data: { email: existingEmail, password: ownerPassword },
  });
  expect(resetRes.status()).toBe(200);
  return existingEmail!;
}

async function openUserSettings(page: Page) {
  await page.goto('/instances?settings=general', { waitUntil: 'domcontentloaded', timeout: 120_000 });

  const settingsDialog = page.locator('[role="dialog"]').filter({
    has: page.getByRole('button', { name: 'Save Changes' }),
  });

  await expect(settingsDialog).toBeVisible({ timeout: 15_000 });
  return settingsDialog;
}

async function cancelDeletionViaUiIfPresent(page: Page) {
  const cancelButton = page.getByRole('button', {
    name: /Cancel Deletion|Cancel deletion|Cancel scheduled deletion/i,
  });

  if (!(await cancelButton.isVisible({ timeout: 3_000 }).catch(() => false))) {
    return;
  }

  await cancelButton.click();

  const cancelDialog = page.locator('[role="alertdialog"]').filter({
    has: page.getByRole('button', { name: /Cancel deletion/i }),
  });
  await expect(cancelDialog).toBeVisible();

  const cancelPromise = page.waitForResponse((response) =>
    response.url().includes('/account/cancel-deletion') && response.request().method() === 'POST',
  );
  await cancelDialog.getByRole('button', { name: /Cancel deletion/i }).click();
  const cancelResponse = await cancelPromise;
  expect(cancelResponse.status()).toBe(200);

  await expect(page.getByText(/Account deletion scheduled/i)).toHaveCount(0);
}

test.describe('07 — Account deletion flow', () => {
  test.setTimeout(240_000);

  test('user can schedule and then cancel account deletion cleanly', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const loginEmail = await bootstrapOwner(page);
    await loginToDashboard(page, { email: loginEmail, password: ownerPassword });

    const settingsDialog = await openUserSettings(page);
    await cancelDeletionViaUiIfPresent(page);

    const openDeleteDialogButton = settingsDialog.getByRole('button', {
      name: 'Delete Account',
      exact: true,
    });

    await openDeleteDialogButton.scrollIntoViewIfNeeded();
    await expect(openDeleteDialogButton).toBeVisible();
    await openDeleteDialogButton.click();

    const deleteDialog = page.locator('[role="dialog"]').filter({
      has: page.locator('#delete-confirm'),
    });

    await expect(deleteDialog).toBeVisible();
    await deleteDialog.locator('#delete-confirm').fill('delete');

    const requestPromise = page.waitForResponse((response) =>
      response.url().includes('/account/request-deletion') && response.request().method() === 'POST',
    );
    await deleteDialog.getByRole('button', { name: 'Delete Account', exact: true }).click();
    const requestResponse = await requestPromise;
    expect(requestResponse.status()).toBe(200);

    await expect(page.getByText(/Account deletion scheduled/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /Cancel Deletion|Cancel deletion|Cancel scheduled deletion/i })).toBeVisible();

    const cancelButton = page.getByRole('button', { name: /Cancel Deletion|Cancel deletion|Cancel scheduled deletion/i });
    await cancelButton.click();

    const cancelDialog = page.locator('[role="alertdialog"]').filter({
      has: page.getByRole('button', { name: /Cancel deletion/i }),
    });
    await expect(cancelDialog).toBeVisible();

    const cancelPromise = page.waitForResponse((response) =>
      response.url().includes('/account/cancel-deletion') && response.request().method() === 'POST',
    );
    await cancelDialog.getByRole('button', { name: /Cancel deletion/i }).click();
    const cancelResponse = await cancelPromise;
    expect(cancelResponse.status()).toBe(200);

    await expect(page.getByText(/Account deletion scheduled/i)).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  });
});
