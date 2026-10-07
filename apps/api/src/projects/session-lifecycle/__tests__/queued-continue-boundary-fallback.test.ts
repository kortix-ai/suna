// KRTX-1684 — the queue's boundary fallback.
//
// A queued head row refused `turn_active` arms the daemon's tool-boundary
// interrupt and waits. That handshake is one the API cannot verify: a turn
// entry the terminal relay never closed, an arm the daemon answers and never
// fires, an arm skipped on an identity mismatch — each leaves the row waiting
// out the WHOLE run in silence (prod 2026-10-06: three queued messages behind
// a ~30-minute research run, dispatched only after the user aborted it).
//
// The fallback bounds that: past QUEUE_BOUNDARY_FALLBACK_MS behind the SAME
// live turn, `admitQueuedContinue` ends the turn itself (stamped
// `QueueInterrupt`, before the abort), the terminal relay promotes the row,
// and the queue dispatches. These tests pin the wiring — window start, window
// patience, the one abort, the reset on a moved boundary — without a database
// or a runtime, on the same `mock.module` seams
// ./queued-continue-staged-revert.test.ts uses.
//
// `mock.module` is process-global in bun:test, so this file must run on its
// own (the repo's `--isolate` runner already guarantees that).
import { describe, expect, mock, test } from 'bun:test';
import type { SessionLifecycleCommandRow } from '../store';
import { QUEUE_BOUNDARY_FALLBACK_MS } from '../inbox-admission';

const SESSION_ID = 'sess-boundary-1';
const TURN = { opencodeSessionId: 'oc-live', messageId: 'msg_live' };

let abortCalls: string[] = [];
let stopRequests: Array<{ sessionId: string; name: string; scope: unknown }> = [];
let requeueCalls: Array<{ reason: string; patch: unknown }> = [];
let markerResult: Record<string, unknown> = {};

mock.module('../../../config', () => ({
  config: { KORTIX_URL: 'https://api.test' },
  SANDBOX_VERSION: 'test',
}));

mock.module('../store', () => ({
  promoteNextInboxRow: async () => null,
  requeueForAdmission: async (
    _lease: unknown,
    reason: string,
    _availableAt: Date,
    patch?: Record<string, unknown>,
  ) => {
    requeueCalls.push({ reason, patch: patch ?? null });
    return true;
  },
  claimDueLifecycleCommands: async () => [],
  claimCreateSessionCommand: async () => {
    throw new Error('not expected');
  },
  enqueueContinueSessionCommand: async () => {
    throw new Error('not expected');
  },
  MAX_RUNTIME_UNREACHABLE_RETRIES: 3,
  parkPromptForUnreachableRuntime: async () => ({ parked: true, retries: 1 }),
  requeueUnlandedPrompt: async () => {
    throw new Error('not expected: this test never fails a landing proof');
  },
  markInboxDeliveryStarted: async () => {},
  requeueUnverifiedRedelivery: async () => ({ requeued: true, refusals: 0 }),
  markCommandFailed: async () => {},
  markCommandSucceeded: async () => {},
  loadLegacyPendingFirstPrompt: async () => null,
  markLegacyInlineAttachmentsRepaired: async () => {},
}));

mock.module('../inbox-admission', () => ({
  admitInboxPrompt: async () => ({
    admit: false,
    reason: 'turn_active',
    retryAfterMs: 300,
    interruptAtBoundary: TURN,
  }),
  hasLaterReleasedSibling: async () => false,
  sessionHoldsLiveTurn: async () => false,
  QUEUE_BOUNDARY_FALLBACK_MS,
}));

mock.module('../runtime-client', () => ({
  armQuickQueueInterrupt: async () => true,
  queuedContinueHasStagedRevert: async () => false,
  readInboxTranscriptState: async () => {
    throw new Error('not expected: a refused row never reads the transcript');
  },
  // Every other importer of this module keeps its own names — carried so the
  // mock stays complete for the import chain, never called on this path.
  removeStrandedOpencodeMessage: async () => false,
  PromptNeverLandedError: class PromptNeverLandedError extends Error {},
  SteerNotTaken: class SteerNotTaken extends Error {
    name = 'SteerNotTaken';
  },
  postPrompt: async () => {
    throw new Error('not expected: a refused row never delivers');
  },
  readLegacyRuntimeMessage: async () => null,
  updateLegacyRuntimePart: async () => false,
  DAEMON_PORT: 8000,
  readSessionMessageTip: async () => null,
}));

mock.module('../abort-runtime-turn', () => ({
  abortRuntimeTurn: async (sessionId: string) => {
    abortCalls.push(sessionId);
    return true;
  },
}));

mock.module('../../session-turn-ledger', () => ({
  markTurnStopRequested: async (sessionId: string, name: string, scope: unknown) => {
    stopRequests.push({ sessionId, name, scope });
  },
}));

const { executeQueuedContinue } = await import('../queued-continue');

const row = (result: Record<string, unknown>): SessionLifecycleCommandRow =>
  ({
    commandId: 'cmd-boundary-1',
    commandType: 'continue_session',
    sessionId: SESSION_ID,
    source: 'ui',
    projectId: 'proj-1',
    actorUserId: 'user-1',
    idempotencyKey: 'prompt:sess-boundary-1:msg-1',
    attempts: 1,
    createdAt: new Date(1_000_000),
    result,
    payload: { text: 'hi', placement: 'transcript', clientMessageId: 'msg-1' },
  }) as unknown as SessionLifecycleCommandRow;

describe('the queue boundary fallback', () => {
  test('the first refusal starts the window and ends nothing', async () => {
    markerResult = {};
    requeueCalls = [];
    abortCalls = [];
    stopRequests = [];
    const outcome = await executeQueuedContinue(row(markerResult));
    expect(outcome).toBe('queued');
    expect(abortCalls).toEqual([]);
    expect(stopRequests).toEqual([]);
    expect(requeueCalls).toHaveLength(1);
    const patch = requeueCalls[0].patch as { boundary_wait: Record<string, unknown> };
    expect(patch.boundary_wait.opencodeSessionId).toBe(TURN.opencodeSessionId);
    expect(patch.boundary_wait.messageId).toBe(TURN.messageId);
    expect(typeof patch.boundary_wait.sinceMs).toBe('number');
  });

  test('a fresh window inside QUEUE_BOUNDARY_FALLBACK_MS keeps waiting', async () => {
    // ONE clock read: the row's marker and the expectation must come from the
    // same instant, or a 1 ms gap between two `Date.now()` reads flakes this.
    const sinceMs = Date.now() - (QUEUE_BOUNDARY_FALLBACK_MS - 1_000);
    markerResult = { boundary_wait: { ...TURN, sinceMs } };
    requeueCalls = [];
    abortCalls = [];
    const outcome = await executeQueuedContinue(row(markerResult));
    expect(outcome).toBe('queued');
    expect(abortCalls).toEqual([]);
    const patch = requeueCalls[0].patch as { boundary_wait: { sinceMs: number } };
    expect(patch.boundary_wait.sinceMs).toBe(sinceMs);
  });

  test('past the window the SAME live turn is ended once, stamped first', async () => {
    markerResult = {
      boundary_wait: { ...TURN, sinceMs: Date.now() - QUEUE_BOUNDARY_FALLBACK_MS - 1 },
    };
    requeueCalls = [];
    abortCalls = [];
    stopRequests = [];
    const outcome = await executeQueuedContinue(row(markerResult));
    expect(outcome).toBe('queued');
    expect(stopRequests).toEqual([
      { sessionId: SESSION_ID, name: 'QueueInterrupt', scope: TURN },
    ]);
    expect(abortCalls).toEqual([SESSION_ID]);
    // The stamp must precede the abort: the ledger keeps a stop request only
    // over an abort, and the abort is what the terminal relay settles.
    expect(requeueCalls).toHaveLength(1);
    const patch = requeueCalls[0].patch as { boundary_wait: { sinceMs: number } };
    expect(patch.boundary_wait.sinceMs).toBeGreaterThanOrEqual(
      Date.now() - QUEUE_BOUNDARY_FALLBACK_MS,
    );
  });

  test('a moved boundary — a different live turn — resets the window, not an abort', async () => {
    markerResult = {
      boundary_wait: { ...TURN, sinceMs: Date.now() - QUEUE_BOUNDARY_FALLBACK_MS - 1 },
    };
    abortCalls = [];
    requeueCalls = [];
    // The admission mock still names TURN; a row whose stored marker names a
    // DIFFERENT turn exercises the reset through the same refusal.
    const stale = row({ boundary_wait: { opencodeSessionId: 'oc-old', messageId: 'msg-old', sinceMs: 0 } });
    const outcome = await executeQueuedContinue(stale);
    expect(outcome).toBe('queued');
    expect(abortCalls).toEqual([]);
    const patch = requeueCalls[0].patch as { boundary_wait: { sinceMs: number; messageId: string } };
    expect(patch.boundary_wait.messageId).toBe(TURN.messageId);
    expect(patch.boundary_wait.sinceMs).toBeGreaterThanOrEqual(Date.now() - 5_000);
  });
});
