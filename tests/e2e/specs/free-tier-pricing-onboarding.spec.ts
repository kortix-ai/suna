import { expect, test } from '@playwright/test';

test.describe('free-tier pricing and onboarding surface', () => {
  test('@target-smoke pricing page presents the free tier, model options, and sandbox compute terms', async ({
    page,
  }) => {
    await page.goto('/pricing', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: /simple credit pricing/i })).toBeVisible();
    await expect(page.getByText('Free', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Credits', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Enterprise', { exact: true }).first()).toBeVisible();

    await expect(page.getByText('200 credits / month, no card needed').first()).toBeVisible();
    await expect(page.getByText('1 project', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Bring your own API key for any premium model')).toBeVisible();
    await expect(page.getByText('Unlimited members, one shared credit pool')).toBeVisible();
    await expect(page.getByText('Unused credits roll over one month')).toBeVisible();
    await expect(
      page.getByText('Connect your ChatGPT subscription', { exact: true }),
    ).toBeVisible();

    // The credits card opens on Pro and updates the credits line live.
    await expect(page.getByText('10,000 credits / month')).toBeVisible();
    await page.getByRole('radio', { name: /Scale/ }).click();
    await expect(page.getByText('50,000 credits / month')).toBeVisible();
    await page.getByLabel('Monthly amount in dollars').fill('250');
    await expect(page.getByText('25,000 credits / month')).toBeVisible();

    await expect(page.getByRole('link', { name: /get started/i }).first()).toHaveAttribute(
      'href',
      '/auth',
    );
  });
});
