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

const { ensureMyKortixSandboxImage, myKortixSnapshotName, settleMyKortixImageBuilds } = await import('./builder');
const { platinumProvider } = await import('./providers/platinum');

const originalIsConfigured = platinumProvider.isConfigured;
const originalGetSnapshotState = platinumProvider.getSnapshotState;
const originalBuildSnapshot = platinumProvider.buildSnapshot;
const originalListSnapshots = platinumProvider.listSnapshots;
const originalFindFirstActive = platinumProvider.findFirstActiveSnapshot;

/** No served images and every region resident: the pre-fallback behaviour. */
const NO_FALLBACK = { readServed: async () => [], regionResident: async () => true };

afterEach(async () => {
  await settleMyKortixImageBuilds();
  platinumProvider.isConfigured = originalIsConfigured;
  platinumProvider.getSnapshotState = originalGetSnapshotState;
  platinumProvider.buildSnapshot = originalBuildSnapshot;
  platinumProvider.listSnapshots = originalListSnapshots;
  platinumProvider.findFirstActiveSnapshot = originalFindFirstActive;
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

  const first = ensureMyKortixSandboxImage({ source: 'session-start', provider: 'platinum' }, NO_FALLBACK);
  const second = ensureMyKortixSandboxImage({ source: 'session-start', provider: 'platinum' }, NO_FALLBACK);
  await buildStarted.promise;

  // One readiness probe per session start, one more by the single build.
  expect(stateCalls).toBe(3);
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

  const result = await ensureMyKortixSandboxImage({ source: 'session-start', provider: 'platinum' }, NO_FALLBACK);
  expect(builtSpec).toEqual({ cpu: 1, memoryGb: 2, diskGb: 8 });
  expect(result.spec).toEqual(builtSpec as typeof result.spec);
});

const PREVIOUS = myKortixSnapshotName('e'.repeat(64));
const OLDER = myKortixSnapshotName('f'.repeat(64));
const served = async () => [
  { snapshotName: PREVIOUS, contentHash: 'e'.repeat(64) },
  { snapshotName: OLDER, contentHash: 'f'.repeat(64) },
];

function fakeStates(states: Record<string, string>, fallbackState = 'missing') {
  platinumProvider.isConfigured = () => true;
  platinumProvider.findFirstActiveSnapshot = undefined as never;
  platinumProvider.getSnapshotState = (async (name: string) => states[name] ?? fallbackState) as never;
  platinumProvider.listSnapshots = async () => [];
}

test('a session start boots the last served image and builds the new one behind it', async () => {
  const buildGate = deferred();
  const buildStarted = deferred();
  let buildCalls = 0;
  fakeStates({ [PREVIOUS]: 'active' });
  platinumProvider.buildSnapshot = async () => {
    buildCalls += 1;
    buildStarted.resolve();
    await buildGate.promise;
    return { externalTemplateId: 'tpl_test' };
  };

  const result = await ensureMyKortixSandboxImage(
    { source: 'session-start', provider: 'platinum' },
    { readServed: served, regionResident: async () => true },
  );

  expect(result.snapshotName).toBe(PREVIOUS);
  expect(result.contentHash).toBe('e'.repeat(64));
  expect(result.built).toBe(false);
  await buildStarted.promise;
  expect(buildCalls).toBe(1);

  // A second session during the build boots the fallback too and starts no second build.
  const second = await ensureMyKortixSandboxImage(
    { source: 'session-start', provider: 'platinum' },
    { readServed: served, regionResident: async () => true },
  );
  expect(second.snapshotName).toBe(PREVIOUS);
  expect(buildCalls).toBe(1);
  buildGate.resolve();
});

test('a build running on another replica is not duplicated while the fallback serves', async () => {
  let buildCalls = 0;
  let current = '';
  platinumProvider.isConfigured = () => true;
  platinumProvider.findFirstActiveSnapshot = undefined as never;
  platinumProvider.listSnapshots = async () => [];
  let polls = 0;
  platinumProvider.getSnapshotState = (async (name: string) => {
    if (name === PREVIOUS) return 'active';
    current = name;
    polls += 1;
    return polls > 2 ? 'active' : 'building';
  }) as never;
  platinumProvider.buildSnapshot = async () => {
    buildCalls += 1;
    return { externalTemplateId: 'tpl_test' };
  };

  const result = await ensureMyKortixSandboxImage(
    { source: 'session-start', provider: 'platinum' },
    { readServed: served, regionResident: async () => true },
  );
  expect(result.snapshotName).toBe(PREVIOUS);
  expect(current).not.toBe('');
  expect(buildCalls).toBe(0);
});

test('this version\'s image is served once it is active and in the session region', async () => {
  let buildCalls = 0;
  fakeStates({}, 'active');
  platinumProvider.buildSnapshot = async () => {
    buildCalls += 1;
    return { externalTemplateId: 'tpl_test' };
  };
  const regionChecks: Array<[string, number | undefined]> = [];

  const result = await ensureMyKortixSandboxImage(
    { source: 'session-start', provider: 'platinum', projectId: 'project-1' },
    {
      readServed: served,
      regionResident: async (_project, _provider, name, timeoutMs) => {
        regionChecks.push([name, timeoutMs]);
        return true;
      },
    },
  );
  expect(result.snapshotName).not.toBe(PREVIOUS);
  expect(result.snapshotName).toStartWith('kortix-mykortix-dev-');
  expect(buildCalls).toBe(0);
  expect(regionChecks).toEqual([[result.snapshotName, 3_000]]);
});

test('an image not yet copied to the session region falls back to a resident one', async () => {
  fakeStates({}, 'active');
  platinumProvider.buildSnapshot = async () => ({ externalTemplateId: 'tpl_test' });

  const result = await ensureMyKortixSandboxImage(
    { source: 'session-start', provider: 'platinum', projectId: 'project-us' },
    {
      readServed: served,
      // Only OLDER is in the US region.
      regionResident: async (_project, _provider, name) => name === OLDER,
    },
  );
  expect(result.snapshotName).toBe(OLDER);
});

test('a served image the provider no longer has is skipped; with none left the session waits for the build', async () => {
  let buildCalls = 0;
  fakeStates({ [PREVIOUS]: 'missing', [OLDER]: 'build_failed' });
  platinumProvider.buildSnapshot = async () => {
    buildCalls += 1;
    return { externalTemplateId: 'tpl_test' };
  };

  const result = await ensureMyKortixSandboxImage(
    { source: 'session-start', provider: 'platinum' },
    { readServed: served, regionResident: async () => true },
  );
  expect(result.built).toBe(true);
  expect(result.snapshotName).not.toBe(PREVIOUS);
  expect(buildCalls).toBe(1);
});

test('a failed served-image lookup waits for the build instead of failing the session', async () => {
  let buildCalls = 0;
  fakeStates({});
  platinumProvider.buildSnapshot = async () => {
    buildCalls += 1;
    return { externalTemplateId: 'tpl_test' };
  };

  const result = await ensureMyKortixSandboxImage(
    { source: 'session-start', provider: 'platinum' },
    {
      readServed: async () => {
        throw new Error('database unreachable');
      },
      regionResident: async () => true,
    },
  );
  expect(result.built).toBe(true);
  expect(buildCalls).toBe(1);
});

test('the startup pre-build never takes the fallback: building the image is its job', async () => {
  let buildCalls = 0;
  fakeStates({ [PREVIOUS]: 'active' });
  platinumProvider.buildSnapshot = async () => {
    buildCalls += 1;
    return { externalTemplateId: 'tpl_test' };
  };

  const result = await ensureMyKortixSandboxImage(
    { source: 'startup', provider: 'platinum' },
    { readServed: served, regionResident: async () => true },
  );
  expect(result.built).toBe(true);
  expect(buildCalls).toBe(1);
});

test('on the first deploy after the rename, a session start boots the served legacy kortix-meta image', async () => {
  const legacy = `kortix-meta-dev-${'e'.repeat(16)}`;
  let buildCalls = 0;
  fakeStates({ [legacy]: 'active' });
  platinumProvider.buildSnapshot = async () => {
    buildCalls += 1;
    return { externalTemplateId: 'tpl_test' };
  };

  const result = await ensureMyKortixSandboxImage(
    { source: 'session-start', provider: 'platinum' },
    { readServed: async () => [{ snapshotName: legacy, contentHash: 'e'.repeat(64) }], regionResident: async () => true },
  );
  expect(result.snapshotName).toBe(legacy);
  expect(result.slug).toBe('mykortix');
  expect(result.built).toBe(false);
  await settleMyKortixImageBuilds();
  // The kortix-mykortix image builds behind it.
  expect(buildCalls).toBe(1);
});
