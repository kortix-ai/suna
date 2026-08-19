/**
 * The hot env push must re-state `KORTIX_LLM_CONNECTED_PROVIDERS` on every
 * prompt, so a provider connected AFTER the sandbox booted reaches a box that
 * is already running.
 *
 * Why it has to ride this path at all: the sandbox bounds its model reconcile
 * to `managed ∪ connected-provider models`. Boot injects the list once
 * (platform/services/session-sandbox.ts). Connecting a provider mid-session
 * changes nothing the sandbox can observe on its own — the credential lives in
 * the project's secrets, which the guest never reads — so without this push the
 * newly offered models stay absent from OpenCode's provider map until the next
 * session, and picking one dies with `ModelNotFound: kortix/<id>`.
 *
 * It rides `opencodeEnv`, which `promptModelSignature` already digests, so a
 * CHANGED list re-pushes with `refreshModels: true` and an UNCHANGED one still
 * short-circuits the round-trip entirely.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

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

mock.module('../../llm-gateway/enablement', () => ({
  projectLlmGatewayEnabled: () => true,
}));

/** The project's LLM-gateway secret names — flip between prompts to simulate a
 *  provider being connected mid-session. */
let gatewaySecretNames: string[] = [];

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: (columns: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          const rows = 'createdBy' in columns ? [SESSION_ROW] : [PROJECT_ROW];
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

let capturedPrincipalUserId: string | null | undefined;

mock.module('../secrets', () => ({
  ...realSecrets,
  listProjectSecretsSnapshotForUser: async () => ({
    env: { EXAMPLE: 'v1' },
    names: ['EXAMPLE'],
    revision: 'rev-1',
    capabilitiesJson: '{"version":1,"capabilities":[]}',
  }),
  listProjectSecretNamesForConsumer: async (input: { principalUserId?: string | null }) => {
    capturedPrincipalUserId = input.principalUserId;
    return gatewaySecretNames;
  },
}));

mock.module('./network-secret-boundary', () => ({
  resolveSessionNetworkBoundary: async () => [],
}));

type PostedBody = {
  refreshModels: unknown;
  opencodeEnv: Record<string, unknown>;
};
let posted: PostedBody[] = [];

const ORIGINAL_FETCH = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = async (_url: unknown, init?: { body?: string }) => {
  const body = init?.body ? (JSON.parse(init.body) as PostedBody) : ({} as PostedBody);
  posted.push(body);
  return Response.json({
    ok: true,
    revision: 'rev-1',
    exported: 1,
    managed: 1,
    withheld: 0,
    agent_env_written: true,
    opencode: 'ok',
  });
};

const { syncSandboxEnvForPrompt, __resetPromptModelSignatureCacheForTests } = await import(
  './sandbox-env-sync'
);

function prompt(externalId = 'ext-1') {
  return syncSandboxEnvForPrompt({
    projectId: 'proj-1',
    sessionId: 'sess-1',
    externalId,
    serviceKey: 'svc-key',
    previewUrl: 'https://sandbox.test',
    providerHeaders: {},
    providerName: 'daytona',
  });
}

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

beforeEach(() => {
  __resetPromptModelSignatureCacheForTests();
  posted = [];
  gatewaySecretNames = [];
  capturedPrincipalUserId = undefined;
});

describe('syncSandboxEnvForPrompt — connected providers', () => {
  test('every push carries the list, even when nothing is connected', async () => {
    await prompt();

    expect(posted).toHaveLength(1);
    // Empty string, not absent: the guest must be able to tell "no BYOK
    // provider" from "this API never told me", and only the first is a reason
    // to reconcile managed models alone.
    expect(posted[0]!.opencodeEnv.KORTIX_LLM_CONNECTED_PROVIDERS).toBe('');
  });

  test('resolves against the SESSION CREATOR, whose personal secrets decide it', async () => {
    await prompt();
    expect(capturedPrincipalUserId).toBe('user-1');
  });

  test('a provider connected mid-session reaches a running box, with refreshModels', async () => {
    await prompt();
    expect(posted[0]!.opencodeEnv.KORTIX_LLM_CONNECTED_PROVIDERS).toBe('');

    // The user connects Anthropic between two prompts.
    gatewaySecretNames = ['ANTHROPIC_API_KEY'];
    await prompt();

    expect(posted).toHaveLength(2);
    expect(posted[1]!.opencodeEnv.KORTIX_LLM_CONNECTED_PROVIDERS).toBe('anthropic');
    // The signature moved, so the push is not short-circuited and the daemon is
    // asked to act on it.
    expect(posted[1]!.refreshModels).toBe(true);
  });

  test('an unchanged list still short-circuits the whole round-trip', async () => {
    gatewaySecretNames = ['ANTHROPIC_API_KEY'];
    await prompt();
    await prompt();
    await prompt();

    expect(posted).toHaveLength(1);
    expect(posted[0]!.opencodeEnv.KORTIX_LLM_CONNECTED_PROVIDERS).toBe('anthropic');
  });

  test('a caller-supplied opencodeEnv is preserved alongside it', async () => {
    await syncSandboxEnvForPrompt({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      externalId: 'ext-2',
      serviceKey: 'svc-key',
      previewUrl: 'https://sandbox.test',
      providerHeaders: {},
      providerName: 'daytona',
      opencodeEnv: { KORTIX_OPENCODE_MODEL: 'kortix/grok-4.6' },
    });

    expect(posted[0]!.opencodeEnv.KORTIX_OPENCODE_MODEL).toBe('kortix/grok-4.6');
    expect(posted[0]!.opencodeEnv.KORTIX_LLM_CONNECTED_PROVIDERS).toBe('');
  });
});
