import { expect, test, type Page } from '@playwright/test';

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

function repoRoot(): string {
  const path = require('path') as typeof import('node:path');
  return path.resolve(__dirname, '../../..');
}

function parseEnvFile(relativePath: string): Record<string, string> {
  const fs = require('fs') as typeof import('node:fs');
  const path = require('path') as typeof import('node:path');
  const filePath = path.isAbsolute(relativePath)
    ? relativePath
    : path.join(repoRoot(), relativePath);
  if (!fs.existsSync(filePath)) return {};

  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return env;
}

function candidateEnvFiles(files: string[]): string[] {
  const path = require('path') as typeof import('node:path');
  const explicit = (process.env.E2E_ENV_FILE || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...explicit, ...files];
}

function requireEnvValue(name: string, ...files: string[]): string {
  if (process.env[name]) return process.env[name]!;

  for (const file of candidateEnvFiles(files)) {
    const value = parseEnvFile(file)[name];
    if (value) return value;
  }
  throw new Error(`${name} was not found in ${candidateEnvFiles(files).join(', ')}`);
}

function optionalEnvValue(name: string, ...files: string[]): string | undefined {
  if (process.env[name]) return process.env[name];

  for (const file of candidateEnvFiles(files)) {
    const value = parseEnvFile(file)[name];
    if (value) return value;
  }
  return undefined;
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
  await page.goto('/auth', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_000);

  const lockScreen = page.getByText('Click or press Enter to sign in');
  if (await lockScreen.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await page.locator('div.fixed.inset-0.cursor-pointer').first().click({ force: true });
    await page.waitForTimeout(1_500);
    if (!(await page.locator('input[name="email"]').isVisible().catch(() => false))) {
      await page.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      });
    }
  }

  await expect(page.locator('input[name="email"]')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /^Sign in$/i }).first().click();
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

function byEmail(members: ProjectAccessMember[], email: string) {
  return members.find((member) => member.email?.toLowerCase() === email.toLowerCase());
}

function toGitHubWebUrl(repoUrl: string): string {
  return repoUrl
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function accountSwitcherName(name: string): RegExp {
  return new RegExp(`^/.*${escapeRegExp(name)}`);
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

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ownerEmail = `e2e-owner-${runId}@example.test`;
    const memberEmail = `e2e-member-${runId}@example.test`;
    const invitedEmail = `e2e-invite-${runId}@example.test`;
    const uiInvitedEmail = `e2e-ui-invite-${runId}@example.test`;
    const accountName = `E2E Org ${runId}`;
    const uiCreatedAccountName = `E2E Created ${runId}`;
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

    const project = await api<ProjectSummary>(
      ownerSession.access_token,
      'POST',
      '/projects',
      {
        account_id: account.account_id,
        name: initialProjectName,
        repo_url: `https://github.com/kortix-ai/e2e-${runId}.git`,
        default_branch: 'main',
      },
      201,
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
    await expect(page).toHaveURL(new RegExp(`/projects/${project.project_id}/files`));
    await expect(page.getByRole('link', { name: 'Kortix' }).first()).toHaveAttribute('href', '/projects');
    await expect(page.getByRole('button', { name: 'New session' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sessions' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Files' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings' }).first()).toBeVisible();
    await expect(page.getByText(ownerSession.user.email!)).toBeVisible();
    await expect(page.locator('a[href*="/instances"], a[href*="/dashboard"], a[href^="/sessions/"]')).toHaveCount(0);
    await expect(page.getByText('Terminal', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Secrets', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Triggers', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Tunnel', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project.project_id}/settings`));
    await expect(page.locator('a[href*="/instances"], a[href*="/dashboard"], a[href^="/sessions/"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Files' }).first().click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project.project_id}/files`));
    await expect(page.locator('a[href*="/instances"], a[href*="/dashboard"], a[href^="/sessions/"]')).toHaveCount(0);
    const sidebarGithubLink = page.getByRole('link', { name: 'Open on GitHub' });
    await expect(sidebarGithubLink).toBeVisible();
    await expect(sidebarGithubLink).toHaveAttribute('href', projectRepoWebUrl);
    await page.context().route(new RegExp(`^${escapeRegExp(projectRepoWebUrl)}/?$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>GitHub repository</title>',
      }),
    );
    const [githubPopup] = await Promise.all([
      page.context().waitForEvent('page'),
      sidebarGithubLink.click(),
    ]);
    await githubPopup.waitForURL(new RegExp(`^${escapeRegExp(projectRepoWebUrl)}/?$`));
    await githubPopup.close();
    await page.getByRole('button', { name: accountSwitcherName(accountName) }).click();
    await page.getByRole('menuitem', { name: ownerPersonalAccount!.name }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project.project_id}/files`));
    await expect(page.locator('a[href*="/instances"], a[href*="/dashboard"], a[href^="/sessions/"]')).toHaveCount(0);
    const switchedAccountId = await page.evaluate(() => {
      const value = localStorage.getItem('kortix.currentAccount');
      return value ? JSON.parse(value).state?.selectedAccountId : null;
    });
    expect(switchedAccountId).toBe(ownerPersonalAccount!.account_id);
    await page.getByRole('button', { name: accountSwitcherName(ownerPersonalAccount!.name) }).click();
    await page.getByRole('menuitem', { name: accountName }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project.project_id}/files`));

    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    const collapsedGithubLink = page.getByRole('link', { name: 'Open on GitHub' });
    await expect(collapsedGithubLink).toBeVisible();
    await expect(collapsedGithubLink).toHaveAttribute('href', projectRepoWebUrl);

    await selectAccountForUi(page, account.account_id);
    await page.goto('/projects', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: accountSwitcherName(accountName) })).toBeVisible();
    await page.getByRole('button', { name: accountSwitcherName(accountName) }).click();
    await expect(page.getByRole('menuitem', { name: accountName })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Account settings' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Create account' })).toBeVisible();

    await page.getByRole('menuitem', { name: 'Create account' }).click();
    await expect(page.getByRole('dialog', { name: 'Create an account' })).toBeVisible();
    const createAccountResponse = page.waitForResponse((response) =>
      response.url().includes('/v1/accounts') &&
      response.request().method() === 'POST',
    );
    await page.getByLabel('Account name').fill(uiCreatedAccountName);
    await page
      .getByRole('dialog', { name: 'Create an account' })
      .getByRole('button', { name: 'Create account' })
      .click();
    const createdAccountResponse = await createAccountResponse;
    expect(createdAccountResponse.status()).toBe(201);
    const uiCreatedAccount = await createdAccountResponse.json() as AccountSummary;
    await expect(page.getByRole('button', { name: new RegExp(uiCreatedAccountName) })).toBeVisible();
    const selectedAccountId = await page.evaluate(() => {
      const value = localStorage.getItem('kortix.currentAccount');
      return value ? JSON.parse(value).state?.selectedAccountId : null;
    });
    expect(selectedAccountId).toBe(uiCreatedAccount.account_id);

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
    await expect(page.getByText(`Invite sent to ${uiInvitedEmail}`)).toBeVisible();
    await expect(page.getByText(uiInvitedEmail)).toBeVisible();

    await createAuthUser(uiInvitedEmail);
    const uiInvitedSession = await signIn(uiInvitedEmail);
    const uiInvitedAccounts = await api<AccountSummary[]>(uiInvitedSession.access_token, 'GET', '/accounts');
    expect(uiInvitedAccounts.some((item) => item.account_id === account.account_id)).toBe(true);

    await selectAccountForUi(page, account.account_id);
    await page.goto(`/projects/${project.project_id}/settings`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Project access' })).toBeVisible();
    await expect(page.getByText(memberEmail)).toBeVisible();
    const githubLink = page.getByRole('main').getByRole('link', { name: /Open on GitHub/i });
    await expect(githubLink).toBeVisible();
    await expect(githubLink).toHaveAttribute('href', projectRepoWebUrl);

    const memberAccessRow = page.locator('li').filter({ hasText: memberEmail }).first();
    await expect(memberAccessRow).toContainText('No project access');
    const accessUpdate = page.waitForResponse((response) =>
      response.url().includes(`/v1/projects/${project.project_id}/access/${member.id}`) &&
      response.request().method() === 'PUT',
    );
    await memberAccessRow.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Viewer' }).click();
    expect((await accessUpdate).status()).toBe(200);
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
