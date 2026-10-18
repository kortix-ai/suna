import { afterEach, expect, test } from 'bun:test';

function setTestEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name]?.startsWith('encrypted:')) process.env[name] = value;
}
setTestEnv('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
setTestEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
setTestEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
setTestEnv('API_KEY_SECRET', 'test-api-key-secret');
setTestEnv('TUNNEL_SIGNING_SECRET', 'test-tunnel-signing-secret');
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'platinum');
setTestEnv('KORTIX_URL', 'https://api.example.com');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');
setTestEnv('PLATINUM_API_URL', 'https://api.platinum.dev');
setTestEnv('PLATINUM_API_KEY', 'pt_test_key');

const { templateRegionResident } = await import('./builder');
type Prepare = NonNullable<NonNullable<Parameters<typeof templateRegionResident>[4]>['prepare']>;

const ON = { experimental: { us_region: true } };
const saved = process.env.KORTIX_PLATINUM_US_REGION;
afterEach(() => {
  if (saved === undefined) delete process.env.KORTIX_PLATINUM_US_REGION;
  else process.env.KORTIX_PLATINUM_US_REGION = saved;
});

function prepareSpy(result: 'ready' | 'replicating') {
  const calls: Array<[string, string, number | undefined]> = [];
  const prepare = (async (name: string, region: string, opts?: { timeoutMs?: number }) => {
    calls.push([name, region, opts?.timeoutMs]);
    if (result === 'replicating') throw new Error('did not become resident in us-east within 3000ms (last state: replicating/copying)');
    return { templateId: 'tpl_1', region };
  }) as Prepare;
  return { calls, prepare };
}

test('a us_region project waits for the copy, then the image is resident', async () => {
  process.env.KORTIX_PLATINUM_US_REGION = 'us-east';
  const { calls, prepare } = prepareSpy('ready');
  expect(await templateRegionResident('p1', 'platinum', 'kortix-tpl-new', 3_000, { readMetadata: async () => ON, prepare })).toBe(true);
  expect(calls).toEqual([['kortix-tpl-new', 'us-east', 3_000]]);
});

test('a copy still running answers false, so a boot serves the last ready image', async () => {
  process.env.KORTIX_PLATINUM_US_REGION = 'us-east';
  const { prepare } = prepareSpy('replicating');
  expect(await templateRegionResident('p1', 'platinum', 'kortix-tpl-new', 3_000, { readMetadata: async () => ON, prepare })).toBe(false);
});

test('home-region projects and other providers never ask Platinum', async () => {
  process.env.KORTIX_PLATINUM_US_REGION = 'us-east';
  const { calls, prepare } = prepareSpy('ready');
  expect(await templateRegionResident('p1', 'platinum', 'kortix-tpl-new', 3_000, { readMetadata: async () => ({}), prepare })).toBe(true);
  expect(await templateRegionResident('p1', 'daytona', 'kortix-tpl-new', 3_000, { readMetadata: async () => ON, prepare })).toBe(true);
  expect(calls).toEqual([]);
});
