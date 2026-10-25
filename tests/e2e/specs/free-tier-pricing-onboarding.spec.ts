import { expect, test } from '@playwright/test';

test.describe('free-tier pricing and onboarding surface', () => {
  test('@target-smoke pricing page presents the free tier, model options, and sandbox compute terms', async ({
    page,
  }) => {
    await page.goto('/pricing', { waitUntil: 'domcontentloaded' });

    await expect(
      page.getByRole('heading', { level: 1, name: 'Start free. Pay only for what your agents use.' }),
    ).toBeVisible();
    await expect(page.getByText('Free', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Credits', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Enterprise', { exact: true }).first()).toBeVisible();

    await expect(page.getByText('500 credits / month, no card needed').first()).toBeVisible();
    await expect(page.getByText('1 project', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Bring your own API key for any premium model')).toBeVisible();
    // The hero and the Credits card both state the shared pool.
    await expect(page.getByText('Unlimited members, one shared credit pool')).toBeVisible();
    await expect(page.getByText('Unused credits roll over one month')).toBeVisible();
    await expect(
      page.getByText('Connect your ChatGPT subscription', { exact: true }),
    ).toBeVisible();

    // Models and sandbox compute are billed apart: the agent-hours and models sections.
    await expect(page.getByRole('heading', { name: /1 credit buys about \d+ minutes of agent computer/ })).toBeVisible();
    await expect(page.getByText('Compute rates', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Models are billed separately from the agent computer' }),
    ).toBeVisible();

    // The Credits card opens on the $200 tier; picking a tier updates the card live.
    const tier = page.getByRole('slider', { name: 'Monthly credits tier' });
    await expect(tier).toHaveAttribute('aria-valuetext', '20,000 credits, $200 / mo');
    await tier.focus();
    for (let step = 0; step < 3; step++) await tier.press('ArrowRight');
    await expect(tier).toHaveAttribute('aria-valuetext', '50,000 credits, $500 / mo');
    await expect(page.getByText('$500', { exact: true })).toBeVisible();
    await expect(page.getByText(/agent-computer hours a month/)).toBeVisible();

    await expect(page.getByRole('link', { name: /get started/i }).first()).toHaveAttribute(
      'href',
      '/auth',
    );
  });
});
