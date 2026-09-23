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

mock.module('../shared/db', () => ({
  db: {
    select: () => makeChain([{ updatedAt: new Date('2026-09-17T10:00:00.000Z') }]),
    insert: () => makeChain([]),
    update: () => makeChain([{ secretId: 'sec-1' }]),
    delete: () => makeChain([]),
  },
}));

mock.module('../projects/secrets', () => ({
  listProjectSecrets: async () => ({}),
  decryptProjectSecret: (_projectId: string, value: string) => value.replace(/^enc:/, ''),
  encryptProjectSecret: (projectId: string, value: string) => {
    encrypted.push({ projectId, value });
    return `enc:${value}`;
  },
  getProjectSecretValueForConsumer: async (input: { name: string; consumer: string }) =>
    input.consumer === 'connector' ? (secretsByName[input.name] ?? null) : null,
}));

const { loadTeamsInstall, setTeamsPublishState } = await import('../channels/install-store');

beforeEach(() => {
  encrypted.length = 0;
  secretsByName = { MS_TEAMS_TENANT_ID: '36009a52-46d2-44bc-ba56-57a87e485e0a' };
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
    secretsByName.MS_TEAMS_CATALOG_APP_ID = 'd06de996-5d5d-4b68-95f9-eda268580a4e';
    const install = await loadTeamsInstall('proj-1');
    expect(install?.publishState).toBe('published');
    expect(install?.orgInstalled).toBe(true);
    expect(install?.catalogAppId).toBe('d06de996-5d5d-4b68-95f9-eda268580a4e');
  });
});
