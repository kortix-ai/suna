import { beforeEach, describe, expect, mock, test } from 'bun:test';

const git = await import('../git');
const branches = await import('../git/branches');
const github = await import('../github');

let commitError: Error | null = null;
let gitCommit:
  | {
      project: unknown;
      options: Parameters<typeof git.commitFileToBranch>[1];
    }
  | undefined;
let contentsWrites = 0;
let shaReads = 0;
let shaError: Error | null = null;

mock.module('../git', () => ({
  ...git,
  commitFileToBranch: async (
    project: Parameters<typeof git.commitFileToBranch>[0],
    options: Parameters<typeof git.commitFileToBranch>[1],
  ) => {
    gitCommit = { project, options };
    if (commitError) throw commitError;
    return { commitSha: 'a'.repeat(40) };
  },
}));

mock.module('../github', () => ({
  ...github,
  getFileSha: async () => {
    shaReads += 1;
    if (shaError) throw shaError;
    return 'b'.repeat(40);
  },
  commitFile: async () => {
    contentsWrites += 1;
  },
}));

const { commitManifest } = await import('./triggers');

const project = {
  projectId: 'project-cas',
  accountId: 'account-cas',
  name: 'CAS project',
  repoUrl: 'https://github.com/example/connectors.git',
  manifestPath: 'kortix.yaml',
  defaultBranch: 'main',
  metadata: {},
  gitAuthToken: 'test-token',
  gitAuthHeaders: {},
} as Parameters<typeof commitManifest>[0];

beforeEach(() => {
  commitError = null;
  gitCommit = undefined;
  contentsWrites = 0;
  shaReads = 0;
  shaError = null;
});

describe('manifest compare-and-swap routing', () => {
  test('uses generic Git and protects every logical manifest candidate', async () => {
    const result = await commitManifest(
      project,
      {
        schemaVersion: 2,
        format: 'yaml',
        path: 'kortix.yaml',
        revision: 'a'.repeat(40),
        candidatePaths: ['kortix.yaml', 'kortix.yml', 'kortix.toml'],
        raw: { kortix_version: 2, connectors: [] },
      },
      'manifest write',
    );

    expect(result).toEqual({ ok: true });
    expect(gitCommit?.options.expectedFileRevision).toEqual({
      path: 'kortix.yaml',
      sha: 'a'.repeat(40),
      candidatePaths: ['kortix.yaml', 'kortix.yml', 'kortix.toml'],
    });
    expect(contentsWrites).toBe(0);
    expect(shaReads).toBe(0);
  });

  test('returns 409 for a generic Git revision conflict', async () => {
    commitError = new branches.GitFileRevisionConflictError('kortix.yaml');

    const result = await commitManifest(
      project,
      {
        schemaVersion: 2,
        format: 'yaml',
        path: 'kortix.yaml',
        revision: 'a'.repeat(40),
        candidatePaths: ['kortix.yaml', 'kortix.yml', 'kortix.toml'],
        raw: { kortix_version: 2, connectors: [] },
      },
      'stale manifest write',
    );

    expect(result).toEqual({
      error: 'File "kortix.yaml" changed since it was read',
      status: 409,
    });
  });

  test('keeps the GitHub Contents API for unguarded writes', async () => {
    const result = await commitManifest(
      project,
      {
        schemaVersion: 2,
        format: 'yaml',
        path: 'kortix.yaml',
        raw: { kortix_version: 2, connectors: [] },
      },
      'unguarded manifest write',
    );

    expect(result).toEqual({ ok: true });
    expect(contentsWrites).toBe(1);
    expect(shaReads).toBe(1);
    expect(gitCommit).toBeUndefined();
  });

  test('maps an unguarded GitHub revision read failure to 502', async () => {
    shaError = new github.GitHubApiError(
      'upstream unavailable',
      500,
      '/repos/example/connectors/contents/kortix.yaml',
    );

    const result = await commitManifest(
      project,
      {
        schemaVersion: 2,
        format: 'yaml',
        path: 'kortix.yaml',
        raw: { kortix_version: 2, connectors: [] },
      },
      'unguarded manifest write',
    );

    expect(result).toEqual({
      error: 'Failed to commit kortix.yaml: upstream unavailable',
      status: 502,
    });
    expect(contentsWrites).toBe(0);
  });
});
