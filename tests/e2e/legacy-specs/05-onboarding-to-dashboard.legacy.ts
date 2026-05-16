import { test, expect } from '@playwright/test';
import { ownerEmail, ownerPassword, apiBase, getAccessTokenFromPage } from '../helpers/auth';
import { waitForSandboxReady } from '../helpers/wait';

test.describe('05 — Onboarding wizard to dashboard', () => {
  test.setTimeout(600_000);

  test('full flow: login -> wizard -> provider -> skip -> dashboard', async ({ page }) => {
    // ── 1. Bootstrap owner (idempotent) ────────────────────────────
    const bootstrapRes = await page.request.post(`${apiBase}/setup/bootstrap-owner`, {
      data: { email: ownerEmail, password: ownerPassword },
    });
    expect(bootstrapRes.status()).toBe(200);

    // ── 2. Sign in ─────────────────────────────────────────────────
    await page.goto('/auth');
    await page.waitForTimeout(2_000);

    // Click through lock screen overlay (div intercepts pointer events)
    const lockScreen = page.getByText('Click or press Enter to sign in');
    if (await lockScreen.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await page.locator('div.fixed.inset-0.cursor-pointer').first().click({ force: true });
      await page.waitForTimeout(1_500);
    }

    await expect(page.getByRole('heading', { name: 'Sign in to Kortix' })).toBeVisible({
      timeout: 15_000,
    });

    await page.locator('input[name="email"]').fill(ownerEmail);
    await page.locator('input[name="password"]').fill(ownerPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // ── 3. Wait for "Connect a provider" step ──────────────────────
    await expect(
      page.getByRole('heading', { name: /Connect a provider/i }),
    ).toBeVisible({ timeout: 180_000 });

    // ── 4. Wait for sandbox to be fully ready ──────────────────────
    const sandboxHealthUrl =
      process.env.E2E_SANDBOX_HEALTH_URL || 'http://localhost:14000/kortix/health';
    await waitForSandboxReady(sandboxHealthUrl);

    // ── 5. Click "Configure LLM Provider" ──────────────────────────
    const configureBtn = page.getByRole('button', { name: /Configure LLM Provider/i });
    if (await configureBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await configureBtn.click();
      // Wait for provider dialog / options
      await page.waitForTimeout(2_000);
    }

    // ── 6. Try to advance past provider step ───────────────────────
    // If there's a Continue button, click it. If not, use skip.
    const continueBtn = page.getByRole('button', { name: /Continue/i });
    if (await continueBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await continueBtn.click();
    }

    // ── 7. Handle tool keys step (skip) ────────────────────────────
    const skipBtn = page.getByRole('button', { name: /Skip for now/i });
    if (await skipBtn.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await skipBtn.click();
    }

    // ── 8. Skip onboarding to reach dashboard ──────────────────────
    await page.goto('/onboarding?skip_onboarding=1');
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });

    // ── 9. Verify dashboard content ────────────────────────────────
    await expect(page.getByRole('button', { name: /New session/i })).toBeVisible({
      timeout: 15_000,
    });

    // ── 10. Verify API access from dashboard ───────────────────────
    const token = await getAccessTokenFromPage(page);
    expect(token).toBeTruthy();

    // Test SSH setup endpoint
    const sshRes = await page.request.post(`${apiBase}/platform/sandbox/ssh/setup`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(sshRes.status()).toBe(200);
    const sshData = await sshRes.json();
    expect(sshData.success).toBeTruthy();

    // ── 11. Verify re-login works (user is authenticated) ──────────
    await page.context().clearCookies();
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });

    await page.goto('/auth');
    await page.waitForTimeout(2_000);
    const lockScreen2 = page.getByText('Click or press Enter to sign in');
    if (await lockScreen2.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await page.locator('div.fixed.inset-0.cursor-pointer').first().click({ force: true });
      await page.waitForTimeout(1_500);
    }

    // Login form should appear
    const emailInput = page.locator('input[name="email"]');
    await expect(emailInput).toBeVisible({ timeout: 10_000 });
    await emailInput.fill(ownerEmail);
    await page.locator('input[name="password"]').fill(ownerPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // After re-login: may go to dashboard, onboarding, or stay on /auth
    // showing the wizard. All are valid — the key test is that the user
    // is authenticated and sees either the wizard or the dashboard.
    await page.waitForTimeout(5_000);

    const wizardVisible = await page
      .getByRole('heading', { name: /Connect a provider/i })
      .isVisible()
      .catch(() => false);
    const dashboardVisible = await page
      .getByRole('button', { name: /New session/i })
      .isVisible()
      .catch(() => false);
    const onboardingUrl = page.url().includes('/onboarding');
    const dashboardUrl = page.url().includes('/dashboard');

    expect(wizardVisible || dashboardVisible || onboardingUrl || dashboardUrl).toBe(true);
  });
});
