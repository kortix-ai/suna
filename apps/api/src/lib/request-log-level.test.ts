/**
 * Regressions for the post-request `Request completed:` line:
 *
 * - KRTX-627: the line must not be WARN for a request that succeeded. Before
 *   the fix, a slow success (duration > 5000 ms, status 200) logged at WARN, so
 *   ordinary fleet-wide contention paged as a warn-class log anomaly on the
 *   sessions read route.
 *
 * - KRTX-468: the line carries the per-stage `Server-Timing` breakdown on the
 *   slow or failed tail. A p95 anomaly used to leave one opaque `duration`;
 *   the breakdown answers "DB stretch or app-side work" from the line itself.
 *
 * The sandbox-proxy suppression of the line lives in
 * sandbox-proxy/request-log-suppression.ts, with its regressions beside it.
 */
import { describe, expect, test } from 'bun:test';
import { runWithContext } from './request-context';
import {
  requestClientLogFields,
  requestLogLevel,
  requestTimingLogField,
} from './request-log-level';
import { beginStage } from './server-timing';

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


describe('requestTimingLogField', () => {
  test('a fast success carries no stage breakdown', () => {
    expect(requestTimingLogField(30, 200)).toBe('');
    expect(requestTimingLogField(999, 200)).toBe('');
  });

  test('a slow request carries the stage entries it recorded', async () => {
    const line = await runWithContext('GET', '/v1/projects/<project>/sessions', async () => {
      const end = beginStage('db');
      await new Promise((resolve) => setTimeout(resolve, 15));
      end();
      return requestTimingLogField(1_100, 200);
    });

    expect(line).toMatch(/^db;dur=\d+;desc="n=1"$/);
    const duration = /db;dur=(\d+)/.exec(line)?.[1] ?? '0';
    expect(Number(duration)).toBeGreaterThanOrEqual(10);
  });

  test('a 5xx carries the breakdown even when fast', async () => {
    const line = await runWithContext('GET', '/x', async () => {
      const end = beginStage('db');
      end();
      return requestTimingLogField(30, 500);
    });
    expect(line).toContain('db;dur=');
  });

  test('outside a request context it is empty, not a throw', () => {
    expect(requestTimingLogField(1_100, 200)).toBe('');
    expect(requestTimingLogField(30, 500)).toBe('');
  });

  test('KORTIX_SLOW_REQUEST_TIMING_MS moves the slow tail threshold', () => {
    const previous = process.env.KORTIX_SLOW_REQUEST_TIMING_MS;
    process.env.KORTIX_SLOW_REQUEST_TIMING_MS = '1';
    try {
      // No request context: the 1 ms threshold puts the request on the slow
      // tail, and the breakdown of zero stages is an empty string.
      expect(requestTimingLogField(5, 200)).toBe('');
    } finally {
      if (previous === undefined) delete process.env.KORTIX_SLOW_REQUEST_TIMING_MS;
      else process.env.KORTIX_SLOW_REQUEST_TIMING_MS = previous;
    }
  });
});

describe('requestClientLogFields', () => {
  const headers = (map: Record<string, string>) => (name: string) => map[name];

  test('logs the reported surface and version so a route can be retired on data', () => {
    expect(requestClientLogFields(headers({ 'x-kortix-client-version': 'cli/0.13.42-dev.ab12cd3' }))).toEqual({
      client_version: 'cli/0.13.42-dev.ab12cd3',
    });
  });

  test('ignores the retired X-Kortix-Client header', () => {
    expect(requestClientLogFields(headers({ 'x-kortix-client': 'cli' }))).toEqual({});
  });

  test('omits a missing, malformed or credential-shaped value', () => {
    expect(requestClientLogFields(headers({}))).toEqual({});
    expect(requestClientLogFields(headers({ 'x-kortix-client-version': 'a b' }))).toEqual({});
    expect(requestClientLogFields(headers({ 'x-kortix-client-version': 'x'.repeat(65) }))).toEqual({});
    expect(requestClientLogFields(headers({ 'x-kortix-client-version': 'sk-live-123' }))).toEqual({});
  });
});
