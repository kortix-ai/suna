// A channel follow-up must enable its OpenCode runtime features before the
// prompt is delivered. This test isolates engine.ts because Bun mocks are
// process-global; run this file separately from other engine mock tests.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, projects } from '@kortix/db';

const SESSION_ID = 'sess-runtime-env-1';
const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';
const EXTERNAL_ID = 'sandbox-1';
const events: string[] = [];

mock.module('../../../config', () => ({ config: { KORTIX_URL: 'https://api.test' } }));

mock.module('../../../shared/db', () => ({
  // `mock.module` replaces the WHOLE module: every export the import graph
  // reaches must exist here. `hasDatabase` entered this test's graph when
  // engine.ts started importing opencode-mapping (staged-revert check).
  hasDatabase: false,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === projectSessions)
              return [
                {
                  accountId: ACCOUNT_ID,
                  projectId: PROJECT_ID,
                  status: 'running',
                  sandboxProvider: 'daytona',
                  baseRef: 'main',
                  agentName: 'email-agent',
                  opencodeSessionId: 'oc-1',
                  metadata: { email: { inbox_id: 'inbox-1' } },
                },
              ];
            if (table === projects) return [{ projectId: PROJECT_ID, accountId: ACCOUNT_ID }];
            return [];
          },
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  }, auditDb: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === projectSessions)
              return [
                {
                  accountId: ACCOUNT_ID,
                  projectId: PROJECT_ID,
                  status: 'running',
                  sandboxProvider: 'daytona',
                  baseRef: 'main',
                  agentName: 'email-agent',
                  opencodeSessionId: 'oc-1',
                  metadata: { email: { inbox_id: 'inbox-1' } },
                },
              ];
            if (table === projects) return [{ projectId: PROJECT_ID, accountId: ACCOUNT_ID }];
            return [];
          },
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  },
}));

mock.module('../../session-title-generate', () => ({
  generateSessionTitleFromFirstPrompt: async () => {},
}));

mock.module('../../routes/shared', () => ({
  openSession: async () => {
    events.push('open');
    return {
      stage: 'ready',
      sandbox: { external_id: EXTERNAL_ID, provider: 'daytona' },
      opencode_session_id: 'oc-1',
    };
  },
}));

mock.module('../../../sandbox-proxy/backend', () => ({
  resolveSandboxIngress: async () => ({ url: 'https://sandbox.test', headers: {} }),
  // Complete-module stand-ins: every export the (growing) import graph
  // reaches must exist, or the whole file dies with "Export named X not
  // found". `resolveServiceKey` is reached via engine.ts → opencode-mapping.
  resolveServiceKey: async () => 'service-key-1',
}));

mock.module('../../../platform/service-key', () => ({
  serviceKeyForExternalId: async () => 'service-key-1',
}));

mock.module('../../lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async (input: Record<string, unknown>) => {
    events.push('sync');
    expect(input).toMatchObject({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      serviceKey: 'service-key-1',
      previewUrl: 'https://sandbox.test',
      providerName: 'daytona',
      opencodeEnv: { KORTIX_CONNECTORS_MCP_ENABLED: '1' },
    });
  },
}));

mock.module('../../../sandbox-proxy/routes/preview', () => ({
  forwardToSandbox: async () => {
    events.push('prompt');
    return new Response(null, { status: 204 });
  },
}));

mock.module('../../lib/sessions', () => ({
  createProjectSession: async () => {
    throw new Error('not expected');
  },
}));
mock.module('../actor', () => ({
  resolveProjectAutomationActor: async () => 'automation-user-1',
  resolveAgentRunAttribution: async () => null,
}));
mock.module('../backpressure', () => ({
  sessionBackpressureState: async () => ({ shouldQueue: false, reason: null }),
}));
mock.module('../store', () => ({
  promoteNextInboxRow: async () => null,
  // The prompt inbox's admission refusal — `executeQueuedContinue` calls it
  // before anything else, so every store mock has to carry it or the engine
  // import fails outright.
  requeueForAdmission: async () => {
    throw new Error('not expected: this test never refuses admission');
  },
  claimCreateSessionCommand: async () => {
    throw new Error('not expected');
  },
  claimDueLifecycleCommands: async () => [],
  enqueueContinueSessionCommand: async () => {},
  markCommandFailed: async () => {},
  markCommandQueued: async () => {},
  // Delivery of a row that carries a wire id closes through this now — see
  // `markCommandForwarded`. Present so the module mock stays complete.
  markCommandForwarded: async () => {},
  markCommandSucceeded: async () => {},
  // `inbox-rows.ts` imports this at module load, so the mock has to carry it or
  // the engine import fails outright. Nothing in this file drives a row through
  // it, so an identity pass-through is the whole of it.
  withNextDeliveryAttempt: (payload: unknown) => payload,
  resultFromExistingCommand: () => {
    throw new Error('not expected');
  },
}));

const { continueSession } = await import('../engine');

beforeEach(() => {
  events.length = 0;
});

describe('continueSession runtime env', () => {
  test('syncs OpenCode env after runtime readiness and before prompt delivery', async () => {
    expect(
      await continueSession({
        source: 'email',
        sessionId: SESSION_ID,
        text: 'new email',
        opencodeEnv: { KORTIX_CONNECTORS_MCP_ENABLED: '1' },
      }),
    ).toBe('delivered');
    expect(events).toEqual(['open', 'sync', 'prompt']);
  });
});
