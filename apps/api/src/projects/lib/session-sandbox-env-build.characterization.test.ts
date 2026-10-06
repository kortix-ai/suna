import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projects, projectSessions } from '@kortix/db';
import * as realDb from '../../shared/db';
import * as realCompile from './compile-agent-config';
import * as realRuntimeContext from './session-runtime-context';
import * as realSecrets from '../secrets';
import { SECRET_CAPABILITIES_ENV_NAME } from '../secret-capabilities';
import { buildPlatformMetaOpenCodeConfig } from './platform-meta-agent';

// Characterization test for buildSessionSandboxEnvVars (written before the
// builder is restructured). It pins the exact sandbox env record for fixed
// inputs with every I/O collaborator stubbed, so the split into per-source
// builders can be proven behavior-preserving: every scenario below must pass
// byte-for-byte before and after the refactor.
//
// Only I/O collaborators are mocked. The pure decision logic
// (selectSessionHarness, manifestRuntime, manifestPiPackages,
// intersectSecretGrants, sessionChannelEnvFromMetadata, buildSessionRuntimeEnv)
// runs for real, so a refactor that changes what the builder DECIDES fails here.

let projectMetadata: unknown = {};
let sessionRow: {
  secretsAllowlist: string[] | null;
  createdBy: string;
  metadata: unknown;
} = { secretsAllowlist: null, createdBy: 'creator-u1', metadata: {} };
let agentGrant: string[] | 'all' | undefined = undefined;
let snapshot: {
  env: Record<string, string>;
  names: string[];
  revision: string;
  capabilitiesJson: string;
} = { env: {}, names: [], revision: '', capabilitiesJson: '{}' };
let compiledConfig: string | null = null;
let rawManifest: Record<string, unknown> | null = null;
let repointedModel: string | null = null;
let contextEnv: Record<string, string> = {};
let piBundle: { digest: string; url: string; fallbackUrl: string } | null = null;

let snapshotCalls: Array<{
  projectId: string;
  principal: string | null;
  grant: string[] | 'all' | undefined;
  sessionId: string;
}> = [];
let grantCalls: number[] = [];

function query(table: unknown) {
  const run = async (): Promise<unknown[]> => {
    if (table === projects) return [{ metadata: projectMetadata }];
    if (table === projectSessions) return [sessionRow];
    throw new Error('session-sandbox-env-build.characterization.test.ts: unexpected table');
  };
  const builder = {
    where: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    then: (resolve: (rows: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      run().then(resolve, reject),
  };
  return builder;
}

mock.module('../../shared/db', () => ({
  ...realDb,
  db: { select: () => ({ from: (table: unknown) => query(table) }) },
}));

mock.module('./secret-grant', () => ({
  resolveSessionSecretGrant: async (input: { sessionAgent: string }) => {
    grantCalls.push(1);
    return agentGrant;
  },
}));

mock.module('../secrets', () => ({
  ...realSecrets,
  listProjectSecretsSnapshotForUser: async (
    projectId: string,
    principal: string | null,
    grant: string[] | 'all' | undefined,
    sessionId: string,
  ) => {
    snapshotCalls.push({ projectId, principal, grant, sessionId });
    return {
      env: { ...snapshot.env },
      names: [...snapshot.names],
      revision: snapshot.revision,
      capabilitiesJson: snapshot.capabilitiesJson,
    };
  },
}));

mock.module('../../llm-gateway/resolution/session-model-repoint', () => ({
  repointRetiredSessionModel: async (model: string) => repointedModel ?? model,
}));

mock.module('../../billing/services/entitlements', () => ({
  accountMayUseManagedModels: async () => true,
}));

mock.module('../../pi-packages/bundle', () => ({
  piPackageBundleForSession: async () => piBundle,
}));

mock.module('./personal-resources', () => ({
  resolveSessionPersonalOwner: async () => 'owner-u1',
}));

mock.module('./session-runtime-context', () => ({
  ...realRuntimeContext,
  buildSessionRuntimeContextEnv: async () => contextEnv,
}));

mock.module('./compile-agent-config', () => ({
  ...realCompile,
  resolveCompiledAgentConfigForSession: async (
    _gitProject: unknown,
    _baseRef: string,
    opts?: { onManifest?: (raw: Record<string, unknown>) => void },
  ) => {
    if (rawManifest && opts?.onManifest) opts.onManifest(rawManifest);
    return compiledConfig;
  },
  resolveSelectedAgentConfigForSession: async (
    _gitProject: unknown,
    _agentName: string,
    _baseRef: string,
    opts?: { onManifest?: (raw: Record<string, unknown>) => void },
  ) => {
    if (rawManifest && opts?.onManifest) opts.onManifest(rawManifest);
    return compiledConfig;
  },
}));

const { buildSessionSandboxEnvVars } = await import('./session-sandbox-env-build');

const baseInput = {
  accountId: 'acc-1',
  projectId: 'prj-1',
  sessionId: 'sess-1',
  userId: 'caller-u9',
  repoUrl: 'https://github.com/acme/widgets',
  baseRef: 'main',
  agentName: 'support',
  llmGatewayEnabled: false,
};

beforeEach(() => {
  projectMetadata = {};
  sessionRow = { secretsAllowlist: null, createdBy: 'creator-u1', metadata: {} };
  agentGrant = undefined;
  snapshot = { env: {}, names: [], revision: '', capabilitiesJson: '{}' };
  compiledConfig = null;
  rawManifest = null;
  repointedModel = null;
  contextEnv = {};
  piBundle = null;
  snapshotCalls = [];
  grantCalls = [];
});

/** Scenario A: a v2 project, native OpenCode, agent grant narrowed by the
 * manifest, a Slack channel binding restored from metadata, and a secret
 * snapshot carrying two Slack secrets and one reserved name that must be
 * dropped. The full top-level key set is pinned. */
describe('buildSessionSandboxEnvVars — v2 native session', () => {
  beforeEach(() => {
    agentGrant = ['STRIPE_API_KEY', 'INTERNAL_TOKEN'];
    sessionRow = {
      secretsAllowlist: ['STRIPE_API_KEY'],
      createdBy: 'creator-u1',
      metadata: { slack: { team_id: 'T1', channel: 'C1', thread_ts: '1.2', user: 'U1' } },
    };
    snapshot = {
      env: {
        STRIPE_API_KEY: 'sk_test_1',
        INTERNAL_TOKEN: 'tok_1',
        SLACK_SIGNING_SECRET: 'signing',
        SLACK_BOT_TOKEN: 'bot',
        PORT: '3000',
      },
      names: ['STRIPE_API_KEY', 'INTERNAL_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN', 'PORT'],
      revision: 'rev-7',
      capabilitiesJson: '{"STRIPE_API_KEY":["read"]}',
    };
    compiledConfig = '{"compiled":"v2"}';
    rawManifest = { kortix_version: 2 };
    contextEnv = { KORTIX_SESSION_TOPIC: 'release-ops' };
  });

  test('the env record is exactly the pinned set with the pinned values', async () => {
    const env = await buildSessionSandboxEnvVars({
      ...baseInput,
      opencodeModel: 'opencode/claude-sonnet-4',
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      repositoryAccess: true,
      freshSession: true,
      baseSha: 'abc123',
    });

    expect(Object.keys(env).sort()).toEqual(
      [
        'STRIPE_API_KEY',
        'INTERNAL_TOKEN',
        'KORTIX_API_URL',
        'KORTIX_AGENT_NAME',
        'KORTIX_BASE_REF',
        'KORTIX_BASE_SHA',
        'KORTIX_BOOTSTRAP_OPENCODE_SESSION',
        'KORTIX_BOOTSTRAP_RUNTIME_SESSION',
        'KORTIX_BRANCH_NAME',
        'KORTIX_CLONE_FILTER',
        'KORTIX_COMPILED_AGENT_CONFIG',
        'KORTIX_COMPILED_AGENT_CONFIG_ETAG',
        'KORTIX_CONNECTORS_MCP_ENABLED',
        'KORTIX_DEFAULT_BRANCH',
        'KORTIX_FRONTEND_URL',
        'KORTIX_MODEL',
        'KORTIX_OPENCODE_MODEL',
        'KORTIX_PROJECT_AUTO_CLONE',
        'KORTIX_PROJECT_ID',
        'KORTIX_PROJECT_SECRET_NAMES',
        'KORTIX_PROJECT_SECRETS_REVISION',
        'KORTIX_REPOSITORY_ACCESS',
        'KORTIX_REPO_URL',
        'KORTIX_SECRET_CAPABILITIES',
        'KORTIX_SERVICE_PORT',
        'KORTIX_SESSION_FRESH',
        'KORTIX_SESSION_ID',
        'KORTIX_SESSION_TOPIC',
        'SLACK_CHANNEL_ID',
        'SLACK_THREAD_TS',
        'SLACK_USER_ID',
        'SLACK_TEAM_ID',
      ].sort(),
    );

    // Secret env: the Slack signing secret and bot token never belong in the
    // sandbox; a project secret named like the runtime env (PORT) is dropped.
    expect(env.STRIPE_API_KEY).toBe('sk_test_1');
    expect(env.INTERNAL_TOKEN).toBe('tok_1');
    expect(env.SLACK_SIGNING_SECRET).toBeUndefined();
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(env.PORT).toBeUndefined();
    // The full names list is echoed even after the env deletions.
    expect(env.KORTIX_PROJECT_SECRET_NAMES).toBe(
      'STRIPE_API_KEY,INTERNAL_TOKEN,SLACK_SIGNING_SECRET,SLACK_BOT_TOKEN,PORT',
    );
    expect(env.KORTIX_PROJECT_SECRETS_REVISION).toBe('rev-7');
    expect(env[SECRET_CAPABILITIES_ENV_NAME]).toBe('{"STRIPE_API_KEY":["read"]}');

    // The channel binding survives a cold reprovision from metadata.
    expect(env.SLACK_TEAM_ID).toBe('T1');
    expect(env.SLACK_CHANNEL_ID).toBe('C1');
    expect(env.SLACK_THREAD_TS).toBe('1.2');
    expect(env.SLACK_USER_ID).toBe('U1');
    // The durable runtime context rows are merged into the env.
    expect(env.KORTIX_SESSION_TOPIC).toBe('release-ops');

    // Fleet default: the connectors MCP server is on unless switched off.
    expect(env.KORTIX_CONNECTORS_MCP_ENABLED).toBe('1');
    expect(env.KORTIX_CLONE_FILTER).toBe('');

    // Runtime identity + git delivery (proxy URL, never the upstream origin).
    expect(env.KORTIX_PROJECT_ID).toBe('prj-1');
    expect(env.KORTIX_SESSION_ID).toBe('sess-1');
    expect(env.KORTIX_AGENT_NAME).toBe('support');
    expect(env.KORTIX_API_URL).toBe('http://localhost:8008/v1');
    expect(env.KORTIX_FRONTEND_URL).toBe('http://localhost:3000');
    expect(env.KORTIX_REPO_URL).toBe('http://localhost:8008/v1/git/prj-1.git');
    expect(env.KORTIX_DEFAULT_BRANCH).toBe('main');
    expect(env.KORTIX_BASE_REF).toBe('main');
    expect(env.KORTIX_BRANCH_NAME).toBe('sess-1');
    expect(env.KORTIX_SESSION_FRESH).toBe('1');
    expect(env.KORTIX_BASE_SHA).toBe('abc123');
    expect(env.KORTIX_SERVICE_PORT).toBe('8000');
    expect(env.KORTIX_PROJECT_AUTO_CLONE).toBe('1');
    expect(env.KORTIX_REPOSITORY_ACCESS).toBe('1');
    expect(env.KORTIX_BOOTSTRAP_RUNTIME_SESSION).toBe('1');
    expect(env.KORTIX_BOOTSTRAP_OPENCODE_SESSION).toBe('1');

    // The model passes through unchanged when the gateway is off (no repoint).
    expect(env.KORTIX_MODEL).toBe('opencode/claude-sonnet-4');
    expect(env.KORTIX_OPENCODE_MODEL).toBe('opencode/claude-sonnet-4');

    // The compiled v2 agent config ships sealed, and its etag matches the
    // shipped config (what the daemon's /kortix/health echoes back).
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe('{"compiled":"v2"}');
    expect(env.KORTIX_COMPILED_AGENT_CONFIG_ETAG).toBe(
      realCompile.agentConfigEtag('{"compiled":"v2"}'),
    );

    // OpenCode is the daemon default: no explicit harness key.
    expect(env.KORTIX_HARNESS).toBeUndefined();
  });

  test('the secret snapshot is resolved as the session owner with the narrowed grant', async () => {
    await buildSessionSandboxEnvVars({
      ...baseInput,
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
    });

    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0]).toEqual({
      projectId: 'prj-1',
      principal: 'owner-u1',
      // (agent grant) ∩ (session allowlist) — INTERNAL_TOKEN is not allowlisted.
      grant: ['STRIPE_API_KEY'],
      sessionId: 'sess-1',
    });
    expect(grantCalls).toHaveLength(1);
  });
});

/** Scenario B: the platform meta coordinator. No manifest read at all, an
 * empty secret grant, the meta compiled config, and the meta env overrides. */
describe('buildSessionSandboxEnvVars — platform meta agent', () => {
  beforeEach(() => {
    sessionRow = { secretsAllowlist: ['STRIPE_API_KEY'], createdBy: 'creator-u1', metadata: {} };
    snapshot = { env: { STRIPE_API_KEY: 'sk_test_1' }, names: ['STRIPE_API_KEY'], revision: 'r1', capabilitiesJson: '{}' };
  });

  test('meta gets the meta config, no secret grant, and the meta overrides', async () => {
    const env = await buildSessionSandboxEnvVars({
      ...baseInput,
      platformMetaAgent: true,
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      repositoryAccess: true,
    });

    // The meta coordinator never reads the project manifest: no per-agent
    // grant resolution, and the compiled config is the platform one.
    expect(grantCalls).toHaveLength(0);
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(buildPlatformMetaOpenCodeConfig());
    expect(env[SECRET_CAPABILITIES_ENV_NAME]).toBe('{}');
    expect(env.STRIPE_API_KEY).toBe('sk_test_1');

    // API-level delegation instead of a project checkout.
    expect(env.KORTIX_META_AGENT).toBe('1');
    expect(env.KORTIX_PROJECT_AUTO_CLONE).toBe('0');

    // The grant handed to the snapshot resolver is empty for meta.
    expect(snapshotCalls[0].grant).toEqual([]);
  });
});

/** Scenario C: a v1 project — no manifest, no compiled config keys, and an
 * unscoped agent grant narrowed only by the session allowlist. */
describe('buildSessionSandboxEnvVars — v1 project', () => {
  beforeEach(() => {
    agentGrant = undefined;
    sessionRow = { secretsAllowlist: ['GMAPS_KEY'], createdBy: 'creator-u1', metadata: {} };
    snapshot = { env: { GMAPS_KEY: 'g1' }, names: ['GMAPS_KEY'], revision: 'r2', capabilitiesJson: '{}' };
  });

  test('no compiled config keys and the allowlist alone narrows the grant', async () => {
    const env = await buildSessionSandboxEnvVars({ ...baseInput });

    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBeUndefined();
    expect(env.KORTIX_COMPILED_AGENT_CONFIG_ETAG).toBeUndefined();
    expect(env.GMAPS_KEY).toBe('g1');
    expect(env.KORTIX_MODEL).toBeUndefined();
    expect(env.KORTIX_OPENCODE_MODEL).toBeUndefined();
    // undefined grant ∩ ['GMAPS_KEY'] allowlist → the allowlist itself.
    expect(snapshotCalls[0].grant).toEqual(['GMAPS_KEY']);
  });
});

/** Scenario D: the gateway model repoint happens at this chokepoint and its
 * result is what the sandbox boots with. */
describe('buildSessionSandboxEnvVars — gateway model repoint', () => {
  beforeEach(() => {
    sessionRow = { secretsAllowlist: null, createdBy: 'creator-u1', metadata: {} };
    snapshot = { env: {}, names: [], revision: '', capabilitiesJson: '{}' };
    repointedModel = 'kortix/claude-opus-4-8';
  });

  test('a retired pin is re-pointed before the env is built', async () => {
    const env = await buildSessionSandboxEnvVars({
      ...baseInput,
      llmGatewayEnabled: true,
      opencodeModel: 'kortix/claude-opus-4-6',
    });

    expect(env.KORTIX_MODEL).toBe('kortix/claude-opus-4-8');
    expect(env.KORTIX_OPENCODE_MODEL).toBe('kortix/claude-opus-4-8');
  });
});

/** Scenario E: restricted workspace mode — no repository delivery at all. */
describe('buildSessionSandboxEnvVars — restricted workspace', () => {
  beforeEach(() => {
    agentGrant = ['STRIPE_API_KEY'];
    compiledConfig = '{"compiled":"restricted"}';
    rawManifest = { kortix_version: 2 };
    snapshot = { env: { STRIPE_API_KEY: 'sk_test_1' }, names: ['STRIPE_API_KEY'], revision: 'r3', capabilitiesJson: '{}' };
  });

  test('no git delivery keys and the auto-clone override', async () => {
    const env = await buildSessionSandboxEnvVars({
      ...baseInput,
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      repositoryAccess: false,
      freshSession: true,
    });

    expect(env.KORTIX_REPO_URL).toBeUndefined();
    expect(env.KORTIX_DEFAULT_BRANCH).toBeUndefined();
    expect(env.KORTIX_BASE_REF).toBeUndefined();
    expect(env.KORTIX_BRANCH_NAME).toBeUndefined();
    expect(env.KORTIX_SESSION_FRESH).toBeUndefined();
    expect(env.KORTIX_PROJECT_AUTO_CLONE).toBe('0');
    expect(env.KORTIX_REPOSITORY_ACCESS).toBe('0');
    // The restricted agent still gets its compiled config and its secrets.
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe('{"compiled":"restricted"}');
    expect(env.STRIPE_API_KEY).toBe('sk_test_1');
  });
});
