import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { resolve } from 'node:path';
import { hashSecretKey } from '../shared/crypto';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must point to isolated test PostgreSQL');
const adminUrl = new URL(process.env.TEST_DATABASE_ADMIN_URL ?? url);
adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString());
const name = `cli_token_test_${crypto.randomUUID().replaceAll('-', '')}`;
const isolatedUrl = new URL(url);
isolatedUrl.pathname = `/${name}`;
const db = postgres(isolatedUrl.toString());
const root = resolve(import.meta.dir, '../../../..');
const env = { ...process.env, BASH_ENV: '/dev/null', INTERNAL_KORTIX_ENV: 'dev', KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT: 'http://127.0.0.1:1', FRONTEND_URL: 'http://127.0.0.1:1', ALLOWED_SANDBOX_PROVIDERS: '', DATABASE_URL: isolatedUrl.toString(), E2E_DATABASE_URL: isolatedUrl.toString() };
const survivor = 'pk_concurrent';

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`);
  // Only the two relations this standalone mint/shell tool uses. No application mocks.
  await db.unsafe(`CREATE SCHEMA kortix;
    CREATE TABLE kortix.account_members (user_id uuid, account_id uuid, joined_at timestamptz DEFAULT now());
    CREATE TABLE kortix.account_tokens (account_id uuid, user_id uuid, name text, public_key text UNIQUE, secret_key_hash text);
    INSERT INTO kortix.account_members VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', now());`);
});
afterAll(async () => {
  await db.end();
  await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
});
async function seed() {
  await db`DELETE FROM kortix.account_tokens`;
  await db`INSERT INTO kortix.account_tokens (name, public_key, secret_key_hash) VALUES ('cli-smoke', ${survivor}, 'existing'), ('cli-e2e-other', 'pk_other', 'existing')`;
}
async function shell(api: string) {
  const child = Bun.spawn(['bash', `${root}/apps/cli/scripts/e2e-cloud.sh`], {
    cwd: root, env: { ...env, KORTIX_API_URL: api }, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
test('failed preflight cannot delete any existing token', async () => {
  await seed();
  const server = Bun.serve({ port: 0, fetch: () => new Response(''), });
  const port = server.port;
  server.stop(true);
  const result = await shell(`http://127.0.0.1:${port}`);
  expect(result.code).toBe(1);
  expect(result.stdout).toContain('API not reachable');
  expect((await db`SELECT public_key FROM kortix.account_tokens ORDER BY public_key`).map(r => r.public_key)).toEqual([survivor, 'pk_other']);
});
test('failed mint cannot delete existing tokens', async () => {
  await seed();
  await db`DELETE FROM kortix.account_members`;
  const server = Bun.serve({ port: 0, fetch: () => Response.json([]) });
  try {
    const result = await shell(`http://127.0.0.1:${server.port}`);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Could not mint a PAT');
    expect((await db`SELECT public_key FROM kortix.account_tokens ORDER BY public_key`).map(r => r.public_key)).toEqual([survivor, 'pk_other']);
  } finally {
    server.stop(true);
    await db`INSERT INTO kortix.account_members (user_id, account_id) VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002')`;
  }
});
test('mint returns separate row identity and credential with a matching stored hash', async () => {
  await seed();
  const child = Bun.spawn(['bun', 'run', 'src/__tests__/e2e-mint-cli-token.ts'], { cwd: `${root}/apps/api`, env, stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(child.stdout).text();
  await new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  const record = output.trim().split('\n').at(-1);
  if (!record) throw new Error('Mint helper returned no record');
  const minted = JSON.parse(record);
  expect(minted.publicKey).toMatch(/^pk_/);
  expect(minted.secretKey).toMatch(/^kortix_pat_/);
  const [row] = await db`SELECT secret_key_hash FROM kortix.account_tokens WHERE public_key = ${minted.publicKey}`;
  expect(row.secret_key_hash).toBe(hashSecretKey(minted.secretKey));
});
test('rename and exit cleanup preserve concurrent smoke and suite tokens; login still verifies auth', async () => {
  await seed();
  let names: string[] = [];
  let credential = '';
  const server = Bun.serve({ port: 0, async fetch(req) {
    if (new URL(req.url).pathname.endsWith('/accounts/me')) {
      credential = req.headers.get('authorization') ?? '';
      names = (await db`SELECT name FROM kortix.account_tokens ORDER BY name`).map(r => r.name);
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (new URL(req.url).pathname.endsWith('/projects')) return Response.json([]);
    return Response.json([]);
  } });
  try {
    const result = await shell(`http://127.0.0.1:${server.port}`);
    expect(result.stdout).toContain('Token rejected by the API');
    expect(credential).toMatch(/^Bearer kortix_pat_/);
    expect(names).toEqual(['cli-e2e-other', 'cli-e2e-suite', 'cli-smoke']);
    expect((await db`SELECT public_key FROM kortix.account_tokens ORDER BY public_key`).map(r => r.public_key)).toEqual([survivor, 'pk_other']);
  } finally { server.stop(true); }
}, 30000);
