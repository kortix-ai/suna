import { describe, expect, test } from 'bun:test';
import {
  MAX_START_REQUEST_FAILURES,
  connectStepFromRequestError,
  connectStepFromStart,
  shouldAwaitHealthProbe,
  startPollDelayMs,
} from './connect-step';

function apiError(status: number, message: string) {
  return Object.assign(new Error(message), { name: 'ApiRequestError', status });
}

const activeSandbox = { status: 'active', external_id: 'ext-1' } as const;

describe('connectStepFromStart', () => {
  test('polls while the runtime is provisioning', () => {
    expect(
      connectStepFromStart({ stage: 'provisioning', retriable: true, sandbox: null, failure: null }),
    ).toEqual({ kind: 'poll' });
  });

  test('opens once the sandbox is active', () => {
    expect(
      connectStepFromStart({ stage: 'starting', retriable: true, sandbox: activeSandbox, failure: null }),
    ).toEqual({ kind: 'open' });
    expect(
      connectStepFromStart({ stage: 'ready', retriable: false, sandbox: activeSandbox, failure: null }),
    ).toEqual({ kind: 'open' });
  });

  test('fails with the server failure message on a failed stage', () => {
    const step = connectStepFromStart({
      stage: 'failed',
      retriable: true,
      sandbox: null,
      failure: { category: 'git-auth', message: 'Git authentication failed.', retryable: true },
    });
    expect(step).toEqual({
      kind: 'fail',
      failure: { title: 'Session failed to start', message: 'Git authentication failed.' },
    });
  });

  test('fails when the sandbox row is in error', () => {
    const step = connectStepFromStart({
      stage: 'provisioning',
      retriable: true,
      sandbox: { status: 'error', external_id: 'ext-1' },
      failure: null,
    });
    expect(step.kind).toBe('fail');
  });

  test('stops on a stopped stage instead of polling it for minutes', () => {
    const step = connectStepFromStart({ stage: 'stopped', retriable: false, sandbox: null, failure: null });
    expect(step.kind).toBe('fail');
  });

  test('stops when the server says polling cannot make progress', () => {
    const step = connectStepFromStart({ stage: 'starting', retriable: false, sandbox: null, failure: null });
    expect(step.kind).toBe('fail');
  });
});

describe('connectStepFromRequestError', () => {
  test('a client error is terminal on the first failure and shows the server message', () => {
    const message = 'KORTIX_URL points at a loopback address (http://localhost:8008).';
    expect(connectStepFromRequestError(apiError(404, 'Session not found'), 1)).toEqual({
      kind: 'fail',
      failure: { title: 'Could not start session', message: 'Session not found' },
    });
    expect(connectStepFromRequestError(apiError(403, message), 1)).toEqual({
      kind: 'fail',
      failure: { title: 'Could not start session', message },
    });
  });

  test('a transient failure polls again until the limit, then fails once', () => {
    const error = apiError(503, 'Service unavailable');
    for (let failures = 1; failures < MAX_START_REQUEST_FAILURES; failures++) {
      expect(connectStepFromRequestError(error, failures)).toEqual({ kind: 'poll' });
    }
    expect(connectStepFromRequestError(error, MAX_START_REQUEST_FAILURES)).toEqual({
      kind: 'fail',
      failure: { title: 'Could not start session', message: 'Service unavailable' },
    });
  });

  test('408 and 429 are transient, not terminal', () => {
    expect(connectStepFromRequestError(apiError(408, 'Timeout'), 1)).toEqual({ kind: 'poll' });
    expect(connectStepFromRequestError(apiError(429, 'Too many requests'), 1)).toEqual({ kind: 'poll' });
  });

  test('a network failure names the unreachable server and keeps the raw error as detail', () => {
    const error = new TypeError('Network request failed');
    expect(connectStepFromRequestError(error, 1)).toEqual({ kind: 'poll' });
    expect(connectStepFromRequestError(error, MAX_START_REQUEST_FAILURES)).toEqual({
      kind: 'fail',
      failure: {
        title: 'Could not reach the server',
        message: 'The app could not connect to the Kortix API. Check the connection and try again.',
        detail: 'Network request failed',
      },
    });
  });
});

describe('startPollDelayMs', () => {
  test('startPollDelayMs is 300, 700, then 1500', () => {
    expect(startPollDelayMs(1)).toBe(300);
    expect(startPollDelayMs(2)).toBe(700);
    expect(startPollDelayMs(3)).toBe(1_500);
    expect(startPollDelayMs(10)).toBe(1_500);
  });
});

describe('shouldAwaitHealthProbe', () => {
  test('ready with a pin skips the awaited health probe', () => {
    expect(shouldAwaitHealthProbe({ stage: 'ready', opencode_session_id: 'ses_oc' })).toBe(false);
  });

  test('ready without a pin, or not ready, awaits the probe', () => {
    expect(shouldAwaitHealthProbe({ stage: 'ready', opencode_session_id: null })).toBe(true);
    expect(shouldAwaitHealthProbe({ stage: 'ready' })).toBe(true);
    expect(shouldAwaitHealthProbe({ stage: 'booting', opencode_session_id: 'ses_oc' })).toBe(true);
  });
});
