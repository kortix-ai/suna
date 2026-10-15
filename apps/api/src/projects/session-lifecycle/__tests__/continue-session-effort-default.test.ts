// continueSession(): the project default reasoning effort rides the prompt.
// This file isolates continue-session.ts because Bun mocks are process-global;
// run it separately from other engine mock tests (`--isolate` gives it its own
// module graph).
//
// The behavior under test (lib/effort-default.ts): a prompt the platform
// delivers carries the project's default effort as its `variant` ONLY when
// the caller named none — the composer's "Auto" sends no variant at all — and
// ONLY when the session's serving model publishes that exact value. An
// explicit session pick always wins; a value the model doesn't publish is
// dropped, never sent.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, projects, sessionSandboxes } from '@kortix/db';

const SESSION_ID = 'sess-effort-1';
const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';
const EXTERNAL_ID = 'sandbox-1';
const OC_SESSION_ID = 'oc-1';

let sessionRow: Record<string, unknown> | null = null;
let boxRow: Record<string, unknown> | null = null;
let actor: string | null = 'automation-user-1';
/** The JSON body of every prompt forward, decoded. */
let forwardedBodies: Array<Record<string, unknown>> = [];

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
  generateSessionTitleFromFirstPrompt: async () => {},
}));

mock.module('../../../sandbox-proxy/forward', () => ({
  forwardToSandbox: async (
    _externalId: string,
    _port: number,
    _access: unknown,
    _method: string,
    _path: string,
    _query: string,
    _headers: Headers,
    body: ArrayBuffer,
  ) => {
    forwardedBodies.push(JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>);
    return new Response(null, { status: 204 });
  },
}));

mock.module('../../lib/sessions', () => ({
  createProjectSession: async () => {
    throw new Error('createProjectSession: not expected in this test');
  },
}));

mock.module('../../session-open', () => ({
  openSession: async () => {
    throw new Error('openSession: not expected in this test');
  },
}));

mock.module('../status-transitions', () => ({
  sessionTransitionLeaves: (_action: string, status: string) => status === 'stopped',
  transitionSession: async (action: string) => {
    void action;
    return true;
  },
}));
mock.module('../../../platform/service-key', () => ({ serviceKeyForExternalId: async () => 'key' }));
mock.module('../../../sandbox-proxy/backend', () => ({
  resolveSandboxIngress: async () => ({ url: 'https://sandbox.test', headers: {} }),
  invalidateSandbox: () => {},
  resolveServiceKey: async () => 'key',
}));
mock.module('../../lib/sandbox-env-sync', () => ({ syncSandboxEnvForPrompt: async () => {} }));

mock.module('../../lib/on-behalf-of', () => ({
  channelPrompterForOnBehalfOf: (input: { source: string; userId: string | null }) =>
    input.source?.startsWith('trigger:') ? null : undefined,
  clearSessionOnBehalfOfForPrompt: async () => true,
  bindSessionTurnIdentity: async () => true,
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

/** An awake box: the delivery takes the fast path and posts the prompt. */
function awakeSession(extra: Record<string, unknown> = {}) {
  sessionRow = {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    status: 'running',
    metadata: {},
    opencodeSessionId: OC_SESSION_ID,
    ...extra,
  };
  boxRow = { status: 'active', externalId: EXTERNAL_ID };
}

const lastVariant = (): unknown => forwardedBodies.at(-1)?.variant;

beforeEach(() => {
  sessionRow = null;
  boxRow = null;
  actor = 'automation-user-1';
  forwardedBodies = [];
});

describe('continueSession — project default reasoning effort', () => {
  test('no project default: the prompt carries no variant (today\u2019s behavior)', async () => {
    awakeSession({ metadata: { opencode_model: 'kortix/gpt-5.6-sol' } });
    expect(await continueSession({ sessionId: SESSION_ID, text: 'hello' } as never)).toBe(
      'delivered',
    );
    expect(lastVariant()).toBeUndefined();
  });

  test('a configured default rides the prompt when the model publishes it', async () => {
    // `deepseek-v4.1-flash` — the platform's managed default — publishes the
    // effort enum including `max`.
    awakeSession({ projectDefaultEffort: 'max', metadata: { opencode_model: 'kortix/deepseek-v4.1-flash' } });
    expect(await continueSession({ sessionId: SESSION_ID, text: 'hello' } as never)).toBe(
      'delivered',
    );
    expect(lastVariant()).toBe('max');
  });

  test('an explicit session pick wins over the project default', async () => {
    awakeSession({ projectDefaultEffort: 'max', metadata: { opencode_model: 'kortix/deepseek-v4.1-flash' } });
    expect(
      await continueSession({
        sessionId: SESSION_ID,
        text: 'hello',
        overrides: { variant: 'low' },
      } as never),
    ).toBe('delivered');
    expect(lastVariant()).toBe('low');
  });

  test('a default the session model does not publish is dropped, never sent', async () => {
    // `deepseek-v4.1-flash` publishes none/low/high/max — `medium` is not on
    // its ladder and must not ride the prompt.
    awakeSession({ projectDefaultEffort: 'medium', metadata: { opencode_model: 'kortix/deepseek-v4.1-flash' } });
    expect(await continueSession({ sessionId: SESSION_ID, text: 'hello' } as never)).toBe(
      'delivered',
    );
    expect(lastVariant()).toBeUndefined();
  });

  test('a stored value no catalog model publishes changes nothing', async () => {
    awakeSession({ projectDefaultEffort: 'ultra', metadata: { opencode_model: 'kortix/deepseek-v4.1-flash' } });
    expect(await continueSession({ sessionId: SESSION_ID, text: 'hello' } as never)).toBe(
      'delivered',
    );
    expect(lastVariant()).toBeUndefined();
  });

  test('no known model: nothing is injected (the runtime\u2019s own default applies)', async () => {
    awakeSession({ projectDefaultEffort: 'high', metadata: {} });
    expect(await continueSession({ sessionId: SESSION_ID, text: 'hello' } as never)).toBe(
      'delivered',
    );
    expect(lastVariant()).toBeUndefined();
  });

  test('the prompt\u2019s own model override selects the model the clamp checks', async () => {
    // deepseek does not publish `medium`; the prompt's own BYOK model does.
    awakeSession({ projectDefaultEffort: 'medium', metadata: { opencode_model: 'kortix/deepseek-v4.1-flash' } });
    expect(
      await continueSession({
        sessionId: SESSION_ID,
        text: 'hello',
        overrides: { model: { providerID: 'anthropic', modelID: 'claude-sonnet-5-5' } },
      } as never),
    ).toBe('delivered');
    expect(lastVariant()).toBe('medium');
    // Without the override the clamp reads the session's own model and drops it.
    forwardedBodies = [];
    expect(await continueSession({ sessionId: SESSION_ID, text: 'hello' } as never)).toBe(
      'delivered',
    );
    expect(lastVariant()).toBeUndefined();
  });
});
