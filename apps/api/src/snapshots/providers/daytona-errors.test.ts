import { describe, expect, test } from 'bun:test';

function setTestEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name]?.startsWith('encrypted:')) {
    process.env[name] = value;
  }
}

setTestEnv('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
setTestEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
setTestEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
setTestEnv('API_KEY_SECRET', 'test-api-key-secret');
setTestEnv('TUNNEL_SIGNING_SECRET', 'test-tunnel-signing-secret');
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'daytona');
setTestEnv('DAYTONA_API_KEY', 'test-daytona-key');
setTestEnv('DAYTONA_SERVER_URL', 'https://daytona.example.test');
setTestEnv('DAYTONA_TARGET', 'test-target');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');
setTestEnv('RECALL_BASE_URL', 'https://us-west-2.recall.ai/api/v1');

const { isDaytonaSnapshotNotFoundError } = await import('./daytona');

describe('Daytona snapshot not-found classifier', () => {
  test.each([
    ['statusCode 404', Object.assign(new Error('missing'), { statusCode: 404 })],
    ['response.status 404', Object.assign(new Error('missing'), { response: { status: 404 } })],
    ['direct status 404', Object.assign(new Error('missing'), { status: 404 })],
    ['numeric code 404', Object.assign(new Error('missing'), { code: 404 })],
    [
      'DaytonaNotFoundError name case-insensitively',
      Object.assign(new Error('missing'), { name: 'dAyToNaNoTfOuNdErRoR' }),
    ],
    ['precise snapshot-with-name message', new Error('Snapshot with name x not found')],
  ])('recognizes %s', (_label, err) => {
    expect(isDaytonaSnapshotNotFoundError(err)).toBe(true);
  });

  test.each([
    ['timeout', new Error('Daytona snapshot.get(x) timed out')],
    ['503', Object.assign(new Error('upstream failed'), { statusCode: 503 })],
    ['generic not-found text', new Error('repository not found')],
    ['imprecise snapshot text', new Error('snapshot lookup not found')],
  ])('rejects %s as an unconfirmed not-found', (_label, err) => {
    expect(isDaytonaSnapshotNotFoundError(err)).toBe(false);
  });
});
