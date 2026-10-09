import { describe, expect, test } from 'bun:test';
import { createPublicKey, verify } from 'node:crypto';
import { requireKortixMember, verifyKortixToken } from '@kortix/sdk';
import { TOKEN_TTL_SECONDS, authEnv, generateSigner, openIdConfiguration, signToken, signerJwks } from './tokens';

const PROJECT = '0b8f1e52-3c0d-4a51-9a0e-2f7d1c6b9e11';
const APP = '7328f996-b417-4a76-994e-a7d38e8f1a28';
const OTHER_APP = '5a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ISSUER = `https://api.example.test/v1/projects/${PROJECT}`;
const target = (audience = APP) => ({ audience, issuer: ISSUER, accountId: 'acct-1', projectId: PROJECT });

function jwksFromEnv(env: Record<string, string>) {
  const b64 = env.KORTIX_AUTH_JWKS!.replace('data:text/plain;charset=utf-8;base64,', '');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as { keys: Record<string, string>[] };
}

const parts = (token: string) => {
  const [h, p, s] = token.split('.');
  return {
    h: h!, p: p!, s: s!,
    header: JSON.parse(Buffer.from(h!, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(p!, 'base64url').toString()),
  };
};

describe('one project issuer, the App as audience', () => {
  test('a token verifies against the JWKS in the env Kortix writes; iss is the project, aud the App', () => {
    const signer = generateSigner();
    const env = authEnv(ISSUER, APP, signer);
    const { token, expiresAt } = signToken(signer, target(), { userId: 'user-1', email: 'a@example.test' }, 1_000);
    const { h, p, s, header, payload } = parts(token);
    const jwk = jwksFromEnv(env).keys[0]!;

    expect(env.KORTIX_AUTH_ISSUER).toBe(ISSUER);
    expect(env.KORTIX_AUTH_AUDIENCE).toBe(APP);
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: signer.kid });
    expect(jwk.kid).toBe(signer.kid);
    expect(payload).toMatchObject({
      iss: ISSUER, aud: APP, sub: 'user-1', email: 'a@example.test', iat: 1_000, exp: 1_000 + 900,
      account_id: 'acct-1', project_id: PROJECT,
    });
    expect(expiresAt.getTime()).toBe((1_000 + 900) * 1000);
    const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
  });

  test("another project's key does not verify the token", () => {
    const { h, p, s } = parts(signToken(generateSigner(), target(), { userId: 'u', email: null }).token);
    const otherJwk = signerJwks(generateSigner()).keys[0]!;
    const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: otherJwk as never, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    expect(ok).toBe(false);
  });

  test('one project key serves every App: a token for one App fails the audience check of another', async () => {
    const signer = generateSigner();
    const { token } = signToken(signer, target(OTHER_APP), { userId: 'u', email: null });
    const jwks = signerJwks(signer);
    expect((await verifyKortixToken(token, { jwks, issuer: ISSUER, audience: OTHER_APP })).userId).toBe('u');
    await expect(verifyKortixToken(token, { jwks, issuer: ISSUER, audience: APP })).rejects.toThrow();
  });

  test('two signers get two key ids', () => {
    expect(generateSigner().kid).not.toBe(generateSigner().kid);
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
  };

  test('15 minutes: a removed member loses App access within one token', () => {
    expect(TOKEN_TTL_SECONDS).toBe(900);
  });

  test('a real name, never the email as the name', () => {
    const { payload } = parts(signToken(generateSigner(), target(), { userId: 'u', email: 'u@example.test' }).token);
    expect(payload.name).toBeUndefined();
  });

  test('an agent token says kind agent and carries no role and no groups', () => {
    const { payload } = parts(signToken(generateSigner(), target(), { userId: 'sa-1', email: null, kind: 'agent' }).token);
    expect(payload).toMatchObject({ sub: 'sa-1', kind: 'agent', groups: [], group_ids: [] });
    expect(payload.role).toBeUndefined();
  });

  test('verifyKortixToken accepts it with exactly the env Kortix writes', async () => {
    const signer = generateSigner();
    const env = authEnv(ISSUER, APP, signer);
    const { token } = signToken(signer, target(), subject);
    const member = await verifyKortixToken(token, {
      jwks: env.KORTIX_AUTH_JWKS,
      issuer: env.KORTIX_AUTH_ISSUER,
      audience: env.KORTIX_AUTH_AUDIENCE,
    });
    expect(member).toEqual({ ...subject, accountId: 'acct-1', projectId: PROJECT });
    expect(requireKortixMember(member, { groups: ['Finance'], roles: ['admin'] }).userId).toBe('user-1');
  });
});

describe('issuer discovery', () => {
  test('the discovery document names the issuer and its key set under it', () => {
    expect(openIdConfiguration(ISSUER)).toMatchObject({
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/jwks.json`,
      id_token_signing_alg_values_supported: ['ES256'],
    });
  });

  test('the key set holds the public key only; none before the first token', () => {
    expect(Object.keys(signerJwks(generateSigner()).keys[0]!).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
    expect(signerJwks(null)).toEqual({ keys: [] });
  });
});
