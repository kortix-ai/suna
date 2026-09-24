import { describe, expect, test } from 'bun:test';

import { downloadFailureMessage } from './download-status';

describe('downloadFailureMessage', () => {
  test('a 2xx status shares the file', () => {
    expect(downloadFailureMessage(200)).toBeNull();
    expect(downloadFailureMessage(206)).toBeNull();
  });

  test('an auth or missing-file status never shares the body', () => {
    expect(downloadFailureMessage(401)).toContain('Sign in again');
    expect(downloadFailureMessage(403)).toContain('access');
    expect(downloadFailureMessage(404)).toContain('Not found');
  });

  test('server and other errors name the status', () => {
    expect(downloadFailureMessage(500)).toContain('HTTP 500');
    expect(downloadFailureMessage(302)).toContain('HTTP 302');
    expect(downloadFailureMessage(418)).toContain('HTTP 418');
  });

  test('a missing status is a failure, not a success', () => {
    expect(downloadFailureMessage(undefined)).not.toBeNull();
    expect(downloadFailureMessage(null)).not.toBeNull();
    expect(downloadFailureMessage(Number.NaN)).not.toBeNull();
  });
});
