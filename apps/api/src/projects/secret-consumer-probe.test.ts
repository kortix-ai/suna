import { beforeEach, describe, expect, mock, test } from 'bun:test';

// A system-internal probe (install lookups run for every project on every
// connector sync) must not write an audit row for a secret that does not exist.
// A read an agent or a person asked for keeps its missing/used rows.

let rows: Array<Record<string, unknown>> = [];
let selects = 0;
const audits: Array<Record<string, unknown>> = [];

mock.module('../lib/db', () => ({
  db: {
    select: () => {
      selects += 1;
      return { from: () => ({ where: async () => rows }) };
    },
  },
}));
mock.module('../services/audit/audit', () => ({
  recordAuditEvent: async (event: Record<string, unknown>) => {
    audits.push(event);
  },
}));

const { encryptProjectSecret, getProjectSecretValueForConsumer, getProjectSecretValuesForConsumer } =
  await import('./secrets');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';

function row(name: string, secretId: string, value: string) {
  return {
    secretId,
    name,
    identifier: name,
    ownerUserId: null,
    valueEnc: encryptProjectSecret(PROJECT_ID, value),
    scope: 'connector',
    active: true,
    strategy: 'broker',
    consumer: 'connector',
    updatedAt: new Date('2026-08-05T12:00:00.000Z'),
  };
}

describe('missing-secret audit: probe vs real request', () => {
  beforeEach(() => {
    rows = [];
    selects = 0;
    audits.length = 0;
  });

  test('a real read by an agent still audits a missing secret', async () => {
    const value = await getProjectSecretValueForConsumer({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      sessionId: 'session-1',
      name: 'NOPE',
      consumer: 'connector',
    });
    expect(value).toBeNull();
    expect(audits.map((a) => [a.action, a.actorType])).toEqual([['secret.consumer.missing', 'agent']]);
  });

  test('a single-name probe of a missing secret writes nothing', async () => {
    const value = await getProjectSecretValueForConsumer({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      name: 'NOPE',
      consumer: 'connector',
      probe: true,
    });
    expect(value).toBeNull();
    expect(audits).toEqual([]);
  });

  test('a batch probe reads 12 names in constant queries and audits no miss', async () => {
    rows = [row('MS_TEAMS_TENANT_ID', 'sec-batch-1', 'tenant-1')];
    const values = await getProjectSecretValuesForConsumer({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      names: ['MS_TEAMS_TENANT_ID', ...Array.from({ length: 11 }, (_, i) => `MS_TEAMS_ABSENT_${i}`)],
      consumer: 'connector',
    });
    expect(values).toEqual({ MS_TEAMS_TENANT_ID: 'tenant-1' });
    expect(selects).toBeLessThanOrEqual(2); // 12 names, not 12 lookups
    expect(audits.map((a) => a.action)).toEqual(['secret.consumer.used']);
  });

  test('a probe repeating a used read is audited once per hour; a real read always is', async () => {
    rows = [row('MS_TEAMS_TENANT_ID', 'sec-batch-2', 'tenant-2')];
    const probe = () =>
      getProjectSecretValuesForConsumer({
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        names: ['MS_TEAMS_TENANT_ID'],
        consumer: 'connector',
      });
    await probe();
    await probe();
    expect(audits).toHaveLength(1);
    for (let i = 0; i < 2; i += 1) {
      await getProjectSecretValueForConsumer({
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        sessionId: 'session-1',
        name: 'MS_TEAMS_TENANT_ID',
        consumer: 'connector',
      });
    }
    expect(audits).toHaveLength(3);
  });

  test('a batch probe still audits a denied secret', async () => {
    rows = [{ ...row('MS_TEAMS_TENANT_ID', 'sec-batch-3', 'x'), strategy: 'runtime', consumer: 'sandbox', scope: 'runtime' }];
    const values = await getProjectSecretValuesForConsumer({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      names: ['MS_TEAMS_TENANT_ID'],
      consumer: 'connector',
    });
    expect(values).toEqual({});
    expect(audits.map((a) => a.action)).toEqual(['secret.consumer.denied']);
  });
});
