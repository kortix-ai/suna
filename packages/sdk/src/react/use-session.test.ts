import { describe, expect, test, beforeEach, mock } from 'bun:test';

// Mock the lowest network boundary the reply/send paths go through — the
// OpenCode SDK client singleton — so the REAL `permissions.ts` wrappers and
// `promptOpenCodeMessage` run for real, matching session.test.ts's approach of
// stubbing the boundary rather than the wrapper.
let permissionReplyImpl: (args: unknown) => Promise<{ data?: unknown; error?: unknown; response?: Response }> =
  async () => ({ data: {} });
let questionReplyImpl: (args: unknown) => Promise<{ data?: unknown; error?: unknown; response?: Response }> =
  async () => ({ data: {} });
let questionRejectImpl: (args: unknown) => Promise<{ data?: unknown; error?: unknown; response?: Response }> =
  async () => ({ data: {} });
let sessionPromptImpl: (args: unknown) => Promise<{ data?: unknown; error?: unknown; response?: Response }> =
  async () => ({ data: {} });

class RuntimeNotReadyError extends Error {
  constructor(message = '[opencode-sdk] Server URL not ready — sandbox is still loading') {
    super(message);
    this.name = 'RuntimeNotReadyError';
  }
}

mock.module('../core/runtime/client', () => ({
  RuntimeNotReadyError,
  getClient: () => ({
    permission: { reply: (args: unknown) => permissionReplyImpl(args) },
    question: {
      reply: (args: unknown) => questionReplyImpl(args),
      reject: (args: unknown) => questionRejectImpl(args),
    },
    session: { promptAsync: (args: unknown) => sessionPromptImpl(args) },
  }),
}));

import { useOpenCodePendingStore } from '../browser/stores/opencode-pending-store';
import {
  getSessionSyncController,
  resetSessionSyncControllers,
} from '../browser/session-sync/session-sync-registry';
import { BillingError } from '../core/http/api/errors';
import { setCurrentRuntime } from '../core/session/current-runtime';
import { promptOpenCodeMessage } from './use-opencode-sessions/messages';
import {
  answerQuestion,
  rejectQuestion,
  answerPermission,
  beginRestPromptObservation,
  sendRestPromptWithObservation,
  classifySendError,
  buildSessionCommandInput,
  sendStateOnStart,
  sendStateOnError,
  shouldRetrySessionStart,
  shouldPollSessionStart,
  SESSION_START_POLL_OPTIONS,
  SESSION_START_POLL_MS,
  hasStartGivenUp,
  computeStartSettled,
  nextInconclusiveSince,
  START_INCONCLUSIVE_GIVE_UP_MS,
} from './use-session';
import { derivePhase } from './use-session-phase';
import { clearSessionFresh, markSessionFresh } from '../core/http/fresh-sessions';
import { SessionStartError } from '../core/rest/projects-client';

function seedQuestion(id: string, sessionID = 'sess-1') {
  useOpenCodePendingStore.getState().addQuestion({
    id,
    sessionID,
    questions: [{ text: 'Continue?', options: [] }],
  } as any);
}

function seedPermission(id: string, sessionID = 'sess-1') {
  useOpenCodePendingStore.getState().addPermission({
    id,
    sessionID,
    permission: 'bash',
    patterns: [],
    metadata: {},
    always: [],
  } as any);
}

beforeEach(() => {
  resetSessionSyncControllers();
  setCurrentRuntime(null);
  useOpenCodePendingStore.getState().clear();
  permissionReplyImpl = async () => ({ data: {} });
  questionReplyImpl = async () => ({ data: {} });
  questionRejectImpl = async () => ({ data: {} });
  sessionPromptImpl = async () => ({ data: {} });
});

describe('REST prompt observation scope', () => {
  test('targets the selected sandbox when two runtimes contain the same OpenCode id', () => {
    const sessionId = 'shared-session';
    const runtimeA = getSessionSyncController(sessionId, undefined, 'runtime-a');
    const runtimeB = getSessionSyncController(sessionId, undefined, 'runtime-b');

    beginRestPromptObservation(sessionId, 'runtime-b');

    expect(runtimeA.getSnapshot().isPromptObservedBusy).toBe(false);
    expect(runtimeB.getSnapshot().isPromptObservedBusy).toBe(true);
  });

  test('keeps observation active after an accepted sendParts prompt', async () => {
    const sessionId = 'send-parts-session';
    const controller = getSessionSyncController(sessionId, undefined, 'runtime-a');

    await sendRestPromptWithObservation(sessionId, 'runtime-a', async () => {});

    expect(controller.getSnapshot().isPromptObservedBusy).toBe(true);
  });

  test('ends observation when a sendParts prompt is rejected', async () => {
    const sessionId = 'failed-send-parts-session';
    const controller = getSessionSyncController(sessionId, undefined, 'runtime-a');
    const rejection = new Error('prompt rejected');

    await expect(
      sendRestPromptWithObservation(sessionId, 'runtime-a', async () => {
        throw rejection;
      }),
    ).rejects.toBe(rejection);

    expect(controller.getSnapshot().isPromptObservedBusy).toBe(false);
  });
});

describe('answerQuestion', () => {
  test('success calls question.reply with the request id + answers and removes the pending entry', async () => {
    seedQuestion('q1');
    let captured: unknown;
    questionReplyImpl = async (args) => {
      captured = args;
      return { data: {} };
    };

    await answerQuestion('q1', [['yes']]);

    expect(captured).toEqual({ requestID: 'q1', answers: [['yes']] });
    expect(useOpenCodePendingStore.getState().questions['q1']).toBeUndefined();
  });

  test('failure keeps the pending entry and throws a typed KortixSendError', async () => {
    seedQuestion('q1');
    questionReplyImpl = async () => ({ error: { message: 'boom' } });

    await expect(answerQuestion('q1', [['yes']])).rejects.toMatchObject({
      kind: 'runtime-error',
      message: 'boom',
    });
    expect(useOpenCodePendingStore.getState().questions['q1']).toBeDefined();
  });
});

describe('rejectQuestion', () => {
  test('success calls question.reject with the request id and removes the pending entry', async () => {
    seedQuestion('q1');
    let captured: unknown;
    questionRejectImpl = async (args) => {
      captured = args;
      return { data: {} };
    };

    await rejectQuestion('q1');

    expect(captured).toEqual({ requestID: 'q1' });
    expect(useOpenCodePendingStore.getState().questions['q1']).toBeUndefined();
  });

  test('failure keeps the pending entry and throws a typed error', async () => {
    seedQuestion('q1');
    questionRejectImpl = async () => ({ error: { message: 'nope' } });

    await expect(rejectQuestion('q1')).rejects.toMatchObject({ kind: 'runtime-error' });
    expect(useOpenCodePendingStore.getState().questions['q1']).toBeDefined();
  });
});

describe('answerPermission', () => {
  test('success calls permission.reply with the request id + reply and removes the pending entry', async () => {
    seedPermission('p1');
    let captured: unknown;
    permissionReplyImpl = async (args) => {
      captured = args;
      return { data: {} };
    };

    await answerPermission('p1', 'once', 'go ahead');

    expect(captured).toEqual({ requestID: 'p1', reply: 'once', message: 'go ahead' });
    expect(useOpenCodePendingStore.getState().permissions['p1']).toBeUndefined();
  });

  test('failure keeps the pending entry and throws a typed error', async () => {
    seedPermission('p1');
    permissionReplyImpl = async () => ({ error: { message: 'denied by server' } });

    await expect(answerPermission('p1', 'always')).rejects.toMatchObject({ kind: 'runtime-error' });
    expect(useOpenCodePendingStore.getState().permissions['p1']).toBeDefined();
  });
});

describe('classifySendError', () => {
  test('classifies a runtime-not-ready error from getClient()', () => {
    const err = new Error('[opencode-sdk] Server URL not ready — sandbox is still loading');
    expect(classifySendError(err).kind).toBe('runtime-not-ready');
  });

  test('classifies a RuntimeNotReadyError via instanceof, even with a non-matching message', () => {
    const err = new RuntimeNotReadyError('totally different wording');
    const result = classifySendError(err);
    expect(result.kind).toBe('runtime-not-ready');
    expect(result.cause).toBe(err);
  });

  test('classifies a 402-shaped error as billing', () => {
    const err = new Error('Payment Required') as Error & { status?: number; data?: unknown };
    err.status = 402;
    err.data = { message: 'Insufficient credits. Balance: $-0.06' };

    const result = classifySendError(err);
    expect(result.kind).toBe('billing');
    expect(result.billing).toBeInstanceOf(BillingError);
    expect(result.message).toBe('Insufficient credits. Balance: $-0.06');
  });

  test('falls back to runtime-error for a generic failure', () => {
    const result = classifySendError(new Error('opencode went sideways'));
    expect(result.kind).toBe('runtime-error');
    expect(result.message).toContain('opencode went sideways');
    expect(result.gateway).toBeUndefined();
  });

  // ERROR-TAXONOMY fix: a runtime-error carrying the gateway's structured
  // envelope (provider/code/suggestion/request_id) surfaces those fields on
  // `.gateway` instead of discarding everything but the bare message.
  test('a runtime-error carrying the gateway envelope (via responseBody) surfaces .gateway', () => {
    const err = {
      name: 'APIError',
      data: {
        message: 'No upstream configured for model "openai/gpt-4.1"',
        responseBody: JSON.stringify({
          message: 'No upstream configured for model "openai/gpt-4.1"',
          code: 'provider_not_connected',
          provider: 'openai',
          request_id: 'req_send_1',
          suggestion: 'Add an openai API key in project settings, then retry.',
        }),
      },
    };
    const result = classifySendError(err);
    expect(result.kind).toBe('runtime-error');
    expect(result.message).toBe('No upstream configured for model "openai/gpt-4.1"');
    expect(result.gateway).toEqual({
      provider: 'openai',
      code: 'provider_not_connected',
      suggestion: 'Add an openai API key in project settings, then retry.',
      upstreamStatus: undefined,
      requestId: 'req_send_1',
    });
  });
});

describe('send state transitions (sendStateOnStart / sendStateOnError)', () => {
  test('a send failure with a 402-shaped error clears pending and yields a billing sendError', async () => {
    sessionPromptImpl = async () => ({
      error: { data: { message: 'Insufficient credits. Balance: $-0.06' } },
      response: new Response(null, { status: 402 }),
    });

    const thrown = await promptOpenCodeMessage({
      sessionId: 'sess-1',
      parts: [{ type: 'text', text: 'hi' }],
    }).then(
      () => undefined,
      (e) => e,
    );

    const state = sendStateOnError(thrown);
    expect(state.pending).toBeNull();
    expect(state.sendError?.kind).toBe('billing');
    expect(state.sendError?.billing).toBeInstanceOf(BillingError);
  });

  test('sendError resets to null on the next sendStateOnStart', () => {
    const errored = sendStateOnError(new Error('boom'));
    expect(errored.sendError).not.toBeNull();

    const restarted = sendStateOnStart('a new message');
    expect(restarted.sendError).toBeNull();
    expect(restarted.pending).toBe('a new message');
  });
});

describe('buildSessionCommandInput', () => {
  test('preserves the command model, agent, and variant overrides', () => {
    expect(
      buildSessionCommandInput('ses_root', 'review', 'src', {
        agent: 'coder',
        model: { providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4-6' },
        variant: 'high',
      }),
    ).toEqual({
      sessionId: 'ses_root',
      command: 'review',
      args: 'src',
      agent: 'coder',
      model: 'kortix/anthropic/claude-sonnet-4-6',
      variant: 'high',
    });
  });

  test('omits empty optional overrides', () => {
    expect(
      buildSessionCommandInput('ses_root', 'review', '', {
        agent: null,
        model: null,
        variant: null,
      }),
    ).toEqual({
      sessionId: 'ses_root',
      command: 'review',
      args: '',
    });
  });
});

describe('shouldRetrySessionStart', () => {
  const startError = (status: number) => new SessionStartError('nope', { status, terminal: true });

  test('retries a 404 for a fresh session within the grace window, then gives up', () => {
    markSessionFresh('fresh');
    try {
      expect(shouldRetrySessionStart(0, startError(404), 'fresh')).toBe(true);
      expect(shouldRetrySessionStart(11, startError(404), 'fresh')).toBe(true);
      expect(shouldRetrySessionStart(12, startError(404), 'fresh')).toBe(false);
    } finally {
      clearSessionFresh('fresh');
    }
  });

  test('does NOT retry a 404 for a non-fresh session (genuinely missing / no access)', () => {
    expect(shouldRetrySessionStart(0, startError(404), 'stale')).toBe(false);
  });

  test('does not retry other terminal start errors even when fresh', () => {
    markSessionFresh('fresh');
    try {
      expect(shouldRetrySessionStart(0, startError(403), 'fresh')).toBe(false);
      expect(shouldRetrySessionStart(0, startError(402), 'fresh')).toBe(false);
    } finally {
      clearSessionFresh('fresh');
    }
  });

  test('retries a few times on transient (non-start) errors', () => {
    const transient = new Error('network blip');
    expect(shouldRetrySessionStart(0, transient, 'x')).toBe(true);
    expect(shouldRetrySessionStart(2, transient, 'x')).toBe(true);
    expect(shouldRetrySessionStart(3, transient, 'x')).toBe(false);
  });
});

describe('shouldPollSessionStart', () => {
  const at = (stage: string) => ({ stage }) as never;

  test('keeps polling while the box is still coming up', () => {
    expect(shouldPollSessionStart(null, at('provisioning'))).toBe(SESSION_START_POLL_MS);
    expect(shouldPollSessionStart(null, at('starting'))).toBe(SESSION_START_POLL_MS);
  });

  test('a null payload (transient transport failure) still polls — the box did not go away', () => {
    expect(shouldPollSessionStart(null, null)).toBe(SESSION_START_POLL_MS);
    expect(shouldPollSessionStart(null, undefined)).toBe(SESSION_START_POLL_MS);
  });

  test('stops on every terminal stage', () => {
    expect(shouldPollSessionStart(null, at('ready'))).toBe(false);
    expect(shouldPollSessionStart(null, at('failed'))).toBe(false);
    expect(shouldPollSessionStart(null, at('stopped'))).toBe(false);
  });

  test('stops on a terminal client error, which polling cannot fix', () => {
    const err = new SessionStartError('gone', { status: 403, terminal: true });
    expect(shouldPollSessionStart(err, at('provisioning'))).toBe(false);
  });
});

describe('SESSION_START_POLL_OPTIONS', () => {
  test('keeps interval fetches active while the document is hidden', () => {
    expect(SESSION_START_POLL_OPTIONS.refetchIntervalInBackground).toBe(true);
  });
});

// `startProjectSession` swallows every 5xx/408/429/transport failure into a
// `null` result instead of throwing, so on a persistent /start outage
// `shouldPollSessionStart(null, null)` polls forever with no error to
// observe — `startSettled` could never become true, pinning `phase` at
// 'starting' forever when a runtime error coexists with it. These tests pin
// the give-up bound that makes "settled" reachable in bounded time, and the
// wiring (`computeStartSettled`) that the hook's `phase` line actually calls.
describe('hasStartGivenUp', () => {
  test('never gives up while /start has SOMETHING to say — data or error', () => {
    const longAgo = Date.now() - START_INCONCLUSIVE_GIVE_UP_MS * 10;
    expect(hasStartGivenUp({ stage: 'starting' } as never, null, longAgo, Date.now())).toBe(false);
    expect(hasStartGivenUp(null, new Error('boom'), longAgo, Date.now())).toBe(false);
  });

  test('does not give up before the budget elapses', () => {
    const now = Date.now();
    expect(hasStartGivenUp(null, null, now - (START_INCONCLUSIVE_GIVE_UP_MS - 1), now)).toBe(false);
  });

  test('gives up once the budget elapses with nothing but silence', () => {
    const now = Date.now();
    expect(hasStartGivenUp(null, null, now - START_INCONCLUSIVE_GIVE_UP_MS, now)).toBe(true);
  });

  test('no timestamp yet (the very first inconclusive tick) is never a give-up', () => {
    expect(hasStartGivenUp(null, null, null, Date.now())).toBe(false);
  });
});

// `computeStartSettled` no longer takes a raw timestamp pair
// (`inconclusiveSinceMs`/`nowMs`). It takes `hasGivenUp` — an
// ALREADY-RESOLVED boolean the caller computed once, in its own effect, from
// `hasStartGivenUp` (see that describe block above for the time-crossing
// behavior itself). Every other input here (`enabled`, `isFetching`, `data`,
// `error`) is read fresh, every call — the point of this signature change is
// that NONE of those four can ever be stale, because they are never stored;
// only `hasGivenUp` is state in the real hook, and it is the one piece that
// inherently needs wall-clock tracking. See the `describe` block below this
// one for the regression this was actually fixing.
describe('computeStartSettled', () => {
  test('a disabled query settles immediately — it was never "still working"', () => {
    expect(
      computeStartSettled({
        enabled: false,
        isFetching: false,
        data: null,
        error: null,
        hasGivenUp: false,
      }),
    ).toBe(true);
  });

  test('a fetch in flight is unsettled only while /start has NOT given up', () => {
    expect(
      computeStartSettled({
        enabled: true,
        isFetching: true,
        data: null,
        error: null,
        hasGivenUp: false,
      }),
    ).toBe(false);
  });

  // `hasGivenUp` must be tested BEFORE `isFetching`. /start keeps polling
  // after give-up — `shouldPollSessionStart(null, null)` returns 1500ms
  // forever. So past the 45s budget this function answered false while a
  // poll was in flight and true in the gap between polls, `phase` oscillated
  // 'starting' <-> 'error', and the runtime error card blinked on and off
  // once per poll cycle for the whole outage. `startGivenUp` is sticky by
  // construction (the effect only
  // clears it when /start actually answers, or the session changes, or the
  // query is disabled), so give-up now short-circuits ABOVE the fetch check
  // and both frames of the cycle agree.
  test('once /start has given up, both frames of the poll cycle read settled — no 1500ms blink', () => {
    const givenUp = { enabled: true, data: null, error: null, hasGivenUp: true } as const;
    // Mid-poll. Under the old ordering this was `false` — the blink's OFF frame.
    expect(computeStartSettled({ ...givenUp, isFetching: true })).toBe(true);
    // Between polls. Was already `true`, which is what made the two disagree.
    expect(computeStartSettled({ ...givenUp, isFetching: false })).toBe(true);
  });

  test('a terminal stage settles immediately, same as today, regardless of hasGivenUp', () => {
    expect(
      computeStartSettled({
        enabled: true,
        isFetching: false,
        data: { stage: 'failed' } as never,
        error: null,
        hasGivenUp: false,
      }),
    ).toBe(true);
  });

  test('an unresolved poll is settled only once hasGivenUp says so — the boolean passes through unchanged', () => {
    expect(
      computeStartSettled({
        enabled: true,
        isFetching: false,
        data: null,
        error: null,
        hasGivenUp: false,
      }),
    ).toBe(false);
    expect(
      computeStartSettled({
        enabled: true,
        isFetching: false,
        data: null,
        error: null,
        hasGivenUp: true,
      }),
    ).toBe(true);
  });

  test('disabled always wins over a stale hasGivenUp=true carried from a prior enabled window', () => {
    // An earlier fix addressed the RAW TIMESTAMP leaking across a disabled
    // period. This test pins a second instance of the same hole one layer
    // up, in the DERIVED BOOLEAN (`startSettled`, stored via `useState`): the
    // effect stored the FULL settled decision, including the `!enabled ->
    // true` branch, so a disabled -> enabled transition could read a stale
    // `true` for one committed, painted frame — with a live runtimeError in
    // that window, `derivePhase` rendered 'error' before a single real
    // /start request had fired. Moving `enabled` (and isFetching, and the
    // terminal-stage check) to be ALWAYS-FRESH render-time inputs — never
    // state — makes this structurally impossible: `enabled: false` here
    // wins regardless of what `hasGivenUp` claims, because `hasGivenUp` is
    // never even consulted.
    expect(
      computeStartSettled({
        enabled: false,
        isFetching: false,
        data: null,
        error: null,
        hasGivenUp: true,
      }),
    ).toBe(true); // "settled" (=inert), NOT because it gave up — because it's disabled.
  });

  test('the crux line: a persistent /start outage + a live runtime error reaches phase "error" within the budget, not a permanent spinner', () => {
    const since = Date.now();
    const runtimeError = { status: 503, body: { error: 'sandbox not ready (status: stopped)' } };

    // Still inside the budget: phase must stay 'starting', not flip to 'error'.
    const stillWaitingGivenUp = hasStartGivenUp(
      null,
      null,
      since,
      since + START_INCONCLUSIVE_GIVE_UP_MS - 1,
    );
    const stillWaitingSettled = computeStartSettled({
      enabled: true,
      isFetching: false,
      data: null,
      error: null,
      hasGivenUp: stillWaitingGivenUp,
    });
    expect(
      derivePhase({
        terminal: false,
        startError: null,
        runtimeError,
        startSettled: stillWaitingSettled,
        switched: false,
      }),
    ).toBe('starting');

    // Budget elapsed with nothing but silence: this MUST reach 'error', not hang.
    const gaveUp = hasStartGivenUp(null, null, since, since + START_INCONCLUSIVE_GIVE_UP_MS);
    const settledAfterGivingUp = computeStartSettled({
      enabled: true,
      isFetching: false,
      data: null,
      error: null,
      hasGivenUp: gaveUp,
    });
    expect(
      derivePhase({
        terminal: false,
        startError: null,
        runtimeError,
        startSettled: settledAfterGivingUp,
        switched: false,
      }),
    ).toBe('error');
  });
});

// The effect that stamped `startInconclusiveSinceRef` had no `enabled`
// guard, so it armed the clock even while the /start query was disabled
// (auth load, billing-blocked). The stale stamp then carried into the
// enabled window, and the first non-fetching null tick after enabling could
// already read as "given up" — reintroducing the exact premature error card
// commit f49e9e38c2 removed. `nextInconclusiveSince` is the extracted,
// unit-testable arm/reset decision the effect now just calls; these tests
// pin the invariant directly, since the earlier composed
// `computeStartSettled` + `derivePhase` test could not see this bug (it
// hand-fed `inconclusiveSinceMs` and never exercised how that value gets
// PRODUCED).
describe('nextInconclusiveSince', () => {
  test('stays null while disabled, even with a fetch settled and nothing to show', () => {
    expect(
      nextInconclusiveSince({
        current: null,
        enabled: false,
        hasData: false,
        hasError: false,
        isFetching: false,
        nowMs: Date.now(),
      }),
    ).toBeNull();
  });

  test('disabling clears an existing stamp — it must not survive into the enabled window', () => {
    const staleStamp = Date.now() - START_INCONCLUSIVE_GIVE_UP_MS * 10;
    expect(
      nextInconclusiveSince({
        current: staleStamp,
        enabled: false,
        hasData: false,
        hasError: false,
        isFetching: false,
        nowMs: Date.now(),
      }),
    ).toBeNull();
  });

  test('arms fresh at nowMs on the first genuinely inconclusive tick while enabled', () => {
    const now = Date.now();
    expect(
      nextInconclusiveSince({
        current: null,
        enabled: true,
        hasData: false,
        hasError: false,
        isFetching: false,
        nowMs: now,
      }),
    ).toBe(now);
  });

  test('keeps the original stamp on later inconclusive ticks — the clock only starts once', () => {
    const armedAt = Date.now() - 1_000;
    expect(
      nextInconclusiveSince({
        current: armedAt,
        enabled: true,
        hasData: false,
        hasError: false,
        isFetching: false,
        nowMs: Date.now(),
      }),
    ).toBe(armedAt);
  });

  test('clears the instant data arrives', () => {
    const armedAt = Date.now() - 1_000;
    expect(
      nextInconclusiveSince({
        current: armedAt,
        enabled: true,
        hasData: true,
        hasError: false,
        isFetching: false,
        nowMs: Date.now(),
      }),
    ).toBeNull();
  });

  test('clears the instant an error arrives', () => {
    const armedAt = Date.now() - 1_000;
    expect(
      nextInconclusiveSince({
        current: armedAt,
        enabled: true,
        hasData: false,
        hasError: true,
        isFetching: false,
        nowMs: Date.now(),
      }),
    ).toBeNull();
  });

  test('a fetch in flight keeps counting toward an existing stamp — it does not reset the clock', () => {
    const armedAt = Date.now() - 1_000;
    expect(
      nextInconclusiveSince({
        current: armedAt,
        enabled: true,
        hasData: false,
        hasError: false,
        isFetching: true,
        nowMs: Date.now(),
      }),
    ).toBe(armedAt);
  });

  test('a fetch in flight with nothing armed yet stays null — not yet inconclusive', () => {
    expect(
      nextInconclusiveSince({
        current: null,
        enabled: true,
        hasData: false,
        hasError: false,
        isFetching: true,
        nowMs: Date.now(),
      }),
    ).toBeNull();
  });

  test('sitting disabled past the budget, then enabling, does not pre-consume the grace window', () => {
    let current: number | null = null;
    const disabledStart = Date.now() - START_INCONCLUSIVE_GIVE_UP_MS * 2;
    // Simulate ticks while disabled (e.g. auth still loading, or
    // billing-blocked) for well over a full budget's worth of time — the ref
    // must never arm.
    for (
      let t = disabledStart;
      t < disabledStart + START_INCONCLUSIVE_GIVE_UP_MS;
      t += SESSION_START_POLL_MS
    ) {
      current = nextInconclusiveSince({
        current,
        enabled: false,
        hasData: false,
        hasError: false,
        isFetching: false,
        nowMs: t,
      });
    }
    expect(current).toBeNull();

    // Now enable it. The very first non-fetching, dataless tick must arm
    // FRESH at "now", not read as already-given-up from the disabled period.
    const enabledAt = Date.now();
    current = nextInconclusiveSince({
      current,
      enabled: true,
      hasData: false,
      hasError: false,
      isFetching: false,
      nowMs: enabledAt,
    });
    expect(current).toBe(enabledAt);

    // Mirrors the real effect's two-step pipeline: hasStartGivenUp first
    // (the time-aware part), then computeStartSettled (the always-fresh
    // part) consumes that as a plain boolean.
    const givenUpImmediatelyAfterEnabling = hasStartGivenUp(null, null, current, enabledAt);
    expect(givenUpImmediatelyAfterEnabling).toBe(false);
    const settledImmediatelyAfterEnabling = computeStartSettled({
      enabled: true,
      isFetching: false,
      data: null,
      error: null,
      hasGivenUp: givenUpImmediatelyAfterEnabling,
    });
    expect(settledImmediatelyAfterEnabling).toBe(false);
  });
});

describe('classifySendError — connector refusals', () => {
  const connection = {
    id: '11111111-1111-4111-a111-111111111111',
    slug: 'gmail',
    name: 'Gmail',
    authorization_strategy: 'project' as const,
  };
  const refusal = (data: Record<string, unknown>) =>
    Object.assign(new Error('Failed to send message'), { status: 409, data });

  test('a required-connector 409 is its own kind, not a generic runtime error', () => {
    // It used to collapse into `runtime-error`, so a host could only say
    // "something went wrong" for the one failure with an obvious remedy — and the
    // platform had already refused the turn before the sandbox saw it.
    const result = classifySendError(
      refusal({
        code: 'CONNECTOR_CONNECTION_REQUIRED',
        message: 'Connect the required connectors before continuing this session.',
        connector_connections: [connection],
      }),
    );

    expect(result.kind).toBe('connector');
    expect(result.connectors).toEqual([connection]);
    expect(result.message).toBe(
      'Connect the required connectors before continuing this session.',
    );
  });

  test('classification keys on the CODE, never the prose', () => {
    // The message is written for humans and will be reworded.
    expect(
      classifySendError(refusal({ message: 'Connect the required connectors.' })).kind,
    ).toBe('runtime-error');
  });

  test('a refusal naming no usable connection stays generic', () => {
    // A connect prompt that cannot say WHICH connector is worse than the generic
    // error it replaced.
    expect(
      classifySendError(refusal({ code: 'CONNECTOR_CONNECTION_REQUIRED' })).kind,
    ).toBe('runtime-error');
    expect(
      classifySendError(
        refusal({ code: 'CONNECTOR_CONNECTION_REQUIRED', connector_connections: [{ id: 'x' }] }),
      ).kind,
    ).toBe('runtime-error');
  });

  test('an unknown authorization strategy is dropped rather than guessed', () => {
    // The strategy decides whether a connect button can help at all; inventing
    // one would offer a button that 409s.
    expect(
      classifySendError(
        refusal({
          code: 'CONNECTOR_CONNECTION_REQUIRED',
          connector_connections: [{ ...connection, authorization_strategy: 'workspace' }],
        }),
      ).kind,
    ).toBe('runtime-error');
  });

  test('billing still wins — a 402 is not a connector problem', () => {
    expect(classifySendError(refusal({ code: 'CONNECTOR_CONNECTION_REQUIRED' })).kind).not.toBe(
      'billing',
    );
  });
});
