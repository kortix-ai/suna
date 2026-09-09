import { describe, expect, mock, test } from 'bun:test';
import { sessionEnvironments, sessionSandboxes } from '@kortix/db';
import * as realProviders from '../platform/providers';
import * as realPreviewOwnership from '../shared/preview-ownership';
import * as realKortixUserContext from '../shared/kortix-user-context';

const environmentRow = {
  sandboxId: 'environment-uuid',
  externalId: 'env-provider-id',
  sessionId: 'session-1',
  agentName: 'default',
  projectId: 'project-1',
  accountId: 'account-1',
  provider: 'daytona',
  status: 'active',
  baseUrl: 'https://environment.example',
  config: { serviceKey: 'environment-service-key' } as Record<string, unknown>,
};
let queriedTables: unknown[] = [];
let environmentColumns: Record<string, unknown> | null = null;

mock.module('../config', () => ({ config: {} }));
mock.module('../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
  resolvePreviewUserContext: async () => null,
}));
mock.module('../shared/kortix-user-context', () => ({
  ...realKortixUserContext,
  KORTIX_USER_CONTEXT_HEADER: 'x-kortix-user-context',
  encodeKortixUserContext: () => '',
}));
mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({
    resolveIngress: async () => ({ url: 'https://environment.example', headers: {} }),
    routeIngress: () => ({ effectivePort: 8000 }),
  }),
}));
mock.module('../shared/db', () => ({
  db: {
    select: (columns: Record<string, unknown>) => ({
      from: (table: unknown) => {
        queriedTables.push(table);
        if (table === sessionEnvironments) environmentColumns = columns;
        return {
          leftJoin() { return this; },
          where: () => ({
            orderBy: () => ({ limit: async () => [] }),
            limit: async () => (table === sessionEnvironments ? [environmentRow] : []),
          }),
        };
      },
    }),
  },
}));

const { loadSandbox } = await import('./backend');

describe('environment proxy lookup', () => {
  test('falls back from the worker table to the environment table', async () => {
    queriedTables = [];
    const record = await loadSandbox('env-provider-id');

    expect(queriedTables.filter((table) => table === sessionSandboxes)).toHaveLength(2);
    expect(queriedTables).toContain(sessionEnvironments);
    expect(record).toMatchObject({
      runtimeKind: 'environment',
      sandboxId: 'environment-uuid',
      externalId: 'env-provider-id',
      sessionId: 'session-1',
      serviceKey: 'environment-service-key',
    });
    expect(environmentColumns?.config).toBe(sessionEnvironments.config);
  });

  test('does not substitute the worker credential when the environment has none', async () => {
    const saved = environmentRow.config;
    try {
      for (const config of [{}, { serviceKey: 123 }]) {
        environmentRow.config = config;
        expect((await loadSandbox('env-provider-id'))?.serviceKey).toBeNull();
      }
    } finally {
      environmentRow.config = saved;
    }
  });
});
