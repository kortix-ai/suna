/**
 * DB suite: the published CLI's bring-your-own-repository creates
 * (`POST /v1/projects/link-repository` from `kortix ship`, `POST /v1/projects`
 * from `kortix projects create --repo`) into an occupied account.
 *
 * Real routes (`app.request`), real schema, real role store. Only GitHub is
 * fake: `fetch` to api.github.com answers from this file, and the GitHub App
 * identity is a key generated here (synthetic values only).
 *
 * The contract (./byo-new-workspace.ts):
 *   - a person naming an occupied account they may create in gets a new
 *     workspace (a new account they own), never `409 workspace_has_project`;
 *   - the new account exists only after the repository validated: a bad token
 *     (400) or a missing App installation (409 install_url) creates nothing;
 *   - the App path carries the source account's installation over as a grant
 *     for this one repository (`project_grant`), never as an installation row
 *     of the new account;
 *   - a workspace-bound key keeps the old answer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { accountGithubInstallations, accountMembers, accounts, projectGitConnections, projects } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { insertIntoView } from '../../__tests__/helpers/compat-views';
import { accountRoleFor, accountRolesForUser } from '../../iam/read-models';
import { app } from '../../index';
import { createAccountToken } from '../../repositories/account-tokens';
import { db } from '../../shared/db';

const OWNER_LOGIN = 'synthetic-org';
const INSTALLATION_ID = '990001';
const USER = crypto.randomUUID();
const ADMIN = crypto.randomUUID();
const OCCUPIED = crypto.randomUUID();
const EXISTING_PROJECT = crypto.randomUUID();
const createdAccounts: string[] = [];
const githubCalls: string[] = [];

/** The repositories the fake GitHub knows, by `owner/name`. */
const REPOS = new Set([`${OWNER_LOGIN}/pat-repo`, `${OWNER_LOGIN}/app-repo`, `${OWNER_LOGIN}/admin-repo`]);

function fakeRepo(fullName: string) {
  const [owner, name] = fullName.split('/');
  return {
    id: Math.abs([...fullName].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7)),
    name,
    full_name: fullName,
    private: true,
    html_url: `https://github.com/${fullName}`,
    clone_url: `https://github.com/${fullName}.git`,
    ssh_url: `git@github.com:${fullName}.git`,
    default_branch: 'main',
    description: null,
    owner: { login: owner, type: 'Organization' },
    permissions: { admin: false, push: true, pull: true },
  };
}

const realFetch = globalThis.fetch;
let pat = '';

beforeAll(async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.KORTIX_GITHUB_APP_ID = '424242';
  process.env.KORTIX_GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  process.env.KORTIX_GITHUB_APP_SLUG = 'kortix-synthetic';
  process.env.KORTIX_GITHUB_APP_STATE_SECRET = 'synthetic-state-secret';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== 'https://api.github.com') return realFetch(input, init);
    githubCalls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const token = new Headers(init?.headers).get('authorization') ?? '';
    if (/^\/app\/installations\/[^/]+\/access_tokens$/.test(url.pathname)) {
      return json(201, { token: 'ghs_synthetic', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    // create-repo under the organization installation, then the one-commit starter.
    const orgCreate = /^\/orgs\/([^/]+)\/repos$/.exec(url.pathname);
    if (orgCreate && init?.method === 'POST') {
      const name = (JSON.parse(String(init.body)) as { name: string }).name;
      const fullName = `${decodeURIComponent(orgCreate[1]!)}/${name}`;
      REPOS.add(fullName);
      return json(201, fakeRepo(fullName));
    }
    if (/^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\//.test(url.pathname)) return json(200, { object: { sha: 'synthetic-parent' } });
    if (/^\/repos\/[^/]+\/[^/]+\/git\/commits\/[^/]+$/.test(url.pathname)) return json(200, { tree: { sha: 'synthetic-tree' } });
    if (/^\/repos\/[^/]+\/[^/]+\/git\/(trees|commits)$/.test(url.pathname)) return json(201, { sha: 'synthetic-new' });
    if (/^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\//.test(url.pathname)) return json(200, { object: { sha: 'synthetic-new' } });
    const repo = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (repo) {
      const fullName = `${decodeURIComponent(repo[1]!)}/${decodeURIComponent(repo[2]!)}`;
      if (token.includes('ghp_bad') || !REPOS.has(fullName)) return json(404, { message: 'Not Found' });
      return json(200, fakeRepo(fullName));
    }
    return json(404, { message: 'Not Found' });
  }) as typeof fetch;

  for (const id of [USER, ADMIN]) {
    await db.execute(sql`insert into auth.users (id, email) values (${id}::uuid, ${`byo-${id.slice(0, 8)}@example.test`})`);
  }
  await db.insert(accounts).values({ accountId: OCCUPIED, name: 'byo-occupied' });
  await insertIntoView(db, accountMembers, [
    { accountId: OCCUPIED, userId: USER, accountRole: 'owner' },
    { accountId: OCCUPIED, userId: ADMIN, accountRole: 'admin' },
  ]);
  await db.insert(projects).values({
    projectId: EXISTING_PROJECT,
    accountId: OCCUPIED,
    name: 'byo-existing',
    repoUrl: `https://example.invalid/${EXISTING_PROJECT}.git`,
  });
  pat = (await createAccountToken({ accountId: OCCUPIED, userId: USER, name: 'byo-cli-login' })).secretKey;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  const all = [OCCUPIED, ...createdAccounts];
  await db.delete(projectGitConnections).where(inArray(projectGitConnections.accountId, all));
  await db.delete(projects).where(inArray(projects.accountId, all));
  await db.delete(accountGithubInstallations).where(inArray(accountGithubInstallations.accountId, all));
  await db.delete(accounts).where(inArray(accounts.accountId, all));
  await db.execute(sql`delete from auth.users where id in (${USER}::uuid, ${ADMIN}::uuid)`);
});

async function post(path: string, body: Record<string, unknown>, bearer = pat) {
  const res = await app.request(`/v1/projects${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function ownedAccounts(userId: string): Promise<string[]> {
  return [...(await accountRolesForUser(userId))].filter(([, role]) => role === 'owner').map(([id]) => id).sort();
}

async function connectionOf(projectId: string) {
  const [row] = await db.select().from(projectGitConnections).where(eq(projectGitConnections.projectId, projectId));
  return row;
}

describe('the published CLI BYO creates into an occupied account', () => {
  test('link-repository with a token (kortix ship --github-token): 201 in a new workspace the person owns', async () => {
    const before = await ownedAccounts(USER);
    const res = await post('/link-repository', {
      repo_url: `https://github.com/${OWNER_LOGIN}/pat-repo`,
      name: 'Shipped Repo',
      account_id: OCCUPIED,
      github_token: 'ghp_synthetic_good',
    });
    expect(res.status).toBe(201);
    const accountId = res.body.project.account_id as string;
    createdAccounts.push(accountId);
    expect(accountId).not.toBe(OCCUPIED);
    expect(await accountRoleFor(accountId, USER)).toBe('owner');
    const [account] = await db.select({ name: accounts.name }).from(accounts).where(eq(accounts.accountId, accountId));
    expect(account?.name).toBe('Shipped Repo');
    expect((await connectionOf(res.body.project.project_id))?.authMethod).toBe('project_credential');
    expect(await ownedAccounts(USER)).toEqual([...before, accountId].sort());
  });

  test('a token GitHub refuses: 400, and no account is created', async () => {
    const before = await ownedAccounts(USER);
    const res = await post('/link-repository', {
      repo_url: `https://github.com/${OWNER_LOGIN}/pat-repo`,
      name: 'Bad Token',
      account_id: OCCUPIED,
      github_token: 'ghp_bad',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).not.toBe('workspace_has_project');
    expect(await ownedAccounts(USER)).toEqual(before);
  });

  test('the App path with no installation: 409 install_url for the named account, and no account is created', async () => {
    const before = await ownedAccounts(USER);
    const res = await post('', { repo_url: `https://github.com/${OWNER_LOGIN}/app-repo`, account_id: OCCUPIED });
    expect(res.status).toBe(409);
    expect(res.body.code).not.toBe('workspace_has_project');
    expect(typeof res.body.install_url).toBe('string');
    expect(await ownedAccounts(USER)).toEqual(before);
  });

  test('the App path with the installation on the named account: 201 in a new workspace, a grant for this repository only', async () => {
    await db.insert(accountGithubInstallations).values({
      accountId: OCCUPIED,
      installationId: INSTALLATION_ID,
      ownerLogin: OWNER_LOGIN,
      ownerType: 'Organization',
      repositorySelection: 'all',
      permissions: { contents: 'write' },
    });
    const res = await post('', { repo_url: `https://github.com/${OWNER_LOGIN}/app-repo`, account_id: OCCUPIED });
    expect(res.status).toBe(201);
    const accountId = res.body.account_id as string;
    createdAccounts.push(accountId);
    expect(accountId).not.toBe(OCCUPIED);
    expect(await accountRoleFor(accountId, USER)).toBe('owner');
    const connection = await connectionOf(res.body.project_id);
    expect(connection?.authMethod).toBe('github_app');
    expect(connection?.installationId).toBe(INSTALLATION_ID);
    expect((connection?.metadata as Record<string, unknown>).project_grant).toBe(true);
    const installs = await db
      .select({ id: accountGithubInstallations.installationRowId })
      .from(accountGithubInstallations)
      .where(eq(accountGithubInstallations.accountId, accountId));
    expect(installs).toEqual([]);
    // The occupied account still holds exactly its one project.
    const active = await db
      .select({ id: projects.projectId })
      .from(projects)
      .where(and(eq(projects.accountId, OCCUPIED), eq(projects.status, 'active')));
    expect(active.map((row) => row.id)).toEqual([EXISTING_PROJECT]);
  });

  test('an admin of the named account carries the installation too (link-repository, App path)', async () => {
    const adminPat = (await createAccountToken({ accountId: OCCUPIED, userId: ADMIN, name: 'byo-admin-login' })).secretKey;
    const res = await post('/link-repository', { repo_url: `https://github.com/${OWNER_LOGIN}/admin-repo`, account_id: OCCUPIED }, adminPat);
    expect(res.status).toBe(201);
    const accountId = res.body.project.account_id as string;
    createdAccounts.push(accountId);
    expect(accountId).not.toBe(OCCUPIED);
    expect(await accountRoleFor(accountId, ADMIN)).toBe('owner');
    expect(((await connectionOf(res.body.project.project_id))?.metadata as Record<string, unknown>).project_grant).toBe(true);
  });

  test('create-repo naming the occupied account (the web form): 201 in a new workspace, a grant for the new repository only', async () => {
    const before = await ownedAccounts(USER);
    const res = await post('/create-repo', { name: 'web-created', account_id: OCCUPIED, installation_id: INSTALLATION_ID });
    expect(res.status).toBe(201);
    const accountId = res.body.account_id as string;
    createdAccounts.push(accountId);
    expect(accountId).not.toBe(OCCUPIED);
    expect(await accountRoleFor(accountId, USER)).toBe('owner');
    expect(await ownedAccounts(USER)).toEqual([...before, accountId].sort());
    expect(githubCalls).toContain(`POST /orgs/${OWNER_LOGIN}/repos`);
    const connection = await connectionOf(res.body.project_id);
    expect(connection?.installationId).toBe(INSTALLATION_ID);
    expect((connection?.metadata as Record<string, unknown>).project_grant).toBe(true);
    const installs = await db
      .select({ id: accountGithubInstallations.installationRowId })
      .from(accountGithubInstallations)
      .where(eq(accountGithubInstallations.accountId, accountId));
    expect(installs).toEqual([]);
  });

  test('create-repo naming a deleted workspace: refused before any GitHub write, and nothing is created', async () => {
    const closing = crypto.randomUUID();
    createdAccounts.push(closing);
    await db.insert(accounts).values({ accountId: closing, name: 'byo-closing' });
    await insertIntoView(db, accountMembers, [{ accountId: closing, userId: USER, accountRole: 'owner' }]);
    await db.execute(sql`INSERT INTO kortix.account_deletion_requests (account_id, user_id, scheduled_for, status)
      VALUES (${closing}::uuid, ${USER}::uuid, now() + interval '14 days', 'pending')`);
    const before = await ownedAccounts(USER);
    const calls = githubCalls.length;
    const res = await post('/create-repo', { name: 'into-closing', account_id: closing, installation_id: INSTALLATION_ID });
    // The authorize engine refuses a create in a closing workspace (`workspace_closed`);
    // projectCreationDenial's `409 workspace_deleting` is the second wall.
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'workspace_closed' });
    expect(githubCalls.slice(calls).filter((call) => call.startsWith('POST'))).toEqual([]);
    expect(await ownedAccounts(USER)).toEqual(before);
    await db.execute(sql`DELETE FROM kortix.account_deletion_requests WHERE account_id = ${closing}::uuid`);
  });

  test('a workspace-bound key keeps 409 workspace_has_project, and nothing is created', async () => {
    const before = await ownedAccounts(USER);
    const key = (
      await createAccountToken({ accountId: OCCUPIED, userId: USER, projectId: EXISTING_PROJECT, name: 'byo-workspace-key' })
    ).secretKey;
    const res = await post(
      '/link-repository',
      { repo_url: `https://github.com/${OWNER_LOGIN}/pat-repo`, account_id: OCCUPIED, github_token: 'ghp_synthetic_good' },
      key,
    );
    expect([403, 409]).toContain(res.status);
    if (res.status === 409) expect(res.body.code).toBe('workspace_has_project');
    expect(await ownedAccounts(USER)).toEqual(before);
  });
});
