import { describe, expect, mock, test } from 'bun:test';
import * as realProviders from '../platform/providers';
import * as realPreviewOwnership from '../shared/preview-ownership';
import * as realKortixUserContext from '../shared/kortix-user-context';

let queryCount = 0;

const canonicalRow = {
  sandboxId: 'session-1',
  externalId: 'sbx_01KYSVD9Y8YETHH5059G6GGN1M',
  sessionId: 'session-1',
  agentName: null,
  projectId: 'project-1',
  accountId: 'account-1',
  provider: 'platinum',
  status: 'active',
  baseUrl: 'https://sandbox.example',
  config: { serviceKey: 'service-key' },
};

mock.module('../config', () => ({ config: {} }));
mock.module('../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
  resolvePreviewUserContext: async () => null,
}));
// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand silently deletes every other one — and the failure lands
// in whatever unrelated file imports the missing name next, as
// `SyntaxError: Export named '…' not found`, attributed to no test at all.
// Overriding only what this file needs keeps new exports working by default.
mock.module('../shared/kortix-user-context', () => ({
  ...realKortixUserContext,
  KORTIX_USER_CONTEXT_HEADER: 'x-kortix-user-context',
  encodeKortixUserContext: () => '',
}));
mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({
    resolveIngress: async () => {
      throw new Error('not used');
    },
    routeIngress: () => ({ effectivePort: 8000 }),
  }),
}));
mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => {
              queryCount += 1;
              return queryCount === 1 ? [] : [canonicalRow];
            },
          }),
        }),
      }),
    }),
  },
}));

const { loadSandbox } = await import('./backend');

describe('loadSandbox hostname-safe external id lookup', () => {
  test('falls back to a case-insensitive lookup and returns the canonical provider id', async () => {
    queryCount = 0;

    const record = await loadSandbox('sbx_01kysvd9y8yethh5059g6ggn1m');

    expect(queryCount).toBe(2);
    expect(record?.externalId).toBe('sbx_01KYSVD9Y8YETHH5059G6GGN1M');
  });
});
