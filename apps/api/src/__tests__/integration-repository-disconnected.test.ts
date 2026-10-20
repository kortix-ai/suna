/**
 * A project whose GitHub App was uninstalled, suspended, or lost its repo
 * (KRTX-2955), against the real tables and a fake GitHub token endpoint.
 *
 * The state machine: a classified mint failure is stored on the project's git
 * connection (`status = 'error'`, `last_error_code = <reason>`); the next read
 * inside PROBE_INTERVAL_MS answers from that row without asking GitHub; a
 * GitHub outage changes nothing; a reconnect (new installation id for the same
 * owner) clears the state and repoints the project.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { accountGithubInstallations, projectGitConnections, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { assertRepositoryConnected, resolveProjectGitAuth, resolveProjectUpstream } from '../projects/lib/git';
import { upsertAccountGitHubInstallation } from '../projects/routes/github-installations';
import { db } from '../shared/db';
import { RepositoryDisconnectedError } from '../shared/repository-health';
import { seedAccount } from './helpers/integration-fixtures';

const OWNER = 'acme-disconnect';

/** What the fake GitHub answers per installation id on `/access_tokens`. */
const answers = new Map<string, { status: number; message?: string }>();
let mints = 0;
const realFetch = globalThis.fetch;
const saved = { appId: process.env.KORTIX_GITHUB_APP_ID, key: process.env.KORTIX_GITHUB_APP_PRIVATE_KEY };

beforeAll(async () => {
  process.env.KORTIX_GITHUB_APP_ID = '424242';
  process.env.KORTIX_GITHUB_APP_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs1', format: 'pem' })
    .toString();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const match = url.match(/^https:\/\/api\.github\.com\/app\/installations\/([^/]+)\/access_tokens$/);
    if (!match) return realFetch(input as RequestInfo, init);
    mints += 1;
    const answer = answers.get(match[1]!) ?? { status: 200 };
    if (answer.status === 200) {
      return Response.json({ token: `ghs_${match[1]}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
    }
    return Response.json({ message: answer.message ?? 'Not Found' }, { status: answer.status });
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  process.env.KORTIX_GITHUB_APP_ID = saved.appId;
  process.env.KORTIX_GITHUB_APP_PRIVATE_KEY = saved.key;
  for (const accountId of accountIds) {
    await db.delete(projects).where(eq(projects.accountId, accountId));
    await db.delete(accountGithubInstallations).where(eq(accountGithubInstallations.accountId, accountId));
  }
});

const accountIds: string[] = [];
const accountOf = new Map<string, string>();

/**
 * One BYO GitHub App project on its own installation id, in its own account:
 * an account keeps one installation row per GitHub owner.
 */
async function seedByoProject(installationId: string, repoName: string) {
  const projectId = crypto.randomUUID();
  const accountId = await seedAccount(`repository-disconnected-${repoName}`);
  accountIds.push(accountId);
  accountOf.set(projectId, accountId);
  await db.insert(projects).values({
    projectId,
    accountId,
    name: repoName,
    repoUrl: `https://github.com/${OWNER}/${repoName}.git`,
  });
  await db.insert(projectGitConnections).values({
    accountId,
    projectId,
    provider: 'github',
    repoUrl: `https://github.com/${OWNER}/${repoName}.git`,
    upstreamUrl: `https://github.com/${OWNER}/${repoName}.git`,
    managed: false,
    repoOwner: OWNER,
    repoName,
    authMethod: 'github_app',
    installationId,
  });
  await db
    .insert(accountGithubInstallations)
    .values({ accountId, installationId, ownerLogin: OWNER, ownerType: 'Organization' });
  return projectId;
}

const row = async (projectId: string) =>
  (await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1))[0]!;
const connection = async (projectId: string) =>
  (await db.select().from(projectGitConnections).where(eq(projectGitConnections.projectId, projectId)).limit(1))[0]!;

describe('repository disconnected state', () => {
  test('a 404 on the mint stores app_uninstalled and every read reports it', async () => {
    const projectId = await seedByoProject('7101', 'uninstalled');
    answers.set('7101', { status: 404 });

    const auth = await resolveProjectGitAuth(await row(projectId));
    expect(auth.authSource).toBe('none');
    expect(auth.reason).toBe('repository_disconnected');
    expect(auth.disconnected).toEqual({ reason: 'app_uninstalled', repository: `${OWNER}/uninstalled`, installationId: '7101' });

    const stored = await connection(projectId);
    expect(stored.status).toBe('error');
    expect(stored.lastErrorCode).toBe('app_uninstalled');
    expect(stored.lastErrorMessage).toContain('reinstall');

    // The seam every repo read routes through throws the typed error.
    await expect(resolveProjectUpstream(await row(projectId), 'read')).rejects.toBeInstanceOf(RepositoryDisconnectedError);
    await expect(assertRepositoryConnected(await row(projectId))).rejects.toBeInstanceOf(RepositoryDisconnectedError);
  });

  test('inside the probe interval GitHub is not asked again', async () => {
    const projectId = await seedByoProject('7102', 'backoff');
    answers.set('7102', { status: 404 });
    await resolveProjectGitAuth(await row(projectId));
    const before = mints;
    for (let i = 0; i < 5; i++) {
      expect((await resolveProjectGitAuth(await row(projectId))).reason).toBe('repository_disconnected');
    }
    expect(mints).toBe(before);
  });

  test('suspended and repo-not-accessible get their own reasons', async () => {
    const suspended = await seedByoProject('7103', 'suspended');
    answers.set('7103', { status: 403, message: 'This installation has been suspended' });
    expect((await resolveProjectGitAuth(await row(suspended))).disconnected?.reason).toBe('app_suspended');

    const gone = await seedByoProject('7104', 'gone');
    answers.set('7104', { status: 422, message: 'There is at least one repository that does not exist or is not accessible to the parent installation.' });
    expect((await resolveProjectGitAuth(await row(gone))).disconnected?.reason).toBe('repo_not_accessible');
    expect((await connection(gone)).lastErrorCode).toBe('repo_not_accessible');
  });

  test('a GitHub outage is retryable and stores nothing', async () => {
    const projectId = await seedByoProject('7105', 'outage');
    answers.set('7105', { status: 502, message: 'Bad Gateway' });
    const auth = await resolveProjectGitAuth(await row(projectId));
    expect(auth.reason).toBe('github_unavailable');
    expect(auth.disconnected).toBeUndefined();
    expect((await connection(projectId)).status).toBe('connected');
  });

  test('a reconnect clears the state and repoints the project to the new installation', async () => {
    const projectId = await seedByoProject('7106', 'reconnect');
    answers.set('7106', { status: 404 });
    await resolveProjectGitAuth(await row(projectId));
    expect((await connection(projectId)).status).toBe('error');

    // The org owner reinstalls: GitHub mints a NEW id for the same owner, and
    // saving it replaces the account's row for that owner.
    await upsertAccountGitHubInstallation(accountOf.get(projectId)!, '7107', {
      id: 7107,
      account: { login: OWNER, type: 'Organization' },
      target_type: 'Organization',
      repository_selection: 'all',
      permissions: { contents: 'write' },
      html_url: `https://github.com/organizations/${OWNER}/settings/installations/7107`,
    });

    const auth = await resolveProjectGitAuth(await row(projectId));
    expect(auth.authSource).toBe('app_installation');
    const healed = await connection(projectId);
    expect(healed.installationId).toBe('7107');
    expect(healed.status).toBe('connected');
    expect(healed.lastErrorCode).toBeNull();
    expect(healed.lastErrorMessage).toBeNull();
    await expect(assertRepositoryConnected(await row(projectId))).resolves.toBeUndefined();
  });
});
