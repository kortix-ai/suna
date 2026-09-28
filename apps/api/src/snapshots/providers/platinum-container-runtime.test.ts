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
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'platinum');
setTestEnv('KORTIX_URL', 'https://api.example.test');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');

const { fromBuildKernelModules, isRetryablePlatinumBuildError } = await import('./platinum');

// kortix.yaml `container_runtime: true` → Platinum `kernel_modules: "container"`
// on /v1/templates/from-build. A Platinum API older than the field strips it and
// builds a template dockerd cannot use, so the echo is required.
describe('fromBuildKernelModules', () => {
  test('requests nothing for an ordinary template', () => {
    const { body, verify } = fromBuildKernelModules({ snapshotName: 'kortix-tpl-a' });
    expect(body).toEqual({});
    expect(() => verify({ id: 'tpl_1' })).not.toThrow();
  });

  test('requests the container profile and accepts the echo', () => {
    const { body, verify } = fromBuildKernelModules({ snapshotName: 'kortix-tpl-a', containerRuntime: true });
    expect(body).toEqual({ kernel_modules: 'container' });
    expect(() => verify({ id: 'tpl_1', kernel_modules: 'container' })).not.toThrow();
  });

  test('an API that did not echo the profile fails the build with a non-retryable error', () => {
    const { verify } = fromBuildKernelModules({ snapshotName: 'kortix-tpl-a', containerRuntime: true });
    let err: unknown;
    try {
      verify({ id: 'tpl_1' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('container_runtime');
    expect((err as Error).message).toContain('kernel_modules');
    expect(isRetryablePlatinumBuildError(err)).toBe(false);
  });
});
