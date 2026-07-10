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

mock.module('../opencode/client', () => ({
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
import { BillingError } from '../platform/api/errors';
import { promptOpenCodeMessage } from './use-opencode-sessions/messages';
import {
  answerQuestion,
  rejectQuestion,
  answerPermission,
  classifySendError,
  sendStateOnStart,
  sendStateOnError,
  shouldRetrySessionStart,
} from './use-session';
import { clearSessionFresh, markSessionFresh } from '../platform/fresh-sessions';
import { SessionStartError } from '../platform/projects-client';

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
  useOpenCodePendingStore.getState().clear();
  permissionReplyImpl = async () => ({ data: {} });
  questionReplyImpl = async () => ({ data: {} });
  questionRejectImpl = async () => ({ data: {} });
  sessionPromptImpl = async () => ({ data: {} });
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
