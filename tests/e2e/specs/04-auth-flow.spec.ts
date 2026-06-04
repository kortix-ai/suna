import { test, expect } from '@playwright/test';
import { installBrowserSession, signIn } from '../helpers/session-auth';

const ownerEmail = process.env.E2E_OWNER_EMAIL || 'test-e2e@kortix.ai';
const ownerPassword = process.env.E2E_OWNER_PASSWORD || 'e2e-testpass-123';
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://localhost:13740',
  password: ownerPassword,
  envFiles: [`${process.env.HOME}/.kortix/.env`, 'apps/web/.env', 'apps/api/.env'],
};

test.describe('04 — Authentication flow', () => {
  test.setTimeout(120_000);

  test('owner can authenticate via Supabase API', async () => {
    const session = await signIn(ownerEmail, authOptions);
    expect(session.access_token).toBeTruthy();
    expect(session.access_token).toMatch(/^eyJ/); // JWT
  });

  test('browser login flow reaches wizard', async ({ page }) => {
    const session = await signIn(ownerEmail, authOptions);
    await installBrowserSession(page, session, '/projects', ownerPassword);

    const wizardHeading = page.getByRole('heading', { name: /Connect a provider/i });
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
