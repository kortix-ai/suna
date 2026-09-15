import { beforeEach, expect, mock, test } from 'bun:test';
import { sessionEnvironments, sessionSandboxes } from '@kortix/db';

let selectedTables: unknown[] = [];
let updatedTables: unknown[] = [];
let metadata: Record<string, unknown> = {};

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            selectedTables.push(table);
            return [{ metadata }];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (input: { metadata: Record<string, unknown> }) => ({
        where: async () => {
          updatedTables.push(table);
          metadata = input.metadata;
        },
      }),
    }),
  },
}));

const { pinRuntimeEgressIp, verifyRuntimeEgressIp } = await import('./sandbox-egress-pin');

beforeEach(() => {
  selectedTables = [];
  updatedTables = [];
  metadata = {};
});

test('an environment pins and verifies against its own row', async () => {
  const runtime = {
    kind: 'environment' as const,
    runtimeId: '77777777-7777-4777-8777-777777777777',
    sessionId: 'session-1',
  };

  await pinRuntimeEgressIp(runtime, '203.0.113.10');
  expect(selectedTables).toEqual([sessionEnvironments]);
  expect(updatedTables).toEqual([sessionEnvironments]);
  expect(await verifyRuntimeEgressIp(runtime, '203.0.113.10')).toEqual({
    ok: true,
    reason: 'match',
    ip: '203.0.113.10',
  });
});

test('a worker still pins against session_sandboxes', async () => {
  await pinRuntimeEgressIp(
    {
      kind: 'worker',
      runtimeId: '66666666-6666-4666-8666-666666666666',
      sessionId: 'session-1',
    },
    '203.0.113.11',
  );

  expect(selectedTables).toEqual([sessionSandboxes]);
  expect(updatedTables).toEqual([sessionSandboxes]);
});
