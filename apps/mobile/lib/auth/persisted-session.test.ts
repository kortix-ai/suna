import { describe, expect, test } from 'bun:test';

import { parsePersistedSession, sessionForNullAuthResult } from './persisted-session';

const stored = {
  access_token: 'at',
  refresh_token: 'rt',
  expires_at: 1_700_000_000,
  token_type: 'bearer',
  user: { id: 'user-1', email: 'a@b.c' },
};

describe('parsePersistedSession', () => {
  test('absent value means signed out', () => {
    expect(parsePersistedSession(null)).toBeNull();
    expect(parsePersistedSession('')).toBeNull();
  });

  test('a stored session with tokens and a user id is returned', () => {
    const session = parsePersistedSession(JSON.stringify(stored));
    expect(session?.user.id).toBe('user-1');
    expect(session?.refresh_token).toBe('rt');
  });

  test('a session missing the refresh token or user id means signed out', () => {
    expect(parsePersistedSession(JSON.stringify({ ...stored, refresh_token: '' }))).toBeNull();
    expect(parsePersistedSession(JSON.stringify({ ...stored, user: {} }))).toBeNull();
    expect(parsePersistedSession(JSON.stringify({ ...stored, user: null }))).toBeNull();
  });

  test('malformed JSON means signed out', () => {
    expect(parsePersistedSession('{not json')).toBeNull();
    expect(parsePersistedSession('"string"')).toBeNull();
    expect(parsePersistedSession('null')).toBeNull();
  });
});

describe('sessionForNullAuthResult', () => {
  const raw = JSON.stringify(stored);

  test('SIGNED_OUT with empty storage signs out', () => {
    expect(sessionForNullAuthResult('SIGNED_OUT', null)).toBeNull();
  });

  test('SIGNED_OUT signs out even if a stored session is still readable', () => {
    expect(sessionForNullAuthResult('SIGNED_OUT', raw)).toBeNull();
  });

  test('INITIAL_SESSION null with a stored session keeps the stored session', () => {
    expect(sessionForNullAuthResult('INITIAL_SESSION', raw)?.user.id).toBe('user-1');
  });

  test('a null restore with a stored session keeps the stored session (retryable refresh failure)', () => {
    expect(sessionForNullAuthResult('RESTORE', raw)?.refresh_token).toBe('rt');
  });

  test('a null restore with no stored session signs out (never signed in, or revoked token removed)', () => {
    expect(sessionForNullAuthResult('RESTORE', null)).toBeNull();
    expect(sessionForNullAuthResult('INITIAL_SESSION', null)).toBeNull();
  });

  test('a null result with a malformed stored session signs out', () => {
    expect(sessionForNullAuthResult('RESTORE', '{broken')).toBeNull();
  });
});
