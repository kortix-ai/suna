import { test, expect } from './fixtures';

test.describe('Example — landing or login flow', () => {
  test('app entry point responds with an HTML document', async ({ page }) => {
    const response = await page.goto('/');
    expect(response).toBeTruthy();
    expect(response!.ok()).toBeTruthy();
    await expect(page).toHaveTitle(/.+/);
  });

  test('landing page renders a primary heading', async ({ page }) => {
    await page.goto('/');
    const heading = page.getByRole('heading').first();
    await expect(heading).toBeVisible();
  });

  test('a sign-in affordance is reachable from the entry point', async ({ page }) => {
    await page.goto('/');

    const signIn = page
      .getByRole('link', { name: /sign in|log ?in|get started/i })
      .or(page.getByRole('button', { name: /sign in|log ?in|get started/i }))
      .first();

    await expect(signIn).toBeVisible();
    await signIn.click();

    const authAffordance = page
      .getByRole('textbox', { name: /email/i })
      .or(page.locator('input[type="email"], input[name="email"], input[type="password"]'))
      .or(page.getByRole('button', { name: /continue with|sign in with|log ?in with|google|github|sso|continue/i }))
      .or(page.getByRole('link', { name: /continue with|sign in with|google|github|sso/i }))
      .first();

    await expect(authAffordance).toBeVisible();
  });

  test('login form rejects an empty submission', async ({ page }) => {
    await page.goto('/auth');

    const submit = page
      .getByRole('button', { name: /sign in|log ?in|continue/i })
      .first();

    if (await submit.isVisible().catch(() => false)) {
      await submit.click();
      await expect(page).toHaveURL(/auth|login|sign-?in/i);
    } else {
      test.skip(true, 'No login form at /auth in this deployment');
    }
  });
});
