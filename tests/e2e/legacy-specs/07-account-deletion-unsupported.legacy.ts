import { expect, test, type Locator, type Page } from '@playwright/test';
import { apiBase, ownerEmail, ownerPassword } from '../helpers/auth';

type BrowserErrorSnapshot = {
  pageErrors: string[];
};

function getSupabaseAnonKey() {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.resolve(__dirname, '../../../apps/web/.env');
  const content = fs.readFileSync(envPath, 'utf8');
  const match = content.match(/^NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)$/m);
  if (!match) {
    throw new Error(`NEXT_PUBLIC_SUPABASE_ANON_KEY not found in ${envPath}`);
  }
  return match[1].trim();
}

function getSupabaseCookieName() {
  const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:13737';
  const port = new URL(baseUrl).port;
  return port ? `sb-kortix-auth-token-${port}` : 'sb-kortix-auth-token';
}

async function bootstrapOwner(page: Page) {
  const bootstrapRes = await page.request.post(`${apiBase}/setup/bootstrap-owner`, {
    data: { email: ownerEmail, password: ownerPassword },
  });

  expect([200, 409]).toContain(bootstrapRes.status());
}

async function loginToWorkspace(page: Page) {
  const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://localhost:13740';
  const anonKey = getSupabaseAnonKey();
  const authRes = await page.request.post(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    headers: {
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    data: {
      email: ownerEmail,
      password: ownerPassword,
    },
  });

  expect(authRes.status()).toBe(200);
  const session = await authRes.json();

  await page.context().addCookies([
    {
      name: getSupabaseCookieName(),
      value: `base64-${Buffer.from(JSON.stringify(session)).toString('base64')}`,
      domain: 'localhost',
      path: '/',
      httpOnly: false,
      sameSite: 'Lax',
      secure: false,
    },
  ]);

  await page.goto('/workspace');

  const wizardHeading = page.getByRole('heading', { name: /Connect a provider/i });
  if (await wizardHeading.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await page.goto('/onboarding?skip_onboarding=1');
  }

  await expect(page).toHaveURL(/\/workspace|\/dashboard|\/instances/, { timeout: 30_000 });
}

async function openUserSettings(page: Page) {
  const userMenuTrigger = page
    .locator('[data-sidebar="menu-button"]')
    .filter({ hasText: ownerEmail })
    .first();

  await expect(userMenuTrigger).toBeVisible({ timeout: 30_000 });
  await userMenuTrigger.click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();

  const settingsDialog = page.locator('[role="dialog"]').filter({
    has: page.getByRole('button', { name: 'Save Changes' }),
  });

  await expect(settingsDialog).toBeVisible();
  return settingsDialog;
}

async function installBrowserErrorCapture(page: Page): Promise<BrowserErrorSnapshot> {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  await page.addInitScript(() => {
    const win = window as Window & { __accountDeletionUnhandledErrors?: string[] };
    win.__accountDeletionUnhandledErrors = [];

    window.addEventListener('error', (event) => {
      const message = event.error instanceof Error ? event.error.message : String(event.message);
      win.__accountDeletionUnhandledErrors?.push(message);
    });

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      win.__accountDeletionUnhandledErrors?.push(message);
    });
  });

  return { pageErrors };
}

async function readWindowErrors(page: Page) {
  return page.evaluate(() => {
    const win = window as Window & { __accountDeletionUnhandledErrors?: string[] };
    return win.__accountDeletionUnhandledErrors ?? [];
  });
}

async function cancelPendingDeletionIfPresent(page: Page, settingsDialog: Locator) {
  const cancelButton = settingsDialog.getByRole('button', { name: 'Cancel Deletion Request' });
  if (!(await cancelButton.isVisible().catch(() => false))) {
    return;
  }

  await cancelButton.click();
  const cancelDialog = page.locator('[role="alertdialog"]').filter({
    has: page.getByText('Are you sure you want to cancel the deletion of your account?'),
  });
  await expect(cancelDialog).toBeVisible();
  await cancelDialog.getByRole('button', { name: 'Cancel Deletion', exact: true }).click();
  await expect(page.getByText('Account deletion cancelled')).toBeVisible();
  await expect(cancelButton).toHaveCount(0);
}

test.describe('07 — Account deletion flow', () => {
  test('user can schedule and cancel account deletion from settings without unhandled errors', async ({ page }) => {
    const browserErrors = await installBrowserErrorCapture(page);

    await bootstrapOwner(page);
    await loginToWorkspace(page);

    const settingsDialog = await openUserSettings(page);
    await cancelPendingDeletionIfPresent(page, settingsDialog);

    const openDeleteDialogButton = settingsDialog.getByRole('button', {
      name: 'Delete Account',
      exact: true,
    });

    await expect(openDeleteDialogButton).toBeVisible();
    await openDeleteDialogButton.scrollIntoViewIfNeeded();
    await openDeleteDialogButton.click();

    const deleteDialog = page.locator('[role="dialog"]').filter({
      has: page.getByText('Type delete to confirm'),
    });

    await expect(deleteDialog).toBeVisible();
    await expect(deleteDialog.getByLabel('30-Day Grace Period')).toBeChecked();
    await deleteDialog.getByLabel('Type delete to confirm').fill('delete');
    await deleteDialog.getByRole('button', { name: 'Delete Account', exact: true }).click();

    await expect(page.getByText('Account deletion scheduled successfully')).toBeVisible();
    await expect(deleteDialog).toBeHidden();
    await expect(settingsDialog.getByText('Deletion Scheduled')).toBeVisible();
    await expect(settingsDialog.getByRole('button', { name: 'Cancel Deletion Request' })).toBeVisible();

    await settingsDialog.getByRole('button', { name: 'Cancel Deletion Request' }).click();
    const cancelDialog = page.locator('[role="alertdialog"]').filter({
      has: page.getByText('Are you sure you want to cancel the deletion of your account?'),
    });
    await expect(cancelDialog).toBeVisible();
    await cancelDialog.getByRole('button', { name: 'Cancel Deletion', exact: true }).click();

    await expect(page.getByText('Account deletion cancelled')).toBeVisible();
    await expect(settingsDialog.getByText('Deletion Scheduled')).toHaveCount(0);
    await expect(settingsDialog.getByRole('button', { name: 'Delete Account', exact: true })).toBeVisible();

    expect(browserErrors.pageErrors).toEqual([]);
    expect(await readWindowErrors(page)).toEqual([]);
  });
});
