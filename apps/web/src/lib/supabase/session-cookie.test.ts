import { describe, expect, test } from 'bun:test';

import { readUnverifiedSession } from './session-cookie';

const COOKIE_NAME = 'sb-kortix-auth-token';

function sessionJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: 'header.payload.sig',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 1_700_000_000,
    refresh_token: 'rt-1',
    user: { id: 'user-1', user_metadata: { locale: 'de' } },
    ...overrides,
  });
}

function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

describe('readUnverifiedSession', () => {
  test('reads a whole plain-JSON cookie', () => {
    const session = readUnverifiedSession([{ name: COOKIE_NAME, value: sessionJson() }], COOKIE_NAME);

    expect(session).not.toBeNull();
    expect(session?.access_token).toBe('header.payload.sig');
    expect(session?.expires_at).toBe(1_700_000_000);
  });

  test('reads a whole base64-prefixed cookie (the @supabase/ssr encoding)', () => {
    const session = readUnverifiedSession(
      [{ name: COOKIE_NAME, value: `base64-${toBase64Url(sessionJson())}` }],
      COOKIE_NAME,
    );

    expect(session?.expires_at).toBe(1_700_000_000);
  });

  test('assembles chunked cookies (<name>.0, <name>.1, …)', () => {
    const json = sessionJson();
    const half = Math.ceil(json.length / 2);
    const session = readUnverifiedSession(
      [
        { name: `${COOKIE_NAME}.0`, value: json.slice(0, half) },
        { name: `${COOKIE_NAME}.1`, value: json.slice(half) },
      ],
      COOKIE_NAME,
    );

    expect(session?.access_token).toBe('header.payload.sig');
  });

  test('assembles chunked base64-prefixed cookies', () => {
    const encoded = toBase64Url(sessionJson());
    const half = Math.ceil(encoded.length / 2);
    const session = readUnverifiedSession(
      [
        { name: `${COOKIE_NAME}.0`, value: `base64-${encoded.slice(0, half)}` },
        { name: `${COOKIE_NAME}.1`, value: encoded.slice(half) },
      ],
      COOKIE_NAME,
    );

    expect(session?.refresh_token).toBe('rt-1');
  });

  test('no cookie at all resolves null', () => {
    expect(readUnverifiedSession([{ name: 'other', value: 'x' }], COOKIE_NAME)).toBeNull();
  });

  test('garbage JSON resolves null instead of throwing', () => {
    expect(readUnverifiedSession([{ name: COOKIE_NAME, value: 'not-json{{{' }], COOKIE_NAME)).toBeNull();
  });

  test('a non-numeric expires_at is passed through as-is for the caller to type-narrow', () => {
    const session = readUnverifiedSession(
      [{ name: COOKIE_NAME, value: sessionJson({ expires_at: 'soon' }) }],
      COOKIE_NAME,
    );

    expect(session?.expires_at).toBe('soon');
  });
});
