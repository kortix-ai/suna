import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  connectors as connectorsTable,
  projectSessionConnectorBindings,
} from '@kortix/db';
import * as realConnectorSync from './sync';

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
let forcedCommitConflicts = 0;
let deletedTables: unknown[] = [];

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

const fakeDb: any = {
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
  delete: (table: unknown) => ({
    where: async () => {
      deletedTables.push(table);
    },
  }),
  transaction: async (callback: (tx: any) => Promise<unknown>) => callback(fakeDb),
};

mock.module('../shared/db', () => ({ db: fakeDb, auditDb: fakeDb }));
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
      if (forcedCommitConflicts > 0) {
        forcedCommitConflicts -= 1;
        return {
          error: 'File "kortix.yaml" changed since it was read',
          status: 409,
        };
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
  ...realConnectorSync,
  syncProjectConnectors: async () => {
    syncCalls += 1;
    return { synced: storedConnectors.length, errors: [] };
  },
}));

const {
  deleteConnectorFromManifest,
  setConnectorAuthorizationStrategyInManifest,
  setConnectorCredentialModeInManifest,
  setConnectorNameInManifest,
  setConnectorPoliciesInManifest,
  setConnectorSensitiveInManifest,
  setProjectPoliciesInManifest,
  upsertConnectorInManifest,
} = await import('./manifest-crud');
const { ensureChannelConnectorDeclared, removeChannelConnectorDeclared } = await import(
  './channel-manifest'
);

beforeEach(() => {
  storedConnectors = [];
  commitCalls = 0;
  commitAttempts = 0;
  syncCalls = 0;
  holdNextCommit = false;
  manifestRevision = 0;
  manifestReads = 0;
  forcedCommitConflicts = 0;
  deletedTables = [];
  commitTail = Promise.resolve();
  firstCommitRelease = resetCommitBarrier();
  resetManifestReadBarrier();
});

describe('deleteConnectorFromManifest connection cleanup', () => {
  test('removes session bindings before deleting the connector', async () => {
    storedConnectors = [
      {
        slug: 'mail-primary',
        provider: 'pipedream',
        app: 'gmail',
      },
    ];

    const result = await deleteConnectorFromManifest('project-1', 'mail-primary');

    expect(result).toEqual({ ok: true });
    expect(deletedTables).toEqual([
      projectSessionConnectorBindings,
      connectorsTable,
    ]);
  });
});

describe('upsertConnectorInManifest create-only requests', () => {
  test('one concurrent create wins and the retry reports the existing slug without a second commit or sync', async () => {
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
        error: 'Connector slug "mail-primary" already exists',
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

  test('a normal mutation reloads and retries exactly once after a revision conflict', async () => {
    forcedCommitConflicts = 1;

    const result = await upsertConnectorInManifest('project-1', 'account-1', {
      slug: 'mail-primary',
      provider: 'pipedream',
      app: 'gmail',
    });

    expect(result).toEqual({ ok: true, sync: { synced: 1, errors: [] } });
    expect(manifestReads).toBe(2);
    expect(commitAttempts).toBe(2);
    expect(commitCalls).toBe(1);
    expect(syncCalls).toBe(1);
  });

  test('a second revision conflict returns 409 without a third attempt', async () => {
    forcedCommitConflicts = 2;

    const result = await upsertConnectorInManifest('project-1', 'account-1', {
      slug: 'mail-primary',
      provider: 'pipedream',
      app: 'gmail',
    });

    expect(result).toEqual({
      ok: false,
      error:
        'kortix.yaml changed twice while the connector mail-primary was being updated. Retry the command.',
      status: 409,
    });
    expect(manifestReads).toBe(2);
    expect(commitAttempts).toBe(2);
    expect(commitCalls).toBe(0);
    expect(syncCalls).toBe(0);
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
      error: 'Connector slug "mail-primary" already exists',
      status: 409,
    });
    expect(commitAttempts).toBe(0);
    expect(commitCalls).toBe(0);
    expect(syncCalls).toBe(0);
    expect(storedConnectors[0]?.name).toBe('Existing mail');
  });
});

describe('every connector manifest mutation retries one revision conflict', () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    [
      'delete',
      () => deleteConnectorFromManifest('project-1', 'mail-primary'),
    ],
    [
      'credential mode',
      () => setConnectorCredentialModeInManifest('project-1', 'account-1', 'mail-primary', 'shared'),
    ],
    [
      'connection strategy',
      () =>
        setConnectorAuthorizationStrategyInManifest(
          'project-1',
          'account-1',
          'mail-primary',
          'user',
        ),
    ],
    [
      'sensitive flag',
      () => setConnectorSensitiveInManifest('project-1', 'account-1', 'mail-primary', true),
    ],
    [
      'display name',
      () => setConnectorNameInManifest('project-1', 'account-1', 'mail-primary', 'Mail'),
    ],
    [
      'connector policies',
      () =>
        setConnectorPoliciesInManifest('project-1', 'account-1', 'mail-primary', [
          { match: 'send_*', action: 'require_approval' },
        ]),
    ],
    [
      'project connector policies',
      () => setProjectPoliciesInManifest('project-1', 'account-1', [], 'risk'),
    ],
  ];

  for (const [name, mutate] of cases) {
    test(`${name} reloads and commits after one conflict`, async () => {
      storedConnectors = [
        {
          slug: 'mail-primary',
          provider: 'pipedream',
          app: 'gmail',
          authorization_strategy: 'project',
        },
      ];
      forcedCommitConflicts = 1;

      const result = await mutate();

      expect(result).toMatchObject({ ok: true });
      expect(manifestReads).toBe(2);
      expect(commitAttempts).toBe(2);
      expect(commitCalls).toBe(1);
    });
  }

  test('a second conflict returns 409 with a direct retry instruction', async () => {
    storedConnectors = [
      {
        slug: 'mail-primary',
        provider: 'pipedream',
        app: 'gmail',
        authorization_strategy: 'project',
      },
    ];
    forcedCommitConflicts = 2;

    const result = await setConnectorNameInManifest(
      'project-1',
      'account-1',
      'mail-primary',
      'Mail',
    );

    expect(result).toEqual({
      ok: false,
      error:
        'kortix.yaml changed twice while the connector mail-primary name was being updated. Retry the command.',
      status: 409,
    });
    expect(manifestReads).toBe(2);
    expect(commitAttempts).toBe(2);
    expect(commitCalls).toBe(0);
  });
});

describe('channel connector manifest mutations retry one revision conflict', () => {
  test('channel registration reloads and commits after one conflict', async () => {
    forcedCommitConflicts = 1;

    const changed = await ensureChannelConnectorDeclared('project-1', 'slack');

    expect(changed).toBe(true);
    expect(manifestReads).toBe(2);
    expect(commitAttempts).toBe(2);
    expect(commitCalls).toBe(1);
    expect(storedConnectors).toEqual([
      {
        slug: 'kortix_slack',
        name: 'Slack',
        provider: 'channel',
        platform: 'slack',
      },
    ]);
  });

  test('channel removal reloads and commits after one conflict', async () => {
    storedConnectors = [
      {
        slug: 'kortix_slack',
        name: 'Slack',
        provider: 'channel',
        platform: 'slack',
      },
    ];
    forcedCommitConflicts = 1;

    const changed = await removeChannelConnectorDeclared('project-1', 'slack');

    expect(changed).toBe(true);
    expect(manifestReads).toBe(2);
    expect(commitAttempts).toBe(2);
    expect(commitCalls).toBe(1);
    expect(storedConnectors).toEqual([]);
  });
});
