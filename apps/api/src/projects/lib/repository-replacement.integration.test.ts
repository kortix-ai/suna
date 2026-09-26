import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { accounts, changeRequests, projectGitConnections, projectGitCredentials, projectSecrets, projectSessions, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { decryptProjectSecret, encryptProjectSecret } from '../secrets';
import type { GitHubRepo } from '../github';
import { persistProjectRepositoryReplacement, RepositoryChangedError } from './repository-replacement';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
  process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
  process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;
const accountId = '00000000-0000-4000-a000-000000009911';
const actorId = '00000000-0000-4000-a000-000000009912';
const projectId = '00000000-0000-4000-a000-000000009913';
const secondProjectId = '00000000-0000-4000-a000-000000009914';
const sourceProjectId = '00000000-0000-4000-a000-000000009915';
const oldUrl = 'https://github.com/managed-kortix/old.git';
const newUrl = 'https://github.com/example-org/shared-repository.git';
const token = 'repo-scoped-test-token';
const repo: GitHubRepo = {
  id: 12345, name: 'shared-repository', full_name: 'example-org/shared-repository',
  private: true, html_url: 'https://github.com/example-org/shared-repository',
  clone_url: newUrl, ssh_url: 'git@github.com:example-org/shared-repository.git',
  default_branch: 'main', description: null,
};

async function cleanup() {
  await db.delete(projects).where(eq(projects.accountId, accountId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
}

withDb('repository replacement persists a validated source atomically', () => {
  beforeEach(async () => {
    await cleanup();
    await db.insert(accounts).values({ accountId, name: 'Repository replacement test' });
    await db.insert(projects).values({
      projectId, accountId, name: 'Project One', repoUrl: oldUrl,
      defaultBranch: 'main', manifestPath: 'kortix.yaml', status: 'active',
      metadata: { icon: '🚀', git: { managed: true } },
    });
    await db.insert(projectGitConnections).values({
      projectId, accountId, provider: 'github', repoUrl: oldUrl,
      upstreamUrl: oldUrl, managed: true, defaultBranch: 'main',
      authMethod: 'managed', status: 'connected',
    });
  });
  afterEach(cleanup);

  test('replaces the project and connection, encrypts the token, and preserves other metadata', async () => {
    const result = await persistProjectRepositoryReplacement({
      projectId, accountId, actorId, expectedRepoUrl: oldUrl,
      expectedManifestPath: 'kortix.yaml', repo, defaultBranch: 'main', token,
    });
    expect(result.project.repoUrl).toBe(newUrl);
    expect(result.connection.managed).toBe(false);
    expect(result.connection.authMethod).toBe('project_credential');

    const [project] = await db.select().from(projects).where(eq(projects.projectId, projectId));
    const [connection] = await db.select().from(projectGitConnections).where(eq(projectGitConnections.projectId, projectId));
    const [credential] = await db.select().from(projectGitCredentials).where(eq(projectGitCredentials.projectId, projectId));
    expect(project?.repoUrl).toBe(newUrl);
    expect((project?.metadata as Record<string, unknown>).icon).toBe('🚀');
    expect(connection?.repoUrl).toBe(newUrl);
    expect(connection?.credentialRef).toBe(credential?.credentialId);
    expect(credential?.valueEnc).not.toContain(token);
    expect(decryptProjectSecret(projectId, credential!.valueEnc)).toBe(token);
  });

  test('a stale expected repository leaves every row unchanged', async () => {
    await expect(persistProjectRepositoryReplacement({
      projectId, accountId, actorId,
      expectedRepoUrl: 'https://github.com/someone-else/old.git',
      expectedManifestPath: 'kortix.yaml', repo, defaultBranch: 'main', token,
    })).rejects.toBeInstanceOf(RepositoryChangedError);
    const [project] = await db.select().from(projects).where(eq(projects.projectId, projectId));
    const [connection] = await db.select().from(projectGitConnections).where(eq(projectGitConnections.projectId, projectId));
    const [credential] = await db.select().from(projectGitCredentials).where(eq(projectGitCredentials.projectId, projectId));
    expect(project?.repoUrl).toBe(oldUrl);
    expect(connection?.repoUrl).toBe(oldUrl);
    expect(credential).toBeUndefined();
  });

  test('two projects can use the same repository with separate encrypted credentials', async () => {
    const secondOldUrl = 'https://github.com/managed-kortix/other.git';
    await db.insert(projects).values({
      projectId: secondProjectId, accountId, name: 'Project Two',
      repoUrl: secondOldUrl, defaultBranch: 'main',
      manifestPath: 'kortix.yaml', status: 'active', metadata: {},
    });
    const first = await persistProjectRepositoryReplacement({
      projectId, accountId, actorId, expectedRepoUrl: oldUrl,
      expectedManifestPath: 'kortix.yaml', repo, defaultBranch: 'main', token,
    });
    const second = await persistProjectRepositoryReplacement({
      projectId: secondProjectId, accountId, actorId,
      expectedRepoUrl: secondOldUrl,
      expectedManifestPath: 'kortix.yaml', repo, defaultBranch: 'main', token,
    });
    expect(first.project.repoUrl).toBe(newUrl);
    expect(second.project.repoUrl).toBe(newUrl);
    expect(first.connection.credentialRef).not.toBe(second.connection.credentialRef);
    expect(decryptProjectSecret(secondProjectId, (
      await db.select().from(projectGitCredentials)
        .where(eq(projectGitCredentials.projectId, secondProjectId))
    )[0]!.valueEnc)).toBe(token);
  });

  test('copies selected shared runtime secrets under the target encryption key', async () => {
    await db.insert(projects).values({
      projectId: sourceProjectId, accountId, name: 'Source', repoUrl: oldUrl,
      defaultBranch: 'main', manifestPath: 'kortix.yaml', status: 'active', metadata: {},
    });
    await db.insert(projectSecrets).values({
      projectId: sourceProjectId, identifier: 'TS_AUTHKEY', name: 'TS_AUTHKEY',
      valueEnc: encryptProjectSecret(sourceProjectId, 'source-secret'), createdBy: actorId,
    });
    await persistProjectRepositoryReplacement({
      projectId, accountId, actorId, expectedRepoUrl: oldUrl,
      expectedManifestPath: 'kortix.yaml', repo, defaultBranch: 'main', token,
      copySharedSecrets: { sourceProjectId, identifiers: ['TS_AUTHKEY'] },
    });
    const [target] = await db.select().from(projectSecrets).where(eq(projectSecrets.projectId, projectId));
    expect(target?.identifier).toBe('TS_AUTHKEY');
    expect(target?.valueEnc).not.toBe(encryptProjectSecret(sourceProjectId, 'source-secret'));
    expect(decryptProjectSecret(projectId, target!.valueEnc)).toBe('source-secret');
  });

  test('missing source secret aborts the repository replacement', async () => {
    await db.insert(projects).values({
      projectId: sourceProjectId, accountId, name: 'Source', repoUrl: oldUrl,
      defaultBranch: 'main', manifestPath: 'kortix.yaml', status: 'active', metadata: {},
    });
    await expect(persistProjectRepositoryReplacement({
      projectId, accountId, actorId, expectedRepoUrl: oldUrl,
      expectedManifestPath: 'kortix.yaml', repo, defaultBranch: 'main', token,
      copySharedSecrets: { sourceProjectId, identifiers: ['TS_AUTHKEY'] },
    })).rejects.toThrow('TS_AUTHKEY');
    const [project] = await db.select().from(projects).where(eq(projects.projectId, projectId));
    expect(project?.repoUrl).toBe(oldUrl);
  });

  test('stores a repository-scoped App grant without persisting its temporary token', async () => {
    await persistProjectRepositoryReplacement({
      projectId, accountId, actorId, expectedRepoUrl: oldUrl,
      expectedManifestPath: 'kortix.yaml', repo, defaultBranch: 'main',
      token: 'temporary-installation-token', installationId: '134718821',
    });
    const [connection] = await db.select().from(projectGitConnections).where(eq(projectGitConnections.projectId, projectId));
    const [credential] = await db.select().from(projectGitCredentials).where(eq(projectGitCredentials.projectId, projectId));
    expect(connection?.authMethod).toBe('github_app');
    expect(connection?.installationId).toBe('134718821');
    expect(connection?.metadata).toMatchObject({ project_grant: true });
    expect(credential).toBeUndefined();
  });

  test('refuses active sessions and open change requests before changing the repository', async () => {
    const sessionId = '00000000-0000-4000-a000-000000009916';
    await db.insert(projectSessions).values({
      sessionId, accountId, projectId, branchName: sessionId, status: 'running', metadata: {},
    });
    const replacement = () => persistProjectRepositoryReplacement({
      projectId, accountId, actorId, expectedRepoUrl: oldUrl,
      expectedManifestPath: 'kortix.yaml', repo, defaultBranch: 'main', token,
    });
    await expect(replacement()).rejects.toThrow('active session');
    await db.update(projectSessions).set({ status: 'stopped' }).where(eq(projectSessions.sessionId, sessionId));
    await db.insert(changeRequests).values({
      accountId, projectId, number: 1, title: 'Review',
      baseRef: 'main', headRef: sessionId, createdBy: actorId,
    });
    await expect(replacement()).rejects.toThrow('open change request');
    const [project] = await db.select().from(projects).where(eq(projects.projectId, projectId));
    expect(project?.repoUrl).toBe(oldUrl);
  });

  test('records a new repository generation for future sessions', async () => {
    const result = await persistProjectRepositoryReplacement({
      projectId, accountId, actorId, expectedRepoUrl: oldUrl,
      expectedManifestPath: 'kortix.yaml', repo, defaultBranch: 'main', token,
    });
    expect((result.project.metadata as Record<string, unknown>).repository_generation).toMatch(/^[0-9a-f-]{36}$/);
  });
});
