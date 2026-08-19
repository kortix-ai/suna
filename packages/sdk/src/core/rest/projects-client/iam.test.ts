import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { listAgentIdentities, listGroups, listPolicies, listRoles } from './iam';

let reportedErrors = 0;

beforeEach(() => {
  reportedErrors = 0;
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ message: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
  configureKortix({
    backendUrl: 'http://test.local',
    getToken: async () => 'tok',
    onError: () => {
      reportedErrors += 1;
    },
  });
});

test('IAM background reads suppress the global error sink', async () => {
  await Promise.allSettled([
    listGroups('acc-1'),
    listPolicies('acc-1'),
    listRoles('acc-1'),
    listAgentIdentities('acc-1'),
  ]);
  expect(reportedErrors).toBe(0);
});
