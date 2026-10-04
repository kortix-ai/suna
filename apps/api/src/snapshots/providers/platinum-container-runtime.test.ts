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

const { fromBuildKernelModules } = await import('./platinum');

// kortix.yaml `container_runtime: true` → Platinum `kernel_modules: "container"`
// on /v1/templates/from-build. A Platinum API older than the field strips it and
// cannot cancel the build it queued (DELETE answers 409 build_in_progress), so a
// missing echo produces a build-log warning, not a failure: the template builds
// as before, without the container modules.
describe('fromBuildKernelModules', () => {
  test('requests nothing for an ordinary template', () => {
    const { body, missing } = fromBuildKernelModules({ snapshotName: 'kortix-tpl-a' });
    expect(body).toEqual({});
    expect(missing({ id: 'tpl_1' })).toBeNull();
  });

  test('requests the container profile and accepts the echo', () => {
    const { body, missing } = fromBuildKernelModules({ snapshotName: 'kortix-tpl-a', containerRuntime: true });
    expect(body).toEqual({ kernel_modules: 'container' });
    expect(missing({ id: 'tpl_1', kernel_modules: 'container' })).toBeNull();
  });

  test('an API that did not echo the profile yields a warning naming the fix', () => {
    const { missing } = fromBuildKernelModules({ snapshotName: 'kortix-tpl-a', containerRuntime: true });
    const warning = missing({ id: 'tpl_1' });
    expect(warning).toContain('kortix-tpl-a');
    expect(warning).toContain('container_runtime');
    expect(warning).toContain('kernel_modules');
  });
});
