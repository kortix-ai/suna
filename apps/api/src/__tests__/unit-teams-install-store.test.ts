import { afterAll, describe, expect, mock, test } from 'bun:test';

const tenantRow = {
  name: 'MS_TEAMS_TENANT_ID',
  valueEnc: 'enc:5a1e0c11-0000-4000-8000-000000000011',
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

mock.module('../lib/db', () => ({
  db: {
    select: () => makeChain([tenantRow]),
    insert: () => makeChain([]),
    update: () => makeChain([]),
    delete: () => makeChain([]),
  },
}));

mock.module('../services/secrets/secrets', () => ({
  listProjectSecrets: async () => ({}),
  decryptProjectSecret: (_projectId: string, value: string) => value.replace(/^enc:/, ''),
  encryptProjectSecret: (_projectId: string, value: string) => `enc:${value}`,
  getProjectSecretValueForConsumer: async (input: { name: string; consumer: string }) =>
    input.name === 'MS_TEAMS_TENANT_ID' && input.consumer === 'connector'
      ? '5a1e0c11-0000-4000-8000-000000000011'
      : null,
  getProjectSecretValuesForConsumer: async (input: { names: string[]; consumer: string }) =>
    input.consumer === 'connector' && input.names.includes('MS_TEAMS_TENANT_ID')
      ? { MS_TEAMS_TENANT_ID: '5a1e0c11-0000-4000-8000-000000000011' }
      : {},
}));

const { loadTeamsInstall } = await import('../services/channels/install-store');

afterAll(() => {
  mock.restore();
});

describe('loadTeamsInstall — connector-scoped Teams secrets', () => {
  test('resolves the install through the connector consumer boundary', async () => {
    const install = await loadTeamsInstall('proj-teams');
    expect(install).not.toBeNull();
    expect(install?.tenantId).toBe('5a1e0c11-0000-4000-8000-000000000011');
    expect(install?.orgInstalled).toBe(false);
  });
});
