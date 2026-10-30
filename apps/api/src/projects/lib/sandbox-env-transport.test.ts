/**
 * The box-unreachable classifier for the daemon transport (`isBoxUnreachableError`).
 *
 * Every shape here is a REAL failure body logged on prod (2026-10-12..17,
 * KRTX-2213/KRTX-2590): the Platinum edge answers `502 upstream unreachable:
 * Failed to connect`, `502 upstream closed before response headers`,
 * `503 Preview access denied` and `404 This sandbox URL is not active ...
 * auto-resume-disabled` for a box that is suspended, stopped or not yet
 * serving, and a push to such a box either gets one of those bodies or hangs
 * until the transport's own 15 s `AbortSignal.timeout` fires (Bun's
 * `TimeoutError: The operation timed out.`).
 *
 * The classifier exists so the env-sync machinery can tell "the BOX is not
 * reachable right now" apart from "the env push was refused" — only the
 * former must back the background refresh off; a 409 (the daemon's single
 * in-flight gate) or a 401/403 (auth) is a transient or configuration state
 * the next prompt must retry at once.
 */
import { describe, expect, test } from 'bun:test';

import { EnvSyncHttpError, isBoxUnreachableError } from './sandbox-env-transport';

function httpError(status: number, body: string): EnvSyncHttpError {
  return new EnvSyncHttpError(status, body);
}

function timeoutError(): Error {
  const err = new Error('The operation timed out.');
  err.name = 'TimeoutError';
  return err;
}

describe('isBoxUnreachableError — the shapes prod actually produced', () => {
  test.each([
    [502, 'upstream unreachable: Failed to connect'],
    [502, 'upstream closed before response headers received'],
    [503, 'Preview access denied'],
    [404, 'This sandbox URL is not active. auto-resume-disabled'],
  ])('%s %s is unreachable', (status, body) => {
    expect(isBoxUnreachableError(httpError(status, body))).toBe(true);
  });

  test('the transport timeout is unreachable', () => {
    expect(isBoxUnreachableError(timeoutError())).toBe(true);
  });

  test('a connect failure is unreachable', () => {
    expect(isBoxUnreachableError(new Error('Unable to connect to https://edge.test'))).toBe(true);
  });
});

describe('isBoxUnreachableError — states the next prompt must retry at once', () => {
  test.each([
    [409, 'env sync already running'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [500, 'daemon exploded'],
  ])('%s %s is not unreachable', (status, body) => {
    expect(isBoxUnreachableError(httpError(status, body))).toBe(false);
  });

  test('a 404 that is not the inactive-sandbox body is not unreachable', () => {
    expect(isBoxUnreachableError(httpError(404, 'no such route'))).toBe(false);
  });

  test('an ordinary error is not unreachable', () => {
    expect(isBoxUnreachableError(new Error('boom'))).toBe(false);
    expect(isBoxUnreachableError(null)).toBe(false);
  });
});
