import { test, expect } from '@playwright/test';
import { ownerEmail, ownerPassword, getAccessToken } from '../helpers/auth';

test.describe('04 — Authentication flow', () => {
  test.setTimeout(120_000);

  test('owner can authenticate via Supabase API', async () => {
    const token = await getAccessToken();
    expect(token).toBeTruthy();
    expect(token).toMatch(/^eyJ/); // JWT
  });

  test('browser login flow reaches wizard', async ({ page }) => {
    // Clear any existing session
    await page.context().clearCookies();

    await page.goto('/auth');
    await page.waitForTimeout(2_000);

    // Click through lock screen — the overlay div intercepts pointer events,
    // so we click the page body which triggers the overlay's click handler.
    const lockScreen = page.getByText('Click or press Enter to sign in');
    if (await lockScreen.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await page.locator('div.fixed.inset-0.cursor-pointer').first().click({ force: true });
      await page.waitForTimeout(1_500);
    }

    // May already be authenticated from a prior session, or show auth form.
    const signUpHeading = page.getByRole('heading', { name: 'Create your account' });
    const signInHeading = page.getByRole('heading', { name: 'Sign in to Kortix' });
    const wizardHeading = page.getByRole('heading', { name: /Connect a provider/i });

    // Wait for either the auth form or the wizard
    await expect(signUpHeading.or(signInHeading).or(wizardHeading)).toBeVisible({ timeout: 15_000 });

    // If login form is showing, fill and submit
    if (await signUpHeading.isVisible().catch(() => false)) {
      await page.getByRole('button', { name: /^Sign in$/i }).first().click();
    }
    if (await signInHeading.isVisible().catch(() => false)) {
      const usePassword = page.getByRole('button', { name: /Use password instead/i });
      if (await usePassword.isVisible().catch(() => false)) {
        await usePassword.click();
      }
      await page.locator('input[name="email"]').fill(ownerEmail);
      await page.locator('input[name="password"]').fill(ownerPassword);
      await page.locator('form').getByRole('button', { name: /^Sign in$/i }).click();
    }

    // Should reach the setup wizard or the v1 project shell.
    const projectsHeading = page.getByRole('heading', { name: 'Projects', exact: true });
    const newProjectButton = page.getByRole('button', { name: /New project|Add new project/i }).first();
    const visibleShell = await Promise.race([
      wizardHeading.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false),
      projectsHeading.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false),
      newProjectButton.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false),
    ]);
    expect(visibleShell).toBe(true);
    expect(page.url()).not.toContain('/instances');
    expect(page.url()).not.toContain('/dashboard');
  });
});
