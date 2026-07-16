import { expect, test } from 'bun:test';

// Locks the telemetry-side guard for the transient `RuntimeNotReadyError`
// ("[opencode-sdk] Server URL not ready — sandbox is still loading") cluster.
// The throw is an expected, self-healing state on every session switch /
// provisioning window; it must never page Better Stack. `app/error.tsx`
// suppresses the global route-segment render case, but the throw can also be
// captured by the generic `<ClientErrorBoundary>` and the shared
// `RouteErrorFallback` — both must skip Sentry for it. (The Sentry
// `ignoreErrors` list + `browser-error-noise` `beforeSend` filter back these
// up at the SDK level; see browser-error-noise.test.mts.)

test('ClientErrorBoundary does not capture runtime-not-ready to Sentry', async () => {
  const source = await Bun.file(`${import.meta.dir}/error-boundary.tsx`).text();
  expect(source).toContain('isRuntimeNotReadyNoiseMessage');
  expect(source).toContain('Sentry.captureException');
  // The guard must short-circuit BEFORE the capture call.
  const guardIdx = source.indexOf('isRuntimeNotReadyNoiseMessage(error?.message)');
  const captureIdx = source.indexOf('Sentry.captureException(error');
  expect(guardIdx).toBeGreaterThan(-1);
  expect(captureIdx).toBeGreaterThan(-1);
  expect(guardIdx).toBeLessThan(captureIdx);
});

test('RouteErrorFallback does not capture runtime-not-ready to Sentry', async () => {
  const source = await Bun.file(`${import.meta.dir}/route-error.tsx`).text();
  expect(source).toContain('isRuntimeNotReadyNoiseMessage(error?.message)');
  expect(source).toContain('return;');
  // The guard must return before the capture call inside the effect.
  const guardIdx = source.indexOf('isRuntimeNotReadyNoiseMessage(error?.message)');
  const captureIdx = source.indexOf('Sentry.captureException(error)');
  expect(guardIdx).toBeGreaterThan(-1);
  expect(captureIdx).toBeGreaterThan(-1);
  expect(guardIdx).toBeLessThan(captureIdx);
});
