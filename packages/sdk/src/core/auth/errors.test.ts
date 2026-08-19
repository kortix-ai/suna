import { describe, expect, test } from 'bun:test';

import { KortixAuthError } from './errors';

describe('KortixAuthError', () => {
  test('is an Error with a stable name, status, code, and body', () => {
    const error = new KortixAuthError('bad credentials', {
      status: 400,
      code: 'invalid_credentials',
      body: { error_code: 'invalid_credentials' },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(KortixAuthError);
    expect(error.name).toBe('KortixAuthError');
    expect(error.message).toBe('bad credentials');
    expect(error.status).toBe(400);
    expect(error.code).toBe('invalid_credentials');
    expect(error.body).toEqual({ error_code: 'invalid_credentials' });
  });

  test('defaults status to 0 and code to null for a client-side failure', () => {
    // A PKCE-unsupported runtime never reached the network — there is no HTTP
    // status to report, and `.status` must still be a number so callers can
    // branch on it without a null check.
    const error = new KortixAuthError('crypto.subtle is unavailable');
    expect(error.status).toBe(0);
    expect(error.code).toBeNull();
    expect(error.body).toBeUndefined();
  });
});
