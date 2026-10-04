/**
 * Characterization pins for the project Git connection and metadata writers.
 *
 * `registerLinkedProject` (project registration) and
 * `persistProjectRepositoryReplacement` (repository replacement) hand-build
 * the `project_git_connections` row and the `metadata.git`/`metadata.github`
 * blocks. KRTX-302 extracts shared builders for those shapes; these pins
 * capture the exact payloads both writers send today, so the extraction
 * stays behavior-preserving: the same assertions must pass before and after.
 *
 * Unit-level by design: the drizzle calls are captured through a mocked
 * `../../shared/db` transaction. The Docker-backed integration suites
 * (`repository-replacement.integration.test.ts`,
 * `project-registration.icon.integration.test.ts`) carry the end-to-end
 * proof against a real PostgreSQL.
 */
import { describe, expect, mock, test } from 'bun:test';
import {
  type accountGithubInstallations,
  projectGitConnections,
  projectGitCredentials,
  projects,
} from '@kortix/db';

type CapturedWrite = {
  table: unknown;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
};

const captured: {
  inserts: CapturedWrite[];
  updates: CapturedWrite[];
  deletes: { table: unknown }[];
} = { inserts: [], updates: [], deletes: [] };

function requireValues(
  kind: string,
  index: number,
  list: CapturedWrite[],
): Record<string, unknown> {
  const record = list[index];
  if (!record?.values) throw new Error(`no captured ${kind} values at index ${index}`);
  return record.values;
}

function requireSet(kind: string, index: number, list: CapturedWrite[]): Record<string, unknown> {
  const record = list[index];
  if (!record?.set) throw new Error(`no captured ${kind} set at index ${index}`);
  return record.set;
}

const PROJECT = {
  projectId: 'synthetic-project',
  accountId: 'synthetic-account',
  status: 'active',
  repoUrl: 'https://old.example.test/synthetic-owner/old-repo.git',
  manifestPath: 'kortix.yaml',
  metadata: { existing: 'value', repository_generation: 'stale-generation' },
};

function resetCaptures() {
  captured.inserts.length = 0;
  captured.updates.length = 0;
  captured.deletes.length = 0;
}

function returnedRowFor(table: unknown, values: Record<string, unknown> | undefined) {
  if (table === projects) return [{ ...PROJECT, ...values }];
  if (table === projectGitCredentials) return [{ credentialId: 'synthetic-credential-id' }];
  return [values ?? {}];
}

function makeTx() {
  return {
    insert: (table: unknown) => {
      const record: CapturedWrite = { table };
      captured.inserts.push(record);
      let value: Record<string, unknown> | undefined;
      const node = {
        values: (v: Record<string, unknown>) => {
          record.values = v;
          value = v;
          return node;
        },
        onConflictDoUpdate: (conflict: { set: Record<string, unknown> }) => {
          record.set = conflict.set;
          return node;
        },
        returning: async () => returnedRowFor(table, value),
      };
      return node;
    },
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => (table === projects ? [PROJECT] : []),
          for: () => [PROJECT],
        }),
      }),
    }),
    update: (table: unknown) => {
      const record: CapturedWrite = { table };
      captured.updates.push(record);
      const node = {
        set: (v: Record<string, unknown>) => {
          record.set = v;
          return node;
        },
        where: () => node,
        returning: async () => [PROJECT],
      };
      return node;
    },
    delete: (table: unknown) => {
      const record: { table: unknown } = { table };
      captured.deletes.push(record);
      return { where: async () => [] };
    },
  };
}

mock.module('../../shared/db', () => ({
  db: {
    transaction: async (fn: (tx: unknown) => unknown) => fn(makeTx()),
  },
}));

mock.module('../secrets', () => ({
  encryptProjectSecret: (projectId: string, value: string) => `enc(${projectId}:${value})`,
  decryptProjectSecret: (projectId: string, valueEnc: string) => valueEnc,
}));
mock.module('./access', () => ({ grantProjectRole: async () => {} }));
mock.module('../../iam/cache-invalidation', () => ({ invalidateIamCacheForUser: () => {} }));
mock.module('../../git-proxy/project-snapshot', () => ({
  queueProjectSnapshotForRef: async () => {},
}));
mock.module('../git', () => ({ invalidateProjectMirror: () => {} }));
mock.module('./config-convergence-triggers', () => ({ notifyBaseBranchMoved: async () => {} }));
mock.module('../github', () => ({
  createInstallationToken: async () => {
    throw new Error('not used by the write half under test');
  },
  getFileSha: async () => {
    throw new Error('not used by the write half under test');
  },
  getGitHubAppInstallation: async () => {
    throw new Error('not used by the write half under test');
  },
  parseGitHubRepoUrl: () => null,
  verifyGitHubInstallationAdmin: async () => {},
}));
mock.module('./git', () => ({
  resolveGitHubImportWithPat: async () => {
    throw new Error('not used by the write half under test');
  },
}));

import { registerGitHubLinkedProject, registerPatLinkedProject } from './project-registration';
import { persistProjectRepositoryReplacement } from './repository-replacement';

type GitHubInstallation = typeof accountGithubInstallations.$inferSelect;

const OLD_REPO = {
  id: 1111,
  name: 'old-repo',
  full_name: 'synthetic-owner/old-repo',
  private: true,
  html_url: 'https://github.com/synthetic-owner/old-repo',
  clone_url: 'https://github.com/synthetic-owner/old-repo.git',
  ssh_url: 'git@github.com:synthetic-owner/old-repo.git',
  default_branch: 'main',
  description: null,
};
const NEW_REPO = {
  id: 2222,
  name: 'new-repo',
  full_name: 'synthetic-owner/new-repo',
  private: false,
  html_url: 'https://github.com/synthetic-owner/new-repo',
  clone_url: 'https://github.com/synthetic-owner/new-repo.git',
  ssh_url: 'git@github.com:synthetic-owner/new-repo.git',
  default_branch: 'trunk',
  description: null,
};
const INSTALLATION = {
  installationId: 'synthetic-installation-id',
  permissions: { contents: 'write' },
} as unknown as GitHubInstallation;

describe('registerLinkedProject characterization (git connection + metadata writes)', () => {
  test('github_app registration inserts the project, then the connection row with App permissions', async () => {
    resetCaptures();
    await registerGitHubLinkedProject({
      accountId: 'synthetic-account',
      userId: 'synthetic-user',
      repo: OLD_REPO,
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      managed: true,
      projectMetadata: { trusted: 'meta' },
      installation: INSTALLATION,
    });

    // Order: the project row first, then the connection. No credential row on
    // the App path.
    expect(captured.inserts.map((record) => record.table)).toEqual([
      projects,
      projectGitConnections,
    ]);
    expect(captured.updates).toEqual([]);
    expect(captured.deletes).toEqual([]);

    // The exact metadata.git / metadata.github block stored on the project row.
    expect(requireValues('insert', 0, captured.inserts).metadata).toEqual({
      trusted: 'meta',
      git: {
        url: OLD_REPO.clone_url,
        default_branch: 'main',
        provider: 'github',
        owner: 'synthetic-owner',
        name: 'old-repo',
        external_repo_id: '1111',
        managed: true,
        auth: { method: 'github_app', installation_id: 'synthetic-installation-id' },
      },
      github: {
        repo_id: '1111',
        full_name: OLD_REPO.full_name,
        html_url: OLD_REPO.html_url,
        private: true,
        auth_source: 'app_installation',
        installation_id: 'synthetic-installation-id',
      },
    });

    // The connection row. `upstreamUrl` and `webhookId` are pinned by value
    // (null) rather than by key presence: the write treats an absent key and
    // an explicit null identically, and the row has no conflict path (the
    // project was just created in the same transaction).
    const { upstreamUrl, webhookId, ...valuesCore } = requireValues('insert', 1, captured.inserts);
    expect(upstreamUrl ?? null).toBe(null);
    expect(webhookId ?? null).toBe(null);
    expect(valuesCore).toEqual({
      accountId: 'synthetic-account',
      projectId: 'synthetic-project',
      provider: 'github',
      repoUrl: OLD_REPO.clone_url,
      repoOwner: 'synthetic-owner',
      repoName: 'old-repo',
      externalRepoId: '1111',
      managed: true,
      defaultBranch: 'main',
      authMethod: 'github_app',
      installationId: 'synthetic-installation-id',
      credentialRef: null,
      permissions: { contents: 'write' },
      visibility: 'private',
      status: 'connected',
      lastValidatedAt: expect.any(Date),
      lastErrorCode: null,
      lastErrorMessage: null,
      metadata: {
        full_name: OLD_REPO.full_name,
        html_url: OLD_REPO.html_url,
        ssh_url: OLD_REPO.ssh_url,
      },
      updatedAt: expect.any(Date),
    });
    expect(valuesCore.lastValidatedAt).toBe(valuesCore.updatedAt);

    const {
      upstreamUrl: setUpstream,
      webhookId: setWebhook,
      ...setCore
    } = requireSet('insert', 1, captured.inserts);
    expect(setUpstream ?? null).toBe(null);
    expect(setWebhook ?? null).toBe(null);
    expect(setCore).toEqual({
      provider: 'github',
      repoUrl: OLD_REPO.clone_url,
      repoOwner: 'synthetic-owner',
      repoName: 'old-repo',
      externalRepoId: '1111',
      managed: true,
      defaultBranch: 'main',
      authMethod: 'github_app',
      installationId: 'synthetic-installation-id',
      credentialRef: null,
      permissions: { contents: 'write' },
      visibility: 'private',
      status: 'connected',
      lastValidatedAt: expect.any(Date),
      lastErrorCode: null,
      lastErrorMessage: null,
      metadata: {
        full_name: OLD_REPO.full_name,
        html_url: OLD_REPO.html_url,
        ssh_url: OLD_REPO.ssh_url,
      },
      updatedAt: expect.any(Date),
    });
  });

  test('PAT registration writes the credential first and links it into the connection row', async () => {
    resetCaptures();
    await registerPatLinkedProject({
      accountId: 'synthetic-account',
      userId: 'synthetic-user',
      repo: OLD_REPO,
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      token: 'synthetic-pat-token',
    });

    // Order: project, credential, connection.
    expect(captured.inserts.map((record) => record.table)).toEqual([
      projects,
      projectGitCredentials,
      projectGitConnections,
    ]);

    const credentialValues = requireValues('insert', 1, captured.inserts);
    expect(credentialValues).toEqual({
      accountId: 'synthetic-account',
      projectId: 'synthetic-project',
      provider: 'github',
      authMethod: 'token',
      valueEnc: 'enc(synthetic-project:synthetic-pat-token)',
      createdBy: 'synthetic-user',
      updatedAt: expect.any(Date),
    });
    expect(requireSet('insert', 1, captured.inserts)).toEqual({
      valueEnc: 'enc(synthetic-project:synthetic-pat-token)',
      createdBy: 'synthetic-user',
      updatedAt: expect.any(Date),
    });

    expect(requireValues('insert', 0, captured.inserts).metadata).toEqual({
      git: {
        url: OLD_REPO.clone_url,
        default_branch: 'main',
        provider: 'github',
        owner: 'synthetic-owner',
        name: 'old-repo',
        external_repo_id: '1111',
        managed: false,
        auth: { method: 'project_credential' },
      },
      github: {
        repo_id: '1111',
        full_name: OLD_REPO.full_name,
        html_url: OLD_REPO.html_url,
        private: true,
        auth_source: 'pat',
      },
    });

    const { upstreamUrl, webhookId, ...valuesCore } = requireValues('insert', 2, captured.inserts);
    expect(upstreamUrl ?? null).toBe(null);
    expect(webhookId ?? null).toBe(null);
    expect(valuesCore).toEqual({
      accountId: 'synthetic-account',
      projectId: 'synthetic-project',
      provider: 'github',
      repoUrl: OLD_REPO.clone_url,
      repoOwner: 'synthetic-owner',
      repoName: 'old-repo',
      externalRepoId: '1111',
      managed: false,
      defaultBranch: 'main',
      authMethod: 'project_credential',
      installationId: null,
      credentialRef: 'synthetic-credential-id',
      permissions: {},
      visibility: 'private',
      status: 'connected',
      lastValidatedAt: expect.any(Date),
      lastErrorCode: null,
      lastErrorMessage: null,
      metadata: {
        full_name: OLD_REPO.full_name,
        html_url: OLD_REPO.html_url,
        ssh_url: OLD_REPO.ssh_url,
      },
      updatedAt: expect.any(Date),
    });
  });
});

describe('persistProjectRepositoryReplacement characterization (git connection + metadata writes)', () => {
  test('github_app grant deletes the credential and writes the connection row with the grant markers', async () => {
    resetCaptures();
    await persistProjectRepositoryReplacement({
      projectId: 'synthetic-project',
      accountId: 'synthetic-account',
      actorId: 'synthetic-actor',
      expectedRepoUrl: PROJECT.repoUrl,
      expectedManifestPath: 'kortix.yaml',
      token: 'synthetic-token',
      installationId: 'synthetic-installation-id',
      repo: NEW_REPO,
      defaultBranch: 'trunk',
    });

    // The App grant invalidates the previous provider credential instead of
    // writing one, and only the connection row is inserted.
    expect(captured.deletes.map((record) => record.table)).toEqual([projectGitCredentials]);
    expect(captured.inserts.map((record) => record.table)).toEqual([projectGitConnections]);

    // Byte-exact: this row CAN conflict (the project already has a
    // connection), so `set` must overwrite every column, including
    // `upstreamUrl` and `webhookId`.
    expect(requireValues('insert', 0, captured.inserts)).toEqual({
      accountId: 'synthetic-account',
      projectId: 'synthetic-project',
      provider: 'github',
      repoUrl: NEW_REPO.clone_url,
      upstreamUrl: NEW_REPO.clone_url,
      managed: false,
      repoOwner: 'synthetic-owner',
      repoName: 'new-repo',
      externalRepoId: '2222',
      defaultBranch: 'trunk',
      authMethod: 'github_app',
      installationId: 'synthetic-installation-id',
      credentialRef: null,
      permissions: {},
      visibility: 'public',
      webhookId: null,
      status: 'connected',
      lastValidatedAt: expect.any(Date),
      lastErrorCode: null,
      lastErrorMessage: null,
      metadata: {
        full_name: NEW_REPO.full_name,
        html_url: NEW_REPO.html_url,
        ssh_url: NEW_REPO.ssh_url,
        project_grant: true,
      },
      updatedAt: expect.any(Date),
    });
    expect(requireSet('insert', 0, captured.inserts)).toEqual({
      provider: 'github',
      repoUrl: NEW_REPO.clone_url,
      upstreamUrl: NEW_REPO.clone_url,
      managed: false,
      repoOwner: 'synthetic-owner',
      repoName: 'new-repo',
      externalRepoId: '2222',
      defaultBranch: 'trunk',
      authMethod: 'github_app',
      installationId: 'synthetic-installation-id',
      credentialRef: null,
      permissions: {},
      visibility: 'public',
      webhookId: null,
      status: 'connected',
      lastValidatedAt: expect.any(Date),
      lastErrorCode: null,
      lastErrorMessage: null,
      metadata: {
        full_name: NEW_REPO.full_name,
        html_url: NEW_REPO.html_url,
        ssh_url: NEW_REPO.ssh_url,
        project_grant: true,
      },
      updatedAt: expect.any(Date),
    });

    // The project row keeps its previous metadata keys, drops nothing, and
    // carries a FRESH repository_generation (a stale one must not survive).
    expect(captured.updates.map((record) => record.table)).toEqual([projects]);
    const updateSet = requireSet('update', 0, captured.updates);
    const metadata = updateSet.metadata as Record<string, unknown>;
    expect(metadata.repository_generation).not.toBe('stale-generation');
    expect(metadata).toEqual({
      existing: 'value',
      repository_generation: expect.any(String),
      git: {
        url: NEW_REPO.clone_url,
        default_branch: 'trunk',
        provider: 'github',
        owner: 'synthetic-owner',
        name: 'new-repo',
        external_repo_id: '2222',
        managed: false,
        auth: {
          method: 'github_app',
          installation_id: 'synthetic-installation-id',
          project_grant: true,
        },
      },
      github: {
        repo_id: '2222',
        full_name: NEW_REPO.full_name,
        html_url: NEW_REPO.html_url,
        private: false,
        auth_source: 'app_installation',
      },
    });
    expect(updateSet.repoUrl).toEqual(NEW_REPO.clone_url);
    expect(updateSet.defaultBranch).toEqual('trunk');
    expect(updateSet.updatedAt).toEqual(expect.any(Date));
  });

  test('PAT replacement rewrites the credential and links it into the connection row', async () => {
    resetCaptures();
    await persistProjectRepositoryReplacement({
      projectId: 'synthetic-project',
      accountId: 'synthetic-account',
      actorId: 'synthetic-actor',
      expectedRepoUrl: PROJECT.repoUrl,
      expectedManifestPath: 'kortix.yaml',
      token: 'synthetic-token',
      repo: NEW_REPO,
      defaultBranch: 'trunk',
    });

    expect(captured.deletes).toEqual([]);
    expect(captured.inserts.map((record) => record.table)).toEqual([
      projectGitCredentials,
      projectGitConnections,
    ]);

    expect(requireValues('insert', 0, captured.inserts)).toEqual({
      accountId: 'synthetic-account',
      projectId: 'synthetic-project',
      provider: 'github',
      authMethod: 'token',
      valueEnc: 'enc(synthetic-project:synthetic-token)',
      createdBy: 'synthetic-actor',
      updatedAt: expect.any(Date),
    });
    expect(requireSet('insert', 0, captured.inserts)).toEqual({
      valueEnc: 'enc(synthetic-project:synthetic-token)',
      createdBy: 'synthetic-actor',
      updatedAt: expect.any(Date),
    });

    expect(requireValues('insert', 1, captured.inserts)).toEqual({
      accountId: 'synthetic-account',
      projectId: 'synthetic-project',
      provider: 'github',
      repoUrl: NEW_REPO.clone_url,
      upstreamUrl: NEW_REPO.clone_url,
      managed: false,
      repoOwner: 'synthetic-owner',
      repoName: 'new-repo',
      externalRepoId: '2222',
      defaultBranch: 'trunk',
      authMethod: 'project_credential',
      installationId: null,
      credentialRef: 'synthetic-credential-id',
      permissions: {},
      visibility: 'public',
      webhookId: null,
      status: 'connected',
      lastValidatedAt: expect.any(Date),
      lastErrorCode: null,
      lastErrorMessage: null,
      metadata: {
        full_name: NEW_REPO.full_name,
        html_url: NEW_REPO.html_url,
        ssh_url: NEW_REPO.ssh_url,
      },
      updatedAt: expect.any(Date),
    });

    const metadata = requireSet('update', 0, captured.updates).metadata as Record<string, unknown>;
    expect(metadata.repository_generation).not.toBe('stale-generation');
    expect(metadata).toEqual({
      existing: 'value',
      repository_generation: expect.any(String),
      git: {
        url: NEW_REPO.clone_url,
        default_branch: 'trunk',
        provider: 'github',
        owner: 'synthetic-owner',
        name: 'new-repo',
        external_repo_id: '2222',
        managed: false,
        auth: { method: 'project_credential' },
      },
      github: {
        repo_id: '2222',
        full_name: NEW_REPO.full_name,
        html_url: NEW_REPO.html_url,
        private: false,
        auth_source: 'pat',
      },
    });
  });
});
