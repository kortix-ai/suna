// A prompt's env sync resolves the env snapshot and the network-boundary
// bindings. Both need the session row, the project row, the running agent's
// grant and the personal-override owner. One shared context reads each once.
import { beforeEach, expect, mock, test } from 'bun:test';
import { projectSessions, projects } from '@kortix/db';

import * as realSecrets from '../secrets';

let reads = { session: 0, project: 0, grant: 0, owner: 0 };

mock.module('../../lib/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === projectSessions) {
              reads.session += 1;
              return [{ createdBy: 'user-1', agentName: 'support', secretsAllowlist: null }];
            }
            if (table === projects) {
              reads.project += 1;
              return [{ repoUrl: 'https://example.test/r.git', defaultBranch: 'main', manifestPath: 'kortix.yaml' }];
            }
            return [];
          },
        }),
      }),
    }),
  },
}));
mock.module('./secret-grant', () => ({
  resolveSessionSecretGrant: async () => {
    reads.grant += 1;
    return 'all' as const;
  },
}));
mock.module('./personal-resources', () => ({
  resolveSessionPersonalOwner: async () => {
    reads.owner += 1;
    return 'user-1';
  },
}));
mock.module('./secret-audience', () => ({
  secretAudienceSubject: async () => ({ kind: 'session' }),
}));
mock.module('../secrets', () => ({
  ...realSecrets,
  listResolvedProjectSecrets: async () => [],
  listProjectSecretsSnapshotForUser: async () => ({
    env: { EXAMPLE: 'v' },
    capabilitiesJson: '{"version":1,"capabilities":[]}',
  }),
}));

const { loadSessionSecretContext } = await import('./session-secret-context');
const { resolveSandboxEnvSnapshot } = await import('./sandbox-env-snapshot');
const { resolveSessionNetworkBoundary } = await import('./network-secret-boundary');

beforeEach(() => {
  reads = { session: 0, project: 0, grant: 0, owner: 0 };
});

test('one context serves the snapshot and the boundary: each row and the grant are read once', async () => {
  const context = loadSessionSecretContext('proj-1', 'sess-1', null);
  const [snapshot, boundary] = await Promise.all([
    resolveSandboxEnvSnapshot('proj-1', 'sess-1', null, context),
    resolveSessionNetworkBoundary('proj-1', 'sess-1', null, context),
  ]);

  expect(snapshot?.env).toEqual({ EXAMPLE: 'v' });
  expect(boundary).toEqual([]);
  expect(reads).toEqual({ session: 1, project: 1, grant: 1, owner: 1 });
});

test('a caller with no context to share still reads its own', async () => {
  await resolveSandboxEnvSnapshot('proj-1', 'sess-1');
  await resolveSessionNetworkBoundary('proj-1', 'sess-1');
  expect(reads).toEqual({ session: 2, project: 2, grant: 2, owner: 2 });
});
