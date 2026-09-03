import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { sessionEnvironments } from '@kortix/db';

let environmentRow: Record<string, unknown> | null;
let finishCreate: (value: {
  externalId: string;
  baseUrl: string;
  metadata: Record<string, unknown>;
}) => void;
let removedExternalIds: string[];
let startedMeters: string[];
let endedMeters: string[];

mock.module('../../billing/services/compute-metering', () => ({
  startComputeSession: async ({ sandboxId }: { sandboxId: string }) => {
    startedMeters.push(sandboxId);
    return 'meter-1';
  },
  endComputeSession: async (sandboxId: string) => {
    endedMeters.push(sandboxId);
  },
}));

mock.module('../../projects/lib/sessions', () => ({
  buildSessionSandboxEnvVars: async () => ({}),
}));

mock.module('./session-runtime-token', () => ({
  mintSessionRuntimeToken: async () => ({
    tokenId: '00000000-0000-4000-8000-000000000099',
    secretKey: 'service-key',
  }),
}));

mock.module('../../repositories/account-tokens', () => ({
  revokeAccountToken: async () => true,
}));

mock.module('../../shared/daytona', () => ({
  getDaytona: () => {
    throw new Error('unexpected Daytona SDK call');
  },
}));

mock.module('../../shared/with-timeout', () => ({
  withTimeout: async <T>(value: Promise<T>) => value,
}));

mock.module('../../snapshots/builder', () => ({
  ensureSandboxImage: async () => ({ snapshotName: 'snapshot-1' }),
}));

mock.module('../providers', () => ({
  getProvider: () => ({
    create: () =>
      new Promise((resolve) => {
        finishCreate = resolve;
      }),
    remove: async (externalId: string) => {
      removedExternalIds.push(externalId);
    },
  }),
}));

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            return environmentRow ? [environmentRow] : [];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const result = {
          onConflictDoNothing: () => result,
          returning: async () => {
            if (table !== sessionEnvironments || environmentRow) return [];
            environmentRow = {
              ...values,
              externalId: null,
              updatedAt: new Date(),
            };
            return [environmentRow];
          },
        };
        return result;
      },
    }),
    update: () => ({
      set: (updates: Record<string, unknown>) => ({
        where: () => {
          const result = Promise.resolve(undefined) as Promise<undefined> & {
            returning: () => Promise<Record<string, unknown>[]>;
          };
          result.returning = async () => {
            if (!environmentRow) return [];
            environmentRow = { ...environmentRow, ...updates };
            return [environmentRow];
          };
          return result;
        },
      }),
    }),
  },
}));

const { ensureSessionEnvironment } = await import('./session-environment');

beforeEach(() => {
  environmentRow = null;
  finishCreate = () => {
    throw new Error('provider create did not start');
  };
  removedExternalIds = [];
  startedMeters = [];
  endedMeters = [];
});

describe('session environment provision ownership', () => {
  test('removes a provider box that finishes after its row was deleted', async () => {
    await ensureSessionEnvironment({
      sessionId: 'session-1',
      projectId: 'project-1',
      accountId: 'account-1',
      userId: 'user-1',
      agentName: 'kortix',
      baseRef: 'main',
      gitProject: {
        projectId: 'project-1',
        repoUrl: 'https://example.com/repo.git',
        defaultBranch: 'main',
        manifestPath: 'kortix.yaml',
      } as never,
    });
    environmentRow = null;
    finishCreate({ externalId: 'env-ext-1', baseUrl: '', metadata: {} });

    for (let i = 0; i < 100 && removedExternalIds.length === 0; i++) await Bun.sleep(1);

    expect(removedExternalIds).toEqual(['env-ext-1']);
    expect(startedMeters).toEqual([]);
    expect(endedMeters).toHaveLength(1);
  });
});
