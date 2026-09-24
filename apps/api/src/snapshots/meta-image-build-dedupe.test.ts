import { afterEach, expect, test } from 'bun:test';

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
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'platinum');
setTestEnv('KORTIX_URL', 'https://api.example.test');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');
setTestEnv('PLATINUM_API_URL', 'https://platinum.test');
setTestEnv('PLATINUM_API_KEY', 'pt_live_testkey');

const { ensureMetaSandboxImage } = await import('./builder');
const { platinumProvider } = await import('./providers/platinum');

const originalIsConfigured = platinumProvider.isConfigured;
const originalGetSnapshotState = platinumProvider.getSnapshotState;
const originalBuildSnapshot = platinumProvider.buildSnapshot;
const originalListSnapshots = platinumProvider.listSnapshots;

afterEach(() => {
  platinumProvider.isConfigured = originalIsConfigured;
  platinumProvider.getSnapshotState = originalGetSnapshotState;
  platinumProvider.buildSnapshot = originalBuildSnapshot;
  platinumProvider.listSnapshots = originalListSnapshots;
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('concurrent meta cold builds share one provider build', async () => {
  const buildGate = deferred();
  const buildStarted = deferred();
  let stateCalls = 0;
  let buildCalls = 0;
  platinumProvider.isConfigured = () => true;
  platinumProvider.getSnapshotState = async () => {
    stateCalls += 1;
    return 'missing';
  };
  platinumProvider.buildSnapshot = async () => {
    buildCalls += 1;
    buildStarted.resolve();
    await buildGate.promise;
    return { externalTemplateId: 'tpl_test' };
  };
  platinumProvider.listSnapshots = async () => [];

  const first = ensureMetaSandboxImage({ source: 'session-start', provider: 'platinum' });
  const second = ensureMetaSandboxImage({ source: 'session-start', provider: 'platinum' });
  await buildStarted.promise;

  expect(stateCalls).toBe(1);
  expect(buildCalls).toBe(1);
  buildGate.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  expect(firstResult).toBe(secondResult);
});

test('a meta image reports the size it was built with, so metering bills that size', async () => {
  let builtSpec: unknown = null;
  platinumProvider.isConfigured = () => true;
  platinumProvider.getSnapshotState = async () => 'missing';
  platinumProvider.buildSnapshot = async (input: { spec?: unknown }) => {
    builtSpec = input.spec;
    return { externalTemplateId: 'tpl_test' };
  };
  platinumProvider.listSnapshots = async () => [];

  const result = await ensureMetaSandboxImage({ source: 'session-start', provider: 'platinum' });
  expect(builtSpec).toEqual({ cpu: 1, memoryGb: 2, diskGb: 8 });
  expect(result.spec).toEqual(builtSpec);
});
