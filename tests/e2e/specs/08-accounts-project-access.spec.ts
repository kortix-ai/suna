import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  firstExistingExplicitEnvFile,
  optionalEnvValue,
  requireEnvValue,
} from '../helpers/env';

const apiBase = process.env.E2E_API_URL || 'http://localhost:13738/v1';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://localhost:13740';
const password = 'E2eAccountAccess123!';

type AccountRole = 'owner' | 'admin' | 'member';
type ProjectRole = 'manager' | 'editor' | 'viewer';

interface AuthUser {
  id: string;
  email?: string;
}

interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  token_type: string;
  user: AuthUser;
}

interface AccountSummary {
  account_id: string;
  name: string;
  personal_account: boolean;
  account_role: AccountRole;
}

interface ProjectSummary {
  project_id: string;
  account_id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  manifest_path: string;
  status: 'active' | 'archived';
  project_role: ProjectRole | null;
  effective_project_role: ProjectRole | null;
}

interface AccountMember {
  user_id: string;
  email: string | null;
  account_role: AccountRole;
  explicit_project_count?: number;
}

interface InviteResult {
  status: 'added' | 'pending';
  user_id?: string;
  invite_id?: string;
  email: string;
  account_role: AccountRole;
}

interface ProjectAccessMember {
  user_id: string;
  email: string | null;
  account_role: AccountRole;
  project_role: ProjectRole | null;
  effective_project_role: ProjectRole | null;
  has_implicit_access: boolean;
}

interface ProjectAccessResponse {
  project_id: string;
  account_id: string;
  can_manage: boolean;
  viewer_user_id: string;
  members: ProjectAccessMember[];
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function json<T>(
  response: Response,
  expectedStatus: number | number[] = 200,
): Promise<T> {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const body = await response.text();
  if (!expected.includes(response.status)) {
    throw new Error(
      `Expected ${expected.join('/')} from ${response.url}, got ${response.status}: ${body}`,
    );
  }
  return body ? JSON.parse(body) as T : ({} as T);
}

async function api<T>(
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  expectedStatus: number | number[] = 200,
): Promise<T> {
  return json<T>(
    await fetch(`${apiBase}${path}`, {
      method,
      headers: authHeaders(token),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    expectedStatus,
  );
}

async function apiStatus(
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<number> {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: authHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await response.text();
  return response.status;
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function seedSelfHostedProject(
  accountId: string,
  ownerUserId: string,
  name: string,
  repoUrl: string,
): string {
  const childProcess = require('child_process') as typeof import('node:child_process');
  const crypto = require('crypto') as typeof import('node:crypto');
  const fs = require('fs') as typeof import('node:fs');
  const path = require('path') as typeof import('node:path');
  const envFile = firstExistingExplicitEnvFile();
  if (!envFile) throw new Error('E2E_ENV_FILE is required for self-host project seeding');

  const composeFile = path.join(path.dirname(envFile), 'docker-compose.yml');
  if (!fs.existsSync(composeFile)) {
    throw new Error(`Self-host docker-compose.yml not found next to ${envFile}`);
  }

  const projectId = crypto.randomUUID();
  const composeProject = process.env.E2E_COMPOSE_PROJECT_NAME || 'kortix-default';
  const sql = `
insert into kortix.projects (
  project_id,
  account_id,
  name,
  repo_url,
  default_branch,
  manifest_path,
  status,
  metadata
) values (
  '${projectId}'::uuid,
  '${escapeSql(accountId)}'::uuid,
  '${escapeSql(name)}',
  '${escapeSql(repoUrl)}',
  'main',
  'kortix.toml',
  'active',
  '{"self_host_e2e":true}'::jsonb
);

insert into kortix.project_members (
  account_id,
  project_id,
  user_id,
  project_role,
  granted_by
) values (
  '${escapeSql(accountId)}'::uuid,
  '${projectId}'::uuid,
  '${escapeSql(ownerUserId)}'::uuid,
  'manager',
  '${escapeSql(ownerUserId)}'::uuid
);
`;

  childProcess.execFileSync(
    'docker',
    [
      'compose',
      '--project-name',
      composeProject,
      '--env-file',
      envFile,
      '-f',
      composeFile,
      'exec',
      '-T',
      'supabase-db',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { input: sql, encoding: 'utf8' },
  );

  return projectId;
}

async function createProjectForAccessTest(
  token: string,
  accountId: string,
  ownerUserId: string,
  name: string,
  repoUrl: string,
): Promise<ProjectSummary> {
  const response = await fetch(`${apiBase}/projects`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      account_id: accountId,
      name,
      repo_url: repoUrl,
      default_branch: 'main',
    }),
  });
  const body = await response.text();
  if (response.status === 201) return JSON.parse(body) as ProjectSummary;
  if (response.status === 409 && body.includes('GitHub App installation required')) {
    const projectId = seedSelfHostedProject(accountId, ownerUserId, name, repoUrl);
    return api<ProjectSummary>(token, 'GET', `/projects/${projectId}`);
  }
  throw new Error(`Expected 201/409 from ${response.url}, got ${response.status}: ${body}`);
}

async function createAuthUser(email: string): Promise<AuthUser> {
  const serviceRoleKey = requireEnvValue('SUPABASE_SERVICE_ROLE_KEY', 'apps/api/.env');
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
    }),
  });
  const body = await json<{ user?: AuthUser } & AuthUser>(response, 200);
  return body.user ?? body;
}

async function signIn(email: string): Promise<AuthSession> {
  const anonKey =
    optionalEnvValue('SUPABASE_ANON_KEY', 'apps/web/.env', 'apps/api/.env') ||
    requireEnvValue('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'apps/web/.env', 'apps/api/.env');
  return json<AuthSession>(
    await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    }),
    200,
  );
}

async function installBrowserSession(page: Page, session: AuthSession, returnUrl: string) {
  await page.context().clearCookies();
  await page.goto('/favicon.png', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto('/auth', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_000);

  const lockScreen = page.getByText('Click or press Enter to sign in');
  if (await lockScreen.isVisible({ timeout: 5_000 }).catch(() => false)) {
    const emailInput = page.locator('input[name="email"]');
    for (let attempt = 0; attempt < 3 && !(await emailInput.isVisible().catch(() => false)); attempt++) {
      await page.locator('div.fixed.inset-0.cursor-pointer').first().click({ force: true });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(750);
    }
  }

  await expect(page.locator('input[name="email"]')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: /^Sign in$/i }).click();
  const usePassword = page.getByRole('button', { name: /Use password instead/i });
  if (await usePassword.isVisible().catch(() => false)) {
    await usePassword.click();
  }
  await page.locator('input[name="email"]').fill(session.user.email || '');
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form').getByRole('button', { name: /^Sign in$/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/auth'), { timeout: 30_000 });
  await page.goto(returnUrl, { waitUntil: 'domcontentloaded' });
}

async function selectAccountForUi(page: Page, accountId: string) {
  await page.evaluate((id) => {
    localStorage.setItem(
      'kortix.currentAccount',
      JSON.stringify({ state: { selectedAccountId: id }, version: 1 }),
    );
  }, accountId);
}

async function dismissProjectOnboarding(page: Page) {
  const onboarding = page.getByRole('dialog', { name: /Project onboarding/i });
  if (!(await onboarding.isVisible({ timeout: 5_000 }).catch(() => false))) return;
  await onboarding.getByRole('button', { name: /Skip onboarding/i }).click();
  await expect(onboarding).toHaveCount(0, { timeout: 10_000 });
}

async function openCustomizeSection(
  page: Page,
  projectId: string,
  section: string,
  heading: RegExp,
) {
  await page.goto(`/projects/${projectId}/customize/${section}`, { waitUntil: 'domcontentloaded' });
  const dialog = page.getByRole('dialog', { name: /Customize/i });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const targetHeading = page.getByRole('heading', { name: heading });
  if (!(await targetHeading.isVisible({ timeout: 5_000 }).catch(() => false))) {
    await dialog.getByRole('button', { name: new RegExp(`^${section}$`, 'i') }).click();
  }
  await expect(targetHeading).toBeVisible({ timeout: 30_000 });
  return dialog;
}

function byEmail(members: ProjectAccessMember[], email: string) {
  return members.find((member) => member.email?.toLowerCase() === email.toLowerCase());
}

function toGitHubWebUrl(repoUrl: string): string {
  return repoUrl
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
}

test.describe('08 — Accounts, invites, and project access', () => {
  test.setTimeout(300_000);

  test('API and web enforce account roles plus project-scoped access', async ({ page }) => {
    const pageErrors: string[] = [];
    const serverErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (response) => {
      const status = response.status();
      const url = response.url();
      if (status >= 500 && (url.includes('/v1/accounts') || url.includes('/v1/projects'))) {
        serverErrors.push(`${status} ${url}`);
      }
    });

    const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const ownerEmail = `e2e-owner-${runId}@example.test`;
    const memberEmail = `e2e-member-${runId}@example.test`;
    const invitedEmail = `e2e-invite-${runId}@example.test`;
    const uiInvitedEmail = `e2e-ui-invite-${runId}@example.test`;
    const accountName = `E2E Org ${runId}`;
    const initialProjectName = `E2E Project ${runId}`;

    const owner = await createAuthUser(ownerEmail);
    const member = await createAuthUser(memberEmail);
    const ownerSession = await signIn(ownerEmail);
    const memberSession = await signIn(memberEmail);

    const ownerInitialAccounts = await api<AccountSummary[]>(ownerSession.access_token, 'GET', '/accounts');
    const ownerPersonalAccount = ownerInitialAccounts.find((item) => item.personal_account);
    expect(ownerPersonalAccount).toBeTruthy();
    await api<AccountSummary[]>(memberSession.access_token, 'GET', '/accounts');

    const account = await api<AccountSummary>(
      ownerSession.access_token,
      'POST',
      '/accounts',
      { name: accountName },
      201,
    );
    expect(account.name).toBe(accountName);
    expect(account.account_role).toBe('owner');

    const addedMember = await api<InviteResult>(
      ownerSession.access_token,
      'POST',
      `/accounts/${account.account_id}/members`,
      { email: memberEmail, role: 'member' },
      201,
    );
    expect(addedMember.status).toBe('added');
    expect(addedMember.user_id).toBe(member.id);

    const pendingInvite = await api<InviteResult>(
      ownerSession.access_token,
      'POST',
      `/accounts/${account.account_id}/members`,
      { email: invitedEmail, role: 'member' },
      201,
    );
    expect(pendingInvite.status).toBe('pending');
    expect(pendingInvite.invite_id).toBeTruthy();
    const accountInviteId = pendingInvite.invite_id!;

    const memberAccounts = await api<AccountSummary[]>(memberSession.access_token, 'GET', '/accounts');
    expect(memberAccounts.some((item) => item.account_id === account.account_id)).toBe(true);

    const project = await createProjectForAccessTest(
      ownerSession.access_token,
      account.account_id,
      owner.id,
      initialProjectName,
      `https://github.com/kortix-ai/e2e-${runId}.git`,
    );
    expect(project.name).toBe(initialProjectName);
    expect(project.project_role).toBe('manager');
    expect(project.effective_project_role).toBe('manager');
    const projectRepoWebUrl = toGitHubWebUrl(project.repo_url);

    const ownerProjects = await api<ProjectSummary[]>(
      ownerSession.access_token,
      'GET',
      `/projects?account_id=${account.account_id}`,
    );
    expect(ownerProjects.map((item) => item.project_id)).toContain(project.project_id);

    const memberProjectsBeforeGrant = await api<ProjectSummary[]>(
      memberSession.access_token,
      'GET',
      `/projects?account_id=${account.account_id}`,
    );
    expect(memberProjectsBeforeGrant).toEqual([]);
    expect(await apiStatus(memberSession.access_token, 'GET', `/projects/${project.project_id}`)).toBe(403);
    expect(await apiStatus(memberSession.access_token, 'POST', `/projects/${project.project_id}/sessions`, {})).toBe(403);

    const accessBeforeGrant = await api<ProjectAccessResponse>(
      ownerSession.access_token,
      'GET',
      `/projects/${project.project_id}/access`,
    );
    expect(accessBeforeGrant.can_manage).toBe(true);
    expect(byEmail(accessBeforeGrant.members, memberEmail)?.project_role).toBeNull();
    expect(byEmail(accessBeforeGrant.members, memberEmail)?.effective_project_role).toBeNull();

    const viewerGrant = await api<ProjectAccessMember>(
      ownerSession.access_token,
      'PUT',
      `/projects/${project.project_id}/access/${member.id}`,
      { role: 'viewer' },
    );
    expect(viewerGrant.project_role).toBe('viewer');
    expect(viewerGrant.effective_project_role).toBe('viewer');

    const memberProjectsAfterGrant = await api<ProjectSummary[]>(
      memberSession.access_token,
      'GET',
      `/projects?account_id=${account.account_id}`,
    );
    expect(memberProjectsAfterGrant.map((item) => item.project_id)).toEqual([project.project_id]);
    const readableProject = await api<ProjectSummary>(
      memberSession.access_token,
      'GET',
      `/projects/${project.project_id}`,
    );
    expect(readableProject.effective_project_role).toBe('viewer');
    expect(await apiStatus(memberSession.access_token, 'PATCH', `/projects/${project.project_id}`, { name: 'blocked' })).toBe(403);

    await api<{ ok: true }>(
      ownerSession.access_token,
      'DELETE',
      `/projects/${project.project_id}/access/${member.id}`,
    );
    expect(await apiStatus(memberSession.access_token, 'GET', `/projects/${project.project_id}`)).toBe(403);

    const promoted = await api<{ account_role: AccountRole }>(
      ownerSession.access_token,
      'PATCH',
      `/accounts/${account.account_id}/members/${member.id}`,
      { role: 'admin' },
    );
    expect(promoted.account_role).toBe('admin');

    const adminUpdate = await api<ProjectSummary>(
      memberSession.access_token,
      'PATCH',
      `/projects/${project.project_id}`,
      { name: `${initialProjectName} Admin` },
    );
    expect(adminUpdate.effective_project_role).toBe('manager');
    expect(adminUpdate.name).toBe(`${initialProjectName} Admin`);

    await api<{ account_role: AccountRole }>(
      ownerSession.access_token,
      'PATCH',
      `/accounts/${account.account_id}/members/${member.id}`,
      { role: 'member' },
    );
    expect(await apiStatus(memberSession.access_token, 'GET', `/projects/${project.project_id}`)).toBe(403);

    await installBrowserSession(page, ownerSession, `/projects/${project.project_id}`);
    await selectAccountForUi(page, account.account_id);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(new RegExp(`/projects/${project.project_id}$`));
    await expect(page.getByRole('link', { name: 'Projects' }).first()).toHaveAttribute('href', '/projects');
    await expect(page.getByRole('button', { name: 'New session' }).first()).toBeVisible();
    await expect(page.getByText('Sessions', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Set up project/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Customize' }).first()).toBeVisible();
    await expect(page.getByText(ownerSession.user.email!)).toBeVisible();
    await expect(page.locator('a[href*="/instances"], a[href*="/dashboard"], a[href^="/sessions/"]')).toHaveCount(0);
    await expect(page.getByText('Terminal', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Secrets', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Triggers', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Tunnel', { exact: true })).toHaveCount(0);
    await dismissProjectOnboarding(page);
    await page.getByRole('button', { name: 'Customize' }).first().click();
    await expect(page.getByRole('dialog', { name: /Customize/i })).toBeVisible();
    await expect(page.locator('a[href*="/instances"], a[href*="/dashboard"], a[href^="/sessions/"]')).toHaveCount(0);
    expect(projectRepoWebUrl).toContain('github.com/kortix-ai/');

    await selectAccountForUi(page, account.account_id);
    await page.goto('/projects', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    await expect(page.getByText(accountName).first()).toBeVisible();

    await installBrowserSession(page, ownerSession, `/accounts/${account.account_id}`);
    await expect(page.getByRole('heading', { name: accountName })).toBeVisible();
    await expect(page.getByText(memberEmail)).toBeVisible();
    await expect(page.getByText(invitedEmail)).toBeVisible();
    await expect(page.getByText(/Pending invites/i)).toBeVisible();
    const uiInviteResponse = page.waitForResponse((response) =>
      response.url().includes(`/v1/accounts/${account.account_id}/members`) &&
      response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Invite member' }).click();
    await expect(page.getByRole('dialog', { name: 'Invite member' })).toBeVisible();
    await page.getByLabel('Email').fill(uiInvitedEmail);
    await page
      .getByRole('dialog', { name: 'Invite member' })
      .getByRole('button', { name: 'Invite' })
      .click();
    expect((await uiInviteResponse).status()).toBe(201);
    await expect(page.getByText(uiInvitedEmail)).toBeVisible();

    await createAuthUser(uiInvitedEmail);
    const uiInvitedSession = await signIn(uiInvitedEmail);
    const uiInvitedAccounts = await api<AccountSummary[]>(uiInvitedSession.access_token, 'GET', '/accounts');
    expect(uiInvitedAccounts.some((item) => item.account_id === account.account_id)).toBe(true);

    await selectAccountForUi(page, account.account_id);
    const settingsDialog = await openCustomizeSection(page, project.project_id, 'settings', /^Settings$/i);
    const githubLink = settingsDialog.getByRole('link', { name: /Open on GitHub/i });
    await expect(githubLink).toBeVisible();
    await expect(githubLink).toHaveAttribute('href', projectRepoWebUrl);

    const membersDialog = await openCustomizeSection(page, project.project_id, 'members', /Project members/i);
    await membersDialog.getByLabel('Email').fill(memberEmail);
    await membersDialog.locator('#invite-role').click();
    await page.getByRole('option', { name: /Viewer/i }).click();
    const accessInvite = page.waitForResponse((response) =>
      response.url().includes(`/v1/projects/${project.project_id}/access/invite`) &&
      response.request().method() === 'POST',
    );
    await membersDialog.getByRole('button', { name: /^Invite$/i }).click();
    expect((await accessInvite).status()).toBe(200);
    const memberAccessRow = membersDialog.locator('li').filter({ hasText: memberEmail }).first();
    await expect(memberAccessRow).toBeVisible({ timeout: 15_000 });
    await expect(memberAccessRow.getByRole('combobox')).toContainText('Viewer');

    await installBrowserSession(page, memberSession, '/projects');
    await selectAccountForUi(page, account.account_id);
    await page.goto('/projects', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(`${initialProjectName} Admin`)).toBeVisible();

    await api<{ ok: true }>(
      ownerSession.access_token,
      'DELETE',
      `/projects/${project.project_id}/access/${member.id}`,
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText(`${initialProjectName} Admin`)).toHaveCount(0);
    await expect(page.getByText(/No projects yet/i)).toBeVisible();

    const invitedUser = await createAuthUser(invitedEmail);
    const invitedSession = await signIn(invitedEmail);
    expect(invitedUser.id).toBeTruthy();
    await installBrowserSession(page, invitedSession, `/invites/${accountInviteId}`);
    await expect(page.getByRole('heading', { name: accountName })).toBeVisible();
    if (page.url().includes(`/invites/${accountInviteId}`)) {
      await expect(page.getByText(/Team account/i)).toBeVisible();
      const acceptAccountInviteResponse = page.waitForResponse((response) =>
        response.url().includes(`/v1/account-invites/${accountInviteId}/accept`) &&
        response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Accept' }).click();
      expect((await acceptAccountInviteResponse).status()).toBe(200);
    }
    await expect(page).toHaveURL(new RegExp(`/accounts/${account.account_id}`));
    await expect(page.getByRole('heading', { name: accountName })).toBeVisible();

    const invitedAccounts = await api<AccountSummary[]>(invitedSession.access_token, 'GET', '/accounts');
    expect(invitedAccounts.some((item) => item.account_id === account.account_id)).toBe(true);

    const finalMembers = await api<AccountMember[]>(
      ownerSession.access_token,
      'GET',
      `/accounts/${account.account_id}/members`,
    );
    expect(finalMembers.some((item) => item.email === memberEmail && item.account_role === 'member')).toBe(true);
    expect(finalMembers.some((item) => item.email === invitedEmail && item.account_role === 'member')).toBe(true);
    expect(finalMembers.some((item) => item.email === uiInvitedEmail && item.account_role === 'member')).toBe(true);

    await api<{ ok: true }>(ownerSession.access_token, 'DELETE', `/projects/${project.project_id}`);

    expect(serverErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
