import { describe, expect, test } from 'bun:test';
import {
  type KortixMemberKeySet,
  KortixMemberError,
  readKortixMember,
  requireKortixMember,
  verifyKortixMemberToken,
} from './kortix-member';

// One member, in each shape a runtime hands it over.
const CLAIMS = {
  iss: 'https://kortix.com/backends/b-1',
  aud: 'b-1',
  sub: 'user-1',
  email: 'ada@example.test',
  name: 'Ada Lovelace',
  picture: 'https://example.test/ada.png',
  groups: ['Finance', 'Ops'],
  group_ids: ['g-fin', 'g-ops'],
  role: 'admin',
  account_id: 'acct-1',
  project_id: 'proj-1',
};
const MEMBER = {
  userId: 'user-1',
  email: 'ada@example.test',
  name: 'Ada Lovelace',
  picture: 'https://example.test/ada.png',
  groups: ['Finance', 'Ops'],
  groupIds: ['g-fin', 'g-ops'],
  role: 'admin',
  accountId: 'acct-1',
  projectId: 'proj-1',
};

describe('readKortixMember', () => {
  test('reads raw token claims', () => {
    expect(readKortixMember(CLAIMS)).toEqual(MEMBER);
  });

  test('reads an identity a runtime already verified (subject, pictureUrl)', () => {
    // A database or JWT middleware that renames the standard claims.
    const { sub, picture, ...rest } = CLAIMS;
    expect(readKortixMember({ ...rest, subject: sub, pictureUrl: picture, tokenIdentifier: 'x|user-1' })).toEqual(
      MEMBER,
    );
  });

  test('reads the App gate answer (/_kortix/viewer)', () => {
    expect(
      readKortixMember({
        user_id: 'user-1',
        email: 'ada@example.test',
        name: 'Ada Lovelace',
        picture: 'https://example.test/ada.png',
        groups: ['Finance', 'Ops'],
        group_ids: ['g-fin', 'g-ops'],
        role: 'admin',
        account_id: 'acct-1',
        project_id: 'proj-1',
        access_token: null,
      }),
    ).toEqual(MEMBER);
  });

  test('accepts list claims a runtime serialised to JSON text', () => {
    expect(readKortixMember({ ...CLAIMS, groups: '["Finance","Ops"]', group_ids: '["g-fin","g-ops"]' })).toEqual(MEMBER);
  });

  test('missing optional claims read as null or empty, never undefined', () => {
    expect(readKortixMember({ sub: 'user-2' })).toEqual({
      userId: 'user-2',
      email: null,
      name: null,
      picture: null,
      groups: [],
      groupIds: [],
      role: null,
      accountId: null,
      projectId: null,
    });
  });

  test('anonymous: null, undefined, or claims without a subject', () => {
    expect(readKortixMember(null)).toBeNull();
    expect(readKortixMember(undefined)).toBeNull();
    expect(readKortixMember({ email: 'x@example.test' })).toBeNull();
    expect(readKortixMember('user-1')).toBeNull();
  });
});

describe('requireKortixMember', () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return error instanceof KortixMemberError ? error.code : 'other';
    }
    return 'none';
  };

  test('returns the member; refuses the anonymous with code unauthenticated', () => {
    expect(requireKortixMember(CLAIMS)).toEqual(MEMBER);
    expect(code(() => requireKortixMember(null))).toBe('unauthenticated');
  });

  test('groups: any one of them, by name or by id', () => {
    expect(requireKortixMember(CLAIMS, { groups: ['Finance'] }).userId).toBe('user-1');
    expect(requireKortixMember(CLAIMS, { groups: ['Legal', 'g-ops'] }).userId).toBe('user-1');
    expect(code(() => requireKortixMember(CLAIMS, { groups: ['Legal'] }))).toBe('forbidden');
  });

  test('roles: any one of them', () => {
    expect(requireKortixMember(CLAIMS, { roles: ['owner', 'admin'] }).userId).toBe('user-1');
    expect(code(() => requireKortixMember(CLAIMS, { roles: ['owner'] }))).toBe('forbidden');
  });

  test('groups and roles together must both hold', () => {
    expect(code(() => requireKortixMember(CLAIMS, { groups: ['Finance'], roles: ['owner'] }))).toBe('forbidden');
  });

  test('an empty requirement list refuses rather than allowing everyone', () => {
    expect(code(() => requireKortixMember(CLAIMS, { groups: [] }))).toBe('forbidden');
  });

  test('the error is an Error with a readable message', () => {
    try {
      requireKortixMember(CLAIMS, { groups: ['Legal'] });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Legal');
    }
  });
});

// ── verifyKortixMemberToken: a real ES256 key, signed the way Kortix signs ──

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function issuer() {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicJwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  const jwks = { keys: [publicJwk] };
  const sign = async (claims: Record<string, unknown>, header: Record<string, unknown> = {}) => {
    const head = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'k1', ...header }));
    const body = b64url(JSON.stringify(claims));
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(`${head}.${body}`)),
    );
    return `${head}.${body}.${b64url(signature)}`;
  };
  return { jwks, sign };
}

const now = Math.floor(Date.now() / 1000);
const live = { ...CLAIMS, iat: now, exp: now + 900 };
const options = (jwks: KortixMemberKeySet) => ({ jwks, issuer: CLAIMS.iss, audience: CLAIMS.aud });

describe('verifyKortixMemberToken', () => {
  test('verifies the signature and returns the member', async () => {
    const { jwks, sign } = await issuer();
    expect(await verifyKortixMemberToken(await sign(live), options(jwks))).toEqual(MEMBER);
  });

  test('takes the key set as an object, JSON text, or the data: URI Kortix sets in KORTIX_AUTH_JWKS', async () => {
    const { jwks, sign } = await issuer();
    const token = await sign(live);
    const json = JSON.stringify(jwks);
    const dataUri = `data:text/plain;charset=utf-8;base64,${Buffer.from(json).toString('base64')}`;
    for (const form of [jwks, json, dataUri]) {
      expect((await verifyKortixMemberToken(token, options(form))).userId).toBe('user-1');
    }
  });

  test('fetches an https key set once and reuses it', async () => {
    const { jwks, sign } = await issuer();
    let fetched = 0;
    const fetchImpl = (async () => {
      fetched += 1;
      return Response.json(jwks);
    }) as unknown as typeof fetch;
    const opts = { ...options('https://example.test/jwks.json'), fetch: fetchImpl };
    await verifyKortixMemberToken(await sign(live), opts);
    await verifyKortixMemberToken(await sign(live), opts);
    expect(fetched).toBe(1);
  });

  test('reads KORTIX_AUTH_JWKS, _ISSUER and _AUDIENCE when no options are given', async () => {
    const { jwks, sign } = await issuer();
    const saved = { ...process.env };
    process.env.KORTIX_AUTH_JWKS = JSON.stringify(jwks);
    process.env.KORTIX_AUTH_ISSUER = CLAIMS.iss;
    process.env.KORTIX_AUTH_AUDIENCE = CLAIMS.aud;
    try {
      expect((await verifyKortixMemberToken(await sign(live))).userId).toBe('user-1');
    } finally {
      process.env = saved;
    }
  });

  const rejects = async (token: string, opts: Parameters<typeof verifyKortixMemberToken>[1]) => {
    try {
      await verifyKortixMemberToken(token, opts);
    } catch (error) {
      return error instanceof KortixMemberError ? error.code : `other: ${String(error)}`;
    }
    return 'accepted';
  };

  test('refuses every token it cannot fully trust, as unauthenticated', async () => {
    const { jwks, sign } = await issuer();
    const other = await issuer();
    const good = await sign(live);
    const [head, body, signature] = good.split('.');
    const tampered = `${head}.${b64url(JSON.stringify({ ...live, sub: 'user-evil' }))}.${signature}`;
    const cases: Array<[string, string, KortixMemberKeySet]> = [
      ['tampered claims', tampered, jwks],
      ['another key', await other.sign(live), jwks],
      ['expired beyond the 60 s skew', await sign({ ...live, exp: now - 120 }), jwks],
      ['no expiry', await sign({ ...CLAIMS, iat: now }), jwks],
      ['wrong audience', await sign({ ...live, aud: 'b-2' }), jwks],
      ['wrong issuer', await sign({ ...live, iss: 'https://evil.test' }), jwks],
      ['alg none', `${b64url(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${body}.`, jwks],
      ['unknown kid', await sign(live, { kid: 'k9' }), jwks],
      ['garbage', 'not-a-token', jwks],
    ];
    for (const [name, token, keySet] of cases) {
      expect(`${name}: ${await rejects(token, options(keySet))}`).toBe(`${name}: unauthenticated`);
    }
  });

  test('refuses when no key set is configured instead of skipping the check', async () => {
    const { sign } = await issuer();
    const saved = { ...process.env };
    delete process.env.KORTIX_AUTH_JWKS;
    try {
      expect(await rejects(await sign(live), undefined)).toBe('unauthenticated');
    } finally {
      process.env = saved;
    }
  });

  test('tolerates 60 s of clock skew on expiry, no more', async () => {
    const { jwks, sign } = await issuer();
    expect((await verifyKortixMemberToken(await sign({ ...live, exp: now - 30 }), options(jwks))).userId).toBe('user-1');
    expect(await rejects(await sign({ ...live, exp: now - 120 }), options(jwks))).toBe('unauthenticated');
  });
});

describe('readKortixMember reads the server-side viewer shapes too', () => {
  test('KortixAppViewer and KortixGuardedViewer (camelCase)', () => {
    expect(
      readKortixMember({
        userId: 'user-1',
        email: 'ada@example.test',
        name: 'Ada Lovelace',
        picture: 'https://example.test/ada.png',
        groups: ['Finance', 'Ops'],
        groupIds: ['g-fin', 'g-ops'],
        role: 'admin',
        accountId: 'acct-1',
        projectId: 'proj-1',
        source: 'app-gate',
        token: null,
      }),
    ).toEqual(MEMBER);
  });
});
