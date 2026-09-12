/**
 * The deployed runtime has no static access key.
 *
 * On ECS the API's credentials come from the task role, delivered through the
 * container credential endpoint, and they EXPIRE and carry a session token. A
 * signer that only understands a static key pair works perfectly in local tests
 * and cannot publish a single object in production, so the chain is exercised
 * here against a loopback stand-in for that endpoint — the same provider the
 * SES transport uses.
 *
 * Run:
 *   cd apps/api && bun test --isolate src/repo-snapshots/s3-role-credentials.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

let server: ReturnType<typeof Bun.serve>;
let served = 0;
/** Absolute expiry the stand-in reports. Tests set it to drive the cache. */
let expiryAt = () => Date.now() + 3600_000;
const ROLE = {
  AccessKeyId: 'ASIAFIXTUREROLEKEY',
  SecretAccessKey: 'fixture-role-secret',
  Token: 'fixture-session-token',
};
const saved: Record<string, string | undefined> = {};

function stash(...names: string[]): void {
  for (const name of names) saved[name] = process.env[name];
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch() {
      served += 1;
      return new Response(JSON.stringify({ ...ROLE, Expiration: new Date(expiryAt()).toISOString() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  stash(
    'KORTIX_REPO_SNAPSHOT_ACCESS_KEY_ID',
    'KORTIX_REPO_SNAPSHOT_SECRET_ACCESS_KEY',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
  );
});

afterEach(async () => {
  const { __resetS3CredentialCacheForTests } = await import('./s3');
  __resetS3CredentialCacheForTests();
});

afterAll(() => {
  server.stop(true);
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('resolveS3Credentials', () => {
  test('an already expired credential is refused, not signed with', async () => {
    const { __resetS3CredentialCacheForTests, resolveS3Credentials } = await import('./s3');
    __resetS3CredentialCacheForTests();
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = `http://127.0.0.1:${server.port}/creds`;
    // A credential source that hands out something already dead must not be
    // papered over: signing with it produces a 403 that reads like a
    // permissions failure and sends the operator to the wrong place.
    expiryAt = () => Date.now() - 60_000;
    try {
      await expect(resolveS3Credentials()).rejects.toThrow(/already expired/);
    } finally {
      expiryAt = () => Date.now() + 3600_000;
      __resetS3CredentialCacheForTests();
    }
  });

  test('falls back to the ambient role when no static key is configured', async () => {
    const { __resetS3CredentialCacheForTests, resolveS3Credentials } = await import('./s3');
    __resetS3CredentialCacheForTests();
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_PROFILE;
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = `http://127.0.0.1:${server.port}/creds`;

    const before = served;
    const credentials = await resolveS3Credentials();
    expect(served).toBeGreaterThan(before);
    expect(credentials.accessKeyId).toBe(ROLE.AccessKeyId);
    expect(credentials.secretAccessKey).toBe(ROLE.SecretAccessKey);
    // Temporary credentials are useless unless the token rides along.
    expect(credentials.sessionToken).toBe(ROLE.Token);
  });

  test('a short-lived credential is refetched before it expires', async () => {
    const { __resetS3CredentialCacheForTests, resolveS3Credentials } = await import('./s3');
    __resetS3CredentialCacheForTests();
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = `http://127.0.0.1:${server.port}/creds`;
    // A task role hands out credentials that last minutes, not hours. A cache
    // that ignores the credential's own expiry keeps signing with a dead one,
    // and every request 403s in a way that reads like a permissions problem.
    const now = Date.now();
    const before = served;
    // Three minutes, so the cached entry expires at now+2min — the credential's
    // OWN expiry minus the skew, well inside the old fixed five-minute window.
    expiryAt = () => now + 180_000;
    await resolveS3Credentials(now);
    expect(served).toBe(before + 1);

    // The task role has rotated by the time this read happens.
    expiryAt = () => now + 600_000;
    await resolveS3Credentials(now + 121_000);
    // A fixed five-minute cache would still be serving the dead one here.
    expect(served).toBe(before + 2);
    expiryAt = () => Date.now() + 3600_000;
  });

  test('a long-lived credential is still reused', async () => {
    const { __resetS3CredentialCacheForTests, resolveS3Credentials } = await import('./s3');
    __resetS3CredentialCacheForTests();
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = `http://127.0.0.1:${server.port}/creds`;
    const now = Date.now();
    const before = served;
    await resolveS3Credentials(now);
    await resolveS3Credentials(now + 60_000);
    expect(served).toBe(before + 1);
  });

  test('a role credential reaches the wire as x-amz-security-token', async () => {
    const { __resetS3CredentialCacheForTests, s3PutObject } = await import('./s3');
    __resetS3CredentialCacheForTests();
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = `http://127.0.0.1:${server.port}/creds`;

    // A stand-in for S3 itself: the point is what the signer actually SENDS,
    // not what a unit-level signature helper returns.
    let seen: Headers | null = null;
    const storage = Bun.serve({
      port: 0,
      fetch(request) {
        seen = request.headers;
        return new Response('', { status: 200, headers: { etag: '"fixture"' } });
      },
    });
    try {
      await s3PutObject(
        {
          bucket: 'kortix-repo-snapshots',
          region: 'us-east-2',
          prefix: 'prod/',
          endpoint: `http://127.0.0.1:${storage.port}`,
          forcePathStyle: true,
        },
        'owner/repo/sha/1/project-snapshot-v1/archive.tar.gz',
        Buffer.from('archive'),
      );
    } finally {
      storage.stop(true);
    }

    expect(seen).not.toBeNull();
    // Temporary credentials are refused without the token, whatever the
    // signature says.
    expect(seen!.get('x-amz-security-token')).toBe(ROLE.Token);
    const authorization = seen!.get('authorization') ?? '';
    expect(authorization).toContain(`Credential=${ROLE.AccessKeyId}/`);
    expect(authorization).toContain('/us-east-2/s3/aws4_request');
    expect(authorization).toContain('x-amz-security-token');
  });
});
