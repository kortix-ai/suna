// A trigger's reused-session delivery authenticates as the ACCOUNT PRINCIPAL,
// not as a session-bound agent token.
//
// Regression for the hourly-heartbeat outage (2026-09-08, "delivery outcome:
// pending"): postPrompt() stamped `boundCredentialSessionId: callerSessionId`
// on its proxy access. In forwardToSandbox → canAccessSandboxSession →
// isProjectSessionVisibleTo, that non-null binding strips the trigger-session
// manager override (connectors/share.ts) — the override exists precisely so an
// UNBOUND project manager (here: the account owner resolving the trigger's
// automation actor) can reach a trigger-created private session. With it
// stripped, the owner check failed (the session's created_by is the agent's
// SERVICE ACCOUNT, not the owner), every fire 403'd with
// "Not authorized to access this session", and after five attempts dead-lettered
// as `delivery outcome: pending`.
//
// The fix: server-to-server delivery carries `boundCredentialSessionId: null`.
// This test pins it by capturing the access object postPrompt forwards, so a
// regression that re-aims the binding at the target session fails here.
//
// Same mocking caveat as the sibling engine.ts test files: `mock.module` is
// process-global in bun:test, so run this file on its own.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, projects, sessionSandboxes } from '@kortix/db';

const SESSION_ID = 'sess-trigger-delivery-1';
const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';
const EXTERNAL_ID = 'sandbox-1';
const OC_SESSION_ID = 'oc-1';

let sessionRow: Record<string, unknown> | null = null;
let forwardedAccess: Array<Record<string, unknown>> = [];

mock.module('../../../config', () => ({
  config: { KORTIX_URL: 'https://kortix.test' },
  SANDBOX_VERSION: 'test',
}));

mock.module('../../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === projectSessions) return sessionRow ? [sessionRow] : [];
            if (table === projects) return [{ projectId: PROJECT_ID, accountId: ACCOUNT_ID }];
            if (table === sessionSandboxes) {
              return [{ status: 'active', externalId: EXTERNAL_ID }];
            }
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

mock.module('../../../sandbox-proxy/routes/preview', () => ({
  forwardToSandbox: async (
    _externalId: string,
    _port: number,
    access: unknown,
    _method: string,
    _path: string,
    _query: string,
    _headers: Headers,
    _body: ArrayBuffer,
  ) => {
    forwardedAccess.push(access as Record<string, unknown>);
    return new Response(null, { status: 204 });
  },
}));

mock.module('../../lib/sessions', () => ({
  createProjectSession: async () => {
    throw new Error('createProjectSession: not expected in this test');
  },
}));

mock.module('../../routes/shared', () => ({
  openSession: async () => {
    throw new Error('openSession: not expected — the awake fast path skips it');
  },
}));

mock.module('../actor', () => ({
  resolveProjectAutomationActor: async () => 'account-owner-1',
  resolveAgentRunAttribution: async () => null,
}));

mock.module('../backpressure', () => ({
  sessionBackpressureState: async () => ({ shouldQueue: false, reason: null }),
}));

mock.module('../store', () => ({
  promoteNextInboxRow: async () => null,
  loadLegacyPendingFirstPrompt: async () => null,
  markLegacyInlineAttachmentsRepaired: async () => {},
  requeueUnlandedPrompt: async () => {
    throw new Error('not expected in this test');
  },
  MAX_LANDING_RETRIES: 2,
  requeueForAdmission: async () => {
    throw new Error('not expected in this test');
  },
  claimCreateSessionCommand: async () => {
    throw new Error('not expected in this test');
  },
  claimDueLifecycleCommands: async () => {
    throw new Error('not expected in this test');
  },
  enqueueContinueSessionCommand: async () => {
    throw new Error('not expected in this test');
  },
  MAX_RUNTIME_UNREACHABLE_RETRIES: 3,
  parkPromptForUnreachableRuntime: async () => ({ parked: true, retries: 1 }),
  reArmRuntimeBlockedPrompts: async () => 0,
  markCommandFailed: async () => {
    throw new Error('not expected in this test');
  },
  markCommandQueued: async () => {
    throw new Error('not expected in this test');
  },
  markCommandForwarded: async () => {},
  markCommandSucceeded: async () => {
    throw new Error('not expected in this test');
  },
  withNextDeliveryAttempt: (payload: unknown) => payload,
  withRemintedWireId: (id: string) => JSON.stringify({ redeliveredMessageId: id }),
  resultFromExistingCommand: () => {
    throw new Error('not expected in this test');
  },
}));

const { continueSession } = await import('../engine');

beforeEach(() => {
  sessionRow = null;
  forwardedAccess = [];
});

describe('continueSession — trigger delivery access carries no agent binding', () => {
  test('the prompt forward authenticates as the account principal, not a session-bound agent', async () => {
    // A trigger-created session: owned by the agent's service account, not the
    // account owner that resolves as the automation actor.
    sessionRow = {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      status: 'running',
      metadata: { source: 'trigger:cron', trigger_kind: 'git', trigger_slug: 'hourly-heartbeat' },
      opencodeSessionId: OC_SESSION_ID,
    };

    const outcome = await continueSession({
      sessionId: SESSION_ID,
      text: 'run the heartbeat',
    } as never);

    expect(outcome).toBe('delivered');
    expect(forwardedAccess).toHaveLength(1);
    const access = forwardedAccess[0] ?? {};
    expect(access).toMatchObject({
      kind: 'principal',
      userId: 'account-owner-1',
      callerSessionId: SESSION_ID,
      sandboxAuthored: false,
    });
    // The delivery is NOT a sandbox/agent token: its credential binding must be
    // null so the trigger-session manager override still authorizes the owner.
    expect(access.boundCredentialSessionId).toBeNull();
  });
});
