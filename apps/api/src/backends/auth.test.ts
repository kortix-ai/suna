import { describe, expect, test } from 'bun:test';
import { createPublicKey, verify } from 'node:crypto';
import { backendAuthEnv, generateBackendAuthKey, mintBackendToken } from './auth';

const BACKEND = '7328f996-b417-4a76-994e-a7d38e8f1a28';

function jwksFromEnv(env: Record<string, string>) {
  const b64 = env.KORTIX_AUTH_JWKS!.replace('data:text/plain;charset=utf-8;base64,', '');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as { keys: Record<string, string>[] };
}

describe('Kortix sign-in for Backends', () => {
  test('a minted token verifies against the JWKS written into the backend', () => {
    const pem = generateBackendAuthKey();
    const env = backendAuthEnv(BACKEND, pem);
    const { token, expiresAt } = mintBackendToken(BACKEND, pem, { userId: 'user-1', email: 'a@example.test' }, 1_000);
    const [h, p, s] = token.split('.');
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    const jwk = jwksFromEnv(env).keys[0]!;

    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: jwk.kid });
    expect(payload).toMatchObject({
      iss: env.KORTIX_AUTH_ISSUER,
      aud: env.KORTIX_AUTH_AUDIENCE,
      sub: 'user-1',
      email: 'a@example.test',
      iat: 1_000,
      exp: 1_000 + 3600,
    });
    expect(expiresAt.getTime()).toBe((1_000 + 3600) * 1000);
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(s!, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  test("another backend's key does not verify the token", () => {
    const token = mintBackendToken(BACKEND, generateBackendAuthKey(), { userId: 'u', email: null }).token;
    const [h, p, s] = token.split('.');
    const otherJwk = jwksFromEnv(backendAuthEnv(BACKEND, generateBackendAuthKey())).keys[0]!;
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: createPublicKey({ key: otherJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(s!, 'base64url'),
    );
    expect(ok).toBe(false);
  });
});
