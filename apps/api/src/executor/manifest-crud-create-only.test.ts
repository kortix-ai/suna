import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realExecutorSync from './sync';

let storedConnectors: Record<string, unknown>[] = [];
let commitCalls = 0;
let commitAttempts = 0;
let syncCalls = 0;
let holdNextCommit = false;
let manifestRevision = 0;
let commitTail: Promise<void> = Promise.resolve();
let firstCommitEntered: Promise<void>;
let resolveFirstCommitEntered: () => void;
let releaseFirstCommit: () => void;
let secondManifestRead: Promise<void>;
let resolveSecondManifestRead: () => void;
let manifestReads = 0;

function resetCommitBarrier() {
  firstCommitEntered = new Promise((resolve) => {
    resolveFirstCommitEntered = resolve;
  });
  return new Promise<void>((resolve) => {
    releaseFirstCommit = resolve;
  });
}

let firstCommitRelease = resetCommitBarrier();

function resetManifestReadBarrier() {
  secondManifestRead = new Promise((resolve) => {
    resolveSecondManifestRead = resolve;
  });
}

resetManifestReadBarrier();

const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [
          {
            projectId: 'project-1',
            accountId: 'account-1',
            name: 'Connector test',
            repoUrl: 'https://example.test/connectors.git',
            manifestPath: 'kortix.yaml',
            defaultBranch: 'main',
            metadata: {},
          },
        ],
      }),
    }),
  }),
};

mock.module('../shared/db', () => ({ db: fakeDb }));
mock.module('../projects/lib/git', () => ({
  withProjectGitAuth: async (project: Record<string, unknown>) => ({
    ...project,
    gitAuthToken: 'test-token',
    gitAuthHeaders: {},
  }),
}));
mock.module('../projects/index', () => ({
  loadManifestForEdit: async () => {
    const manifest = {
      schemaVersion: 2,
      format: 'yaml',
      path: 'kortix.yaml',
      revision: String(manifestRevision),
      raw: {
        kortix_version: 2,
        connectors: structuredClone(storedConnectors),
      },
    };
    manifestReads += 1;
    if (manifestReads === 2) resolveSecondManifestRead();
    return manifest;
  },
  commitManifest: async (
    _project: unknown,
    manifest: {
      revision?: string | null;
      raw: { connectors?: Record<string, unknown>[] };
    },
  ) => {
    commitAttempts += 1;
    const attempt = commitAttempts;
    const previous = commitTail;
    let releaseCommit: () => void = () => {};
    commitTail = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    await previous;
    try {
      if (holdNextCommit && attempt === 1) {
        resolveFirstCommitEntered();
        await firstCommitRelease;
      }
      if (manifest.revision !== String(manifestRevision)) {
        return {
          error: 'File "kortix.yaml" changed since it was read',
          status: 409,
        };
      }
      commitCalls += 1;
      storedConnectors = structuredClone(manifest.raw.connectors ?? []);
      manifestRevision += 1;
      return { ok: true as const };
    } finally {
      releaseCommit();
    }
  },
}));
// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('./sync', () => ({
  ...realExecutorSync,
  syncProjectConnectors: async () => {
    syncCalls += 1;
    return { synced: storedConnectors.length, errors: [] };
  },
}));

const { upsertConnectorInManifest } = await import('./manifest-crud');

beforeEach(() => {
  storedConnectors = [];
  commitCalls = 0;
  commitAttempts = 0;
  syncCalls = 0;
  holdNextCommit = false;
  manifestRevision = 0;
  manifestReads = 0;
  commitTail = Promise.resolve();
  firstCommitRelease = resetCommitBarrier();
  resetManifestReadBarrier();
});

describe('upsertConnectorInManifest create-only requests', () => {
  test('one concurrent create wins and one returns 409 without a second commit or sync', async () => {
    holdNextCommit = true;
    const draft = {
      slug: 'mail-primary',
      name: 'Primary mail',
      provider: 'pipedream' as const,
      app: 'gmail',
      create_only: true,
    };

    const first = upsertConnectorInManifest('project-1', 'account-1', draft);
    await firstCommitEntered;
    const second = upsertConnectorInManifest('project-1', 'account-1', draft);
    await secondManifestRead;
    releaseFirstCommit();

    const results = await Promise.all([first, second]);

    expect(results).toEqual([
      { ok: true, sync: { synced: 1, errors: [] } },
      {
        ok: false,
        error: 'File "kortix.yaml" changed since it was read',
        status: 409,
      },
    ]);
    expect(commitAttempts).toBe(2);
    expect(commitCalls).toBe(1);
    expect(syncCalls).toBe(1);
    expect(storedConnectors).toEqual([
      {
        slug: 'mail-primary',
        name: 'Primary mail',
        provider: 'pipedream',
        app: 'gmail',
      },
    ]);
  });

  test('a normal request keeps the existing upsert behavior', async () => {
    storedConnectors = [
      {
        slug: 'mail-primary',
        name: 'Old name',
        provider: 'pipedream',
        app: 'gmail',
        authorization_strategy: 'user',
      },
    ];

    const result = await upsertConnectorInManifest('project-1', 'account-1', {
      slug: 'mail-primary',
      name: 'New name',
      provider: 'pipedream',
      app: 'gmail',
    });

    expect(result).toEqual({ ok: true, sync: { synced: 1, errors: [] } });
    expect(commitCalls).toBe(1);
    expect(syncCalls).toBe(1);
    expect(storedConnectors[0]).toEqual({
      slug: 'mail-primary',
      name: 'New name',
      provider: 'pipedream',
      app: 'gmail',
      authorization_strategy: 'user',
    });
  });

  test('an existing create-only slug returns 409 without commit or sync', async () => {
    storedConnectors = [
      {
        slug: 'mail-primary',
        name: 'Existing mail',
        provider: 'pipedream',
        app: 'gmail',
      },
    ];

    const result = await upsertConnectorInManifest('project-1', 'account-1', {
      slug: 'mail-primary',
      name: 'Replacement mail',
      provider: 'pipedream',
      app: 'gmail',
      create_only: true,
    });

    expect(result).toEqual({
      ok: false,
      error: 'Connector profile slug "mail-primary" already exists',
      status: 409,
    });
    expect(commitAttempts).toBe(0);
    expect(commitCalls).toBe(0);
    expect(syncCalls).toBe(0);
    expect(storedConnectors[0]?.name).toBe('Existing mail');
  });
});
