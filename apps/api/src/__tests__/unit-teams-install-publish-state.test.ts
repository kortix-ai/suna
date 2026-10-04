import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * The one-click Teams install persists the org-catalog publish OUTCOME on the
 * install, so the dashboard can show "publishing…", "pending review", or the
 * exact Graph rejection instead of a bare `?teams=consented` that nothing reads.
 */

const encrypted: Array<{ projectId: string; value: string }> = [];
let secretsByName: Record<string, string> = {};

function makeChain(result: unknown[]): any {
  const chain: any = {};
  for (const method of ['from', 'where', 'orderBy', 'limit', 'returning', 'onConflictDoNothing', 'set', 'values']) {
    chain[method] = () => chain;
  }
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(result));
  return chain;
}

mock.module('../lib/db', () => ({
  db: {
    select: () => makeChain([{ updatedAt: new Date('2026-09-17T10:00:00.000Z') }]),
    insert: () => makeChain([]),
    update: () => makeChain([{ secretId: 'sec-1' }]),
    delete: () => makeChain([]),
  },
}));

mock.module('../services/secrets/secrets', () => ({
  listProjectSecrets: async () => ({}),
  decryptProjectSecret: (_projectId: string, value: string) => value.replace(/^enc:/, ''),
  encryptProjectSecret: (projectId: string, value: string) => {
    encrypted.push({ projectId, value });
    return `enc:${value}`;
  },
  getProjectSecretValueForConsumer: async (input: { name: string; consumer: string }) =>
    input.consumer === 'connector' ? (secretsByName[input.name] ?? null) : null,
  getProjectSecretValuesForConsumer: async (input: { names: string[]; consumer: string }) =>
    input.consumer === 'connector'
      ? Object.fromEntries(input.names.filter((n) => secretsByName[n] != null).map((n) => [n, secretsByName[n]]))
      : {},
}));

const { loadTeamsInstall, setTeamsAppVersion, setTeamsPublishState } = await import('../services/channels/install-store');
const { TEAMS_MANIFEST_VERSION } = await import('../services/channels/teams-manifest');

beforeEach(() => {
  encrypted.length = 0;
  secretsByName = { MS_TEAMS_TENANT_ID: '00000000-0000-4000-8000-00000000a11c' };
});

afterAll(() => {
  mock.restore();
});

describe('setTeamsPublishState', () => {
  test('"publishing" writes the state and clears any previous error', async () => {
    await setTeamsPublishState('proj-1', 'publishing');
    expect(encrypted.map((e) => e.value)).toEqual(['publishing', '']);
  });

  test('"failed" writes the state and the Graph reason', async () => {
    await setTeamsPublishState('proj-1', 'failed', 'Graph app-catalog publish failed (400): Invalid manifest');
    expect(encrypted.map((e) => e.value)).toEqual([
      'failed',
      'Graph app-catalog publish failed (400): Invalid manifest',
    ]);
  });
});

describe('loadTeamsInstall — publish outcome', () => {
  test('an install with no recorded outcome reports null state and null error', async () => {
    const install = await loadTeamsInstall('proj-1');
    expect(install?.publishState).toBeNull();
    expect(install?.publishError).toBeNull();
  });

  test('a failed publish surfaces the state and the reason', async () => {
    secretsByName.MS_TEAMS_PUBLISH_STATE = 'failed';
    secretsByName.MS_TEAMS_PUBLISH_ERROR = 'Graph app-catalog publish failed (400): Invalid manifest';
    const install = await loadTeamsInstall('proj-1');
    expect(install?.publishState).toBe('failed');
    expect(install?.publishError).toBe('Graph app-catalog publish failed (400): Invalid manifest');
    expect(install?.orgInstalled).toBe(false);
  });

  test('a published app reports "published" with the catalog id', async () => {
    secretsByName.MS_TEAMS_PUBLISH_STATE = 'published';
    secretsByName.MS_TEAMS_ORG_INSTALLED = '1';
    secretsByName.MS_TEAMS_CATALOG_APP_ID = '5a1e0c10-0000-4000-8000-000000000010';
    const install = await loadTeamsInstall('proj-1');
    expect(install?.publishState).toBe('published');
    expect(install?.orgInstalled).toBe(true);
    expect(install?.catalogAppId).toBe('5a1e0c10-0000-4000-8000-000000000010');
  });
});

/**
 * The Channels page and `kortix channels status` offer an app update from
 * `appUpdateAvailable`. On dev (2026-10-01) the three Teams installs were
 * all one-click installs on 1.0.0 or 1.1.0, and two of them predate the
 * recorded publish state, so the flag keys on `orgInstalled`, not only on
 * `publishState === 'published'`.
 */
describe('loadTeamsInstall — the app version the catalog serves', () => {
  const inCatalog = (extra: Record<string, string> = {}) => {
    secretsByName = {
      ...secretsByName,
      MS_TEAMS_ORG_INSTALLED: '1',
      MS_TEAMS_CATALOG_APP_ID: '5a1e0c10-0000-4000-8000-000000000010',
      MS_TEAMS_PUBLISH_STATE: 'published',
      ...extra,
    };
  };

  test('a catalog on an older version offers the update and names both versions', async () => {
    inCatalog({ MS_TEAMS_APP_VERSION: '1.2.0' });
    const install = await loadTeamsInstall('proj-1');
    expect(install).toMatchObject({
      appVersion: '1.2.0',
      latestAppVersion: TEAMS_MANIFEST_VERSION,
      appUpdateAvailable: true,
    });
  });

  test('a catalog on the latest version offers nothing', async () => {
    inCatalog({ MS_TEAMS_APP_VERSION: TEAMS_MANIFEST_VERSION });
    expect((await loadTeamsInstall('proj-1'))?.appUpdateAvailable).toBe(false);
  });

  test('versions compare as numbers, so 1.10.0 is newer than 1.6.1', async () => {
    inCatalog({ MS_TEAMS_APP_VERSION: '1.10.0' });
    expect((await loadTeamsInstall('proj-1'))?.appUpdateAvailable).toBe(false);
  });

  test('a catalog published before Kortix recorded versions offers the update', async () => {
    inCatalog();
    const install = await loadTeamsInstall('proj-1');
    expect(install?.appVersion).toBeNull();
    expect(install?.appUpdateAvailable).toBe(true);
  });

  test('a catalog published before Kortix recorded the publish state offers the update', async () => {
    inCatalog();
    delete secretsByName.MS_TEAMS_PUBLISH_STATE;
    const install = await loadTeamsInstall('proj-1');
    expect(install?.publishState).toBeNull();
    expect(install?.appUpdateAvailable).toBe(true);
  });

  test('a publish in flight, waiting for review, or failed offers nothing: its own state says what to do', async () => {
    for (const state of ['publishing', 'review', 'failed']) {
      inCatalog({ MS_TEAMS_PUBLISH_STATE: state });
      expect((await loadTeamsInstall('proj-1'))?.appUpdateAvailable).toBe(false);
    }
  });

  test('an app that is not in the org catalog, or a bring-your-own bot, offers nothing', async () => {
    expect((await loadTeamsInstall('proj-1'))?.appUpdateAvailable).toBe(false);
    inCatalog({ MS_TEAMS_APP_ID: 'byo-app-1' });
    expect((await loadTeamsInstall('proj-1'))?.appUpdateAvailable).toBe(false);
  });

  test('setTeamsAppVersion stores the version', async () => {
    await setTeamsAppVersion('proj-1', '1.6.1');
    expect(encrypted.map((e) => e.value)).toEqual(['1.6.1']);
  });
});
