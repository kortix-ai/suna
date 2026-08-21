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
let compileCalls: Array<{ ref: string | null | undefined; agent?: string }> = [];
let posted: Array<{ opencodeEnv?: Record<string, string | null>; refreshModels?: boolean }> = [];
let sessionMetadata: Record<string, unknown> | null = null;
// One fake row that satisfies every select on this path — the sandbox lookup and
// the session/project lookups `resolveSandboxEnvSnapshot` walks on its way to an
// env snapshot. Cheaper than teaching the fake db which table it was asked for.
const SANDBOX_ROW = {
  sessionId: 'sess-1',
  externalId: 'ext-1',
  provider: 'daytona',
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
let activeSandbox: {
  externalId: string;
  provider: string;
  config: Record<string, unknown>;
} | null = SANDBOX_ROW;
let daemonProof = true;
let daemonReload: string | null = 'restarted';

// Spread: the module also exports `agentConfigEtag`, which sandbox-env-sync now
// imports. A partial mock silently drops it and the module fails to load.
mock.module('./compile-agent-config', () => ({
  ...realCompile,
  resolveCompiledAgentConfigForSession: async (_project: unknown, baseRef?: string | null) => {
    compileCalls.push({ ref: baseRef });
    if (compileThrows) throw compileThrows;
    return compiled;
  },
  resolveSelectedAgentConfigForSession: async (
    _project: unknown,
    agentName: string,
    baseRef?: string | null,
  ) => {
    compileCalls.push({ ref: baseRef, agent: agentName });
    if (compileThrows) throw compileThrows;
    return compiled;
  },
}));

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = activeSandbox
            ? [{ ...SESSION_ROW, metadata: sessionMetadata, ...activeSandbox }]
            : [];
          return {
            limit: async () => rows,
            then: (resolve: (value: typeof rows) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(rows).then(resolve, reject),
          };
        },
      }),
    }),
  }, auditDb: {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = activeSandbox
            ? [{ ...SESSION_ROW, metadata: sessionMetadata, ...activeSandbox }]
            : [];
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

mock.module('./network-secret-boundary', () => ({
  resolveSessionNetworkBoundary: async () => [],
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
    // How the daemon applied it. 'kept-old' is the verified swap declining a
    // config that would not boot — the push landed, the config did not.
    opencode_reload: daemonReload,
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
  daemonReload = 'restarted';
  sessionMetadata = null;
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
  test('reports compilation before the blocking runtime apply starts', async () => {
    const phases: string[] = [];
    const result = await pushSessionAgentConfigToSandbox({
      ...INPUT,
      baseRef: 'main',
      onPhase: (phase) => phases.push(phase),
    });

    expect(result.applied).toBe(true);
    expect(phases).toEqual(['compiling-config', 'applying-config']);
  });

  test('pushes the freshly compiled config and asks for the opencode restart', async () => {
    // opencode reads its config only at spawn, so the push alone changes
    // nothing — `refreshModels` is what makes the daemon restart it and apply.
    const result = await pushSessionAgentConfigToSandbox({ ...INPUT, baseRef: 'main' });

    expect(result).toMatchObject({ applied: true, opencodeReload: 'restarted' });
    expect(posted).toHaveLength(1);
    expect(posted[0].opencodeEnv?.KORTIX_COMPILED_AGENT_CONFIG).toBe(compiled as string);
    expect(posted[0].refreshModels).toBe(true);
  });

  test('a declined swap is reported, not hidden behind applied:true', async () => {
    // The verified reload booted the new opencode, it never served, so the box
    // kept the one it had. We DID push — `applied` stays true — but the config
    // did not take, and only `opencodeReload` can say so. Collapsing this to a
    // bare success is exactly the silent no-op the swap exists to prevent.
    daemonReload = 'kept-old';
    const result = await pushSessionAgentConfigToSandbox({ ...INPUT, baseRef: 'main' });
    expect(result.applied).toBe(true);
    expect(result.opencodeReload).toBe('kept-old');
  });

  test('an older daemon that says nothing reports null, never success', async () => {
    daemonReload = null;
    const result = await pushSessionAgentConfigToSandbox({ ...INPUT, baseRef: 'main' });
    expect(result.opencodeReload).toBeNull();
  });

  test("recompiles from the SESSION's ref", async () => {
    await pushSessionAgentConfigToSandbox({ ...INPUT, baseRef: 'feature/x' });
    expect(compileCalls).toEqual([{ ref: 'feature/x' }]);
  });

  test('keeps runtime sessions on selected-agent compilation', async () => {
    sessionMetadata = { workspace_mode: 'runtime' };

    await pushSessionAgentConfigToSandbox({ ...INPUT, baseRef: 'main' });

    expect(compileCalls).toEqual([{ ref: 'main', agent: 'support' }]);
  });

  test('keeps historical read sessions on selected-agent compilation', async () => {
    sessionMetadata = { workspace_mode: 'read' };

    await pushSessionAgentConfigToSandbox({ ...INPUT, baseRef: 'main' });

    expect(compileCalls).toEqual([{ ref: 'main', agent: 'support' }]);
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
    activeSandbox = { externalId: 'ext-1', provider: 'daytona', config: {} };

    const result = await pushSessionAgentConfigToSandbox({ ...INPUT, baseRef: 'main' });

    expect(result.applied).toBe(false);
    expect(posted).toEqual([]);
  });
});
