import { expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import {
  createDatabaseProject,
  deleteDatabaseProject,
  setDatabaseEnterpriseDemo,
} from '../../src/fixtures/database-project';
import { runDatabaseSql } from '../helpers/database';
import { createApiJsonClient } from '../helpers/http';
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

/**
 * KRTX-2326, KRTX-2327: the account hub's bulk remove and the branding tab's
 * upload controls rendered English on every locale. A German owner of an
 * Enterprise account with one other member and an uploaded logo sees them in
 * German: the bulk remove button and its plural, and the uploaded, replace and
 * remove controls.
 *
 * KRTX-2399, KRTX-2400: the audit log's quick filters were keyed by their
 * translated labels, so outside English a click applied nothing, and a secret
 * write's audit title stayed English. In German the title reads German and the
 * Agenten filter applies.
 *
 * Local only: the Enterprise flag and the logo are written into the database.
 */

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
  password: 'E2eAccountSettingsDe123!',
};
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  name?: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role: string;
}

test(
  '51 — account settings render the bulk remove and branding controls in German',
  { tag: '@local-only' },
  async ({ page, baseURL }) => {
    test.setTimeout(240_000);
    const env = loadEnv();
    if (!env.databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
    const runId = Date.now().toString(36);
    const owner = await createAuthUser(`e2e-account-de-owner-${runId}@example.test`, authOptions);
    const member = await createAuthUser(`e2e-account-de-member-${runId}@example.test`, authOptions);
    let projectId: string | null = null;
    try {
      // The locale lives in the profile metadata, which the session cookie carries.
      const first = await signIn(`e2e-account-de-owner-${runId}@example.test`, authOptions);
      await api(first.access_token, 'PATCH', '/auth/user', { data: { locale: 'de' } });
      const session = await signIn(`e2e-account-de-owner-${runId}@example.test`, authOptions);

      const accounts = await api<AccountSummary[]>(session.access_token, 'GET', '/accounts');
      const account = accounts.find(
        (item) => item.personal_account || item.is_primary_owner || item.account_role === 'owner',
      );
      if (!account) throw new Error('test user has no personal account');
      const accountId = account.account_id;
      await setDatabaseEnterpriseDemo(env, accountId, true);
      await runDatabaseSql(
        "UPDATE kortix.accounts SET branding = jsonb_build_object('logo_url', $2::text) WHERE account_id = $1",
        [accountId, new URL('/favicon.png', baseURL ?? 'http://localhost:3000').href],
        env.databaseUrl,
      );
      await api(session.access_token, 'POST', `/accounts/${accountId}/members`, {
        email: `e2e-account-de-member-${runId}@example.test`,
        role: 'member',
      }, 201);
      const project = await createDatabaseProject(env, {
        accountId,
        userId: owner.id,
        name: `Account settings ${runId}`,
      });
      projectId = project.id;

      await installBrowserSessionDirect(page, session, '/favicon.png', authOptions);
      await selectAccountForUi(page, accountId);

      await test.step('bulk remove: the button, the plural and the confirm label are German', async () => {
        await page.goto(`/projects/${projectId}?accountId=${accountId}&accountTab=members`, {
          waitUntil: 'domcontentloaded',
        });
        await dismissOnboarding(page);
        await expect(page.locator('html')).toHaveAttribute('lang', 'de', { timeout: 60_000 });
        await page.getByRole('checkbox', { name: 'Alle auswählen', exact: true }).click({ timeout: 60_000 });
        await page.getByRole('button', { name: 'Entfernen', exact: true }).click();
        const dialog = page.getByRole('alertdialog');
        await expect(dialog.getByText(/^1 Mitglied verliert den Zugriff auf /)).toBeVisible();
        await expect(dialog.getByRole('button', { name: '1 entfernen', exact: true })).toBeVisible();
        await expect(dialog.getByText(/member(s)? lose/)).toHaveCount(0);
        await dialog.getByRole('button', { name: 'Abbrechen' }).click();
      });

      await test.step('branding: uploaded, replace, upload and remove are German', async () => {
        await page.goto(`/projects/${projectId}?accountId=${accountId}&accountTab=branding`, {
          waitUntil: 'domcontentloaded',
        });
        await dismissOnboarding(page);
        await expect(page.getByRole('button', { name: 'Ersetzen', exact: true })).toBeVisible({ timeout: 60_000 });
        await expect(page.getByText('Hochgeladen', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'logo (hell) entfernen', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Hochladen', exact: true }).first()).toBeVisible();
        for (const english of ['Uploaded', 'Replace', 'Upload']) {
          await expect(page.getByText(english, { exact: true })).toHaveCount(0);
        }
      });

      await test.step('audit: a secret write reads German, and a translated quick filter applies', async () => {
        await api(
          session.access_token,
          'PUT',
          `/projects/${projectId}/secrets/E2E_AUDIT_KEY/personal`,
          { value: 'synthetic' },
          200,
        );
        const auditReads: string[] = [];
        page.on('request', (request) => {
          const url = new URL(request.url());
          if (url.pathname.endsWith(`/accounts/${accountId}/audit`)) auditReads.push(url.search);
        });
        await page.goto(`/projects/${projectId}?accountId=${accountId}&accountTab=audit`, {
          waitUntil: 'domcontentloaded',
        });
        await dismissOnboarding(page);
        await expect(page.getByText('Persönliches Secret gesetzt').first()).toBeVisible({ timeout: 60_000 });
        const agents = page.getByRole('tab', { name: 'Agenten', exact: true });
        await agents.click();
        await expect(agents).toHaveAttribute('aria-selected', 'true');
        await expect.poll(() => auditReads.some((search) => search.includes('actor_type=agent'))).toBe(true);
        const all = page.getByRole('tab', { name: 'Alle Aktivitäten', exact: true });
        await all.click();
        await expect(all).toHaveAttribute('aria-selected', 'true');
      });
    } finally {
      if (projectId) await deleteDatabaseProject(env, projectId).catch(() => {});
      await deleteAuthUser(member.id, authOptions).catch(() => {});
      await deleteAuthUser(owner.id, authOptions).catch(() => {});
    }
  },
);
