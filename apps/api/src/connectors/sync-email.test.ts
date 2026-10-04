import { expect, mock, test } from 'bun:test';
import * as realInstallStore from '../channels/install-store';
import * as realDb from '../lib/db';
import * as realCredentials from './credentials';

const writes: string[] = [];
const active = [{ connectionId: 'existing', ownerId: 'agentmail:inbox' }];
let listingFails = true;
mock.module('../channels/install-store', () => ({
  ...realInstallStore,
  listAgentMailInstalls: async () => {
    if (listingFails) throw new Error('install listing unavailable');
    return [];
  },
}));
mock.module('../lib/db', () => ({
  ...realDb,
  hasDatabase: () => true,
  db: {
    select: () => ({
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve(active), {
            limit: async () => [{ connectorId: 'email-connector' }],
          }),
      }),
    }),
    update: () => {
      writes.push('revoke');
      return { set: () => ({ where: async () => undefined }) };
    },
  },
}));
mock.module('./credentials', () => ({
  ...realCredentials,
  ensureDefaultConnection: async () => {
    writes.push('default');
  },
}));

const { reconcileEmailConnections } = await import('./sync');

test('failed listing preserves existing email connections without writes; successful empty listing revokes', async () => {
  await expect(reconcileEmailConnections('project', 'account')).rejects.toThrow(
    'install listing unavailable',
  );
  expect(writes).toEqual([]);
  listingFails = false;
  await reconcileEmailConnections('project', 'account');
  expect(writes).toContain('revoke');
});
