import { type Page, expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import {
  createDatabaseSession,
  setDatabaseEnterpriseDemo,
} from '../../src/fixtures/database-project';
import { createApiJsonClient } from '../helpers/http';
import { type ManifestProject, createManifestProject } from '../helpers/manifest-project';
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';

const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const databaseUrl = process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
const password = 'E2eTriggerAccess123!';
const authOptions = { supabaseUrl, password };
const api = createApiJsonClient(apiBase);

interface AccountSummary {
  account_id: string;
  personal_account?: boolean;
  is_primary_owner?: boolean;
  account_role: string;
}

interface TriggerList {
  triggers: Array<{
    slug: string;
    session_access: {
      mode: 'private' | 'project' | 'members';
      memberIds: string[];
      groupIds: string[];
    };
  }>;
}

async function openTriggerAccess(page: Page, projectId: string) {
  // Schedules graduated out of the Settings overlay before this branch (it
  // already redirected to the merged Triggers capability page —
  // `settings-tabs.ts` GRADUATED map: `schedules: (p) => \`/projects/${p}/triggers\``).
  // Navigate straight there instead of through the now-gone overlay tab; the
  // row click / detail-sheet mechanics below are unchanged.
  await page.goto(`/projects/${projectId}/triggers`, { waitUntil: 'domcontentloaded' });
  await dismissOnboarding(page);
  const panel = page.locator('body');
  await panel.getByRole('button', { name: 'Access policy UI', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Access policy UI', exact: true });
  await expect(sheet).toBeVisible();
  const section = sheet.locator('section', { hasText: 'Session access' });
  await expect(section).toBeVisible();
  await expect(section.getByRole('heading', { name: 'Session access', exact: true })).toBeVisible();
  return { panel, section, sheet };
}

test.describe('21 — Trigger-created session access UI', () => {
  test('defaults private and saves selected members and groups through the trigger PATCH', async ({
    page,
  }) => {
    test.skip(!databaseUrl, 'KE2E_DATABASE_URL is required');
    test.setTimeout(180_000);

    const runId = Date.now().toString(36);
    const email = `e2e-trigger-access-${runId}@example.test`;
    const groupName = `Trigger reviewers ${runId}`;
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    const env = loadEnv();
    let projectId: string | null = null;
    let accountId: string | null = null;
    let groupId: string | null = null;
    let project: ManifestProject | null = null;
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      const accounts = await api<AccountSummary[]>(session.access_token, 'GET', '/accounts');
      const account = accounts.find(
        (item) => item.personal_account || item.is_primary_owner || item.account_role === 'owner',
      );
      if (!account) throw new Error('the seeded user owns no account');
      accountId = account.account_id;
      await setDatabaseEnterpriseDemo(env, accountId, true);

      // POST /triggers commits the trigger into the project's kortix.yaml, so
      // the API must be able to reach the repo. On a deployed target a local
      // bare repo under the runner's /tmp is invisible to it and the write
      // answers 502 (edge: 503 MAINTENANCE_MODE). See helpers/manifest-project.
      project = await createManifestProject({
        api,
        accessToken: session.access_token,
        accountId,
        userId: user.id,
        name: `Trigger access UI ${runId}`,
        databaseUrl: databaseUrl!,
      });
      projectId = project.id;

      const ownSessionId = await createDatabaseSession(env, {
        projectId,
        accountId,
        userId: user.id,
        visibility: 'private',
        metadata: { custom_name: 'My private chat' },
      });
      const sharedTriggerSessionId = await createDatabaseSession(env, {
        projectId,
        accountId,
        userId: crypto.randomUUID(),
        visibility: 'private',
        metadata: {
          custom_name: 'Shared scheduled session',
          source: 'trigger:scheduler',
          trigger_kind: 'git',
          trigger_slug: 'access-policy-ui',
          trigger_source: 'cron',
          trigger_type: 'cron',
        },
      });

      const group = await api<{ group_id: string }>(
        session.access_token,
        'POST',
        `/accounts/${accountId}/iam/groups`,
        { name: groupName },
        201,
      );
      groupId = group.group_id;

      await api<TriggerList>(
        session.access_token,
        'POST',
        `/projects/${projectId}/triggers`,
        {
          name: 'Access policy UI',
          type: 'cron',
          cron: '0 0 3 * * *',
          timezone: 'UTC',
          prompt_template: 'Review the access policy.',
        },
        201,
      );

      await installBrowserSessionDirect(page, session, `/projects/${projectId}`, authOptions);
      await selectAccountForUi(page, accountId);
      await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
      await dismissOnboarding(page);

      const ownSidebarLink = page.locator(`a[href$="/sessions/${ownSessionId}"]`);
      const sharedSidebarLink = page.locator(`a[href$="/sessions/${sharedTriggerSessionId}"]`);
      const ownSidebarRow = ownSidebarLink.locator('..');
      const sharedSidebarRow = sharedSidebarLink.locator('..');
      await expect(ownSidebarLink).toBeVisible();
      await expect(ownSidebarRow.locator('[data-session-shared="true"]')).toHaveCount(0);
      await expect(sharedSidebarLink).toBeVisible();
      await expect(sharedSidebarRow.locator('[data-session-shared="true"]')).toHaveAttribute(
        'aria-label',
        /^Shared by /,
      );
      await expect(sharedSidebarRow.locator('[data-session-shared="true"] svg')).toHaveCount(1);
      await expect(sharedSidebarRow.getByText('Shared', { exact: true })).toHaveCount(0);
      const sidebarIndicators = sharedSidebarRow.locator('[data-session-indicators="true"]');
      await expect(sidebarIndicators.locator('[data-session-shared="true"]')).toHaveCount(1);
      await expect(sidebarIndicators.locator('[data-session-source="true"]')).toHaveCount(1);

      await page.goto(`/projects/${projectId}/sessions`, {
        waitUntil: 'domcontentloaded',
      });
      const ownInventoryRow = page.getByLabel('Show details for My private chat');
      const sharedInventoryRow = page.getByLabel('Show details for Shared scheduled session');
      await expect(ownInventoryRow).toBeVisible();
      await expect(ownInventoryRow.locator('[data-session-shared="true"]')).toHaveCount(0);
      await expect(sharedInventoryRow).toBeVisible();
      await expect(sharedInventoryRow.locator('[data-session-shared="true"] svg')).toHaveCount(1);
      await expect(sharedInventoryRow.getByText('Shared', { exact: true })).toHaveCount(0);

      await page.getByRole('button', { name: 'Search', exact: true }).click();
      const palette = page.getByRole('dialog');
      await expect(palette).toBeVisible();
      const sharedPaletteRow = palette.locator('[cmdk-item]', {
        hasText: 'Shared scheduled session',
      });
      await expect(sharedPaletteRow.locator('[data-session-shared="true"] svg')).toHaveCount(1);
      await expect(sharedPaletteRow.getByText('Shared', { exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');

      const { section } = await openTriggerAccess(page, projectId);
      const privateOption = section.getByRole('radio', {
        // Capital "Managers" — matches `schedule-detail-sheet.tsx`'s copy
        // override verbatim ("Trigger agent and project Managers", "Project
        // Managers can always open trigger-created sessions."). A raw regex
        // (unlike `getByText`'s string form) is case-sensitive by default, so
        // the lowercase "managers" this used to read never matched.
        name: /Trigger agent and project Managers/,
      });
      await expect(privateOption).toBeChecked();
      await expect(
        section.getByText('Project managers can always open trigger-created sessions.'),
      ).toBeVisible();

      await section.getByRole('radio', { name: /Selected teammates/ }).click();
      const memberButton = section.getByRole('button', { name: new RegExp(email) });
      const groupButton = section.getByRole('button', { name: new RegExp(groupName) });
      await expect(memberButton).toBeVisible();
      await expect(groupButton).toBeVisible();
      await memberButton.click();
      await groupButton.click();
      await expect(memberButton).toHaveAttribute('aria-pressed', 'true');
      await expect(groupButton).toHaveAttribute('aria-pressed', 'true');

      const patchRequest = page.waitForRequest(
        (request) =>
          request.method() === 'PATCH' &&
          request.url().endsWith(`/v1/projects/${projectId}/triggers/access-policy-ui`),
      );
      const patchResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          response.url().endsWith(`/v1/projects/${projectId}/triggers/access-policy-ui`),
      );
      await section.getByRole('button', { name: 'Save', exact: true }).click();
      expect((await patchRequest).postDataJSON()).toEqual({
        session_access: {
          mode: 'members',
          memberIds: [user.id],
          groupIds: [groupId],
        },
      });
      expect((await patchResponse).status()).toBe(200);

      const readback = await api<TriggerList>(
        session.access_token,
        'GET',
        `/projects/${projectId}/triggers`,
      );
      expect(
        readback.triggers.find((trigger) => trigger.slug === 'access-policy-ui')?.session_access,
      ).toEqual({ mode: 'members', memberIds: [user.id], groupIds: [groupId] });

      await page.reload({ waitUntil: 'domcontentloaded' });
      await dismissOnboarding(page);
      const reopened = await openTriggerAccess(page, projectId);
      await expect(
        reopened.section.getByRole('radio', { name: /Selected teammates/ }),
      ).toBeChecked();
      await expect(
        reopened.section.getByRole('button', { name: new RegExp(email) }),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        reopened.section.getByRole('button', { name: new RegExp(groupName) }),
      ).toHaveAttribute('aria-pressed', 'true');
      expect(pageErrors).toEqual([]);
    } finally {
      if (groupId && accountId) {
        await api<Record<string, never>>(
          session.access_token,
          'DELETE',
          `/accounts/${accountId}/iam/groups/${groupId}`,
        ).catch(() => {});
      }
      if (project) await project.dispose().catch(() => {});
      await deleteAuthUser(user.id, authOptions).catch(() => {});
    }
  });
});
