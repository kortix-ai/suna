/**
 * POST /v1/platform/runtime-projection — the daemon's push sink.
 *
 * Driven through the real router with real request bodies, including real
 * gzip bytes, because the two things that break this route are both wire-level:
 * the credential check and the body decoding. What it falsifies:
 *
 *   1. only a SANDBOX credential is accepted, and only for the session that
 *      credential's sandbox is actually bound to;
 *   2. a gzipped body is accepted (that is the whole point of the push: 0.9 KB
 *      instead of 8.7 KB, on every boot);
 *   3. the size cap is enforced on DECOMPRESSED bytes, so a small bomb is a
 *      413 and not an out-of-memory;
 *   4. the DAEMON's capture clock is what is stored, so an out-of-order retry
 *      loses to the newer capture rather than overwriting it.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { Hono } from 'hono';

const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const SANDBOX_ID = '66666666-6666-4666-8666-666666666666';

let sandboxRow: Record<string, unknown> | null = null;
let saved: Array<Record<string, unknown>> = [];
let saveResult: 'stored' | 'ignored' = 'stored';

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (sandboxRow ? [sandboxRow] : []) }) }),
    }),
  },
  hasDatabase: true,
}));

mock.module('../../projects/lib/session-runtime-projection', () => ({
  PROJECTION_MAX_BYTES: 256 * 1024,
  saveRuntimeProjection: async (input: Record<string, unknown>) => {
    saved.push(input);
    return saveResult;
  },
}));

const { runtimeProjectionRouter } = await import('./runtime-projection');

/** The projection document the daemon serves — the shape from WS-Z1 §2.1. */
const PROJECTION = {
  epoch: 'bmtaokkdb0piayh',
  seq: 41,
  built_at: '2026-08-26T22:43:49.919Z',
  identity: {
    opencode_session_id: 'ses_fc5a',
    opencode_version: '1.18.23',
    daemon_build: 1756240000,
    agent_config_etag: 'ff8a8b4f',
    head_seq: { ses_fc5a: 2016 },
  },
  agents: { known: true, value: [{ name: 'build' }] },
};

function buildApp(credential: Record<string, unknown> = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const identity = {
      authType: 'apiKey',
      apiKeyType: 'sandbox',
      accountId: ACCOUNT_ID,
      sandboxId: SANDBOX_ID,
      ...credential,
    };
    for (const [key, value] of Object.entries(identity)) {
      if (value !== undefined) (c as any).set(key, value);
    }
    await next();
  });
  app.route('/v1/platform/runtime-projection', runtimeProjectionRouter);
  return app;
}

function post(
  body: BodyInit,
  headers: Record<string, string> = {},
  credential: Record<string, unknown> = {},
) {
  return buildApp(credential).request('/v1/platform/runtime-projection', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

const validBody = () =>
  JSON.stringify({
    session_id: SESSION_ID,
    captured_at: '2026-08-26T22:43:49.919Z',
    projection_etag: 'sha256:9f1c',
    projection: PROJECTION,
  });

beforeEach(() => {
  saved = [];
  saveResult = 'stored';
  sandboxRow = { sessionId: SESSION_ID, projectId: PROJECT_ID, externalId: 'box-1' };
});

describe('credential', () => {
  test('a sandbox token for its own session is accepted', async () => {
    const response = await post(validBody());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, stored: 'stored', etag: 'sha256:9f1c' });
  });

  test('a user PAT is refused — this is never a user action', async () => {
    const response = await post(validBody(), {}, { apiKeyType: 'user', authType: 'pat' });
    expect(response.status).toBe(403);
    expect(saved).toHaveLength(0);
  });

  test('an environment token cannot overwrite the worker runtime projection', async () => {
    const response = await post(
      validBody(),
      {},
      {
        authType: 'pat',
        apiKeyType: undefined,
        sessionId: SESSION_ID,
        sandboxId: '77777777-7777-4777-8777-777777777777',
        sessionRuntimeKind: 'environment',
      },
    );
    expect(response.status).toBe(403);
    expect(saved).toHaveLength(0);
  });

  test('an anonymous call is refused', async () => {
    const response = await post(
      validBody(),
      {},
      { authType: undefined, apiKeyType: undefined, sandboxId: undefined, accountId: undefined },
    );
    expect(response.status).toBe(403);
  });

  test('a sandbox token for a DIFFERENT session cannot write that session', async () => {
    // The row lookup is scoped by (sandboxId AND sessionId AND accountId), so a
    // mismatch returns nothing and the push is refused whatever the body claims.
    sandboxRow = null;
    const response = await post(validBody());
    expect(response.status).toBe(403);
    expect(saved).toHaveLength(0);
  });

  test('the stored session id comes from the DB row, never from the body', async () => {
    await post(JSON.stringify({ session_id: SESSION_ID, projection: PROJECTION }));
    expect(saved[0]).toMatchObject({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      externalId: 'box-1',
      source: 'daemon_push',
    });
  });
});

describe('body decoding', () => {
  test('a gzipped body is accepted and decoded', async () => {
    const gz = gzipSync(Buffer.from(validBody()));
    // The saving this route exists for, measured on the test's own body.
    expect(gz.byteLength).toBeLessThan(validBody().length);
    const response = await post(gz, { 'content-encoding': 'gzip' });
    expect(response.status).toBe(200);
    expect(saved[0]!.projection).toMatchObject({ epoch: 'bmtaokkdb0piayh', seq: 41 });
  });

  test('a body claiming gzip that is not gzip is a 413/400, never a crash', async () => {
    const response = await post('not gzip at all', { 'content-encoding': 'gzip' });
    expect(response.status).toBe(413);
    expect(saved).toHaveLength(0);
  });

  test('a gzip bomb is refused on DECOMPRESSED size, not on content-length', async () => {
    // 300 KB of zeros compresses to a few hundred bytes; a content-length check
    // would wave it straight through.
    const bomb = gzipSync(Buffer.alloc(300 * 1024, 0x20));
    expect(bomb.byteLength).toBeLessThan(2_000);
    const response = await post(bomb, { 'content-encoding': 'gzip' });
    expect(response.status).toBe(413);
  });

  test('an oversized PLAIN body is refused too', async () => {
    const response = await post('x'.repeat(300 * 1024));
    expect(response.status).toBe(413);
  });

  test('a non-JSON body is a 400', async () => {
    const response = await post('{not json');
    expect(response.status).toBe(400);
  });

  test('a body missing `projection` is a 400', async () => {
    const response = await post(JSON.stringify({ session_id: SESSION_ID }));
    expect(response.status).toBe(400);
    expect(saved).toHaveLength(0);
  });
});

describe('capture clock and etag', () => {
  test("the daemon's captured_at is what is stored", async () => {
    await post(validBody());
    expect((saved[0]!.capturedAt as Date).toISOString()).toBe('2026-08-26T22:43:49.919Z');
  });

  test("without captured_at the document's own built_at is used", async () => {
    await post(JSON.stringify({ session_id: SESSION_ID, projection: PROJECTION }));
    expect((saved[0]!.capturedAt as Date).toISOString()).toBe('2026-08-26T22:43:49.919Z');
  });

  test('a missing etag is synthesized from epoch+seq, never left blank', async () => {
    await post(JSON.stringify({ session_id: SESSION_ID, projection: PROJECTION }));
    expect(saved[0]!.projectionEtag).toBe('push:bmtaokkdb0piayh:41:2026-08-26T22:43:49.919Z');
  });

  test('an out-of-order push reports `ignored` rather than claiming a write', async () => {
    saveResult = 'ignored';
    const response = await post(validBody());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ stored: 'ignored' });
  });
});
