import { describe, expect, test } from 'bun:test';
import { createPublicKey, verify } from 'node:crypto';
import { requireKortixMember, verifyKortixMemberToken } from '@kortix/sdk';
import {
  BACKEND_TOKEN_TTL_SECONDS,
  backendAuthEnv,
  backendJwks,
  backendOpenIdConfiguration,
  generateBackendAuthKey,
  mintBackendToken,
} from './auth';

const BACKEND = '7328f996-b417-4a76-994e-a7d38e8f1a28';
const ISSUER = `https://api.example.test/v1/backends/${BACKEND}`;

function jwksFromEnv(env: Record<string, string>) {
  const b64 = env.KORTIX_AUTH_JWKS!.replace('data:text/plain;charset=utf-8;base64,', '');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as { keys: Record<string, string>[] };
}

describe('Kortix sign-in for Backends', () => {
  test('a minted token verifies against the JWKS written into the backend', () => {
    const pem = generateBackendAuthKey();
    const env = backendAuthEnv(BACKEND, ISSUER, pem);
    const { token, expiresAt } = mintBackendToken(BACKEND, ISSUER, pem, { userId: 'user-1', email: 'a@example.test' }, 1_000);
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
      exp: 1_000 + 900,
    });
    expect(expiresAt.getTime()).toBe((1_000 + 900) * 1000);
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(s!, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  test("another backend's key does not verify the token", () => {
    const token = mintBackendToken(BACKEND, ISSUER, generateBackendAuthKey(), { userId: 'u', email: null }).token;
    const [h, p, s] = token.split('.');
    const otherJwk = jwksFromEnv(backendAuthEnv(BACKEND, ISSUER, generateBackendAuthKey())).keys[0]!;
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: createPublicKey({ key: otherJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(s!, 'base64url'),
    );
    expect(ok).toBe(false);
  });
});

describe('the token carries the whole member, and the SDK reads it', () => {
  const subject = {
    userId: 'user-1',
    email: 'ada@example.test',
    name: 'Ada Lovelace',
    picture: 'https://example.test/ada.png',
    groups: ['Finance'],
    groupIds: ['g-fin'],
    role: 'admin',
    accountId: 'acct-1',
    projectId: 'proj-1',
  };

  test('15 minutes: a removed member loses backend access within one token', () => {
    expect(BACKEND_TOKEN_TTL_SECONDS).toBe(900);
  });

  test('a real name, never the email as the name', () => {
    const { token } = mintBackendToken(BACKEND, ISSUER, generateBackendAuthKey(), { userId: 'u', email: 'u@example.test' });
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    expect(payload.name).toBeUndefined();
  });

  test('verifyKortixMemberToken accepts it with exactly the env Kortix writes into the backend', async () => {
    const pem = generateBackendAuthKey();
    const env = backendAuthEnv(BACKEND, ISSUER, pem);
    const { token } = mintBackendToken(BACKEND, ISSUER, pem, subject);
    const member = await verifyKortixMemberToken(token, {
      jwks: env.KORTIX_AUTH_JWKS,
      issuer: env.KORTIX_AUTH_ISSUER,
      audience: env.KORTIX_AUTH_AUDIENCE,
    });
    expect(member).toEqual({ ...subject });
    expect(requireKortixMember(member, { groups: ['Finance'], roles: ['admin'] }).userId).toBe('user-1');
  });
});

describe('issuer discovery', () => {
  test('the token names the issuer it was given; the discovery document points at its key set', async () => {
    const pem = generateBackendAuthKey();
    const { token } = mintBackendToken(BACKEND, ISSUER, pem, { userId: 'u', email: null });
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    expect(payload.iss).toBe(ISSUER);
    expect(backendOpenIdConfiguration(ISSUER)).toMatchObject({
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/jwks.json`,
      id_token_signing_alg_values_supported: ['ES256'],
    });
  });

  test('the served key set is the public key only, and verifies the token', async () => {
    const pem = generateBackendAuthKey();
    const jwks = backendJwks(BACKEND, pem);
    expect(Object.keys(jwks.keys[0]!).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
    const { token } = mintBackendToken(BACKEND, ISSUER, pem, { userId: 'u', email: null });
    const member = await verifyKortixMemberToken(token, { jwks, issuer: ISSUER, audience: BACKEND });
    expect(member.userId).toBe('u');
  });
});
