import { type Response, expect, test } from '@playwright/test';

import { createApiJsonClient } from '../helpers/http';
import { type ManifestProject, createManifestProject } from '../helpers/manifest-project';
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

/**
 * Permissions decide what a project MEMBER sees of Customize.
 *
 * `project.customize.read` used to gate the whole surface, so a member saw
 * none of it. It was split into one leaf per topic, and there is no surface
 * gate any more: each tab's body opens when its own read leaf is held. A plain
 * project member holds `project.agent.read` and `project.trigger.read`, so it
 * opens Agents and Triggers read-only and gets the no-access body elsewhere —
 * and no page may fire a project request the member is not allowed to make (a
 * 403 here is a control or a load the member can never complete).
 */

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const databaseUrl = process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const password = 'E2eMemberCustomize123!';
const authOptions = { supabaseUrl, password };
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role: string;
}

test.describe('38 — a project member sees Customize read-only', () => {
  test('Agents and Triggers open, the rest show no-access, no forbidden project request', async ({ page }) => {
    test.skip(!databaseUrl, 'KE2E_DATABASE_URL is required');
    test.setTimeout(180_000);

    const runId = Date.now().toString(36);
    const ownerEmail = `e2e-customize-owner-${runId}@example.test`;
    const memberEmail = `e2e-customize-member-${runId}@example.test`;
    const owner = await createAuthUser(ownerEmail, authOptions);
    const member = await createAuthUser(memberEmail, authOptions);
    const ownerSession = await signIn(ownerEmail, authOptions);
    let project: ManifestProject | null = null;

    try {
      const accounts = await api<AccountSummary[]>(ownerSession.access_token, 'GET', '/accounts');
      const account = accounts.find(
        (item) => item.personal_account || item.is_primary_owner || item.account_role === 'owner',
      );
      if (!account) throw new Error('the seeded owner owns no account');
      const accountId = account.account_id;

      project = await createManifestProject({
        api,
        accessToken: ownerSession.access_token,
        accountId,
        userId: owner.id,
        name: `Member customize ${runId}`,
        databaseUrl: databaseUrl!,
      });
      const projectId = project.id;

      await api(
        ownerSession.access_token,
        'POST',
        `/accounts/${accountId}/members`,
        { email: memberEmail, role: 'member' },
        201,
      );
      await api(ownerSession.access_token, 'PUT', `/projects/${projectId}/access/${member.id}`, {
        role: 'member',
      });

      const memberSession = await signIn(memberEmail, authOptions);
      const forbidden: string[] = [];
      page.on('response', (response: Response) => {
        const url = response.url();
        if (response.status() === 403 && url.includes(`/projects/${projectId}`)) {
          forbidden.push(`${response.request().method()} ${new URL(url).pathname}`);
        }
      });

      await installBrowserSessionDirect(page, memberSession, `/projects/${projectId}`, authOptions);
      await selectAccountForUi(page, accountId);
      await page.goto(`/projects/${projectId}/customize/agents`, { waitUntil: 'domcontentloaded' });
      await dismissOnboarding(page);

      // The tab bar is static (#9042): every label paints on the first frame.
      // Access is decided in the body, per tab, by that tab's own read leaf.
      const noAccess = page.locator('[data-slot="capability-no-access"]');
      // Let the tab's reads settle before asserting. Staging is a protected
      // Vercel preview: its injected toolbar (vercel.live feedback) keeps a
      // connection the trace never closes, so networkidle can wait forever
      // (gate 37548429782). Bound it, as 09-admin-console and 30-git-connections do.
      const settle = () => page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      await expect(page.getByRole('tab', { name: 'Agents' })).toBeVisible({ timeout: 60_000 });
      await settle();
      await expect(noAccess).toHaveCount(0);

      await page.getByRole('tab', { name: 'Triggers' }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/customize/triggers`));
      await settle();
      await expect(noAccess).toHaveCount(0);

      // A tab whose read leaf the member lacks shows the no-access body and
      // fires none of that page's requests.
      for (const [label, segment] of [
        ['Connectors', 'connectors'],
        ['Secrets', 'secrets'],
        ['Settings', 'settings'],
      ] as const) {
        await page.getByRole('tab', { name: label }).click();
        await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/customize/${segment}`));
        await expect(noAccess).toBeVisible();
      }
      await settle();

      expect(forbidden).toEqual([]);
    } finally {
      await project?.dispose().catch(() => undefined);
      await deleteAuthUser(member.id, authOptions).catch(() => undefined);
      await deleteAuthUser(owner.id, authOptions).catch(() => undefined);
    }
  });
});
