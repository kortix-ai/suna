// continueSession(): what a server-side delivery does before and during the
// prompt forward. The heavier dependencies are stubbed so its top-level imports
// resolve; `mock.module` is process-global, and the `--isolate` runner gives
// this file its own module graph.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, projects, sessionSandboxes } from '@kortix/db';

const SESSION_ID = 'sess-continue-1';
const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';
const EXTERNAL_ID = 'sandbox-1';
const OC_SESSION_ID = 'oc-1';

let sessionRow: Record<string, unknown> | null = null;
/** The session's box. Null sends the delivery down the wake path. */
let boxRow: Record<string, unknown> | null = null;
let actor: string | null = 'automation-user-1';
let titleCalls: Array<Record<string, unknown>> = [];
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
            if (table === sessionSandboxes) return boxRow ? [boxRow] : [];
            return [];
          },
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  },
}));

mock.module('../../session-title-generate', () => ({
  generateSessionTitleFromFirstPrompt: async (input: Record<string, unknown>) => {
    titleCalls.push(input);
  },
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
    throw new Error('openSession: reached');
  },
}));

mock.module('../actor', () => ({
  resolveProjectAutomationActor: async () => actor,
  resolveAgentRunAttribution: async () => null,
}));

mock.module('../backpressure', () => ({
  sessionBackpressureState: async () => ({ shouldQueue: false, reason: null }),
}));

const notExpected = (name: string) => async () => {
  throw new Error(`${name}: not expected in this test`);
};

mock.module('../store', () => ({
  promoteNextInboxRow: async () => null,
  loadLegacyPendingFirstPrompt: async () => null,
  markLegacyInlineAttachmentsRepaired: async () => {},
  requeueUnlandedPrompt: notExpected('requeueUnlandedPrompt'),
  MAX_LANDING_RETRIES: 2,
  requeueForAdmission: notExpected('requeueForAdmission'),
  claimCreateSessionCommand: notExpected('claimCreateSessionCommand'),
  claimDueLifecycleCommands: notExpected('claimDueLifecycleCommands'),
  enqueueContinueSessionCommand: notExpected('enqueueContinueSessionCommand'),
  MAX_RUNTIME_UNREACHABLE_RETRIES: 3,
  parkPromptForUnreachableRuntime: async () => ({ parked: true, retries: 1 }),
  reArmRuntimeBlockedPrompts: async () => 0,
  markInboxDeliveryStarted: async () => {},
  markCommandFailed: notExpected('markCommandFailed'),
  markCommandQueued: notExpected('markCommandQueued'),
  markCommandForwarded: async () => {},
  markCommandSucceeded: notExpected('markCommandSucceeded'),
  withNextDeliveryAttempt: (payload: unknown) => payload,
  withRemintedWireId: (id: string) => JSON.stringify({ redeliveredMessageId: id }),
  resultFromExistingCommand: notExpected('resultFromExistingCommand'),
}));

const { continueSession } = await import('../continue-session');

beforeEach(() => {
  sessionRow = { accountId: ACCOUNT_ID, projectId: PROJECT_ID, status: 'running', metadata: {} };
  boxRow = null;
  actor = 'automation-user-1';
  titleCalls = [];
  forwardedAccess = [];
});

// The title fires before the runtime opens; these cases stop at the open.
describe('continueSession — server-side delivery titles the session', () => {
  test('a server-side delivery titles the session with the prompt and the actor', async () => {
    await expect(
      continueSession({ sessionId: SESSION_ID, text: 'bump the node version in CI' } as never),
    ).rejects.toThrow(/openSession/);

    expect(titleCalls).toHaveLength(1);
    expect(titleCalls[0]?.firstPromptText).toBe('bump the node version in CI');
    expect(titleCalls[0]?.userId).toBe('automation-user-1');
  });

  test('an explicit command.userId is preferred over the resolved automation actor', async () => {
    await expect(
      continueSession({ sessionId: SESSION_ID, text: 'hello', userId: 'user-42' } as never),
    ).rejects.toThrow(/openSession/);
    expect(titleCalls[0]?.userId).toBe('user-42');
  });

  test('no actor → returns pending and never titles', async () => {
    actor = null;

    expect(await continueSession({ sessionId: SESSION_ID, text: 'hello' } as never)).toBe(
      'pending',
    );
    expect(titleCalls).toEqual([]);
  });
});

// Regression for the hourly-heartbeat outage (2026-09-08, "delivery outcome:
// pending"): postPrompt() stamped `boundCredentialSessionId: callerSessionId`
// on its proxy access. That non-null binding strips the trigger-session manager
// override (connectors/share.ts), which exists so an UNBOUND project manager —
// the account owner resolving the trigger's automation actor — can reach a
// trigger-created private session. Every fire 403'd, then dead-lettered.
describe('continueSession — trigger delivery access carries no agent binding', () => {
  test('the prompt forward authenticates as the account principal, not a session-bound agent', async () => {
    actor = 'account-owner-1';
    // A trigger-created session: owned by the agent's service account, not the
    // account owner that resolves as the automation actor. The box is awake,
    // so the delivery takes the fast path and never opens the runtime.
    sessionRow = {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      status: 'running',
      metadata: { source: 'trigger:cron', trigger_kind: 'git', trigger_slug: 'hourly-heartbeat' },
      opencodeSessionId: OC_SESSION_ID,
    };
    boxRow = { status: 'active', externalId: EXTERNAL_ID };

    const outcome = await continueSession({
      sessionId: SESSION_ID,
      text: 'run the heartbeat',
    } as never);

    expect(outcome).toBe('delivered');
    expect(forwardedAccess).toHaveLength(1);
    expect(forwardedAccess[0]).toMatchObject({
      kind: 'principal',
      userId: 'account-owner-1',
      callerSessionId: SESSION_ID,
      sandboxAuthored: false,
      // Not a sandbox/agent token: the null binding keeps the manager override.
      boundCredentialSessionId: null,
    });
  });
});
