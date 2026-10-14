import { expect, test } from '@playwright/test';

import { createApiJsonClient } from '../helpers/http';
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

/**
 * KRTX-2291: `/settings/api-keys` opened the personal settings on Profile. The
 * personal API keys tab was renamed `tokens`, and the standalone `[tab]` route
 * did not follow the rename. A deep link opens the tab it names, under its old
 * or its new name; an unknown segment still opens Profile.
 */

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
  password: 'E2eSettingsDeepLinks123!',
};
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role: string;
}

test('50 — a settings deep link opens the tab it names', async ({ page }) => {
  test.setTimeout(180_000);
  const email = `e2e-settings-links-${Date.now().toString(36)}@example.test`;
  const user = await createAuthUser(email, authOptions);
  try {
    const session = await signIn(email, authOptions);
    const accounts = await api<AccountSummary[]>(session.access_token, 'GET', '/accounts');
    const account = accounts.find(
      (item) => item.personal_account || item.is_primary_owner || item.account_role === 'owner',
    );
    if (!account) throw new Error('test user has no personal account');
    await installBrowserSessionDirect(page, session, '/favicon.png', authOptions);
    await selectAccountForUi(page, account.account_id);

    for (const [path, tab] of [
      ['/settings/api-keys', 'Personal access keys'],
      ['/settings/tokens', 'Personal access keys'],
      ['/settings/security', 'Security'],
      ['/settings/not-a-tab', 'Profile'],
    ] as const) {
      await test.step(`${path} opens ${tab}`, async () => {
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        await dismissOnboarding(page);
        const selected = page.getByRole('dialog').getByRole('tab', { name: tab, exact: true });
        await expect(selected).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 });
      });
    }
  } finally {
    await deleteAuthUser(user.id, authOptions).catch(() => {});
  }
});
