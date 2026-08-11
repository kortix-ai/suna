import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const insertedValues: unknown[] = [];
const updatedValues: unknown[] = [];

function makeChain(result: unknown[] = []): any {
  const chain: any = {};
  for (const method of ['where', 'returning', 'onConflictDoNothing']) {
    chain[method] = () => chain;
  }
  chain.values = (value: unknown) => {
    insertedValues.push(value);
    return chain;
  };
  chain.set = (value: unknown) => {
    updatedValues.push(value);
    return chain;
  };
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(result));
  return chain;
}

mock.module('../shared/db', () => ({
  db: {
    insert: () => makeChain([]),
    update: () => makeChain([]),
    select: () => makeChain([]),
    delete: () => makeChain([]),
  },
}));

mock.module('../workspaces/secrets', () => ({
  decryptWorkspaceSecret: (_projectId: string, value: string) => value.replace(/^enc:/, ''),
  encryptWorkspaceSecret: (_projectId: string, value: string) => `enc:${value}`,
  getWorkspaceSecretValueForConsumer: async () => null,
  listWorkspaceSecrets: async () => ({}),
}));

const { saveSlackInstall } = await import('../channels/install-store');

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  insertedValues.length = 0;
  updatedValues.length = 0;
});

describe('saveSlackInstall', () => {
  test('registers the workspace-project install for BYO Slack apps', async () => {
    await saveSlackInstall({
      workspaceId: 'proj-1',
      botToken: 'xoxb-test',
      signingSecret: 'signing-secret',
      teamId: 'T1',
      teamName: 'Team One',
      botUserId: 'B1',
    });

    expect(insertedValues[0]).toEqual({
      platform: 'slack',
      platformWorkspaceId: 'T1',
      workspaceId: 'proj-1',
    });
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        workspaceId: 'proj-1',
        identifier: 'SLACK_BOT_TOKEN',
        name: 'SLACK_BOT_TOKEN',
        valueEnc: 'enc:xoxb-test',
        scope: 'connector',
        strategy: 'broker',
        consumer: 'connector',
        rotatedAt: expect.any(Date),
      }),
    );
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        workspaceId: 'proj-1',
        identifier: 'SLACK_SIGNING_SECRET',
        name: 'SLACK_SIGNING_SECRET',
        valueEnc: 'enc:signing-secret',
        scope: 'connector',
        strategy: 'broker',
        consumer: 'connector',
        rotatedAt: expect.any(Date),
      }),
    );
  });
});
