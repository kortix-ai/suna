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
  metadata: { provisionAttemptId: 'first-boot' },
};
let queriedTables: unknown[] = [];
let environmentColumns: Record<string, unknown> | null = null;
let ingressResolutions = 0;

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
    resolveIngress: async () => ({
      url: 'https://environment.example',
      headers: { 'X-Daytona-Preview-Token': `token-${++ingressResolutions}` },
    }),
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

const { loadSandbox, resolveSandboxIngress, invalidateSandbox } = await import('./backend');

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

  test.each(['http', 'websocket'] as const)(
    'refreshes %s provider credentials immediately after another API process resumes the environment',
    async (transport) => {
      const saved = environmentRow.metadata;
      try {
        invalidateSandbox(environmentRow.externalId);
        ingressResolutions = 0;
        const request = { port: 8000, transport, path: '/pty/terminal/connect' };
        const initial = await resolveSandboxIngress(environmentRow.externalId, request);
        expect(await resolveSandboxIngress(environmentRow.externalId, request)).toEqual(initial);
        expect(ingressResolutions).toBe(1);

        environmentRow.metadata = { provisionAttemptId: 'resumed-boot' };
        const resumed = await resolveSandboxIngress(environmentRow.externalId, request);
        expect(resumed.headers).not.toEqual(initial.headers);
        expect(ingressResolutions).toBe(2);
        expect(await resolveSandboxIngress(environmentRow.externalId, request)).toEqual(resumed);
        expect(ingressResolutions).toBe(2);
      } finally {
        environmentRow.metadata = saved;
        invalidateSandbox(environmentRow.externalId);
      }
    },
  );

  test('does not reuse a preview link resolved before the resumed environment becomes active', async () => {
    const savedStatus = environmentRow.status;
    try {
      invalidateSandbox(environmentRow.externalId);
      ingressResolutions = 0;
      environmentRow.status = 'provisioning';
      const provisioning = await loadSandbox(environmentRow.externalId);
      const first = await resolveSandboxIngress(provisioning!, { port: 8000 });
      environmentRow.status = 'active';
      const active = await loadSandbox(environmentRow.externalId);
      const second = await resolveSandboxIngress(active!, { port: 8000 });
      expect(second.headers).not.toEqual(first.headers);
      expect(ingressResolutions).toBe(2);
    } finally {
      environmentRow.status = savedStatus;
      invalidateSandbox(environmentRow.externalId);
    }
  });
});
