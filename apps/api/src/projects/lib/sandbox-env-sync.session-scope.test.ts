// Session-scoped secret sync: what an AGENT session gets from
// `POST /secrets/sync`. It re-pushes that session's own sandbox only — the same
// work every prompt's pre-prompt env sync already does — never another
// session's box. The project-wide fan-out stays a person's action.
//
// Harness copied from `sandbox-env-sync.instance-scope.test.ts` (the db double
// ignores WHERE, so the session filter must hold in code, which this asserts).
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import * as realSecrets from '../secrets';
import * as realSecretGrant from './secret-grant';

const PROJECT_ROW = {
  repoUrl: 'https://example.test/acme/repo.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  metadata: null as Record<string, unknown> | null,
};
const SESSION_ROW = {
  createdBy: 'user-1',
  agentName: 'support',
  secretsAllowlist: null as string[] | null,
};

type SandboxRow = {
  externalId: string | null;
  sessionId: string;
  provider: string;
  config: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};
let sandboxRows: SandboxRow[] = [];

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: (columns: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          const wantsSandboxes = 'externalId' in columns && 'sessionId' in columns;
          const wantsSession = 'createdBy' in columns;
          const rows = wantsSandboxes ? sandboxRows : wantsSession ? [SESSION_ROW] : [PROJECT_ROW];
          return {
            limit: async () => rows,
            then: (resolve: (value: typeof rows) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(rows).then(resolve, reject),
          };
        },
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

mock.module('./secret-grant', () => ({
  ...realSecretGrant,
  resolveSessionSecretGrant: async () => 'all' as const,
}));
mock.module('../secrets', () => ({
  ...realSecrets,
  listProjectSecretsSnapshotForUser: async () => ({
    env: { EXAMPLE: 'v1' },
    names: ['EXAMPLE'],
    revision: 'rev-1',
    capabilitiesJson: '{"version":1,"capabilities":[]}',
  }),
}));
mock.module('./network-secret-boundary', () => ({
  resolveSessionNetworkBoundary: async () => [],
}));
mock.module('../../sandbox-proxy/backend', () => ({
  resolveSandboxIngress: async (externalId: string) => ({
    url: `https://daemon.test/${externalId}`,
    headers: {},
  }),
}));

/** External ids whose daemon received an env push, in order. */
let pushed: string[] = [];
const ORIGINAL_FETCH = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = async (url: unknown, init?: { body?: string }) => {
  const href = String(url);
  const externalId = new URL(href).pathname.split('/')[1]!;
  pushed.push(externalId);
  const body = init?.body ? (JSON.parse(init.body) as { revision?: unknown }) : {};
  return Response.json({
    ok: true,
    revision: body.revision,
    exported: 1,
    managed: 1,
    withheld: 0,
    agent_env_written: true,
    opencode: 'ok',
  });
};

const { syncSessionSecretsToSandbox } = await import('./sandbox-env-sync');

function row(externalId: string): SandboxRow {
  return {
    externalId,
    sessionId: `sess-${externalId}`,
    provider: 'daytona',
    config: { serviceKey: `svc-${externalId}` },
    metadata: null,
  };
}

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});
beforeEach(() => {
  pushed = [];
  sandboxRows = [row('ext-mine'), row('ext-other')];
});

describe('syncSessionSecretsToSandbox — one session, never the project', () => {
  test('pushes only the named session’s own sandbox', async () => {
    const report = await syncSessionSecretsToSandbox('proj-1', 'sess-ext-mine');

    expect(pushed).toEqual(['ext-mine']);
    expect(report.targeted).toBe(1);
    expect(report.synced).toBe(1);
    expect(report.results.map((r) => r.session_id)).toEqual(['sess-ext-mine']);
  });

  test('a session with no active sandbox touches nothing', async () => {
    const report = await syncSessionSecretsToSandbox('proj-1', 'sess-missing');

    expect(pushed).toEqual([]);
    expect(report.active_sandboxes).toBe(0);
    expect(report.ok).toBe(true);
  });
});
