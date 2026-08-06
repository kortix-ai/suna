// Delivering a FRESH compiled agent config to a box that is already running.
//
// The compiled agent config — agents, prompts, permissions, model — is compiled
// from git once at provision and handed down as an env var, and it was the one
// piece of config with no way into a live sandbox. `git pull` did not help (the
// compiled bytes never came from the working tree) and neither did restarting
// (the daemon's env was unchanged, so a respawn rebuilt the same config). So a
// session merged past days ago kept running the agents it booted with, with no
// documented way to reconcile the two short of starting a new session.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realCompile from './compile-agent-config';
import * as realSecrets from '../secrets';
import * as realSecretGrant from './secret-grant';

process.env.KORTIX_URL = 'https://api.example.com';

let compiled: string | null = '{"agent":{"support":{"prompt":"fresh"}}}';
let compileThrows: Error | null = null;
let compileCalls: Array<{ ref: string | null | undefined }> = [];
let posted: Array<{ opencodeEnv?: Record<string, string | null>; refreshModels?: boolean }> = [];
// One fake row that satisfies every select on this path — the sandbox lookup and
// the session/project lookups `resolveSandboxEnvSnapshot` walks on its way to an
// env snapshot. Cheaper than teaching the fake db which table it was asked for.
const SANDBOX_ROW = {
  sessionId: 'sess-1',
  externalId: 'ext-1',
  config: { serviceKey: 'svc-key' },
};
const SESSION_ROW = {
  createdBy: 'user-1',
  agentName: 'support',
  secretsAllowlist: null,
  repoUrl: 'https://example.test/acme/repo.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  accountId: 'acct-1',
};
let activeSandbox: { externalId: string; config: Record<string, unknown> } | null = SANDBOX_ROW;
let daemonProof = true;

// Spread: the module also exports `agentConfigEtag`, which sandbox-env-sync now
// imports. A partial mock silently drops it and the module fails to load.
mock.module('./compile-agent-config', () => ({
  ...realCompile,
  resolveCompiledAgentConfigForSession: async (_project: unknown, baseRef?: string | null) => {
    compileCalls.push({ ref: baseRef });
    if (compileThrows) throw compileThrows;
    return compiled;
  },
}));

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = activeSandbox ? [{ ...SESSION_ROW, ...activeSandbox }] : [];
          return {
            limit: async () => rows,
            then: (resolve: (value: typeof rows) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(rows).then(resolve, reject),
          };
        },
      }),
    }),
  },
}));

mock.module('./secret-grant', () => ({
  ...realSecretGrant,
  resolveSessionSecretGrant: async () => 'all' as const,
}));
// Spread the real module: overriding only the DB-backed reader keeps every other
// export (sanitizers, revision hashing) intact — a partial mock silently removes
// the rest and the module fails to load.
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

mock.module('../../sandbox-proxy/backend', () => ({
  resolveSandboxIngress: async () => ({ url: 'https://sandbox.test', headers: {} }),
}));

const ORIGINAL_FETCH = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = async (_url: unknown, init?: { body?: string }) => {
  const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  posted.push({
    opencodeEnv: body.opencodeEnv as Record<string, string | null> | undefined,
    refreshModels: body.refreshModels as boolean | undefined,
  });
  return Response.json({
    ok: true,
    revision: body.revision,
    exported: Object.keys((body.env as Record<string, unknown> | undefined) ?? {}).length,
    managed: 1,
    withheld: 0,
    agent_env_written: daemonProof,
  });
};

const { propagateProjectSecretsToActiveSandboxes, pushSessionAgentConfigToSandbox } =
  await import('./sandbox-env-sync');

const INPUT = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
  repoUrl: 'https://example.test/acme/repo.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
};

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

beforeEach(() => {
  compiled = '{"agent":{"support":{"prompt":"fresh"}}}';
  compileThrows = null;
  compileCalls = [];
  posted = [];
  activeSandbox = SANDBOX_ROW;
  daemonProof = true;
});

describe('propagateProjectSecretsToActiveSandboxes', () => {
  test('reports a sandbox only after the daemon confirms revision, file write, and export count', async () => {
    const result = await propagateProjectSecretsToActiveSandboxes('proj-1');

    expect(result).toMatchObject({
      ok: true,
      active_sandboxes: 1,
      targeted: 1,
      synced: 1,
      failed: 0,
      exported: 1,
      results: [{
        session_id: 'sess-1',
        sandbox_id: 'ext-1',
        status: 'synced',
        scope: 'inherit',
        revision: expect.any(String),
        exported: 1,
        managed: 1,
        withheld: 0,
        agent_env_written: true,
      }],
    });
  });

  test('reports failure when the daemon does not confirm agent-env.sh write', async () => {
    daemonProof = false;

    const result = await propagateProjectSecretsToActiveSandboxes('proj-1');

    expect(result).toMatchObject({
      ok: false,
      synced: 0,
      failed: 1,
      exported: 0,
      results: [{
        session_id: 'sess-1',
        status: 'failed',
        reason: 'env sync did not confirm agent-env.sh write',
      }],
    });
  });
});

describe('pushSessionAgentConfigToSandbox', () => {
  test('pushes the freshly compiled config and asks for the opencode restart', async () => {
    // opencode reads its config only at spawn, so the push alone changes
    // nothing — `refreshModels` is what makes the daemon restart it and apply.
    const result = await pushSessionAgentConfigToSandbox({ ...INPUT, baseRef: 'main' });

    expect(result).toEqual({ applied: true });
    expect(posted).toHaveLength(1);
    expect(posted[0].opencodeEnv?.KORTIX_COMPILED_AGENT_CONFIG).toBe(compiled as string);
    expect(posted[0].refreshModels).toBe(true);
  });

  test("recompiles from the SESSION's ref", async () => {
    await pushSessionAgentConfigToSandbox({ ...INPUT, baseRef: 'feature/x' });
    expect(compileCalls).toEqual([{ ref: 'feature/x' }]);
  });

  test('a project with no compiled config pushes NOTHING', async () => {
    // `null` is a v1 project or an unreadable manifest. Pushing an empty value
    // would delete the agents the box is running — for a transient read failure
    // that is a silent downgrade to no agents at all.
    compiled = null;

    const result = await pushSessionAgentConfigToSandbox({ ...INPUT, baseRef: 'main' });

    expect(result.applied).toBe(false);
    expect(posted).toEqual([]);
  });

  test('a compile failure pushes nothing and never throws at the caller', async () => {
    // This runs detached, after a restart already reported the session running.
    // A box that is up with old config beats one parked because git blipped.
    compileThrows = new Error('git mirror unavailable');

    const result = await pushSessionAgentConfigToSandbox({ ...INPUT, baseRef: 'main' });

    expect(result.applied).toBe(false);
    expect(posted).toEqual([]);
  });

  test('no active sandbox is a no-op, not an error', async () => {
    activeSandbox = null;
    expect((await pushSessionAgentConfigToSandbox({ ...INPUT, baseRef: 'main' })).applied).toBe(
      false,
    );
  });

  test('a sandbox with no service key is refused rather than pushed unauthenticated', async () => {
    activeSandbox = { externalId: 'ext-1', config: {} };

    const result = await pushSessionAgentConfigToSandbox({ ...INPUT, baseRef: 'main' });

    expect(result.applied).toBe(false);
    expect(posted).toEqual([]);
  });
});
