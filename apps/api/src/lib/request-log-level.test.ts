/**
 * KRTX-627 regression: the post-request `Request completed:` line must not be
 * WARN for a request that succeeded. Before the fix, a slow success (duration >
 * 5000 ms, status 200) logged at WARN, so ordinary fleet-wide contention paged
 * as a warn-class log anomaly on the sessions read route.
 */
import { describe, expect, test } from 'bun:test';
import { requestLogLevel } from './request-log-level';

describe('requestLogLevel', () => {
  test('a successful or client-error request is INFO, however slow', () => {
    expect(requestLogLevel(200)).toBe('info');
    expect(requestLogLevel(201)).toBe('info');
    expect(requestLogLevel(304)).toBe('info');
    expect(requestLogLevel(403)).toBe('info');
    expect(requestLogLevel(404)).toBe('info');
  });

  test('only a server failure is WARN', () => {
    expect(requestLogLevel(500)).toBe('warn');
    expect(requestLogLevel(503)).toBe('warn');
  });
});
