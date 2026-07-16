import { afterAll, describe, expect, mock, test } from 'bun:test';

const tenantRow = {
  name: 'MS_TEAMS_TENANT_ID',
  valueEnc: 'enc:435431f6-fc5c-4d3e-8d99-9ff939fec417',
  updatedAt: new Date('2026-07-12T22:24:46.853Z'),
};

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
    select: () => makeChain([tenantRow]),
    insert: () => makeChain([]),
    update: () => makeChain([]),
    delete: () => makeChain([]),
  },
}));

mock.module('../projects/secrets', () => ({
  listProjectSecrets: async () => ({}),
  decryptProjectSecret: (_projectId: string, value: string) => value.replace(/^enc:/, ''),
  encryptProjectSecret: (_projectId: string, value: string) => `enc:${value}`,
}));

const { loadTeamsInstall } = await import('../channels/install-store');

afterAll(() => {
  mock.restore();
});

describe('loadTeamsInstall — connector-scoped Teams secrets', () => {
  test('resolves the install by reading secrets directly, not via listProjectSecrets (which strips connector scope)', async () => {
    const install = await loadTeamsInstall('proj-teams');
    expect(install).not.toBeNull();
    expect(install?.tenantId).toBe('435431f6-fc5c-4d3e-8d99-9ff939fec417');
    expect(install?.orgInstalled).toBe(false);
  });
});
