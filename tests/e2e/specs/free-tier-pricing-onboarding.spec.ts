import { expect, test } from '@playwright/test';

const previewTarget = process.env.KE2E_TARGET === 'preview';

test.describe('free-tier pricing and onboarding surface', () => {
  test('@target-smoke pricing page presents the free tier, model options, and sandbox compute terms', async ({
    page,
  }) => {
    if (previewTarget) {
      const redirect = await page.request.get('/pricing', { maxRedirects: 0 });
      expect(redirect.status()).toBe(307);
      expect(redirect.headers().location).toBe('/auth');
      await page.goto('/pricing', { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL((url) => url.pathname === '/auth');
      await expect(page.getByRole('heading', { name: 'Welcome to Kortix' })).toBeVisible();
      await expect(page.locator('form').first()).toBeVisible();
      return;
    }

    await page.goto('/pricing', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: /simple per-seat/i })).toBeVisible();
    await expect(page.getByText('Free', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Team', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Enterprise', { exact: true }).first()).toBeVisible();

    await expect(page.getByText('200 credits / month for sandbox compute')).toBeVisible();
    await expect(page.getByText('1 project', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Bring your own API key for any premium model')).toBeVisible();
    await expect(page.getByText('2,500 credits / month per seat, pooled')).toBeVisible();
    await expect(
      page.getByText('Connect your ChatGPT subscription', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Optional managed models use pooled credits')).toBeVisible();
    await expect(page.getByText(/about 125 default Agent Computer hours/i).first()).toBeVisible();

    await expect(page.getByRole('link', { name: /get started/i }).first()).toHaveAttribute(
      'href',
      '/auth',
    );
  });
});
