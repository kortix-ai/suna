/**
 * Characterization pins for the two project Git write paths, BEFORE and AFTER
 * the dedupe: what exactly lands in `projects.metadata` (`git`/`github`
 * blocks), `project_git_credentials`, and `project_git_connections` for one
 * App-auth case and one PAT-auth case of each path.
 *
 * The two call sites hand-build the same shapes and have drifted
 * (project_grant, upstream_url, github.installation_id). Until the dedupe
 * lands, these tests pin the CURRENT shapes so a refactor that unifies the
 * writers cannot silently change any stored field. They mock the db and every
 * network collaborator; no PostgreSQL is needed.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  changeRequests,
  projectGitConnections,
  projectGitCredentials,
  projectSessions,
  projects,
  type accountGithubInstallations,
} from '@kortix/db';
import type { GitHubRepo } from '../github';
import * as realSecrets from '../secrets';

type GitHubInstallation = typeof accountGithubInstallations.$inferSelect;

const SYNTHETIC = {
  accountId: 'synthetic-account',
  userId: 'synthetic-user',
  projectId: 'synthetic-project',
  installationId: 'synthetic-installation',
  credentialId: 'synthetic-credential',
} as const;

const REPO: GitHubRepo = {
  id: 42,
  name: 'synthetic-repo',
  full_name: 'synthetic-owner/synthetic-repo',
  private: true,
  html_url: 'https://github.com/synthetic-owner/synthetic-repo',
  clone_url: 'https://github.com/synthetic-owner/synthetic-repo.git',
  ssh_url: 'git@github.com:synthetic-owner/synthetic-repo.git',
  default_branch: 'main',
  description: null,
};

const APP_INSTALLATION = {
  installationId: SYNTHETIC.installationId,
  permissions: { contents: 'write' },
} as unknown as GitHubInstallation;

type RecordedOp = {
  op: 'insert' | 'update' | 'delete';
  table: unknown;
  values?: unknown;
  onConflict?: unknown;
  set?: unknown;
};

let ops: RecordedOp[] = [];
let oldProjectRow: Record<string, unknown> | null = null;
let grantedRoles: Array<Record<string, unknown>> = [];
let queuedSnapshots: Array<Record<string, unknown>> = [];
let baseBranchMoves: Array<unknown[]> = [];
let mirrorsInvalidated: string[] = [];
let iamCachesInvalidated: string[] = [];

function returningRowsFor(table: unknown, values: Record<string, unknown>) {
  if (table === projects) return [{ ...values, projectId: SYNTHETIC.projectId }];
  if (table === projectGitCredentials) return [{ ...values, credentialId: SYNTHETIC.credentialId }];
  return [{ ...values }];
}

function record(op: RecordedOp['op'], table: unknown, extra: Partial<RecordedOp>) {
  ops.push({ op, table, ...extra });
}

mock.module('../../shared/db', () => ({
  db: {
    transaction: async (fn: (tx: unknown) => unknown) => {
      const tx = {
        select: () => {
          const chain = {
            from: (table: unknown) => {
              const withRows = () => (table === projects && oldProjectRow ? [oldProjectRow] : []);
              return {
                where: () => ({
                  limit: async () => withRows(),
                  for: async () => withRows(),
                }),
                limit: async () => withRows(),
                then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(withRows()).then(resolve),
              };
            },
          };
          return chain;
        },
        insert: (table: unknown) => ({
          values: (values: Record<string, unknown>) => {
            record('insert', table, { values });
            return {
              onConflictDoUpdate: (onConflict: unknown) => {
                record('insert', table, { values, onConflict });
                return {
                  returning: async () => returningRowsFor(table, values),
                };
              },
              returning: async () => returningRowsFor(table, values),
            };
          },
        }),
        update: (table: unknown) => ({
          set: (set: Record<string, unknown>) => {
            record('update', table, { set });
            return {
              where: () => ({
                returning: async () => returningRowsFor(table, set),
              }),
            };
          },
        }),
        delete: (table: unknown) => ({
          where: () => {
            record('delete', table, {});
            return { returning: async () => [] };
          },
        }),
      };
      return fn(tx);
    },
  },
}));

mock.module('./access', () => ({
  grantProjectRole: async (input: Record<string, unknown>) => {
    grantedRoles.push(input);
  },
}));

mock.module('../../iam/cache-invalidation', () => ({
  invalidateIamCacheForUser: (userId: string) => {
    iamCachesInvalidated.push(userId);
  },
}));

mock.module('../secrets', () => ({
  ...realSecrets,
  encryptProjectSecret: (projectId: string, value: string) => `enc:${projectId}:${value}`,
  decryptProjectSecret: (projectId: string, valueEnc: string) => valueEnc.replace(`enc:${projectId}:`, ''),
}));

mock.module('../github', () => ({
  createInstallationToken: async () => {
    throw new Error('not expected in this test');
  },
  getFileSha: async () => {
    throw new Error('not expected in this test');
  },
  getGitHubAppInstallation: async () => {
    throw new Error('not expected in this test');
  },
  parseGitHubRepoUrl: () => null,
  verifyGitHubInstallationAdmin: async () => {
    throw new Error('not expected in this test');
  },
  isGithubAppConfigured: () => false,
}));

mock.module('./git', () => ({
  resolveGitHubImportWithPat: async () => {
    throw new Error('not expected in this test');
  },
}));

mock.module('../git', () => ({
  invalidateProjectMirror: (projectId: string) => {
    mirrorsInvalidated.push(projectId);
  },
}));

mock.module('../../git-proxy/project-snapshot', () => ({
  queueProjectSnapshotForRef: (project: Record<string, unknown>, ref: string) => {
    queuedSnapshots.push({ ...project, ref });
  },
}));

mock.module('./config-convergence-triggers', () => ({
  notifyBaseBranchMoved: (...args: unknown[]) => {
    baseBranchMoves.push(args);
  },
}));

import { registerGitHubLinkedProject, registerPatLinkedProject } from './project-registration';
import { persistProjectRepositoryReplacement } from './repository-replacement';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function insertOf(table: unknown): Extract<RecordedOp, { values: unknown }> {
  const hits = ops.filter((entry) => entry.op === 'insert' && entry.table === table);
  expect(hits.length).toBeGreaterThan(0);
  return hits[hits.length - 1] as Extract<RecordedOp, { values: unknown }>;
}

function flushFireAndForgetImports() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  ops = [];
  grantedRoles = [];
  queuedSnapshots = [];
  baseBranchMoves = [];
  mirrorsInvalidated = [];
  iamCachesInvalidated = [];
  oldProjectRow = {
    projectId: SYNTHETIC.projectId,
    accountId: SYNTHETIC.accountId,
    status: 'active',
    repoUrl: 'https://github.com/old-owner/old-repo.git',
    manifestPath: 'kortix.yaml',
    metadata: { legacy: 'keep-me', repository_generation: 'old-generation', git: { stale: true } },
  };
});

describe('registerLinkedProject (project-registration) — App auth', () => {
  test('writes the exact project metadata, connection row, and post-write side effects', async () => {
    const row = await registerGitHubLinkedProject({
      accountId: SYNTHETIC.accountId,
      userId: SYNTHETIC.userId,
      repo: REPO,
      name: 'Synthetic Project',
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      projectMetadata: { team: 'synthetic-team' },
      installation: APP_INSTALLATION,
    });
    expect(row.projectId).toBe(SYNTHETIC.projectId);

    const projectInsert = insertOf(projects);
    expect(projectInsert.values).toEqual({
      accountId: SYNTHETIC.accountId,
      name: 'Synthetic Project',
      repoUrl: 'https://github.com/synthetic-owner/synthetic-repo.git',
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      status: 'active',
      metadata: {
        team: 'synthetic-team',
        git: {
          url: 'https://github.com/synthetic-owner/synthetic-repo.git',
          default_branch: 'main',
          provider: 'github',
          owner: 'synthetic-owner',
          name: 'synthetic-repo',
          external_repo_id: '42',
          managed: false,
          auth: { method: 'github_app', installation_id: 'synthetic-installation' },
        },
        github: {
          repo_id: '42',
          full_name: 'synthetic-owner/synthetic-repo',
          html_url: 'https://github.com/synthetic-owner/synthetic-repo',
          private: true,
          auth_source: 'app_installation',
          installation_id: 'synthetic-installation',
        },
      },
      updatedAt: expect.any(Date),
    });

    // App auth persists no project Git credential.
    expect(ops.some((entry) => entry.table === projectGitCredentials && entry.op === 'insert')).toBe(false);

    const connectionInsert = insertOf(projectGitConnections);
    expect(connectionInsert.values).toEqual({
      accountId: SYNTHETIC.accountId,
      projectId: SYNTHETIC.projectId,
      provider: 'github',
      repoUrl: 'https://github.com/synthetic-owner/synthetic-repo.git',
      repoOwner: 'synthetic-owner',
      repoName: 'synthetic-repo',
      externalRepoId: '42',
      managed: false,
      defaultBranch: 'main',
      authMethod: 'github_app',
      installationId: 'synthetic-installation',
      credentialRef: null,
      permissions: { contents: 'write' },
      visibility: 'private',
      status: 'connected',
      lastValidatedAt: expect.any(Date),
      lastErrorCode: null,
      lastErrorMessage: null,
      metadata: {
        full_name: 'synthetic-owner/synthetic-repo',
        html_url: 'https://github.com/synthetic-owner/synthetic-repo',
        ssh_url: 'git@github.com:synthetic-owner/synthetic-repo.git',
      },
      updatedAt: expect.any(Date),
    });
    // The conflict `set` omits the key columns (accountId/projectId).
    expect((connectionInsert.onConflict as { set: unknown }).set).toEqual({
      provider: 'github',
      repoUrl: 'https://github.com/synthetic-owner/synthetic-repo.git',
      repoOwner: 'synthetic-owner',
      repoName: 'synthetic-repo',
      externalRepoId: '42',
      managed: false,
      defaultBranch: 'main',
      authMethod: 'github_app',
      installationId: 'synthetic-installation',
      credentialRef: null,
      permissions: { contents: 'write' },
      visibility: 'private',
      status: 'connected',
      lastValidatedAt: expect.any(Date),
      lastErrorCode: null,
      lastErrorMessage: null,
      metadata: {
        full_name: 'synthetic-owner/synthetic-repo',
        html_url: 'https://github.com/synthetic-owner/synthetic-repo',
        ssh_url: 'git@github.com:synthetic-owner/synthetic-repo.git',
      },
      updatedAt: expect.any(Date),
    });

    expect(grantedRoles).toEqual([{
      accountId: SYNTHETIC.accountId,
      projectId: SYNTHETIC.projectId,
      userId: SYNTHETIC.userId,
      role: 'manager',
      grantedBy: SYNTHETIC.userId,
    }]);
    expect(iamCachesInvalidated).toEqual([SYNTHETIC.userId]);

    await flushFireAndForgetImports();
    expect(queuedSnapshots).toEqual([{
      projectId: SYNTHETIC.projectId,
      repoUrl: 'https://github.com/synthetic-owner/synthetic-repo.git',
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      gitAuthToken: null,
      ref: 'main',
    }]);
  });

  test('a managed repo records managed: true in both the metadata and the connection row', async () => {
    await registerGitHubLinkedProject({
      accountId: SYNTHETIC.accountId,
      userId: SYNTHETIC.userId,
      repo: REPO,
      name: 'Synthetic Project',
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      managed: true,
      installation: APP_INSTALLATION,
    });

    const projectMetadata = (insertOf(projects).values as { metadata: { git: { managed: boolean } } }).metadata;
    expect(projectMetadata.git.managed).toBe(true);
    const connectionValues = insertOf(projectGitConnections).values as { managed: boolean };
    expect(connectionValues.managed).toBe(true);
  });
});

describe('registerLinkedProject (project-registration) — PAT auth', () => {
  test('writes the credential row and pins its fields on the connection', async () => {
    await registerPatLinkedProject({
      accountId: SYNTHETIC.accountId,
      userId: SYNTHETIC.userId,
      repo: REPO,
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      token: 'synthetic-pat-token',
    });

    // The project name is derived from the repository name when none is given.
    expect((insertOf(projects).values as { name: string }).name).toBe('Synthetic Repo');
    const projectMetadata = (insertOf(projects).values as {
      metadata: { git: Record<string, unknown>; github: Record<string, unknown> };
    }).metadata;
    expect(projectMetadata.git).toEqual({
      url: 'https://github.com/synthetic-owner/synthetic-repo.git',
      default_branch: 'main',
      provider: 'github',
      owner: 'synthetic-owner',
      name: 'synthetic-repo',
      external_repo_id: '42',
      managed: false,
      auth: { method: 'project_credential' },
    });
    expect(projectMetadata.github).toEqual({
      repo_id: '42',
      full_name: 'synthetic-owner/synthetic-repo',
      html_url: 'https://github.com/synthetic-owner/synthetic-repo',
      private: true,
      auth_source: 'pat',
    });

    const credentialInsert = insertOf(projectGitCredentials);
    expect(credentialInsert.values).toEqual({
      accountId: SYNTHETIC.accountId,
      projectId: SYNTHETIC.projectId,
      provider: 'github',
      authMethod: 'token',
      valueEnc: `enc:${SYNTHETIC.projectId}:synthetic-pat-token`,
      createdBy: SYNTHETIC.userId,
      updatedAt: expect.any(Date),
    });
    expect(credentialInsert.onConflict).toEqual({
      target: [projectGitCredentials.projectId, projectGitCredentials.provider],
      set: {
        valueEnc: `enc:${SYNTHETIC.projectId}:synthetic-pat-token`,
        createdBy: SYNTHETIC.userId,
        updatedAt: expect.any(Date),
      },
    });

    const connectionValues = insertOf(projectGitConnections).values as Record<string, unknown>;
    expect(connectionValues).toMatchObject({
      provider: 'github',
      repoUrl: 'https://github.com/synthetic-owner/synthetic-repo.git',
      repoOwner: 'synthetic-owner',
      repoName: 'synthetic-repo',
      externalRepoId: '42',
      managed: false,
      defaultBranch: 'main',
      authMethod: 'project_credential',
      installationId: null,
      credentialRef: SYNTHETIC.credentialId,
      permissions: {},
      visibility: 'private',
      status: 'connected',
    });
  });
});

describe('persistProjectRepositoryReplacement (repository-replacement) — App auth', () => {
  test('deletes the credential, writes the grant connection, and rewrites the project metadata', async () => {
    const result = await persistProjectRepositoryReplacement({
      projectId: SYNTHETIC.projectId,
      accountId: SYNTHETIC.accountId,
      actorId: SYNTHETIC.userId,
      expectedRepoUrl: 'https://github.com/old-owner/old-repo.git',
      expectedManifestPath: 'kortix.yaml',
      token: 'synthetic-app-token',
      installationId: SYNTHETIC.installationId,
      repo: REPO,
      defaultBranch: 'main',
    });
    expect(result.project.projectId).toBe(SYNTHETIC.projectId);

    // App auth REPLACES the project credential rather than upserting one.
    expect(ops.some((entry) => entry.table === projectGitCredentials && entry.op === 'delete')).toBe(true);
    expect(ops.some((entry) => entry.table === projectGitCredentials && entry.op === 'insert')).toBe(false);

    const connectionInsert = insertOf(projectGitConnections);
    expect(connectionInsert.values).toEqual({
      accountId: SYNTHETIC.accountId,
      projectId: SYNTHETIC.projectId,
      provider: 'github',
      repoUrl: 'https://github.com/synthetic-owner/synthetic-repo.git',
      upstreamUrl: 'https://github.com/synthetic-owner/synthetic-repo.git',
      managed: false,
      repoOwner: 'synthetic-owner',
      repoName: 'synthetic-repo',
      externalRepoId: '42',
      defaultBranch: 'main',
      authMethod: 'github_app',
      installationId: 'synthetic-installation',
      credentialRef: null,
      permissions: {},
      visibility: 'private',
      webhookId: null,
      status: 'connected',
      lastValidatedAt: expect.any(Date),
      lastErrorCode: null,
      lastErrorMessage: null,
      metadata: {
        full_name: 'synthetic-owner/synthetic-repo',
        html_url: 'https://github.com/synthetic-owner/synthetic-repo',
        ssh_url: 'git@github.com:synthetic-owner/synthetic-repo.git',
        project_grant: true,
      },
      updatedAt: expect.any(Date),
    });

    const projectUpdate = ops.find((entry) => entry.op === 'update' && entry.table === projects)!;
    const metadata = (projectUpdate.set as { metadata: Record<string, unknown> }).metadata;
    expect(metadata).toEqual({
      legacy: 'keep-me',
      repository_generation: expect.stringMatching(UUID_PATTERN),
      git: {
        url: 'https://github.com/synthetic-owner/synthetic-repo.git',
        default_branch: 'main',
        provider: 'github',
        owner: 'synthetic-owner',
        name: 'synthetic-repo',
        external_repo_id: '42',
        managed: false,
        auth: {
          method: 'github_app',
          installation_id: 'synthetic-installation',
          project_grant: true,
        },
      },
      github: {
        repo_id: '42',
        full_name: 'synthetic-owner/synthetic-repo',
        html_url: 'https://github.com/synthetic-owner/synthetic-repo',
        private: true,
        auth_source: 'app_installation',
      },
    });
    expect(projectUpdate.set).toMatchObject({
      repoUrl: 'https://github.com/synthetic-owner/synthetic-repo.git',
      defaultBranch: 'main',
      updatedAt: expect.any(Date),
    });

    expect(mirrorsInvalidated).toEqual([SYNTHETIC.projectId]);
    await flushFireAndForgetImports();
    expect(baseBranchMoves).toEqual([[
      SYNTHETIC.projectId,
      'main',
      'repository-replacement',
    ]]);
  });
});

describe('persistProjectRepositoryReplacement (repository-replacement) — PAT auth', () => {
  test('upserts the credential and writes the connection without a project grant', async () => {
    await persistProjectRepositoryReplacement({
      projectId: SYNTHETIC.projectId,
      accountId: SYNTHETIC.accountId,
      actorId: SYNTHETIC.userId,
      expectedRepoUrl: 'https://github.com/old-owner/old-repo.git',
      expectedManifestPath: 'kortix.yaml',
      token: 'synthetic-pat-token',
      repo: REPO,
      defaultBranch: 'main',
    });

    expect(ops.some((entry) => entry.table === projectGitCredentials && entry.op === 'delete')).toBe(false);
    const credentialInsert = insertOf(projectGitCredentials);
    expect(credentialInsert.values).toEqual({
      accountId: SYNTHETIC.accountId,
      projectId: SYNTHETIC.projectId,
      provider: 'github',
      authMethod: 'token',
      valueEnc: `enc:${SYNTHETIC.projectId}:synthetic-pat-token`,
      createdBy: SYNTHETIC.userId,
      updatedAt: expect.any(Date),
    });
    expect(credentialInsert.onConflict).toEqual({
      target: [projectGitCredentials.projectId, projectGitCredentials.provider],
      set: {
        valueEnc: `enc:${SYNTHETIC.projectId}:synthetic-pat-token`,
        createdBy: SYNTHETIC.userId,
        updatedAt: expect.any(Date),
      },
    });

    const connectionValues = insertOf(projectGitConnections).values as Record<string, unknown>;
    expect(connectionValues).toMatchObject({
      provider: 'github',
      repoUrl: 'https://github.com/synthetic-owner/synthetic-repo.git',
      upstreamUrl: 'https://github.com/synthetic-owner/synthetic-repo.git',
      managed: false,
      authMethod: 'project_credential',
      installationId: null,
      credentialRef: SYNTHETIC.credentialId,
      permissions: {},
      webhookId: null,
      status: 'connected',
    });
    expect(connectionValues.metadata).toEqual({
      full_name: 'synthetic-owner/synthetic-repo',
      html_url: 'https://github.com/synthetic-owner/synthetic-repo',
      ssh_url: 'git@github.com:synthetic-owner/synthetic-repo.git',
    });

    const projectUpdate = ops.find((entry) => entry.op === 'update' && entry.table === projects)!;
    const metadata = (projectUpdate.set as { metadata: Record<string, unknown> }).metadata;
    expect(metadata).toMatchObject({
      legacy: 'keep-me',
      repository_generation: expect.stringMatching(UUID_PATTERN),
      git: {
        managed: false,
        auth: { method: 'project_credential' },
      },
      github: { auth_source: 'pat' },
    });
  });
});

describe('shared invariants of both write paths', () => {
  test('the connection upsert targets the project id and the project row exists before the credential', async () => {
    await registerGitHubLinkedProject({
      accountId: SYNTHETIC.accountId,
      userId: SYNTHETIC.userId,
      repo: REPO,
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      installation: APP_INSTALLATION,
    });
    await persistProjectRepositoryReplacement({
      projectId: SYNTHETIC.projectId,
      accountId: SYNTHETIC.accountId,
      actorId: SYNTHETIC.userId,
      expectedRepoUrl: 'https://github.com/old-owner/old-repo.git',
      expectedManifestPath: 'kortix.yaml',
      token: 'synthetic-pat-token',
      repo: REPO,
      defaultBranch: 'main',
    });

    const connectionInsert = insertOf(projectGitConnections);
    expect(connectionInsert.onConflict).toMatchObject({ target: projectGitConnections.projectId });

    const projectInsertIndex = ops.findIndex((entry) => entry.table === projects);
    const connectionInsertIndex = ops.findIndex((entry) => entry.table === projectGitConnections);
    expect(projectInsertIndex).toBeGreaterThanOrEqual(0);
    expect(connectionInsertIndex).toBeGreaterThan(projectInsertIndex);

    // Every write ran inside ONE db.transaction (the only db entry point the
    // fake exposes here); projectSessions/changeRequests guards saw no rows.
    expect(ops.some((entry) => entry.table === projectSessions)).toBe(false);
    expect(ops.some((entry) => entry.table === changeRequests)).toBe(false);
  });
});
