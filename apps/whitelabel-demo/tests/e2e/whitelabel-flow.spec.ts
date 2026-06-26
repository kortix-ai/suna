import { expect, test } from '@playwright/test';

test('registers a user, runs a backend session, and gets a streamed agent reply', async ({
  page,
}) => {
  const email = `demo-${Date.now()}@example.test`;

  // Register
  await page.goto('/register');
  await expect(page.getByRole('heading', { name: /create your .* account/i })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('demo-pass-123');
  await page.getByRole('button', { name: /create account/i }).click();

  // Home composer
  await expect(page.getByRole('heading', { name: /what should we build/i })).toBeVisible();
  const prompt = 'Add a short overview section to the README.';
  await page.getByPlaceholder(/ask the agent to build/i).fill(prompt);
  await page.getByRole('button', { name: /start session/i }).click();

  // Session page — the prompt shows as a user message and the agent streams a reply
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]+$/);
  await expect(page.getByText(prompt, { exact: false }).first()).toBeVisible();

  if (process.env.WHITELABEL_E2E_REAL_BACKEND !== '1') {
    // Initial agent run streams in (assistant text + tool cards)
    await expect(page.getByText(/take a look at the project/i)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/package\.json/i)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/added a concise overview/i)).toBeVisible({ timeout: 60_000 });

    // Real follow-up send — the agent responds and streams back, doing work
    const followUp = 'Create a simple contact page.';
    await page.getByPlaceholder(/reply to the agent/i).fill(followUp);
    await page.getByRole('button', { name: /send message/i }).click();
    await expect(page.getByText(followUp, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/index\.html/i).first()).toBeVisible({ timeout: 30_000 });
  }
});
