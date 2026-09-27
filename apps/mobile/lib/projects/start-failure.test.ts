import { describe, expect, test } from 'bun:test';

import { classifyStartFailure, startFailureCopy } from './start-failure';

const apiError = (status: number) => Object.assign(new Error(`Request failed (${status})`), { status });

describe('classifyStartFailure', () => {
  test('401 and 403 mean the session is no longer accepted', () => {
    expect(classifyStartFailure(apiError(401))).toBe('session');
    expect(classifyStartFailure(apiError(403))).toBe('session');
  });

  test('a request that never got a response is unreachable', () => {
    expect(classifyStartFailure(new TypeError('Network request failed'))).toBe('unreachable');
    expect(classifyStartFailure(new Error('Network request timed out'))).toBe('unreachable');
    expect(classifyStartFailure(apiError(0))).toBe('unreachable');
    expect(classifyStartFailure(undefined)).toBe('unreachable');
  });

  test('gateway errors are unreachable; other statuses are server errors', () => {
    expect(classifyStartFailure(apiError(502))).toBe('unreachable');
    expect(classifyStartFailure(apiError(503))).toBe('unreachable');
    expect(classifyStartFailure(apiError(504))).toBe('unreachable');
    expect(classifyStartFailure(apiError(500))).toBe('server');
    expect(classifyStartFailure(apiError(404))).toBe('server');
  });
});

describe('startFailureCopy', () => {
  test('each kind has one short line that says what to do', () => {
    expect(startFailureCopy('unreachable')).toEqual({
      title: "Can't reach Kortix",
      body: 'Check your connection, then try again.',
    });
    expect(startFailureCopy('session')).toEqual({
      title: 'Your session has ended',
      body: 'Sign in again to continue.',
    });
    expect(startFailureCopy('server')).toEqual({
      title: 'Could not open your project',
      body: 'Try again, or open another project.',
    });
  });
});
