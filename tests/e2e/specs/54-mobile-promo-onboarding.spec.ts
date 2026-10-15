import { type Page, expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseProject } from '../../src/fixtures/database-project';
import { queryDatabaseRows } from '../helpers/database';
import { createApiJsonClient } from '../helpers/http';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { selectAccountForUi } from '../helpers/ui';

/**
 * KRTX-2378 / KRTX-2396: the "Kortix, now on your phone" introduction waits
 * until onboarding is done, so it never opens behind or over the onboarding
 * wizard. "Skip for now" closes the wizard in place (it used to stay on screen
 * until a reload). Then the introduction opens once, and a close sticks across
 * a reload.
 */

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
  password: 'E2eMobilePromo123!',
  showMobileAppPromo: true,
};
const api = createApiJsonClient(apiBase);
const PROMO_TITLE = 'Kortix, now on your phone';
const WIZARD_TITLE = 'What do you mostly work on?';

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
}

/** The promo's title in the DOM, open or not: a modal behind another one is aria-hidden, so no role query. */
const promoTitle = (page: Page) => page.getByText(PROMO_TITLE, { exact: true });

test('54 — the mobile app promo waits for onboarding, and a close sticks', async ({ page }) => {
  test.setTimeout(300_000);
  const env = loadEnv();
  if (!env.databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
  const runId = Date.now().toString(36);
  const email = `e2e-mobile-promo-${runId}@example.test`;
  const user = await createAuthUser(email, authOptions);
  let projectId: string | undefined;

  try {
    const auth = await signIn(email, authOptions);
    const accounts = await api<AccountSummary[]>(auth.access_token, 'GET', '/accounts');
    const accountId = (accounts.find((item) => item.personal_account) ?? accounts[0]).account_id;
    // Onboarding pending, as on an account's first project.
    projectId = (
      await createDatabaseProject(env, {
        accountId,
        userId: user.id,
        name: `Mobile promo ${runId}`,
        metadata: { onboarding_completed_at: null },
      })
    ).id;

    await installBrowserSessionDirect(page, auth, `/projects/${projectId}`, authOptions);
    await selectAccountForUi(page, accountId);

    await test.step('while onboarding is pending, the wizard shows and the promo is not mounted', async () => {
      await expect(page.getByText(WIZARD_TITLE, { exact: true })).toBeVisible({ timeout: 120_000 });
      // The promo opens right after hydration; give it the time it would take.
      await page.waitForTimeout(3_000);
      await expect(promoTitle(page)).toHaveCount(0);
    });

    await test.step('Skip for now stamps the project and closes the wizard in place; then the promo opens', async () => {
      await page.getByRole('button', { name: 'Skip for now' }).first().click();
      await expect(page.getByText(WIZARD_TITLE, { exact: true })).toHaveCount(0, { timeout: 10_000 });
      await expect
        .poll(async () =>
          (await queryDatabaseRows<{ stamped: boolean }>(
            "SELECT metadata ? 'onboarding_completed_at' AND metadata->>'onboarding_completed_at' IS NOT NULL AS stamped FROM kortix.projects WHERE project_id = $1",
            [projectId],
            env.databaseUrl,
          ))[0]?.stamped,
        )
        .toBe(true);
      await expect(promoTitle(page)).toBeVisible({ timeout: 30_000 });
    });

    await test.step('Close closes it for good: stored as closed, and gone after a reload', async () => {
      await page.getByRole('dialog').filter({ has: promoTitle(page) }).getByRole('button', { name: /close/i }).first().click();
      await expect(promoTitle(page)).toHaveCount(0);
      expect(await page.evaluate(() => localStorage.getItem('kortix.mobileAppPromo'))).toContain('"closed":true');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(3_000);
      await expect(promoTitle(page)).toHaveCount(0);
    });
  } finally {
    if (projectId) {
      const auth = await signIn(email, authOptions).catch(() => null);
      if (auth) await api(auth.access_token, 'DELETE', `/projects/${projectId}`, undefined, [200, 204, 404]).catch(() => undefined);
    }
    await deleteAuthUser(user.id, authOptions).catch(() => undefined);
  }
});
