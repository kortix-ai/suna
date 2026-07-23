import { describe, expect, mock, test } from 'bun:test';

// Mirrors the established pattern (see e.g. src/projects/maintenance.test.ts)
// for isolating a DB-touching resolver in a unit test: mock the query chain,
// keep everything else (config, encrypt/decrypt) real so the round trip is
// genuine. mock.module() is process-wide — this file's chain always returns
// whatever `nextRows` was set to just before the call under test.
let nextRows: Array<{ secretId: string; ownerUserId: string | null; valueEnc: string }> = [];
mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => nextRows,
      }),
    }),
  },
}));

const { encryptProjectSecret } = await import('../../projects/secrets');
const { parseClaudeAuth, probeClaudeConnection, resolveClaudeCredential } = await import(
  './claude'
);

const PROJECT_ID = 'proj_claude_test';

function row(input: { secretId: string; ownerUserId: string | null; token: string }) {
  return {
    secretId: input.secretId,
    ownerUserId: input.ownerUserId,
    valueEnc: encryptProjectSecret(PROJECT_ID, input.token),
  };
}

describe('parseClaudeAuth', () => {
  test("a plain setup-token string (today's only shape) has no known expiry", () => {
    expect(parseClaudeAuth('sk-ant-oat-abc123')).toEqual({
      token: 'sk-ant-oat-abc123',
      expiresAt: null,
    });
  });

  test('trims surrounding whitespace on the plain-string path', () => {
    expect(parseClaudeAuth('  sk-ant-oat-abc123  \n')).toEqual({
      token: 'sk-ant-oat-abc123',
      expiresAt: null,
    });
  });

  test('decodes a future {token, expires} JSON envelope', () => {
    expect(parseClaudeAuth(JSON.stringify({ token: 't1', expires: 123456 }))).toEqual({
      token: 't1',
      expiresAt: 123456,
    });
  });

  test('accepts the expiresAt alias too', () => {
    expect(parseClaudeAuth(JSON.stringify({ token: 't1', expiresAt: 999 }))).toEqual({
      token: 't1',
      expiresAt: 999,
    });
  });

  test('malformed JSON that merely starts with "{" falls back to the raw trimmed string, never throws', () => {
    expect(parseClaudeAuth('{not valid json')).toEqual({
      token: '{not valid json',
      expiresAt: null,
    });
  });

  test('a JSON object without a usable token field falls back to the raw string', () => {
    expect(parseClaudeAuth(JSON.stringify({ foo: 'bar' }))).toEqual({
      token: JSON.stringify({ foo: 'bar' }),
      expiresAt: null,
    });
  });

  test('empty/whitespace-only input yields an empty token (caller treats as absent)', () => {
    expect(parseClaudeAuth('   ')).toEqual({ token: '', expiresAt: null });
  });
});

describe('resolveClaudeCredential — shared/personal precedence, mirrors loadCodexRow', () => {
  test('returns null when no row exists', async () => {
    nextRows = [];
    expect(await resolveClaudeCredential(PROJECT_ID, 'user_1')).toBeNull();
  });

  test('returns the shared row when only a shared row exists', async () => {
    nextRows = [row({ secretId: 's1', ownerUserId: null, token: 'shared-token' })];
    const result = await resolveClaudeCredential(PROJECT_ID, 'user_1');
    expect(result).toEqual({ token: 'shared-token', expiresAt: null, scope: 'shared' });
  });

  test("the caller's own personal row wins over the shared row", async () => {
    nextRows = [
      row({ secretId: 's1', ownerUserId: null, token: 'shared-token' }),
      row({ secretId: 's2', ownerUserId: 'user_1', token: 'personal-token' }),
    ];
    const result = await resolveClaudeCredential(PROJECT_ID, 'user_1');
    expect(result).toEqual({ token: 'personal-token', expiresAt: null, scope: 'personal' });
  });

  test("a DIFFERENT user's personal row never wins — falls back to shared", async () => {
    nextRows = [
      row({ secretId: 's1', ownerUserId: null, token: 'shared-token' }),
      row({ secretId: 's2', ownerUserId: 'someone-else', token: 'their-personal-token' }),
    ];
    const result = await resolveClaudeCredential(PROJECT_ID, 'user_1');
    expect(result).toEqual({ token: 'shared-token', expiresAt: null, scope: 'shared' });
  });

  test('an empty stored token resolves to null (never a blank credential)', async () => {
    nextRows = [row({ secretId: 's1', ownerUserId: null, token: '   ' })];
    expect(await resolveClaudeCredential(PROJECT_ID, 'user_1')).toBeNull();
  });

  test('a decrypt failure (corrupt envelope) propagates, never silently swallowed — fail closed', async () => {
    nextRows = [{ secretId: 's1', ownerUserId: null, valueEnc: 'not-a-valid-envelope' }];
    await expect(resolveClaudeCredential(PROJECT_ID, 'user_1')).rejects.toThrow();
  });

  test('a JSON envelope with a future expiry round-trips through the real encrypt/decrypt path', async () => {
    nextRows = [
      row({
        secretId: 's1',
        ownerUserId: null,
        token: JSON.stringify({ token: 't2', expires: 4102444800000 }),
      }),
    ];
    const result = await resolveClaudeCredential(PROJECT_ID, 'user_1');
    expect(result).toEqual({ token: 't2', expiresAt: 4102444800000, scope: 'shared' });
  });
});

describe('probeClaudeConnection', () => {
  test('healthy on a 2xx response', async () => {
    const status = await probeClaudeConnection(
      'tok',
      async () => new Response('{}', { status: 200 }),
    );
    expect(status).toBe('healthy');
  });

  test('invalid on 401', async () => {
    const status = await probeClaudeConnection(
      'tok',
      async () => new Response('{}', { status: 401 }),
    );
    expect(status).toBe('invalid');
  });

  test('invalid on 403', async () => {
    const status = await probeClaudeConnection(
      'tok',
      async () => new Response('{}', { status: 403 }),
    );
    expect(status).toBe('invalid');
  });

  test('unverified (never invalid) on a 5xx/rate-limit response — an ambiguous status must not falsely accuse a working credential', async () => {
    expect(
      await probeClaudeConnection('tok', async () => new Response('{}', { status: 500 })),
    ).toBe('unverified');
    expect(
      await probeClaudeConnection('tok', async () => new Response('{}', { status: 429 })),
    ).toBe('unverified');
  });

  test('unverified on a network error — never invalid', async () => {
    const status = await probeClaudeConnection('tok', async () => {
      throw new Error('network blip');
    });
    expect(status).toBe('unverified');
  });

  test('invalid immediately for an empty token — never even sends the request', async () => {
    let called = false;
    const status = await probeClaudeConnection('   ', async () => {
      called = true;
      return new Response('{}', { status: 200 });
    });
    expect(status).toBe('invalid');
    expect(called).toBe(false);
  });

  test('sends the token as an OAuth bearer + the expected Anthropic headers', async () => {
    const captured: { headers: Headers | null } = { headers: null };
    await probeClaudeConnection('secret-token', async (_input, init) => {
      captured.headers = new Headers(init?.headers);
      return new Response('{}', { status: 200 });
    });
    expect(captured.headers?.get('authorization')).toBe('Bearer secret-token');
    expect(captured.headers?.get('anthropic-version')).toBe('2023-06-01');
  });
});
