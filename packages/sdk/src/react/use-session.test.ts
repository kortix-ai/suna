import { describe, expect, test } from 'bun:test';
import { BillingError } from '../core/http/api/errors';
import { clearSessionFresh, markSessionFresh } from '../core/http/fresh-sessions';
import { SessionStartError } from '../core/rest/projects-client';
import {
  classifySendError,
  computeSessionPhase,
  runtimeRecoveryDelayMs,
  sendStateOnError,
  sendStateOnStart,
  shouldRetrySessionStart,
} from './use-session';

describe('ACP session error classification', () => {
  test('classifies a runtime that is not ready', () => {
    expect(classifySendError(new Error('Server URL not ready')).kind).toBe('runtime-not-ready');
  });

  test('classifies a 402-shaped error as billing', () => {
    const error = new Error('Payment Required') as Error & { status?: number; data?: unknown };
    error.status = 402;
    error.data = { message: 'Insufficient credits' };
    const result = classifySendError(error);
    expect(result.kind).toBe('billing');
    expect(result.billing).toBeInstanceOf(BillingError);
  });

  test('keeps the original runtime error message', () => {
    expect(classifySendError(new Error('harness failed')).message).toBe('harness failed');
  });

  test('falls back to runtime-error for a generic failure with no gateway envelope', () => {
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

describe('send state helpers', () => {
  test('start clears the old error and error clears pending', () => {
    expect(sendStateOnStart('hello')).toEqual({ pending: 'hello', sendError: null });
    expect(sendStateOnError(new Error('boom'))).toMatchObject({ pending: null, sendError: { kind: 'runtime-error' } });
  });
});

describe('shouldRetrySessionStart', () => {
  const startError = (status: number) => new SessionStartError('nope', { status, terminal: true });

  test('retries a fresh 404 only within its bounded create race window', () => {
    markSessionFresh('fresh');
    try {
      expect(shouldRetrySessionStart(0, startError(404), 'fresh')).toBe(true);
      expect(shouldRetrySessionStart(12, startError(404), 'fresh')).toBe(false);
    } finally {
      clearSessionFresh('fresh');
    }
  });

  test('does not retry a stale 404', () => {
    expect(shouldRetrySessionStart(0, startError(404), 'stale')).toBe(false);
  });
});

describe('computeSessionPhase', () => {
  const base = {
    stageTerminal: false,
    startError: false,
    protocolError: false,
    switched: true,
    acpReady: true,
    acpErrorTerminal: false,
  };

  test('healthy switched+ready session is ready', () => {
    expect(computeSessionPhase(base)).toBe('ready');
  });

  test('a terminal ACP error on an ALREADY-READY session keeps phase ready — a failed send must never collapse the layout back to the boot loader', () => {
    expect(computeSessionPhase({ ...base, acpErrorTerminal: true })).toBe('ready');
  });

  test('a terminal ACP error before the session ever became ready is an error (dead sandbox at bootstrap)', () => {
    expect(computeSessionPhase({ ...base, acpReady: false, acpErrorTerminal: true })).toBe('error');
  });

  test('a NON-terminal ACP hiccup before ready keeps the session starting (the client retries on its own)', () => {
    expect(computeSessionPhase({ ...base, acpReady: false })).toBe('starting');
  });

  test('terminal stage / start error / protocol error always win', () => {
    expect(computeSessionPhase({ ...base, stageTerminal: true })).toBe('error');
    expect(computeSessionPhase({ ...base, startError: true })).toBe('error');
    expect(computeSessionPhase({ ...base, protocolError: true })).toBe('error');
  });

  test('not switched yet is starting', () => {
    expect(computeSessionPhase({ ...base, switched: false })).toBe('starting');
  });
});

describe('runtimeRecoveryDelayMs', () => {
  test('first recovery fires almost immediately, then backs off, capped', () => {
    expect(runtimeRecoveryDelayMs(0)).toBe(500);
    expect(runtimeRecoveryDelayMs(1)).toBe(2_000);
    expect(runtimeRecoveryDelayMs(2)).toBe(4_000);
    expect(runtimeRecoveryDelayMs(3)).toBe(8_000);
    expect(runtimeRecoveryDelayMs(4)).toBe(8_000);
  });

  test('gives up (null) after the attempt cap', () => {
    expect(runtimeRecoveryDelayMs(5)).toBeNull();
    expect(runtimeRecoveryDelayMs(99)).toBeNull();
  });
});
