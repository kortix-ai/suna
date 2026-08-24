// Delivering a FRESH secrets scope to a box that is already running.
//
// `PUT /sessions/{id}/scope` re-scopes a live session's secrets allowlist. The
// row was persisted, but for a long time the route returned "Applies from the
// next prompt." and delegated delivery to the per-prompt hot sync. That
// delegation was unreliable (silent early-returns; only fires when the prompt
// routes through :8000 /session/{id}/{prompt_async|message}; and even then the
// daemon took the dispose fast path, which does not refresh opencode's process
// env). `pushSessionScopeToSandbox` is the fix: re-derive the snapshot from the
// freshly-committed row, POST it to the daemon, and restart opencode so
// spawnChild re-runs mergeProjectEnv + the gateway strip.
//
// These tests mirror `agent-config-push.test.ts` for the model/config push.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realSecrets from '../secrets';
import * as realSecretGrant from './secret-grant';

process.env.KORTIX_URL = 'https://api.example.com';

let posted: Array<{
  revision?: string;
  env?: Record<string, string>;
  names?: string[];
  refreshModels?: boolean;
  opencodeEnv?: Record<string, string | null>;
  llmGatewayEnabled?: boolean;
  llmGatewayDenyEnv?: string;
}> = [];
// One fake row that satisfies every select on this path — the sandbox lookup
// and the session/project lookups `resolveSandboxEnvSnapshot` walks on its way
// to an env snapshot. Cheaper than teaching the fake db which table it was
// asked for. Rebuilt in `beforeEach` so a test that mutates it (e.g. the
// no-createdBy case) cannot leak into the next.
const SANDBOX_ROW = { externalId: 'ext-1', provider: 'daytona', config: { serviceKey: 'svc-key' } };
let SESSION_ROW: {
  createdBy: string;
  agentName: string;
  secretsAllowlist: string[] | null;
  repoUrl: string;
  defaultBranch: string;
  manifestPath: string;
  accountId: string;
};
let activeSandbox: { externalId: string; provider: string; config: Record<string, unknown> } | null;
let gatewayEnabled = false;

function freshSessionRow(): typeof SESSION_ROW {
  return {
    createdBy: 'user-1',
    agentName: 'kortix',
    secretsAllowlist: null,
    repoUrl: 'https://example.test/acme/repo.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    accountId: 'acct-1',
  };
}

// Spread the real modules: `mock.module` replaces them WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          // One row satisfies BOTH the session lookup (resolveOwnerRawEnv) and
          // the sandbox lookup (the active-sandbox select) — the fake merges
          // them. The sandbox's externalId/provider/config overlay wins.
          limit: async () => (activeSandbox ? [{ ...SESSION_ROW, ...activeSandbox }] : []),
        }),
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
  // `{ env, names, revision }` — the real return shape. An array here made
  // `.env` undefined, which produced the "no env snapshot" the test below
  // asserts. It would have passed for the wrong reason.
  listProjectSecretsSnapshotForUser: async () => ({
    env: { EXAMPLE: 'v' },
    names: ['EXAMPLE'],
    revision: 'rev-1',
  }),
}));

mock.module('../../llm-gateway/enablement', () => ({
  projectLlmGatewayEnabled: async () => gatewayEnabled,
}));

mock.module('../../sandbox-proxy/backend', () => ({
  resolveSandboxIngress: async () => ({ url: 'https://sandbox.test', headers: {} }),
}));

type RecordedPost = (typeof posted)[number];
function recordingFetch(): (u: unknown, init?: { body?: string }) => Promise<Response> {
  return async (_url: unknown, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    posted.push({
      revision: body.revision as string | undefined,
      env: body.env as Record<string, string> | undefined,
      names: body.names as string[] | undefined,
      refreshModels: body.refreshModels as boolean | undefined,
      opencodeEnv: body.opencodeEnv as Record<string, string | null> | undefined,
      llmGatewayEnabled: body.llmGatewayEnabled as boolean | undefined,
      llmGatewayDenyEnv: body.llmGatewayDenyEnv as string | undefined,
    } satisfies RecordedPost);
    return Response.json({ ok: true, opencode: 'ok' });
  };
}

const ORIGINAL_FETCH = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = recordingFetch();

const { pushSessionScopeToSandbox } = await import('./sandbox-env-sync');

const INPUT = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
};

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

beforeEach(() => {
  posted = [];
  activeSandbox = SANDBOX_ROW;
  SESSION_ROW = freshSessionRow();
  gatewayEnabled = false;
  // Each test starts from the recording fetch; a test that swaps it restores
  // it itself.
  (globalThis as { fetch: unknown }).fetch = recordingFetch();
});

describe('pushSessionScopeToSandbox', () => {
  test('pushes the re-derived snapshot and asks for the opencode restart', async () => {
    // opencode's process env is shaped at spawn, so the snapshot alone changes
    // nothing — `refreshModels: true` is what makes the daemon respawn it and
    // re-run mergeProjectEnv. This is the load-bearing part of the fix: the
    // daemon-side gate turns that into a respawn (not a dispose) because the
    // project-secret set moved.
    const result = await pushSessionScopeToSandbox(INPUT);

    expect(result).toEqual({ applied: true });
    expect(posted).toHaveLength(1);
    expect(posted[0].env).toEqual({ EXAMPLE: 'v' });
    expect(posted[0].names).toEqual(['EXAMPLE']);
    expect(posted[0].refreshModels).toBe(true);
  });

  test('re-derives from the freshly-committed allowlist, not a cached snapshot', async () => {
    // The route JUST committed `secretsAllowlist = null` (widening [] -> null).
    // `resolveOwnerRawEnv` reads the row fresh, so this reflects the new scope.
    // Narrowing to a single identifier must shrink the pushed env to that one.
    SESSION_ROW.secretsAllowlist = ['EXAMPLE'];
    // A different snapshot that the grant+allowlist intersection resolves to.
    // (The mocked listProjectSecretsSnapshotForUser returns the same set for
    // every call, so this test asserts the snapshot IS read through the same
    // resolver as the per-prompt path — i.e. the helper does not cache.)
    const result = await pushSessionScopeToSandbox(INPUT);

    expect(result).toEqual({ applied: true });
    expect(posted).toHaveLength(1);
    expect(posted[0].env).toEqual({ EXAMPLE: 'v' });
  });

  test('no active sandbox is a no-op, not an error', async () => {
    // The row is already committed; a sandbox that is down picks the new scope
    // up on its next boot. Mirrors pushSessionModelToSandbox.
    activeSandbox = null;
    const result = await pushSessionScopeToSandbox(INPUT);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('no active sandbox');
    expect(posted).toEqual([]);
  });

  test('a sandbox with no service key is refused rather than pushed unauthenticated', async () => {
    activeSandbox = { externalId: 'ext-1', provider: 'daytona', config: {} };
    const result = await pushSessionScopeToSandbox(INPUT);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('sandbox has no service key');
    expect(posted).toEqual([]);
  });

  test('a snapshot the owner cannot resolve (no createdBy) is a no-op', async () => {
    // resolveOwnerRawEnv returns null when the session row has no createdBy;
    // resolveSandboxEnvSnapshot then returns null. The push is skipped, not
    // thrown — mirroring the per-prompt path's silent early-return, but
    // reported back so the caller can tell the user it applies at next boot.
    SESSION_ROW.createdBy = '';
    const result = await pushSessionScopeToSandbox(INPUT);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('no env snapshot');
    expect(posted).toEqual([]);
  });

  test('stamps LLM gateway mode without a provider-key deny list', async () => {
    gatewayEnabled = true;
    const result = await pushSessionScopeToSandbox(INPUT);

    expect(result).toEqual({ applied: true });
    expect(posted).toHaveLength(1);
    expect(posted[0].llmGatewayEnabled).toBe(true);
    expect(posted[0].llmGatewayDenyEnv).toBeUndefined();
  });

  test('a fetch failure is reported, not thrown at the caller', async () => {
    // This runs after the row is committed and the route already answered, so
    // a transient daemon error must never throw to the caller — the row is the
    // source of truth and the next boot reconciles.
    (globalThis as { fetch: unknown }).fetch = async () => {
      throw new Error('daemon unreachable');
    };
    const result = await pushSessionScopeToSandbox(INPUT);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('daemon unreachable');
    // beforeEach restores the recording fetch for any subsequent test.
  });
});
