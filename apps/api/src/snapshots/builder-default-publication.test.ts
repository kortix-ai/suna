import { expect, test } from 'bun:test';

// Module replacements run in a child process so they cannot leak into other suites.
for (const scenario of ['cache-ready', 'build-ready', 'cache-failure', 'build-failure', 'startup-ready', 'session-ready', 'identity-mismatch', 'background-failure']) {
  test(`shared default publication: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, '--no-env-file', `${import.meta.dir}/__tests__/default-publication.fixture.ts`, scenario], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:54322/postgres',
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
        API_KEY_SECRET: 'test-api-key-secret',
        TUNNEL_SIGNING_SECRET: 'test-tunnel-signing-secret',
        ALLOWED_SANDBOX_PROVIDERS: 'platinum',
        KORTIX_URL: 'https://api.example.test',
        FRONTEND_URL: 'http://localhost:3000',
        INTERNAL_KORTIX_ENV: 'dev',
        PLATINUM_API_URL: 'https://platinum.test',
        PLATINUM_API_KEY: 'pt_live_testkey',
        KORTIX_PLATINUM_US_REGION: 'us-east',
        KORTIX_SNAPSHOT_REAP_PREDECESSOR: 'true',
        KORTIX_SKIP_STARTUP_PREBUILD: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, errors: exit === 0 ? '' : `${stdout}\n${stderr}` }).toEqual({ exit: 0, errors: '' });
  }, 15_000);
}
