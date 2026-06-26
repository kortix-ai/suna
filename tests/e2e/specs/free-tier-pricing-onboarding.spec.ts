import { expect, test } from '@playwright/test';

test.describe('free-tier pricing and onboarding surface', () => {
  test('pricing page presents the free tier, model options, and sandbox compute terms', async ({
    page,
  }) => {
    await page.goto('/pricing', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: /simple per-seat/i })).toBeVisible();
    await expect(page.getByText('Free', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Team', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Enterprise', { exact: true }).first()).toBeVisible();

    await expect(page.getByText('500 credits / month for sandbox compute only')).toBeVisible();
    await expect(page.getByText('1 project', { exact: true })).toBeVisible();
    await expect(page.getByText('Free LLM models included')).toBeVisible();
    await expect(page.getByText('Bring your own API key for any premium model')).toBeVisible();
    await expect(page.getByText('2,000 usage credits per seat, pooled')).toBeVisible();
    await expect(
      page.getByText('Connect your ChatGPT subscription', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Credits reset monthly')).toBeVisible();
    await expect(page.getByText(/about \$0\.10\/hour/i).first()).toBeVisible();

    await expect(page.getByRole('link', { name: /start free/i }).first()).toHaveAttribute(
      'href',
      '/auth',
    );
  });
});
