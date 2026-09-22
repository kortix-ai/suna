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
  await page.goto(`/projects/${projectId}/customize/triggers`, { waitUntil: 'domcontentloaded' });
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

test.describe('21 — Session access UI', () => {
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

      // The API path is `/projects/:id/triggers`. `/customize/` is a WEB route
      // prefix (`capabilityTabHref`) and has no API counterpart — POSTing
      // through it answered 404 in 0ms, which reads as the trigger never
      // being created rather than as a wrong URL.
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
        // Matches `trigger-session-access-copy.ts` verbatim — the copy names
        // the permission the API checks (`project.trigger.update`), not a
        // role nickname. A raw regex is case-sensitive by default.
        name: /Trigger managers only/,
      });
      await expect(privateOption).toBeChecked();
      await expect(section.getByText(/project\.trigger\.update permission/)).toBeVisible();

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
  test('an owner lets admins open every session; the admin then finds a member\'s private session', async ({
    page,
    browser,
  }) => {
    test.skip(!databaseUrl, 'KE2E_DATABASE_URL is required');
    test.setTimeout(240_000);

    const runId = Date.now().toString(36);
    const ownerEmail = `e2e-oversight-owner-${runId}@example.test`;
    const adminEmail = `e2e-oversight-admin-${runId}@example.test`;
    const owner = await createAuthUser(ownerEmail, authOptions);
    const admin = await createAuthUser(adminEmail, authOptions);
    const ownerSession = await signIn(ownerEmail, authOptions);
    const adminSession = await signIn(adminEmail, authOptions);
    const env = loadEnv();
    let accountId: string | null = null;
    let project: ManifestProject | null = null;
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      // Personal accounts are lazy; a token mint creates the owner's.
      await api(ownerSession.access_token, 'POST', '/accounts/tokens', { name: `e2e-${runId}` }, 201);
      const team = await api<{ account_id: string }>(
        ownerSession.access_token,
        'POST',
        '/accounts',
        { name: `Oversight ${runId}` },
        201,
      );
      accountId = team.account_id;
      await api(
        ownerSession.access_token,
        'POST',
        `/accounts/${accountId}/members`,
        { email: adminEmail, role: 'admin' },
        201,
      );
      project = await createManifestProject({
        api,
        accessToken: ownerSession.access_token,
        accountId,
        userId: owner.id,
        name: `Oversight UI ${runId}`,
        databaseUrl: databaseUrl!,
      });
      const projectId = project.id;
      // Another member's private session: invisible to the admin by default.
      await createDatabaseSession(env, {
        projectId,
        accountId,
        userId: crypto.randomUUID(),
        visibility: 'private',
        metadata: { custom_name: 'Member private chat' },
      });
      // A whole-project session, so the Access facet has two kinds to offer.
      await createDatabaseSession(env, {
        projectId,
        accountId,
        userId: crypto.randomUUID(),
        visibility: 'project',
        metadata: { custom_name: 'Team roadmap' },
      });

      // Owner: the switch is off, then on through the confirm dialog.
      await installBrowserSessionDirect(page, ownerSession, `/projects/${projectId}`, authOptions);
      await selectAccountForUi(page, accountId);
      await page.goto(`/projects/${projectId}/sessions?accountId=${accountId}&accountTab=settings`, {
        waitUntil: 'domcontentloaded',
      });
      await dismissOnboarding(page);
      const toggle = page.getByRole('switch', { name: 'Admins can open every session' });
      await expect(toggle).toBeEnabled();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await toggle.click();
      const confirm = page.getByRole('alertdialog');
      await expect(confirm.getByText('Let admins open every session?')).toBeVisible();
      const patchRequest = page.waitForRequest(
        (request) =>
          request.method() === 'PATCH' &&
          request.url().endsWith(`/v1/accounts/${accountId}/iam/session-oversight`),
      );
      const patchResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          response.url().endsWith(`/v1/accounts/${accountId}/iam/session-oversight`),
      );
      await confirm.getByRole('button', { name: 'Turn on', exact: true }).click();
      expect((await patchRequest).postDataJSON()).toEqual({ enabled: true });
      expect((await patchResponse).status()).toBe(200);
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      const readback = await api<{ enabled: boolean }>(
        ownerSession.access_token,
        'GET',
        `/accounts/${accountId}/iam/session-oversight`,
      );
      expect(readback.enabled).toBe(true);

      // Admin: the switch is read-only for them, and the Sessions page now
      // lists the member's private session.
      const adminContext = await browser.newContext();
      const adminPage = await adminContext.newPage();
      try {
        await installBrowserSessionDirect(adminPage, adminSession, `/projects/${projectId}`, authOptions);
        await selectAccountForUi(adminPage, accountId);
        const inventory = adminPage.waitForResponse(
          (response) =>
            response.request().method() === 'GET' &&
            response.url().includes(`/v1/projects/${projectId}/sessions`) &&
            response.url().includes('scope=project'),
        );
        await adminPage.goto(`/projects/${projectId}/sessions`, { waitUntil: 'domcontentloaded' });
        await dismissOnboarding(adminPage);
        expect((await inventory).status()).toBe(200);
        const memberRow = adminPage.getByLabel('Show details for Member private chat');
        await expect(memberRow).toBeVisible();
        // The row names its owner and its access; the admin's is not theirs.
        await expect(memberRow.locator('[data-session-owner]')).toHaveAttribute(
          'aria-label',
          /· Only the owner$/,
        );
        await expect(memberRow.locator('[data-session-shared="true"]')).toHaveCount(1);

        // The Access facet narrows the inventory: whole-project sessions only.
        await adminPage
          .getByRole('button', { name: 'Session view options', exact: true })
          .last()
          .click();
        // Drive the submenu from the keyboard. The toolbar sits at the right
        // edge, so at 1280px the submenu flips LEFT of the menu, and a pointer
        // jump from its trigger leaves Radix's grace area and closes it (the
        // pre-existing Status submenu does the same). Keys are deterministic.
        await adminPage.getByRole('menuitem', { name: /^Access/ }).hover();
        await adminPage.keyboard.press('ArrowRight');
        const wholeProject = adminPage.getByRole('menuitemcheckbox', { name: /Whole project/ });
        await expect(wholeProject).toBeVisible();
        for (let step = 0; step < 4; step += 1) {
          if (await wholeProject.evaluate((el) => el === document.activeElement)) break;
          await adminPage.keyboard.press('ArrowDown');
        }
        await expect(wholeProject).toBeFocused();
        await adminPage.keyboard.press('Space');
        await expect(wholeProject).toHaveAttribute('aria-checked', 'true');
        await adminPage.keyboard.press('Escape');
        await adminPage.keyboard.press('Escape');
        await expect(adminPage.getByLabel('Show details for Team roadmap')).toBeVisible();
        await expect(memberRow).toHaveCount(0);

        await adminPage.goto(
          `/projects/${projectId}/sessions?accountId=${accountId}&accountTab=settings`,
          { waitUntil: 'domcontentloaded' },
        );
        const adminToggle = adminPage.getByRole('switch', { name: 'Admins can open every session' });
        await expect(adminToggle).toBeDisabled();
        await expect(adminPage.getByText('Only an account owner can change this.')).toBeVisible();
      } finally {
        await adminContext.close();
      }
      expect(pageErrors).toEqual([]);
    } finally {
      if (project) await project.dispose().catch(() => {});
      if (accountId) {
        await api(ownerSession.access_token, 'DELETE', '/billing/account/delete-immediately', {
          account_id: accountId,
        }).catch(() => {});
      }
      await deleteAuthUser(owner.id, authOptions).catch(() => {});
      await deleteAuthUser(admin.id, authOptions).catch(() => {});
    }
  });
});
