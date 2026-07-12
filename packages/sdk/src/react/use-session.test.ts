import { describe, expect, test } from 'bun:test';
import { BillingError } from '../platform/api/errors';
import { clearSessionFresh, markSessionFresh } from '../platform/fresh-sessions';
import { SessionStartError } from '../platform/projects-client';
import {
  classifySendError,
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
